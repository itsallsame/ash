/**
 * T17g: each agent is one state machine (stopped, starting, running, backoff, stopping) with one intent (`desired`), and every
 * step that waited on something checks that it is still the current attempt before it lands. These are the time orders that
 * the earlier rounds got wrong: a planned restart, a stop that comes while a failed start is cleaned up, a primary agent that
 * flaps, a start that outlives its timeout, a proxy that changes while a process starts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { HostNetwork } from "../../../../sdk/src/host";
import { RETRY_STEPS_MS, START_TIMEOUT_MS, STABLE_RUN_MS, TROUBLE_NOTICE_AT } from "../../../src/edges/agents/manager";
import { fixture, OWNER, settle, waitFor } from "./helpers";

const M = "agent:main";
type F = ReturnType<typeof fixture>;
const gate = () => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };
const reachable = (f: F) => f.registry.find(M, "say") !== null;
const waits = (f: F) => f.waiting().map((a) => a.ms).filter((ms) => RETRY_STEPS_MS.includes(ms));
const notices = (f: F) => f.router.says().map((s) => s.text);
const starts = (f: F) => f.driver().of("start").length;
const sends = (f: F, key: string) => f.driver().of("send").filter((c) => c[2] === key);
const pass = async (f: F) => { const [ms] = waits(f); assert.ok(ms !== undefined, "a retry is waiting"); assert.ok(f.fire(ms)); await settle(); return ms; };

test("a planned restart keeps the member while the old process stops: the owner's words are accepted, not refused as offline", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const g = gate();
  const stop = d.stop.bind(d);
  d.stop = async (agent, reason) => { await g.promise; return stop(agent, reason); };
  const restarting = f.agents.manager.restartAgent(M, "代理换了", true);
  await settle();
  assert.ok(reachable(f), "still a member while the old process is being stopped");
  assert.equal(f.agents.manager.reachable(M), true);
  assert.equal(f.agents.manager.stateOf(M), "starting");
  const reply = await f.call(M, "say", { text: "重启中说的话" }, OWNER);
  assert.deepEqual((reply as { data: unknown }).data, { accepted: true });
  g.open();
  await restarting;
  await waitFor(() => sends(f, "front").length === 1);
  assert.deepEqual((sends(f, "front")[0]![3] as { text: string }[]).map((m) => m.text), ["重启中说的话"]);
  assert.ok(reachable(f));
});

test("a stop for good that comes while a failed start is being cleaned up wins: no notice, no give-up, no retry", async () => {
  const f = fixture();
  f.agents.manager.driver("dsh");
  const d = f.driver();
  d.startFailures = 100;
  await f.agents.startAll();
  await settle();
  await pass(f);
  await pass(f); // three failures so far; the fourth would tell the owner
  const g = gate();
  const stop = d.stop.bind(d);
  d.stop = async (agent, reason) => { if (reason === "start failed") await g.promise; return stop(agent, reason); };
  assert.ok(f.fire(waits(f)[0]!));
  await waitFor(() => starts(f) === 4); // the fourth try fails; its process is being stopped (held)
  await settle();
  const stopping = f.agents.manager.stopAgent(M, "stopped", true);
  assert.equal(f.agents.manager.reachable(M), false, "off at once, before the old process is gone");
  g.open();
  await stopping;
  await settle();
  assert.equal(f.agents.manager.stateOf(M), "stopped");
  assert.equal(f.agents.manager.reachable(M), false);
  assert.deepEqual(waits(f), [], "no retry was set");
  assert.deepEqual(notices(f), [], "nothing was said");
  assert.equal(starts(f), 4);
});

test("a primary agent that flaps: told once that it cannot start, and told it is back only when it has stayed up or finished a round", async () => {
  const f = fixture();
  f.agents.manager.driver("dsh");
  const d = f.driver();
  d.startFailures = TROUBLE_NOTICE_AT;
  await f.agents.startAll();
  await settle();
  for (let i = 1; i <= TROUBLE_NOTICE_AT; i++) await pass(f);
  assert.equal(f.agents.manager.stateOf(M), "idle");
  assert.equal(notices(f).length, 1, "told once");
  assert.match(notices(f)[0]!, /Ash 暂时起不来/);
  // up, but it dies again and again before it is known to stay: nothing more is said, in either direction
  for (let i = 0; i < 3; i++) {
    d.die(M);
    await settle();
    if (waits(f).length) await pass(f);
    assert.equal(f.agents.manager.stateOf(M), "idle");
  }
  assert.equal(notices(f).length, 1, "no 「恢复了」 for a start that did not last");
  // a round that completes is the proof
  await f.call(M, "say", { text: "hi" }, OWNER);
  await waitFor(() => sends(f, "front").length === 1);
  d.finish(M, "front");
  await settle();
  assert.deepEqual(notices(f).slice(1), ["Ash 恢复了。"]);
  d.die(M);
  await settle();
  if (waits(f).length) await pass(f);
  assert.equal(notices(f).length, 2, "and once only");
});

test("a start that outlives its timeout is void: the retry is the only process, and the late answer of the old one changes nothing", async () => {
  const f = fixture();
  f.agents.manager.driver("dsh");
  const d = f.driver();
  const late = gate();
  d.startGate = late.promise;
  await f.agents.startAll();
  await waitFor(() => starts(f) === 1);
  assert.ok(f.fire(START_TIMEOUT_MS));
  await waitFor(() => d.of("stop").length === 1 && waits(f).length === 1);
  d.startGate = null;
  await pass(f); // the retry comes up
  assert.equal(f.agents.manager.stateOf(M), "idle");
  assert.equal(starts(f), 2);
  const lane = f.agents.manager.liveOf(M)!.lanes.get("front");
  late.open(); // the first start finally answers
  await settle();
  assert.equal(f.agents.manager.stateOf(M), "idle");
  assert.equal(f.agents.manager.liveOf(M)!.lanes.get("front"), lane, "the running attempt is still the second one");
  assert.equal(starts(f), 2);
  assert.deepEqual(waits(f), []);
});

test("a stop that comes while the process is starting voids the attempt: nothing is started later, whatever the driver answers", async () => {
  const f = fixture();
  f.agents.manager.driver("dsh");
  const d = f.driver();
  const g = gate();
  d.startGate = g.promise;
  await f.agents.startAll();
  await waitFor(() => starts(f) === 1);
  await f.agents.manager.stopAgent(M, "owner", true);
  g.open();
  await settle();
  assert.equal(f.agents.manager.stateOf(M), "stopped");
  assert.equal(d.of("stop").length, 1);
  assert.equal(f.agents.manager.reachable(M), false);
  assert.deepEqual(waits(f), []);
  assert.deepEqual(notices(f), []);
});

test("the proxy changed while the process was starting: once it is up it is started again with the new one, once", async () => {
  const OLD: HostNetwork = { proxy: { http: "http://10.0.2.2:7890" } };
  const f = fixture({ network: OLD });
  f.agents.manager.driver("dsh");
  const d = f.driver();
  const g = gate();
  d.startGate = g.promise;
  await f.agents.startAll();
  await waitFor(() => starts(f) === 1);
  await f.call(M, "say", { text: "代理换的时候说的" }, OWNER);
  await f.service("env.changed", { what: "network", network: { proxy: null }, online: true });
  await settle();
  assert.equal(d.of("stop").length, 0, "the attempt in flight is not cut: it is looked at when it is over");
  d.startGate = null;
  g.open();
  await waitFor(() => starts(f) === 2);
  await waitFor(() => f.agents.manager.stateOf(M) !== "starting" && sends(f, "front").length === 1);
  assert.deepEqual(d.of("stop").map((c) => c[1]), [M], "the process that began with the old proxy was stopped");
  await settle();
  assert.equal(starts(f), 2, "once");
  assert.equal(f.agents.manager.stateOf(M), "working");
  assert.deepEqual((sends(f, "front")[0]![3] as { text: string }[]).map((m) => m.text), ["代理换的时候说的"]);
  // the same proxy again: nothing
  await f.service("env.changed", { what: "network", network: { proxy: null }, online: true });
  await settle();
  assert.equal(starts(f), 2);
});

test("a process that dies before the attempt took it as up is a failure of that attempt", async () => {
  const f = fixture();
  f.agents.manager.driver("dsh");
  const d = f.driver();
  const g = gate();
  d.startGate = g.promise;
  await f.agents.startAll();
  await waitFor(() => starts(f) === 1);
  d.die(M); // dies after the runtime came up but before the start returned
  d.startGate = null;
  g.open();
  await settle();
  assert.equal(f.agents.manager.stateOf(M), "idle", "started again at once, as the first quick crash is");
  assert.equal(starts(f), 2);
});
