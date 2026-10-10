import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentStartSpec, DriverMessage } from "../../sdk/src/driver";
import { WordError } from "../../sdk/src/message";
import { createComputerDriver, type ComputerDriver } from "../src/agents/driver";
import { abilitiesOf, KINDS, type Kind } from "../src/agents/info";
import { CodexSession } from "../src/agents/codex";
import { ClaudeSession } from "../src/agents/claude";
import { WorkBuddySession } from "../src/agents/workbuddy";
import type { AgentEvent as SessionEvent, AgentSession, OpenOptions } from "../src/agents/types";
import { eventually } from "./kernel";
import { rig, WORK, type Rig } from "./fake-session";

const refused = (code: string) => (error: unknown) => error instanceof WordError && error.code === code;
const dir = () => mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-driver-"));

const spec = (over: Partial<AgentStartSpec> = {}): AgentStartSpec => ({
  runtime: { kind: "codex", model: "m1", effort: "low" },
  native: { on: "device", cwd: "agents/main", env: { A: "1" } },
  tools: { mcp_url: "http://hub/mcp", token: "tok", allowed: [] },
  modules: { static: [{ id: "identity", version: "v1", content: "You are Ash." }, { id: "rules", version: "v1", content: "Be brief." }] },
  lanes: ["front", "back"], sessions: {}, ...over,
});
const message = (id: string, text: string, over: Partial<DriverMessage> = {}): DriverMessage =>
  ({ id, from: "person:owner", word: "say", text, lane: "front", at: Date.UTC(2026, 9, 10, 8, 0, 0), ...over });

async function started(kind: Kind = "codex", over: Partial<AgentStartSpec> = {}) {
  const r = rig(kind);
  await r.driver.start("agent:main", spec({ runtime: { kind, model: "m1", effort: "low" }, ...over }));
  return r;
}
const lastTurn = (r: Rig, key: string) => (r.named("turn.started") as any[]).filter((e) => e.key === key).at(-1)!.turn as string;

test("start holds one runtime session per lane, with the working directory, environment, model, effort and static modules", async () => {
  const r = await started();
  assert.equal(r.sessions.length, 2);
  const [front] = r.sessions;
  assert.deepEqual([front!.options.cwd, front!.options.env, front!.options.model, front!.options.effort], [join(WORK, "agents/main"), { A: "1" }, "m1", "low"]);
  assert.equal(front!.options.system, "You are Ash.\n\n---\n\nBe brief.");
  assert.deepEqual(front!.options.tools.map((t) => t.name), ["agent_list", "agent_ask", "agent_tell"]);
  assert.deepEqual(r.named("handle.updated").map((e) => [e.key, e.handle]), [["front", "handle-1"], ["back", "handle-2"]]);
  assert.deepEqual(r.driver.status("agent:main"), { state: "running" });
  assert.equal(r.driver.session.get("agent:main", "back"), "handle-2");
  assert.equal(r.driver.session.get("agent:main", "nope"), null);
  assert.deepEqual(r.driver.handles("agent:main"), { front: "handle-1", back: "handle-2" });
  assert.deepEqual(r.driver.list(), [{ agent: "agent:main", state: "running" }]);
  // a start for an agent that is running attaches: nothing is opened again
  await r.driver.start("agent:main", spec());
  assert.equal(r.sessions.length, 2);
});

test("a handle is resumed; a handle the runtime no longer knows gives a new session and says so", async () => {
  const r = rig("codex", { open: (o) => { if (o.seed === "stale") throw new Error("no such thread"); } });
  await r.driver.start("agent:main", spec({ sessions: { front: "saved-1", back: "stale" } }));
  assert.deepEqual(r.sessions.map((s) => s.options.seed), ["saved-1", undefined]);
  assert.deepEqual(r.named("error").map((e) => String(e.message).includes("could not be resumed")), [true]);
  assert.equal(r.driver.session.get("agent:main", "front"), "saved-1");
  assert.equal(r.driver.session.get("agent:main", "back"), "handle-2");
  const failing = rig("codex", { open: () => { throw new Error("cannot start"); } });
  await assert.rejects(failing.driver.start("agent:main", spec()), refused("failed"));
  assert.equal(failing.driver.status("agent:main").state, "failed");
  await assert.rejects(failing.driver.send("agent:main", "front", [message("m1", "hi")]), refused("offline"));
  await assert.rejects(rig().driver.start("agent:main", spec({ lanes: [] })), refused("bad_request"));
});

test("send puts the envelope in front of each message, opens a turn, and a running lane is a conflict; the other lane is free", async () => {
  const r = await started();
  await r.driver.send("agent:main", "front", [message("m1", "hello", { thread: "th1", attachments: [{ name: "a b.png", mime_type: "image/png", ref: "blob1" }] }), message("m2", "and this", { word: "tell", origin: { label: "phone" } as never })]);
  const sent = r.sessions[0]!.sent;
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.text, [
    "[ash] 2026-10-10T08:00:00.000Z · person:owner · lane front · say · id m1 · thread th1\nhello\n[attachment name=\"a b.png\" type=image/png ref=blob1]",
    "[ash] 2026-10-10T08:00:00.000Z · phone · lane front · tell · id m2\nand this",
  ].join("\n\n"));
  assert.deepEqual(r.named("turn.started").map((e) => [e.key, e.ids]), [["front", ["m1", "m2"]]]);
  await assert.rejects(r.driver.send("agent:main", "front", [message("m3", "again")]), refused("conflict"));
  await r.driver.send("agent:main", "back", [message("m4", "background", { lane: "back" })]);
  assert.equal(r.sessions[1]!.sent.length, 1);
  await assert.rejects(r.driver.send("agent:main", "nope", [message("m5", "x")]), refused("not_found"));
  await assert.rejects(r.driver.send("agent:other", "front", [message("m5", "x")]), refused("offline"));
});

test("the runtime's events become the contract's: speech is output, thinking and plans are thought, tools, outcome and usage", async () => {
  const r = await started();
  await r.driver.send("agent:main", "front", [message("m1", "go")]);
  const s = r.sessions[0]!;
  s.say("Working on it.");
  s.say("hmm", "thinking");
  s.say("1. look", "plan");
  s.say("   ");
  s.emit({ type: "tool", turn: s.turn, phase: "start", name: "Bash", summary: "ls token=abc123" });
  s.emit({ type: "tool", turn: s.turn, phase: "end", name: "Bash" });
  s.emit({ type: "note", turn: "some-old-turn", kind: "text", text: "LATE" });
  s.end("ok", { usage: { input_tokens: 10, output_tokens: 4 } });
  const turn = lastTurn(r, "front");
  assert.deepEqual(r.events.filter((e) => e.event !== "handle.updated").map((e) => [e.event, (e as any).text ?? (e as any).phase ?? (e as any).outcome]), [
    ["turn.started", undefined], ["output", "Working on it."], ["thought", "hmm"], ["thought", "1. look"], ["tool", "start"], ["tool", "end"], ["turn.ended", "completed"],
  ]);
  assert.equal((r.named("tool")[0] as any).summary, "ls token=\"[redacted]\"");
  assert.deepEqual(r.named("turn.ended")[0], { event: "turn.ended", agent: "agent:main", key: "front", turn, outcome: "completed", usage: { input_tokens: 10, output_tokens: 4 } });
  // the lane is free again
  await r.driver.send("agent:main", "front", [message("m2", "next")]);
});

test("outcomes: failed is error with its message, interrupted stays interrupted, usage shapes of the runtimes are read", async () => {
  const r = await started();
  const run = async (outcome: "failed" | "interrupted" | "unknown", extra: object = {}) => {
    await r.driver.send("agent:main", "front", [message("m", "x")]);
    r.sessions[0]!.end(outcome, extra);
    return r.named("turn.ended").at(-1)!;
  };
  assert.deepEqual([(await run("failed", { error: "provider rejected" })).outcome, r.named("turn.ended").at(-1).error], ["error", "provider rejected"]);
  assert.equal((await run("interrupted")).outcome, "interrupted");
  assert.equal((await run("failed")).error, "the runtime reported a failed turn");
  assert.deepEqual((await run("failed", { usage: { total: { inputTokens: 5, outputTokens: 2 } } })).usage, { input_tokens: 5, output_tokens: 2 });
  assert.equal((await run("failed", { usage: { used: 10, size: 100 } })).usage, undefined);
});

test("speech is redacted and bounded to one frame", async () => {
  const r = await started();
  await r.driver.send("agent:main", "front", [message("m1", "go")]);
  r.sessions[0]!.say("my password: hunter2 and Bearer abcdef");
  r.sessions[0]!.say("🙂".repeat(400_000));
  const [a, b] = r.named("output");
  assert.ok(!a.text.includes("hunter2") && !a.text.includes("abcdef"));
  assert.ok(Buffer.byteLength(b.text) <= 1024 * 1024 && !b.text.includes("�"));
});

test("followup waits behind a running turn and then runs by itself; after an interrupt it waits for the next send", async () => {
  const r = await started();
  await r.driver.send("agent:main", "front", [message("m1", "first")]);
  await r.driver.followup("agent:main", "front", [message("m2", "second")]);
  await r.driver.followup("agent:main", "front", [message("m3", "third")]);
  assert.equal(r.sessions[0]!.sent.length, 1);
  r.sessions[0]!.end("ok");
  await eventually(() => r.sessions[0]!.sent.length === 2, "the queued turn");
  assert.match(r.sessions[0]!.sent[1]!.text, /id m2[\s\S]*id m3/);
  assert.deepEqual(r.named("turn.started").map((e) => e.ids), [["m1"], ["m2", "m3"]]);

  await r.driver.followup("agent:main", "front", [message("m4", "fourth")]);
  await r.driver.interrupt("agent:main", "front");
  assert.deepEqual(r.sessions[0]!.interrupted, [lastTurn(r, "front")]);
  r.sessions[0]!.end("interrupted");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(r.sessions[0]!.sent.length, 2, "nothing is sent after a stop");
  await r.driver.send("agent:main", "front", [message("m5", "fifth")]);
  assert.match(r.sessions[0]!.sent[2]!.text, /id m4[\s\S]*id m5/, "what waited goes with the next send");
  // on an idle lane followup is a send
  r.sessions[0]!.end("ok");
  await r.driver.followup("agent:main", "front", [message("m6", "sixth")]);
  assert.equal(r.sessions[0]!.sent.length, 4);
});

test("steer says whether the words were taken; interrupt on an idle lane does nothing", async () => {
  const r = await started();
  assert.equal(await r.driver.steer("agent:main", "front", "hey"), false);
  await r.driver.interrupt("agent:main", "front");
  assert.deepEqual(r.sessions[0]!.interrupted, []);
  await r.driver.send("agent:main", "front", [message("m1", "go")]);
  assert.equal(await r.driver.steer("agent:main", "front", "also this"), true);
  assert.deepEqual(r.sessions[0]!.steered, ["also this"]);
});

test("inject is held and goes in front of the next turn once", async () => {
  const r = await started();
  await r.driver.inject("agent:main", "front", { modules: [{ id: "user", version: "v1", content: "[USER v1] likes tea" }], text: "note: it rained" });
  await r.driver.send("agent:main", "front", [message("m1", "hi")]);
  assert.match(r.sessions[0]!.sent[0]!.text, /^\[USER v1\] likes tea\n\nnote: it rained\n\n\[ash\] /);
  r.sessions[0]!.end("ok");
  await r.driver.send("agent:main", "front", [message("m2", "again")]);
  assert.match(r.sessions[0]!.sent[1]!.text, /^\[ash\] /);
});

test("a refused send fails, leaves the lane free, and the session is reopened from its handle for the next one", async () => {
  const r = await started();
  r.sessions[0]!.failSend = true;
  await assert.rejects(r.driver.send("agent:main", "front", [message("m1", "hi")]), refused("failed"));
  assert.equal(r.sessions[0]!.closed, true);
  assert.equal(r.named("turn.started").length, 0);
  await r.driver.send("agent:main", "front", [message("m2", "hi")]);
  assert.equal(r.sessions.length, 3);
  assert.equal(r.sessions[2]!.options.seed, "handle-1", "reopened from the lane's handle");
  assert.equal(r.sessions[2]!.sent.length, 1);
});

test("session.new, set, reload and restart reopen the lane; a running lane refuses them, except restart, which ends its turn", async () => {
  const r = await started();
  await r.driver.send("agent:main", "front", [message("m1", "go")]);
  await assert.rejects(r.driver.session["new"]("agent:main", "front"), refused("conflict"));
  await assert.rejects(r.driver.session.set("agent:main", "front", "h"), refused("conflict"));
  await assert.rejects(r.driver.session.reload("agent:main", "front", { static: [] }), refused("conflict"));
  await assert.rejects(r.driver.session.compact("agent:main", "front"), refused("conflict"));
  await assert.rejects(r.driver.configure("agent:main", "front", { model: "x" }), refused("conflict"));

  const old = r.sessions[0]!;
  await r.driver.restart("agent:main", "front");
  assert.equal(old.closed, true);
  assert.deepEqual(r.named("turn.ended").map((e) => e.outcome), ["interrupted"]);
  assert.equal(r.sessions[2]!.options.seed, "handle-1", "restart resumes the same session");
  assert.equal(r.sessions[1]!.closed, false, "the other lane is untouched");

  const made = await r.driver.session["new"]("agent:main", "front");
  assert.equal(made.handle, "handle-4");
  assert.equal(r.sessions[3]!.options.seed, undefined);
  await r.driver.session.set("agent:main", "front", "chosen");
  assert.equal(r.driver.session.get("agent:main", "front"), "chosen");
  assert.equal(r.sessions[4]!.options.seed, "chosen");
  const reloaded = await r.driver.session.reload("agent:main", "front", { static: [{ id: "identity", version: "v2", content: "You are Ash v2." }] });
  assert.equal(r.sessions[5]!.options.system, "You are Ash v2.");
  assert.equal(reloaded.handle, r.driver.session.get("agent:main", "front"));
  await r.driver.restart("agent:main");
  assert.equal(r.sessions.length, 8, "restart without a key reopens every lane");
});

test("session.compact: Codex has a call for it, Claude Code is sent its /compact as a turn nobody hears of, WorkBuddy cannot", async () => {
  const codex = await started("codex");
  assert.deepEqual(await codex.driver.session.compact("agent:main", "front"), { compacted: true, detail: "fake" });
  assert.equal(codex.sessions[0]!.compacts, 1);

  const claude = await started("claude");
  const pending = claude.driver.session.compact("agent:main", "front");
  await eventually(() => claude.sessions[0]!.sent.length === 1, "the /compact turn");
  assert.equal(claude.sessions[0]!.sent[0]!.text, "/compact");
  await assert.rejects(claude.driver.send("agent:main", "front", [message("m1", "x")]), refused("conflict"));
  claude.sessions[0]!.say("compacting...");
  claude.sessions[0]!.end("ok");
  assert.deepEqual(await pending, { compacted: true });
  assert.deepEqual(claude.events.filter((e) => e.event !== "handle.updated"), [], "the owner's agent is told nothing of it");
  await claude.driver.send("agent:main", "front", [message("m1", "x")]);

  const buddy = await started("workbuddy");
  await assert.rejects(buddy.driver.session.compact("agent:main", "front"), refused("unavailable"));
});

test("configure sets model and effort and reads them back; Claude Code's effort needs the session reopened", async () => {
  const r = await started("codex");
  assert.deepEqual(await r.driver.configure("agent:main", undefined), { model: "m1", effort: "low" });
  assert.deepEqual(await r.driver.configure("agent:main", "front", { model: "m2" }), { model: "m2", effort: "low" });
  assert.deepEqual(r.sessions[0]!.selected, [["m2", "low"]]);
  assert.deepEqual(r.sessions[1]!.selected, [], "only the named lane");
  await assert.rejects(r.driver.configure("agent:main", undefined, { temperature: 1 }), refused("bad_request"));
  await assert.rejects(r.driver.configure("agent:main", undefined, { model: 5 }), refused("bad_request"));
  await assert.rejects(r.driver.plugins("agent:main", "list"), refused("unavailable"));

  const claude = await started("claude");
  await claude.driver.configure("agent:main", undefined, { model: "m3" });
  assert.deepEqual(claude.sessions.map((s) => s.selected), [[["m3", "low"]], [["m3", "low"]]]);
  await claude.driver.configure("agent:main", undefined, { effort: "high" });
  assert.equal(claude.sessions.length, 4, "both lanes were reopened");
  assert.deepEqual(claude.sessions.slice(2).map((s) => [s.options.effort, s.options.seed, s.options.model]), [["high", "handle-1", "m3"], ["high", "handle-2", "m3"]]);
});

test("a tool the runtime calls goes to the hub with the agent, lane and turn it belongs to; a stale turn is refused", async () => {
  const r = await started();
  await r.driver.send("agent:main", "front", [message("m1", "go")]);
  const turn = lastTurn(r, "front");
  assert.deepEqual(await r.sessions[0]!.options.onOutbound({ turn, requestId: "c1", tool: "agent_ask", args: { agent: "agent:x", text: "?" } }), { agents: [] });
  assert.deepEqual(r.outbound, [{ agent: "agent:main", key: "front", turn, tool: "agent_ask", args: { agent: "agent:x", text: "?" } }]);
  await assert.rejects(r.sessions[0]!.options.onOutbound({ turn: "old", requestId: "c2", tool: "agent_list", args: {} }), /no longer current/);
});

test("a runtime that dies ends its turn as an error, ends the agent once, and the hub's next start resumes the sessions", async () => {
  const r = await started();
  await r.driver.send("agent:main", "front", [message("m1", "go")]);
  r.sessions[0]!.end("unknown");
  r.sessions[0]!.emit({ type: "ended", reason: "runtime exited (7)" });
  r.sessions[1]!.emit({ type: "ended", reason: "runtime exited (7)" });
  assert.deepEqual(r.events.filter((e) => ["turn.ended", "ended"].includes(e.event)).map((e: any) => [e.event, e.outcome, e.error ?? e.reason]), [
    ["turn.ended", "error", "the runtime exited before the turn finished"], ["ended", undefined, "runtime exited (7)"],
  ]);
  assert.deepEqual(r.driver.status("agent:main"), { state: "failed", detail: "runtime exited (7)" });
  assert.ok(r.sessions.every((s) => s.closed), "the other lane is closed too");
  await assert.rejects(r.driver.send("agent:main", "front", [message("m2", "x")]), refused("offline"));
  assert.deepEqual(r.driver.handles("agent:main"), { front: "handle-1", back: "handle-2" });
  await r.driver.start("agent:main", spec({ sessions: r.driver.handles("agent:main") }));
  assert.deepEqual(r.sessions.slice(2).map((s) => s.options.seed), ["handle-1", "handle-2"]);
  assert.deepEqual(r.driver.status("agent:main"), { state: "running" });
  // restart brings a failed agent back from its handles too
  r.sessions[2]!.emit({ type: "ended", reason: "again" });
  await r.driver.restart("agent:main");
  assert.deepEqual(r.driver.status("agent:main"), { state: "running" });
  assert.equal(r.sessions.length, 6);
});

test("stop is silent: no ended, no turn.ended; the sessions are closed and the agent is gone", async () => {
  const r = await started();
  await r.driver.send("agent:main", "front", [message("m1", "go")]);
  const before = r.events.length;
  const session = r.sessions[0]!;
  await r.driver.stop("agent:main", "because");
  assert.ok(r.sessions.every((s) => s.closed));
  session.emit({ type: "turn_ended", turn: session.turn, outcome: "unknown", reply: "" });
  session.emit({ type: "ended", reason: "runtime closed" });
  assert.equal(r.events.length, before);
  assert.deepEqual(r.driver.status("agent:main"), { state: "exited", detail: "not started" });
  assert.deepEqual(r.driver.list(), []);
  await assert.rejects(r.driver.restart("agent:main"), refused("not_found"));
});

test("running reports the turns in progress, the way a hub that came back learns of them", async () => {
  const r = await started();
  assert.deepEqual(r.driver.running("agent:main"), []);
  await r.driver.send("agent:main", "front", [message("m1", "go")]);
  assert.deepEqual(r.driver.running("agent:main"), [{ key: "front", turn: lastTurn(r, "front"), ids: ["m1"] }]);
});

// ---------------------------------------------------------------------------------------------------------------------
// the real session classes against the fixture runtimes, one contract
// ---------------------------------------------------------------------------------------------------------------------

const fixture = fileURLToPath(new URL("./fixtures/agent-cli.mjs", import.meta.url));
const real = (kind: Kind, events: AgentEvent[], tools: unknown[]): ComputerDriver => createComputerDriver({
  kind, workdir: process.cwd(),
  info: () => ({ kind, models: [], abilities: abilitiesOf(kind) }),
  report: (e) => events.push(e),
  outbound: async (call) => { tools.push(call); return { agents: [] }; },
  open: (options) => {
    const command = { command: process.execPath, args: [fixture, kind] };
    return { codex: CodexSession, claude: ClaudeSession, workbuddy: WorkBuddySession }[kind].open(options, command);
  },
});

for (const kind of KINDS) {
  test(`${kind}: start, send, tools, steer, queued follow-up, interrupt, new session, resume, crash`, async (t) => {
    const events: AgentEvent[] = [], tools: any[] = [];
    const driver = real(kind, events, tools);
    t.after(() => driver.closeAll());
    const named = (name: string, key = "front") => events.filter((e) => e.event === name && (e as any).key === key) as any[];
    const cwd = await dir();
    await driver.start("agent:main", spec({ runtime: { kind }, native: { on: "device", cwd }, lanes: ["front"], modules: { static: [] } }));
    const handle = driver.session.get("agent:main", "front")!;
    assert.ok(handle, "the runtime's session handle is reported");
    assert.equal(named("handle.updated")[0].handle, handle);

    await driver.send("agent:main", "front", [message("m1", "hello")]);
    assert.equal(named("turn.started").length, 1);
    await eventually(() => tools.length === 1, "the tool call");
    assert.equal(tools[0].turn, named("turn.started")[0].turn);
    await assert.rejects(driver.send("agent:main", "front", [message("m2", "no")]), refused("conflict"));
    assert.ok(named("tool").some((e) => e.phase === "start"));

    await driver.followup("agent:main", "front", [message("m3", "after")]);
    assert.equal(await driver.steer("agent:main", "front", "finish"), true);
    await eventually(() => named("turn.ended").length === 1, "the first turn's end");
    assert.equal(named("turn.ended")[0].outcome, "completed");
    assert.ok(named("output").some((e) => e.text.includes("完整结果🙂")) || kind === "claude", "the reply is heard as speech");
    await eventually(() => named("turn.started").length === 2, "the queued turn");
    assert.deepEqual(named("turn.started")[1].ids, ["m3"]);

    await driver.interrupt("agent:main", "front");
    await eventually(() => named("turn.ended").length === 2, "the interrupted turn's end");
    assert.equal(named("turn.ended")[1].outcome, "interrupted");

    const made = await driver.session["new"]("agent:main", "front");
    assert.ok(made.handle && (kind === "workbuddy" || made.handle !== handle) );
    await driver.session.set("agent:main", "front", handle);
    assert.equal(driver.session.get("agent:main", "front"), handle);
    assert.deepEqual(await driver.configure("agent:main", "front", { model: "test-model" }), { model: "test-model" });

    await driver.send("agent:main", "front", [message("m4", "crash")]);
    await eventually(() => named("turn.ended").length === 3 && events.some((e) => e.event === "ended"), "the crash");
    assert.deepEqual([named("turn.ended")[2].outcome, driver.status("agent:main").state], ["error", "failed"]);
    await driver.start("agent:main", spec({ runtime: { kind }, native: { on: "device", cwd }, lanes: ["front"], sessions: driver.handles("agent:main"), modules: { static: [] } }));
    assert.equal(driver.status("agent:main").state, "running");
    await driver.send("agent:main", "front", [message("m5", "hi again")]);
    assert.equal(named("turn.started").length, 4);
  });
}
