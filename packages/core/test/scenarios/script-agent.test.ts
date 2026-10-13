/**
 * The script agent (a debug build's `agent:script`): a message to it is a script, and it makes the calls through the same tool
 * surface a real agent has. Here the hub is a debug one (host.json `dev.script_agent`) and the agent's program really runs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { OWNER, accepted, isApprovalAsk, startScenario, type Human, type Scenario } from "./harness";
import { eventually } from "../fixtures/wait";

const SCRIPT = "agent:script";
interface Report { run: string | null; trigger: string; completed?: boolean; matched?: string | null; steps: { i: number; id?: string; kind: string; ok: boolean; status?: string; ms?: number; error?: { code: string }; data?: any }[] } // eslint-disable-line @typescript-eslint/no-explicit-any

const reports = (owner: Human): Report[] => owner.messages
  .filter((m) => m.from === SCRIPT && m.to === OWNER && m.word === "say" && String((m.body as { text?: unknown }).text).startsWith('{"script_report"'))
  .map((m) => JSON.parse(String((m.body as { text: string }).text)).script_report as Report);

async function boot(t: Parameters<typeof startScenario>[0], options: Parameters<typeof startScenario>[1] = {}): Promise<{ s: Scenario; owner: Human }> {
  const s = await startScenario(t, { scriptAgent: true, ...options });
  const owner = await s.human();
  await eventually(async () => { const r = await owner.call("service:agents", "list"); return r.ok && JSON.stringify(r.result?.data).includes('"agent:script"') && JSON.stringify(r.result?.data).includes('"idle"'); }, "agent:script up");
  return { s, owner };
}

test("a script's calls go through the tool surface as the agent's own, and the agent reports every step", async (t) => {
  const { owner } = await boot(t);
  accepted(await owner.say(JSON.stringify({ run: "r1", steps: [
    { id: "a", call: { member: "service:admin", word: "status" } },
    { id: "b", call: { member: "service:admin", word: "nothing.here" } },
    { say: "hello from the script" },
  ] }), { to: SCRIPT }));

  await eventually(() => reports(owner).length === 1, "the report");
  const report = reports(owner)[0]!;
  assert.deepEqual([report.run, report.trigger, report.completed], ["r1", "script", true]);
  assert.deepEqual(report.steps.map((s) => [s.id, s.kind, s.ok]), [["a", "call", true], ["b", "call", false], [undefined, "say", true]]);
  assert.equal(report.steps[0]!.data.version !== undefined, true, "the data of the answer");
  assert.equal(report.steps[1]!.error?.code, "not_found");
  // The calls are the script agent's, in a turn of its own, with the same events a real agent's turn has.
  const ledger = await owner.ledger();
  assert.ok(ledger.some((m) => m.from === SCRIPT && m.to === "service:admin" && m.word === "status" && m.turn), "an agent's call, in a turn");
  assert.ok(ledger.some((m) => m.from === SCRIPT && m.word === "turn.started") && ledger.some((m) => m.from === SCRIPT && m.word === "turn.ended"));
  assert.ok(ledger.some((m) => m.from === SCRIPT && m.word === "agent.tool"), "tool events");
  assert.ok(owner.messages.some((m) => m.from === SCRIPT && m.to === OWNER && (m.body as { text?: string }).text === "hello from the script"));
});

test("the approval fast path, end to end: the owner approves in time and the same call returns the result, with no message of the owner's", async (t) => {
  const { owner } = await boot(t, { fastApproval: true });
  accepted(await owner.say(JSON.stringify({ run: "fast", steps: [{ id: "a1", call: { member: "service:gate", word: "mode.set", body: { mode: "auto" }, purpose: "test" } }] }), { to: SCRIPT }));
  const card = await owner.seen(isApprovalAsk, "the approval card");
  accepted(await owner.answer(card, "once"));
  await eventually(() => reports(owner).length === 1, "the report");
  const step = reports(owner)[0]!.steps[0]!;
  assert.deepEqual([step.ok, step.status, step.data], [true, undefined, { mode: "auto" }]);
  assert.equal(owner.messages.some((m) => m.from === OWNER && m.to === SCRIPT && String((m.body as { text?: string }).text).includes("批准")), false);
  assert.equal((await owner.ledger()).some((m) => m.word === "pending.redeem"), false);
});

test("the slow way, end to end: past the threshold the call gets the receipt, the answer comes as the owner's message, and a handler redeems it", async (t) => {
  const { owner } = await boot(t, { fastApproval: true });
  assert.ok((await owner.call("service:admin", "settings.set", { "approval.fast_seconds": 1 })).ok);
  accepted(await owner.say(JSON.stringify({ run: "slow",
    steps: [{ id: "a1", call: { member: "service:gate", word: "mode.set", body: { mode: "auto" }, purpose: "test" } }],
    on_message: [{ match: "[answers ", steps: [{ id: "r", call: { member: "service:gate", word: "pending.redeem", body: { id: "${msg.pending}" } } }] }],
  }), { to: SCRIPT }));
  const card = await owner.seen(isApprovalAsk, "the approval card");
  await eventually(() => reports(owner).length === 1, "the first report");
  assert.equal(reports(owner)[0]!.steps[0]!.status, "waiting_owner");
  accepted(await owner.answer(card, "once"));
  await eventually(() => reports(owner).length === 2, "the second report");
  const second = reports(owner)[1]!;
  assert.equal(second.trigger, "message");
  assert.equal(second.steps[0]!.ok, true, JSON.stringify(second));
  assert.ok(owner.messages.some((m) => m.from === OWNER && m.to === SCRIPT && String((m.body as { text?: string }).text).startsWith("批准：")), "the owner's message");
});

test("only a debug hub has the script agent: without `dev.script_agent` nobody can declare one", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();
  const listed = await owner.call("service:agents", "list");
  assert.ok(listed.ok && !JSON.stringify(listed.result?.data).includes("agent:script"));
  const declared = await owner.call("service:agents", "declare", { id: "agent:script", runtime: { kind: "script" } });
  assert.equal(declared.ok, false);
});
