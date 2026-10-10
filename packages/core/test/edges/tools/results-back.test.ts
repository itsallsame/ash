/**
 * SPEC-02 §3.4, the result comes back by itself: the real router and the real agents module (a fake driver), with the tool
 * surface on its HTTP door. A receipt's answer that is still not fetched when the turn that made the call is over is told
 * to the agent once, as a `wake` on the back lane.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../../../sdk/src/message";
import { wordsOf } from "../../../../sdk/src/words";
import { createAgents } from "../../../src/edges/agents";
import { createToolsEdge, type ToolsEdge } from "../../../src/edges/tools";
import { fake, owner, word, world } from "../../kernel/router/world";
import { FakeDriver, MAIN_TEMPLATE, settle, waitFor } from "../agents/helpers";
import { deferred, fakeRegistry, MAIN, startRig, type Rig, type ToolClient } from "./helpers";

const SLOW = "service:slow";
const DEVICE = `device:${"A".repeat(22)}`;

async function setup() {
  const w = world();
  w.registry.remove(MAIN); // the world's stand-in agent: the real module takes its place
  const slow: ReturnType<typeof deferred<{ data: unknown }>>[] = [];
  w.registry.add(fake(SLOW, [word(SLOW, "slow")], () => { const d = deferred<{ data: unknown }>(); slow.push(d); return d.promise; }));
  w.registry.add(fake(DEVICE, [word(DEVICE, "message.send", { effect: "act", risk: "outward" })]));
  const drivers: FakeDriver[] = [];
  const logs: unknown[][] = [];
  const late: { edge?: ToolsEdge } = {};
  let ids = 0;
  const agents = createAgents({
    router: w.router, registry: w.registry, ledger: w.ledger, vault: { use: () => null },
    drivers: { dsh: (report) => { const d = new FakeDriver(report); drivers.push(d); return d; } },
    templates: { read: (name) => (name === "main" ? MAIN_TEMPLATE : null) },
    tools: (agent, lanes) => ({ mcp_url: "http://hub/mcp", tokens: Object.fromEntries(lanes.map((l) => [l, `tok-${agent}-${l}`])), allowed: ["*"] }),
    started: (agent) => late.edge?.catchUp(agent),
    rules: () => "rules", now: () => Date.now(), newId: () => `n${++ids}`, log: (...a) => logs.push(a),
    timers: { every: () => () => {}, after: () => () => {} },
  });
  await agents.startAll();
  await settle();
  const driver = drivers[0]!;
  const wakes: Message[] = [];
  w.router.subscribe({ to: MAIN, word: "wake" }, (m) => wakes.push(m));
  return { w, agents, driver, slow, wakes, logs, late };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const rigOver = async (s: Setup, extra: Record<string, unknown> = {}) => { const rig = await startRigOver(s, extra); s.late.edge = rig.edge; return rig; };
const startRigOver = (s: Setup, extra: Record<string, unknown> = {}) => startRig({
  router: s.w.router as never, registry: s.w.registry as never, ledger: s.w.ledger,
  agentPolicy: (id) => s.agents.policyOf(id), currentTurn: (id, lane) => s.agents.currentTurn(id, lane), turnActive: (id, turn) => s.agents.turnActive(id, turn),
  log: (...a: unknown[]) => s.logs.push(a), ...extra,
});

/** The owner speaks: a turn on the front lane begins. */
async function startTurn(s: Setup): Promise<string> {
  const reply = await s.w.router.send({ to: MAIN, kind: "request", word: "say", body: { text: "go" } }, owner);
  assert.ok(reply.ok, JSON.stringify(reply));
  await waitFor(() => s.driver.running.has(`${MAIN}/front`), "the front turn");
  return s.driver.running.get(`${MAIN}/front`)!.turn;
}
const endTurn = async (s: Setup) => { s.driver.finish(MAIN, "front"); await settle(); };
const backWakes = (s: Setup) => s.wakes.filter((m) => (m.body as any).reason === "result");
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

async function slowReceipt(client: ToolClient, over: Record<string, unknown> = {}): Promise<string> {
  const receipt = await client.call("capability_call", { member: SLOW, word: "slow", ...over });
  assert.equal(receipt.data.status, "accepted");
  return receipt.data.request_id;
}

test("a slow call whose answer comes after the turn is over wakes the agent once, on the back lane", async () => {
  const s = await setup();
  const rig: Rig = await rigOver(s);
  await startTurn(s);
  const id = await slowReceipt(await rig.client());
  await endTurn(s);
  assert.equal(backWakes(s).length, 0, "no answer yet");
  s.slow[0]!.resolve({ data: { rows: 3 } });
  await waitFor(() => backWakes(s).length === 1, "the wake");
  await tick();
  assert.equal(backWakes(s).length, 1, "only once");
  const body = backWakes(s)[0]!.body as any;
  assert.equal(body.lane, "back");
  assert.equal(body.reason, "result");
  assert.deepEqual(body.context, { request_id: id, member: SLOW, word: "slow", label: "slow", outcome: { ok: true, result: { rows: 3 } } });
  assert.equal(backWakes(s)[0]!.from, "service:tools");
  // the agent got it on its back lane, as a message of its own
  await waitFor(() => s.driver.of("send").some((c) => c[2] === "back"), "a back turn");
  const sent = s.driver.of("send").find((c) => c[2] === "back")!;
  assert.match(JSON.stringify(sent[3]), /Wake · result/);
  assert.ok(JSON.stringify(sent[3]).includes(id));
});

test("human_ask: the owner answers long after the turn; the agent is woken with the answer", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const ask = await (await rig.client()).call("human_ask", { title: "Rice or noodles?", options: [{ id: "rice", label: "rice" }, { id: "noodles", label: "noodles" }] });
  assert.equal(ask.data.status, "waiting_owner", ask.text);
  await endTurn(s);
  await tick();
  assert.equal(backWakes(s).length, 0, "the owner has not answered");
  s.w.owner.answer("rice");
  await waitFor(() => backWakes(s).length === 1, "the wake");
  const context = (backWakes(s)[0]!.body as any).context;
  assert.equal(context.request_id, ask.data.request_id);
  assert.equal(context.member, "person:owner");
  assert.equal(context.word, "ask");
  assert.deepEqual(context.outcome, { ok: true, result: { choice: "rice" } });
});

test("an answer fetched with await_result inside the turn is not told again", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const client = await rig.client();
  const id = await slowReceipt(client);
  const pending = client.call("await_result", { request_id: id });
  s.slow[0]!.resolve({ data: { n: 1 } });
  assert.deepEqual((await pending).data, { n: 1 });
  await endTurn(s);
  await tick();
  assert.equal(backWakes(s).length, 0);
  const row = s.w.ledger.db().prepare("SELECT taken, woken FROM agent_jobs WHERE id=?").get(id) as any;
  assert.deepEqual({ ...row }, { taken: 1, woken: 0 });
});

test("an answer that came during the turn and was not fetched is told once, when the turn ends", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const id = await slowReceipt(await rig.client());
  s.slow[0]!.resolve({ data: { n: 2 } });
  await tick();
  assert.equal(backWakes(s).length, 0, "the turn is still running: the agent can fetch it");
  await endTurn(s);
  await waitFor(() => backWakes(s).length === 1, "the wake at the end of the turn");
  assert.equal((backWakes(s)[0]!.body as any).context.request_id, id);
  // another turn ending, on any lane, does not tell it again
  await waitFor(() => s.driver.running.has(`${MAIN}/back`), "the back turn");
  s.driver.finish(MAIN, "back");
  await settle();
  await startTurn(s);
  await endTurn(s);
  await tick();
  assert.equal(backWakes(s).length, 1);
});

test("a call cancelled by the agent is not told back", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const client = await rig.client();
  const id = await slowReceipt(client);
  assert.equal((await client.call("cancel", { request_id: id })).data.cancelled, true);
  s.slow[0]!.resolve({ data: {} });
  await endTurn(s);
  await tick();
  assert.equal(backWakes(s).length, 0);
});

test("waiting_owner is not told back: the gate parks the call and service:gate tells the agent the card's answer", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const client = await rig.client();
  const parked = await client.call("capability_call", { member: DEVICE, word: "message.send", body: {} });
  assert.equal(parked.data.status, "waiting_owner", parked.text);
  // and a slow call that is parked by the gate only after the receipt was given
  const later = await slowReceipt(client);
  s.slow[0]!.resolve({ data: { status: "waiting_owner", pending_id: "m_p1" } });
  await endTurn(s);
  await tick();
  assert.equal(backWakes(s).length, 0);
  const rows = s.w.ledger.db().prepare("SELECT id, woken FROM agent_jobs WHERE agent=?").all(MAIN) as { id: string; woken: number }[];
  assert.ok(rows.length >= 2 && rows.every((r) => r.woken === 1), JSON.stringify(rows));
  assert.ok(rows.some((r) => r.id === later));
});

test("a long answer is cut in the wake; the whole is still there for await_result", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const client = await rig.client();
  const id = await slowReceipt(client);
  await endTurn(s);
  s.slow[0]!.resolve({ data: { text: "x".repeat(9000) } });
  await waitFor(() => backWakes(s).length === 1, "the wake");
  const outcome = (backWakes(s)[0]!.body as any).context.outcome;
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.preview.length, 4000);
  assert.match(outcome.note, new RegExp(id));
  const whole = await client.call("await_result", { request_id: id });
  assert.equal(whole.data.text.length, 9000);
});

test("a result over 60000 characters is an attachment: the wake carries a summary and the attachment reference", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const client = await rig.client();
  const id = await slowReceipt(client);
  await endTurn(s);
  s.slow[0]!.resolve({ data: { text: "y".repeat(70_000) } });
  await waitFor(() => backWakes(s).length === 1, "the wake");
  const outcome = (backWakes(s)[0]!.body as any).context.outcome;
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.preview.length, 4000);
  assert.ok(Array.isArray(outcome.attachments) && outcome.attachments.length === 1 && typeof outcome.attachments[0].hash === "string", JSON.stringify(outcome).slice(0, 400));
  assert.match(outcome.note, /service:blobs\/read/);
  assert.match(outcome.note, new RegExp(id));
});

test("the agent is deleted: no wake, one line in the log; stopped: the wake is tried, stays owed, and goes out when the agent is up again", async () => {
  const deleted = await setup();
  let gone = false;
  const rig = await rigOver(deleted, { agentPolicy: (id: string) => (gone ? null : deleted.agents.policyOf(id)) });
  await startTurn(deleted);
  await slowReceipt(await rig.client());
  await endTurn(deleted);
  gone = true;
  deleted.slow[0]!.resolve({ data: { n: 3 } });
  await tick();
  assert.equal(backWakes(deleted).length, 0);
  assert.equal(deleted.logs.filter((l) => String(l[0]).includes("no agent to wake")).length, 1);

  // stopped: the wake cannot be sent now, and is sent once when the agent is up again
  const stopped = await setup();
  const rig2 = await rigOver(stopped);
  await startTurn(stopped);
  const id = await slowReceipt(await rig2.client());
  await endTurn(stopped);
  await stopped.agents.manager.stopAgent(MAIN, "test");
  stopped.slow[0]!.resolve({ data: { n: 4 } });
  await tick();
  assert.equal(stopped.logs.filter((l) => String(l[0]).includes("could not wake")).length, 1, JSON.stringify(stopped.logs));
  assert.equal(backWakes(stopped).length, 0, "the router refused it: the agent is not there");
  assert.equal((stopped.w.ledger.db().prepare("SELECT woken FROM agent_jobs WHERE id=?").get(id) as any).woken, 0, "still owed");
  await stopped.agents.manager.restartAgent(MAIN);
  await waitFor(() => backWakes(stopped).length === 1, "the wake after the agent started again");
  await tick();
  assert.equal(backWakes(stopped).length, 1, "and no more");
  assert.equal((backWakes(stopped)[0]!.body as any).context.request_id, id);
  assert.equal((stopped.w.ledger.db().prepare("SELECT woken FROM agent_jobs WHERE id=?").get(id) as any).woken, 1);
});

test("an answer that came in a turn which never reached turn.ended (the agent process died) is told when the agent is up again, once", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const id = await slowReceipt(await rig.client());
  s.slow[0]!.resolve({ data: { n: 6 } });
  await tick();
  assert.equal(backWakes(s).length, 0, "its turn is still running");
  s.driver.die(MAIN); // the process ends: only `ended` is reported, never turn.ended
  await waitFor(() => backWakes(s).length === 1, "the wake after the restart of the process");
  await tick();
  assert.equal(backWakes(s).length, 1, "once");
  assert.equal((backWakes(s)[0]!.body as any).context.request_id, id);
  assert.deepEqual((backWakes(s)[0]!.body as any).context.outcome, { ok: true, result: { n: 6 } });
});

test("an answer that came in a turn, and the hub restarts before the turn ends, is told once at recover", async () => {
  const s = await setup();
  const first = await rigOver(s);
  await startTurn(s);
  const id = await slowReceipt(await first.client());
  s.slow[0]!.resolve({ data: { n: 5 } });
  await tick();
  first.edge.close();
  // a new process: the agents and their turns are new too, so nothing of the old turn is running
  const again = createToolsEdge({ router: s.w.router, registry: fakeRegistry(), ledger: s.w.ledger, agentPolicy: (a) => s.agents.policyOf(a), currentTurn: () => null, turnActive: () => false, log: (...a) => s.logs.push(a) });
  assert.equal(backWakes(s).length, 0);
  again.recover();
  await waitFor(() => backWakes(s).length === 1, "the wake");
  again.recover();
  again.catchUp(MAIN);
  await tick();
  assert.equal(backWakes(s).length, 1, "once");
  const row = s.w.ledger.db().prepare("SELECT state, taken, woken FROM agent_jobs WHERE id=?").get(id) as any;
  assert.deepEqual({ ...row }, { state: "done", taken: 0, woken: 1 });
  again.close();
});

test("await_result in a later turn for a call of an earlier turn: the answer that comes while it waits is handed over, not also told", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const client = await rig.client();
  const id = await slowReceipt(client);
  await endTurn(s);
  await startTurn(s); // a new front turn
  const pending = client.call("await_result", { request_id: id });
  await tick(50);
  s.slow[0]!.resolve({ data: { n: 9 } });
  const got = await pending;
  assert.deepEqual(got.data, { n: 9 });
  await tick();
  assert.equal(backWakes(s).length, 0, "the agent has the answer");
  assert.deepEqual({ ...(s.w.ledger.db().prepare("SELECT taken, woken FROM agent_jobs WHERE id=?").get(id) as any) }, { taken: 1, woken: 0 });
});

test("an await_result that gives up before the answer comes does not hold the wake back", async () => {
  const s = await setup();
  const rig = await rigOver(s);
  await startTurn(s);
  const client = await rig.client();
  const id = await slowReceipt(client);
  await endTurn(s);
  await startTurn(s);
  const waited = await client.call("await_result", { request_id: id, timeout_ms: 40 });
  assert.equal(waited.data.status, "accepted", "still running");
  s.slow[0]!.resolve({ data: { n: 1 } });
  await waitFor(() => backWakes(s).length === 1, "the wake");
});

test("after a restart the calls that were running are told once as result_unknown", async () => {
  const s = await setup();
  const first = await rigOver(s);
  await startTurn(s);
  const id = await slowReceipt(await first.client());
  await endTurn(s);
  first.edge.close(); // the hub stops; the call is left as it was
  s.slow[0]!.resolve({ data: { too: "late" } });
  await tick();
  assert.equal(backWakes(s).length, 0, "nothing is told while shutting down");

  // the hub starts again on the same database
  const again = createToolsEdge({ router: s.w.router, registry: fakeRegistry(), ledger: s.w.ledger, agentPolicy: (a) => s.agents.policyOf(a), currentTurn: (a, lane) => s.agents.currentTurn(a, lane), turnActive: (a, t) => s.agents.turnActive(a, t), log: (...a) => s.logs.push(a) });
  assert.equal(backWakes(s).length, 0, "not before the hub is up");
  again.recover();
  await waitFor(() => backWakes(s).length === 1, "the wake");
  again.recover();
  await tick();
  assert.equal(backWakes(s).length, 1, "once");
  const context = (backWakes(s)[0]!.body as any).context;
  assert.equal(context.request_id, id);
  assert.equal(context.outcome.ok, false);
  assert.equal(context.outcome.error.code, "result_unknown");
  again.close();
});
