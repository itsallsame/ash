/**
 * T17f: a start that fails is tried again later, not at once. The waits are 2 s, 5 s, 15 s, 60 s and then five minutes; the
 * agent stays a member (the inbox takes messages) all the while. The primary agent is never given up on and the owner hears
 * about it once; any other agent is given up on after MAX_FAILURES in a row. A restart, or the host saying the network is
 * back, ends the wait. The timers are the fixture's: a wait ends when the test says so.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FAILURES, RETRY_STEPS_MS, START_TIMEOUT_MS, STABLE_RUN_MS, TROUBLE_NOTICE_AT } from "../../../src/edges/agents/manager";
import { fixture, OWNER, settle, waitFor } from "./helpers";

const M = "agent:main";
const B = "agent:b";
const STEPS = RETRY_STEPS_MS;
const starts = (f: ReturnType<typeof fixture>, agent = M) => f.driver().of("start").filter((c) => c[1] === agent).length;
const sends = (f: ReturnType<typeof fixture>, key: string, agent = M) => f.driver().of("send").filter((c) => c[1] === agent && c[2] === key);
const texts = (call: unknown[]) => (call[3] as { text: string }[]).map((m) => m.text);
/** The retry timers waiting now: the ones with one of the step lengths (the start timeout and the like are not these). */
const waits = (f: ReturnType<typeof fixture>) => f.waiting().map((a) => a.ms).filter((ms) => STEPS.includes(ms));
const reachable = (f: ReturnType<typeof fixture>, id = M) => f.registry.find(id, "say") !== null;
const notices = (f: ReturnType<typeof fixture>) => f.router.says().map((s) => s.text);
const decl = (id: string) => ({ id, name: id.slice(6), summary: "a helper agent", brief: "help" });

/** A fixture whose driver exists and whose next `n` starts fail. */
function failing(n: number) {
  const f = fixture();
  f.agents.manager.driver("dsh");
  f.driver().startFailures = n;
  return f;
}
/** Let the wait that is on run out, and say how long it was. */
async function pass(f: ReturnType<typeof fixture>): Promise<number> {
  const [ms] = waits(f);
  assert.ok(ms !== undefined, "a retry is waiting");
  assert.ok(f.fire(ms));
  await settle();
  return ms;
}

test("a start that fails is not tried again at once: it waits 2 s, then 5 s, then 15 s; the owner's words wait in the inbox and arrive when it is up", async () => {
  const f = failing(3);
  await f.agents.startAll();
  await settle();
  assert.equal(starts(f), 1);
  assert.deepEqual(waits(f), [STEPS[0]]);
  assert.equal(f.agents.manager.stateOf(M), "starting");
  assert.ok(reachable(f), "a member while it waits for the next try");
  assert.equal(f.agents.manager.reachable(M), true);

  const reply = await f.call(M, "say", { text: "你在吗" }, OWNER);
  assert.deepEqual((reply as { data: unknown }).data, { accepted: true });
  await settle();
  assert.equal(sends(f, "front").length, 0);
  await settle();
  assert.equal(starts(f), 1, "nothing happens before the time");

  assert.equal(await pass(f), STEPS[0]);
  assert.equal(starts(f), 2);
  assert.deepEqual(waits(f), [STEPS[1]]);
  assert.equal(await pass(f), STEPS[1]);
  assert.equal(starts(f), 3);
  assert.deepEqual(waits(f), [STEPS[2]]);
  assert.ok(reachable(f));
  assert.equal(await pass(f), STEPS[2]);
  await waitFor(() => sends(f, "front").length === 1);
  assert.equal(starts(f), 4);
  assert.deepEqual(texts(sends(f, "front")[0]!), ["你在吗"]);
  assert.equal(f.agents.manager.stateOf(M), "working");
  assert.deepEqual(waits(f), []);
  assert.deepEqual(notices(f), [], "a short trouble is not worth a word to the owner");
});

test("the primary agent is never given up on: it keeps trying on the steps, the owner is told once, and once more when it is back", async () => {
  const failures = MAX_FAILURES + 3;
  const f = failing(failures);
  await f.agents.startAll();
  await settle();
  const waited: number[] = [];
  for (let i = 1; i < failures; i++) {
    assert.equal(starts(f), i);
    assert.ok(reachable(f));
    assert.equal(f.agents.manager.stateOf(M), "starting");
    waited.push(await pass(f));
  }
  assert.deepEqual(waited, [2000, 5000, 15_000, 60_000, 300_000, 300_000, 300_000]);
  assert.equal(starts(f), failures);
  assert.deepEqual(waits(f), [300_000], "still waiting for the next try");
  const trouble = notices(f);
  assert.equal(trouble.length, 1, "told once, not at every try");
  assert.match(trouble[0]!, /Ash 暂时起不来/);
  assert.equal((f.router.to("person:owner", "say")[0]!.msg.body as { kind: string }).kind, "heads_up");
  assert.ok(starts(f) >= TROUBLE_NOTICE_AT);

  await pass(f); // the start works now
  assert.equal(f.agents.manager.stateOf(M), "idle");
  assert.deepEqual(notices(f), [trouble[0]], "it is up, but not yet known to stay up: not told it is back");
  assert.deepEqual(waits(f), [STABLE_RUN_MS]);
  assert.ok(f.fire(STABLE_RUN_MS));
  assert.deepEqual(waits(f), []);
  assert.deepEqual(notices(f), [trouble[0], "Ash 恢复了。"]);
  // dying again later says nothing more: the owner has been told it is back
  f.driver().die(M);
  await settle();
  assert.equal(notices(f).length, 2);
  assert.ok(reachable(f));
});

test("an agent that is not the primary one is given up on after MAX_FAILURES, having waited out the steps; it is then offline and the owner is told", async () => {
  const f = fixture();
  await f.start();
  f.driver().startFailures = 99;
  await f.service("declare", decl(B));
  assert.equal(starts(f, B), 1);
  assert.ok(reachable(f, B));
  const waited: number[] = [];
  for (let i = 1; i < MAX_FAILURES; i++) waited.push(await pass(f));
  assert.deepEqual(waited, STEPS.slice(0, MAX_FAILURES - 1));
  assert.equal(starts(f, B), MAX_FAILURES);
  assert.deepEqual(waits(f), []);
  assert.ok(!reachable(f, B), "no longer a member");
  assert.equal(f.agents.manager.stateOf(B), "error");
  assert.equal(f.agents.manager.reachable(B), false);
  assert.match(f.router.says().at(-1)!.text, new RegExp(`${B} 起不来了：连着失败了${MAX_FAILURES}次`));
  // the primary agent was up all the while
  assert.equal(f.agents.manager.stateOf(M), "idle");
  // the owner can start it again by hand
  f.driver().startFailures = 0;
  await f.service("restart", { agent: B });
  assert.equal(f.agents.manager.stateOf(B), "idle");
  assert.ok(reachable(f, B));
});

test("a restart by hand ends the wait: the new try is made at once and the old timer is dropped", async () => {
  const f = failing(2);
  await f.agents.startAll();
  await settle();
  assert.deepEqual(waits(f), [2000]);
  await f.call(M, "say", { text: "还在吗" }, OWNER);
  f.driver().startFailures = 0;
  await f.service("restart", { agent: M });
  assert.equal(starts(f), 2);
  assert.deepEqual(waits(f), [], "the wait is gone: it will not start a second process");
  await waitFor(() => sends(f, "front").length === 1);
  assert.deepEqual(texts(sends(f, "front")[0]!), ["还在吗"]);
  f.driver().finish(M, "front");
  assert.ok(f.fire(5000), "(the usage pull a turn schedules is a 5 s timer too: out of the way)");
  // a restart that fails starts the steps over from the first
  f.driver().startFailures = 2;
  await f.service("restart", { agent: M });
  assert.deepEqual(waits(f), [2000]);
  assert.equal(await pass(f), 2000);
  assert.deepEqual(waits(f), [5000]);
  f.driver().startFailures = 0;
  await f.service("restart", { agent: M });
  assert.equal(f.agents.manager.stateOf(M), "idle");
  assert.deepEqual(waits(f), []);
});

test("the host saying the network is back ends the wait; going offline does not; a stop for good drops it", async () => {
  const f = failing(2);
  await f.agents.startAll();
  await settle();
  f.registry.add(f.agents.service);
  assert.deepEqual(waits(f), [2000]);
  await f.service("env.changed", { what: "power", saver: true });
  await f.service("env.changed", { what: "network", network: { proxy: null }, online: false });
  await settle();
  assert.equal(starts(f), 1);
  assert.deepEqual(waits(f), [2000]);
  await f.service("env.changed", { what: "network", network: { proxy: null }, online: true });
  await waitFor(() => starts(f) === 2);
  assert.deepEqual(waits(f), [5000], "that try failed too: the count went on, and so did the steps");
  await f.service("env.changed", { what: "network", network: { proxy: null }, online: true });
  await waitFor(() => starts(f) === 3);
  await waitFor(() => f.agents.manager.stateOf(M) === "idle");
  assert.deepEqual(waits(f), []);

  const g = failing(5);
  await g.agents.startAll();
  await settle();
  assert.deepEqual(waits(g), [2000]);
  await g.agents.manager.stopAgent(M, "owner", true);
  assert.deepEqual(waits(g), []);
  assert.ok(!reachable(g));
  assert.equal(g.agents.manager.stateOf(M), "stopped");
  assert.equal(starts(g), 1);
});

test("a process that dies: the first time it is started again at once, and the next ones wait on the steps; the primary agent is not given up on", async () => {
  const f = fixture();
  await f.start();
  f.driver().die(M);
  await waitFor(() => starts(f) === 2);
  assert.deepEqual(waits(f), []);
  f.driver().die(M);
  await settle();
  assert.equal(starts(f), 2, "not started again at once");
  assert.deepEqual(waits(f), [2000]);
  assert.ok(reachable(f));
  assert.equal(f.agents.manager.stateOf(M), "starting");
  assert.equal(await pass(f), 2000);
  assert.equal(starts(f), 3);
  f.driver().die(M);
  await settle();
  assert.equal(await pass(f), 5000);
  f.driver().die(M);
  await settle();
  assert.equal(await pass(f), 15_000);
  f.driver().die(M);
  await settle();
  assert.equal(await pass(f), 60_000);
  assert.equal(starts(f), 6);
  assert.ok(reachable(f));
  assert.equal(f.agents.manager.stateOf(M), "idle");
  // dying right away again and again is trouble whether the start failed or the process ran a moment: told once, at TROUBLE_NOTICE_AT
  assert.equal(notices(f).length, 1);
  assert.match(notices(f)[0]!, /Ash 暂时起不来/);
  assert.ok(f.fire(STABLE_RUN_MS));
  assert.equal(notices(f).at(-1), "Ash 恢复了。");

  // another agent is given up on after MAX_FAILURES crashes in a row
  await f.service("declare", decl(B));
  for (let i = 1; i < MAX_FAILURES; i++) {
    f.driver().die(B);
    await waitFor(() => waits(f).length > 0 || starts(f, B) === i + 1);
    if (waits(f).length) await pass(f);
  }
  f.driver().die(B);
  await settle();
  assert.equal(f.agents.manager.stateOf(B), "error");
  assert.ok(!reachable(f, B));
});

test("a start that hangs counts as failed after START_TIMEOUT_MS and is tried again", async () => {
  const f = fixture();
  f.agents.manager.driver("dsh");
  f.driver().startGate = new Promise<void>(() => {}); // the runtime never answers
  const starting = f.agents.startAll();
  await waitFor(() => starts(f) === 1);
  assert.deepEqual(f.waiting().map((a) => a.ms), [START_TIMEOUT_MS]);
  f.driver().startGate = null;
  assert.ok(f.fire(START_TIMEOUT_MS));
  await starting;
  await waitFor(() => f.driver().of("stop").length === 1);
  await settle();
  assert.equal(f.driver().of("stop").length, 1, "the hung process is stopped");
  assert.deepEqual(waits(f), [2000]);
  assert.ok(reachable(f));
  await pass(f);
  assert.equal(f.agents.manager.stateOf(M), "idle");
});
