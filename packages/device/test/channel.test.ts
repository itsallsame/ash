import test from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../sdk/src/driver";
import type { AgentFrame } from "../../sdk/src/link";
import { frameError } from "../../sdk/src/link";
import { AgentChannel } from "../src/agents/channel";
import { createComputerDriver } from "../src/agents/driver";
import { abilitiesOf, type Kind } from "../src/agents/info";
import { eventually } from "./kernel";
import { FakeSession, WORK } from "./fake-session";

type Frame = Record<string, any>;

/** A channel over drivers of fake runtimes, and the frames it sends. */
function channel(o: { graceMs?: number; offers?: (kind: Kind) => boolean; kinds?: Kind[] } = {}) {
  const sent: Frame[] = [];
  const sessions: FakeSession[] = [];
  let connected = true;
  const make = (kind: Kind) => (report: (e: AgentEvent) => void, outbound: Parameters<typeof createComputerDriver>[0]["outbound"]) => createComputerDriver({
    kind, workdir: WORK, startWaitMs: 50, report, outbound,
    info: () => ({ kind, models: [], abilities: abilitiesOf(kind) }),
    open: async (options) => { const s = new FakeSession(options, options.seed ?? `h${sessions.length + 1}`); sessions.push(s); options.onEvent({ type: "seed_updated", seed: s.seed }); return s; },
  });
  const chan = new AgentChannel({
    drivers: Object.fromEntries((o.kinds ?? ["codex", "claude"]).map((k) => [k, make(k)])),
    send: (frame) => { if (!connected) return false; sent.push(frame as Frame); return true; },
    graceMs: o.graceMs, offers: o.offers,
  });
  chan.opened();
  const call = async (op: string, fields: Frame = {}): Promise<Frame> => {
    const id = `i${sent.length}-${Math.random()}`;
    const before = sent.length;
    await chan.handle({ t: "agent", id, op, ...fields } as AgentFrame);
    const reply = sent.slice(before).find((f) => f.id === id);
    assert.ok(reply, `${op} was answered`);
    return reply;
  };
  return { chan, sent, sessions, call, disconnect: () => { connected = false; chan.closed(); }, reconnect: () => { connected = true; chan.opened(); } };
}
const spec = (kind: Kind = "codex", over: Frame = {}) => ({
  runtime: { kind }, tools: { mcp_url: "x", tokens: { front: "x" }, allowed: [] }, modules: { static: [] }, lanes: ["front"], sessions: {}, ...over,
});
const msg = (id: string, text = "hi") => ({ id, from: "person:owner", word: "say", text, lane: "front", at: 1 });
const events = (sent: Frame[], name?: string) => sent.filter((f) => typeof f.event === "string" && (!name || f.event === name));

test("every frame the channel sends is a valid agent frame of the link protocol", async () => {
  const { call, sent, sessions } = channel();
  await call("agent.start", { agent: "agent:main", spec: spec() });
  await call("send", { agent: "agent:main", key: "front", messages: [msg("m1")] });
  sessions[0]!.say("hi");
  sessions[0]!.end("ok");
  await call("session.get", { agent: "agent:main", key: "front" });
  await call("steer", { agent: "agent:main", key: "nope", text: "x" });
  assert.ok(sent.length > 8);
  for (const frame of sent) assert.equal(frameError("agent", frame), null, JSON.stringify(frame));
});

test("an operation's answer is op_result with ok and result, or ok:false and a coded error; the fields are the driver method's arguments", async () => {
  const { call, sessions } = channel();
  const started = await call("agent.start", { agent: "agent:main", spec: spec() });
  assert.deepEqual([started.t, started.op_result, started.ok], ["agent", "agent.start", true]);
  assert.deepEqual(started.result, { sessions: { front: "h1" }, attached: false });
  const sent = await call("send", { agent: "agent:main", key: "front", messages: [msg("m1")] });
  assert.deepEqual([sent.op_result, sent.ok, sent.result], ["send", true, {}]);
  assert.equal(sessions[0]!.sent.length, 1);
  const busy = await call("send", { agent: "agent:main", key: "front", messages: [msg("m2")] });
  assert.deepEqual([busy.ok, busy.error.code], [false, "conflict"]);
  assert.match(busy.error.message, /busy/);
  assert.deepEqual((await call("steer", { agent: "agent:main", key: "front", text: "now" })).result, { accepted: true });
  assert.deepEqual((await call("session.get", { agent: "agent:main", key: "front" })).result, { handle: "h1" });
  assert.deepEqual((await call("session.get", { agent: "agent:main", key: "other" })).result, { handle: null });
  assert.equal((await call("configure", { agent: "agent:main", config: { model: "m" } })).error.code, "conflict", "a running lane refuses it");
  assert.deepEqual((await call("config.get", { agent: "agent:main" })).result, {});
  assert.equal((await call("plugins", { agent: "agent:main", action: "list" })).error.code, "unavailable");
});

test("bad frames are bad_request, not a crash: a missing agent or key, malformed messages, an unknown operation", async () => {
  const { call } = channel();
  await call("agent.start", { agent: "agent:main", spec: spec() });
  const code = async (op: string, fields: Frame) => (await call(op, fields)).error?.code;
  assert.equal(await code("send", { key: "front", messages: [msg("m1")] }), "bad_request");
  assert.equal(await code("send", { agent: "agent:main", messages: [msg("m1")] }), "bad_request");
  assert.equal(await code("send", { agent: "agent:main", key: "front", messages: [{ id: 1 }] }), "bad_request");
  assert.equal(await code("send", { agent: "agent:main", key: "front", messages: "hi" }), "bad_request");
  assert.equal(await code("steer", { agent: "agent:main", key: "front" }), "bad_request");
  assert.equal(await code("session.set", { agent: "agent:main", key: "front" }), "bad_request");
  assert.equal(await code("session.reload", { agent: "agent:main", key: "front" }), "bad_request");
  assert.equal(await code("configure", { agent: "agent:main", config: "fast" }), "bad_request");
  assert.equal(await code("inject", { agent: "agent:main", key: "front", modules: "x" }), "bad_request");
  assert.equal(await code("agent.start", { agent: "agent:x", spec: { ...spec(), lanes: [] } }), "bad_request");
  assert.equal(await code("agent.start", { agent: "agent:x" }), "unavailable");
  assert.equal(await code("agent.explode", { agent: "agent:main" }), "bad_request");
  assert.equal(await code("interrupt", { agent: "agent:ghost", key: "front" }), "not_found");
});

test("a runtime this computer does not have is unavailable, and the agent is reported failed; one agent has one runtime", async () => {
  const { call, sent } = channel({ offers: (kind) => kind === "codex" });
  const refused = await call("agent.start", { agent: "agent:main", spec: spec("claude") });
  assert.equal(refused.error.code, "unavailable");
  assert.deepEqual(events(sent, "agent.status").map((e) => [e.agent, e.state]), [["agent:main", "failed"]]);
  await call("agent.start", { agent: "agent:main", spec: spec("codex") });
  const other = channel({ kinds: ["codex", "claude"] });
  await other.call("agent.start", { agent: "agent:main", spec: spec("codex") });
  assert.equal((await other.call("agent.start", { agent: "agent:main", spec: spec("claude") })).error.code, "conflict");
});

test("agent.status follows start and stop; a runtime that dies is reported as ended and as failed", async () => {
  const { call, sent, sessions } = channel();
  await call("agent.start", { agent: "agent:main", spec: spec() });
  assert.deepEqual(events(sent, "agent.status").map((e) => e.state), ["starting", "running"]);
  sessions[0]!.emit({ type: "ended", reason: "runtime exited (7)" });
  assert.deepEqual(events(sent).filter((e) => e.event === "ended" || e.state === "failed").map((e) => [e.event, e.reason ?? e.detail]), [["ended", "runtime exited (7)"], ["agent.status", "runtime exited (7)"]]);
  assert.equal((await call("agent.list")).result.agents[0].state, "failed");
  await call("agent.start", { agent: "agent:main", spec: spec() });
  await call("agent.stop", { agent: "agent:main", reason: "done" });
  assert.deepEqual(events(sent, "agent.status").slice(-3).map((e) => e.state), ["starting", "running", "exited"]);
  assert.deepEqual((await call("agent.list")).result.agents, []);
});

test("a tool call goes out as an outbound frame and the answer comes back by its id; a refusal, a lost connection and the end of the turn all end it", async () => {
  const { chan, call, sent, sessions, disconnect } = channel();
  await call("agent.start", { agent: "agent:main", spec: spec() });
  await call("send", { agent: "agent:main", key: "front", messages: [msg("m1")] });
  const turn = events(sent, "turn.started")[0]!.turn;
  const options = sessions[0]!.options;

  const answered = options.onOutbound({ turn, requestId: "r", tool: "agent_ask", args: { agent: "agent:b", text: "?" } });
  const out = sent.find((f) => typeof f.outbound === "string")!;
  assert.deepEqual([out.outbound, out.agent, out.key, out.turn, out.args], ["agent_ask", "agent:main", "front", turn, { agent: "agent:b", text: "?" }]);
  assert.equal(frameError("agent", out), null);
  await chan.handle({ t: "agent", id: out.id, outbound_result: "agent_ask", ok: true, result: { answer: "yes" } } as AgentFrame);
  assert.deepEqual(await answered, { answer: "yes" });

  const refused = options.onOutbound({ turn, requestId: "r2", tool: "agent_tell", args: { agent: "agent:b", text: "!" } });
  const refusedOut = sent.filter((f) => typeof f.outbound === "string")[1]!;
  await chan.handle({ t: "agent", id: refusedOut.id, outbound_result: "agent_tell", ok: false, error: { code: "forbidden", message: "not allowed" } } as AgentFrame);
  await assert.rejects(refused, /not allowed/);

  const cut = options.onOutbound({ turn, requestId: "r3", tool: "agent_list", args: {} });
  disconnect();
  await assert.rejects(cut, /connection to Ash was lost/);
  await assert.rejects(options.onOutbound({ turn, requestId: "r4", tool: "agent_list", args: {} }), /unavailable/);
});

test("a turn that ends cancels its tool calls still waiting", async () => {
  const { call, sent, sessions } = channel();
  await call("agent.start", { agent: "agent:main", spec: spec() });
  await call("send", { agent: "agent:main", key: "front", messages: [msg("m1")] });
  const turn = events(sent, "turn.started")[0]!.turn;
  const waiting = sessions[0]!.options.onOutbound({ turn, requestId: "r", tool: "agent_list", args: {} });
  sessions[0]!.end("ok");
  await assert.rejects(waiting, /turn ended/);
});

test("while the hub is away the agent's events are kept in order and sent when the channel is open again", async () => {
  const { call, sent, sessions, disconnect, reconnect } = channel();
  await call("agent.start", { agent: "agent:main", spec: spec() });
  await call("send", { agent: "agent:main", key: "front", messages: [msg("m1")] });
  disconnect();
  const before = sent.length;
  sessions[0]!.say("one");
  sessions[0]!.say("two");
  sessions[0]!.end("ok");
  assert.equal(sent.length, before, "nothing is sent to a hub that is not there");
  reconnect();
  assert.deepEqual(sent.slice(before).map((f) => [f.event, f.text ?? f.outcome]), [["output", "one"], ["output", "two"], ["turn.ended", "completed"]]);
});

test("the backlog is bounded", async () => {
  const { call, sent, sessions, disconnect, reconnect } = channel();
  await call("agent.start", { agent: "agent:main", spec: spec() });
  await call("send", { agent: "agent:main", key: "front", messages: [msg("m1")] });
  disconnect();
  const before = sent.length;
  for (let i = 0; i < 2500; i++) sessions[0]!.say(`line ${i}`);
  reconnect();
  const got = sent.slice(before);
  assert.equal(got.length, 2000);
  assert.equal(got.at(-1)!.text, "line 2499");
});

test("a start for an agent that kept running attaches and tells the hub where every lane is", async () => {
  const { call, sent, sessions, disconnect, reconnect } = channel();
  await call("agent.start", { agent: "agent:main", spec: spec("codex", { lanes: ["front", "back"] }) });
  await call("send", { agent: "agent:main", key: "front", messages: [msg("m1")] });
  const turn = events(sent, "turn.started")[0]!.turn;
  disconnect();
  reconnect();
  const before = sent.length;
  const attached = await call("agent.start", { agent: "agent:main", spec: spec("codex", { lanes: ["front", "back"] }) });
  assert.deepEqual(attached.result, { sessions: { front: "h1", back: "h2" }, attached: true });
  assert.equal(sessions.length, 2, "no session was opened again");
  const told = sent.slice(before).filter((f) => f.event === "handle.updated" || f.event === "turn.started").map((f) => [f.event, f.key, f.handle ?? f.turn]);
  assert.deepEqual(told, [["handle.updated", "front", "h1"], ["handle.updated", "back", "h2"], ["turn.started", "front", turn]]);
});

test("agents are stopped when the hub stays away longer than the grace; a hub that returns in time cancels it", async () => {
  const { chan, call, disconnect, reconnect } = channel({ graceMs: 60 });
  await call("agent.start", { agent: "agent:main", spec: spec() });
  disconnect();
  reconnect();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(chan.list().length, 1, "it came back in time");
  disconnect();
  await eventually(() => chan.list().length === 0, "the agents being stopped");
  await chan.close();
});

test("busy is true while a turn runs", async () => {
  const { chan, call, sessions } = channel();
  await call("agent.start", { agent: "agent:main", spec: spec() });
  assert.equal(chan.busy, false);
  await call("send", { agent: "agent:main", key: "front", messages: [msg("m1")] });
  assert.equal(chan.busy, true);
  sessions[0]!.end("ok");
  assert.equal(chan.busy, false);
});
