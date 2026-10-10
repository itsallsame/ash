/**
 * T17e: an agent that is meant to be on takes messages while its process starts or starts again. The router finds a
 * member through the registry (a missing one is `offline`), so the member stays in the registry from the start of the
 * start until a stop for good; the words wait in the inbox and go to the process when it is up.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { STABLE_RUN_MS } from "../../../src/edges/agents/manager";
import { fixture, OWNER, settle, waitFor, type FakeDriver } from "./helpers";

const M = "agent:main";
const sends = (d: FakeDriver, key?: string) => d.of("send").filter((c) => !key || c[2] === key);
const texts = (call: unknown[]) => (call[3] as { text: string }[]).map((m) => m.text);
const gate = () => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };
/** What the router does first: look the member up for the word. */
const dataOf = (r: unknown) => (r as { data: unknown }).data;
const reachable = (f: ReturnType<typeof fixture>) => f.registry.find(M, "say") !== null;

/** A fixture whose driver exists and whose next starts wait for the returned gate. */
function slowStart() {
  const f = fixture();
  f.agents.manager.driver("dsh");
  const g = gate();
  const d = f.drivers[0]!;
  d.startGate = g.promise;
  return { f, d, g };
}

test("the process is still starting (the hub just came up): the owner's words are accepted, and delivered when it is up", async () => {
  const { f, d, g } = slowStart();
  const starting = f.agents.startAll();
  assert.ok(reachable(f), "a member from the first moment, before anything is awaited");
  await waitFor(() => d.of("start").length === 1);
  assert.equal(f.agents.manager.stateOf(M), "starting");
  assert.equal(f.agents.manager.reachable(M), true);

  const reply = await f.call(M, "say", { text: "你在吗" }, OWNER);
  assert.deepEqual(dataOf(reply), { accepted: true });
  await settle();
  assert.equal(sends(d).length, 0, "nothing is handed to a process that is not up");
  assert.equal(f.agents.manager.inbox.pending(M, "front").length, 1);

  g.open();
  await starting;
  await waitFor(() => sends(d, "front").length === 1);
  assert.deepEqual(texts(sends(d, "front")[0]!), ["你在吗"]);
  assert.equal(f.agents.manager.stateOf(M), "working");
});

test("agents/list tells being there from the process running: available is the process, reachable is the member", async () => {
  const { f, d, g } = slowStart();
  const starting = f.agents.startAll();
  f.registry.add(f.agents.service);
  await waitFor(() => d.of("start").length === 1);
  const info = async () => (dataOf(await f.service("list", {})) as { agents: { id: string; state: string; available: boolean; reachable: boolean }[] }).agents.find((a) => a.id === M)!;
  assert.deepEqual([(await info()).state, (await info()).available, (await info()).reachable], ["starting", false, true]);
  g.open();
  await starting;
  assert.deepEqual([(await info()).state, (await info()).available, (await info()).reachable], ["idle", true, true]);
});

test("the process crashed and is being started again: the owner's words are accepted, and delivered to the new process", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const g = gate();
  d.startGate = g.promise;
  d.die(M);
  await waitFor(() => d.of("start").length === 2); // the restart is under way, held
  assert.ok(reachable(f), "the member did not go away with the process");
  assert.equal(f.agents.manager.stateOf(M), "starting");

  const reply = await f.call(M, "say", { text: "刚才断了吗" }, OWNER);
  assert.deepEqual(dataOf(reply), { accepted: true });
  await settle();
  assert.equal(sends(d).length, 0);

  g.open();
  await waitFor(() => sends(d, "front").length === 1);
  assert.deepEqual(texts(sends(d, "front")[0]!), ["刚才断了吗"]);
  assert.ok(reachable(f));
});

test("an ask to an agent that is starting waits for the new process and gets its answer", async () => {
  const { f, d, g } = slowStart();
  const starting = f.agents.startAll();
  await waitFor(() => d.of("start").length === 1);
  const asked = f.call(M, "ask", { text: "q?" }, { member: "agent:other", via: "agent", local: true });
  await settle();
  g.open();
  await starting;
  await waitFor(() => sends(d).length === 1);
  d.say(M, sends(d)[0]![2] as string, "a!");
  d.finish(M, sends(d)[0]![2] as string);
  assert.deepEqual(dataOf(await asked), { answer: "a!" });
});

test("an agent that is stopped for good is offline: off, removed, or given up on", async () => {
  const f = fixture();
  await f.start();
  await f.agents.manager.stopAgent(M, "owner", true);
  assert.ok(!reachable(f));
  assert.equal(f.agents.manager.reachable(M), false);
  assert.equal(f.agents.manager.stateOf(M), "stopped");
  await assert.rejects(() => f.call(M, "say", { text: "x" }), /does not speak say/);
  // the hub comes up again: an agent that is off is not a member
  const g = fixture({ from: f });
  await g.start();
  assert.ok(!reachable(g));
  // given up on after three quick crashes
  const h = fixture();
  await h.start();
  for (let i = 1; i <= 3; i++) { h.driver().die(M); if (i < 3) await waitFor(() => h.driver().of("start").length === i + 1); }
  await settle();
  assert.ok(!reachable(h));
  assert.equal(h.agents.manager.reachable(M), false);
  assert.equal(h.agents.manager.stateOf(M), "error");
});

test("a stop that comes while the process is starting leaves no member, and the start is not tried again", async () => {
  const { f, d, g } = slowStart();
  const starting = f.agents.startAll();
  await waitFor(() => d.of("start").length === 1);
  await f.agents.manager.stopAgent(M, "owner", true);
  assert.ok(!reachable(f));
  g.open();
  await starting;
  await settle();
  assert.ok(!reachable(f));
  assert.equal(d.of("start").length, 1);
  assert.equal(f.agents.manager.stateOf(M), "stopped");
});

test("the failure count: a process that stayed up, or finished a round, starts the count again; only quick crashes in a row add up", async () => {
  // many crashes, each after a stable run: never given up
  const a = fixture();
  await a.start();
  for (let i = 1; i <= 6; i++) {
    a.clock.t += STABLE_RUN_MS;
    a.driver().die(M);
    await waitFor(() => a.driver().of("start").length === i + 1);
  }
  assert.ok(reachable(a));

  // many crashes close together, but each process finished a round first: never given up
  const b = fixture();
  await b.start();
  for (let i = 1; i <= 6; i++) {
    b.driver().die(M);
    await waitFor(() => b.driver().of("start").length === i + 1);
    await b.call(M, "say", { text: `round ${i}` }, OWNER);
    await waitFor(() => sends(b.driver(), "front").length === i);
    b.driver().finish(M, "front");
    await settle();
  }
  assert.ok(reachable(b));
  assert.equal(b.agents.manager.stateOf(M), "idle");

  // a turn that failed does not count as a round done: two crashes, a failed turn, then the third crash gives up
  const c = fixture();
  await c.start();
  c.driver().die(M);
  await waitFor(() => c.driver().of("start").length === 2);
  await c.call(M, "wake", { reason: "r" }, { member: "service:pulse", via: "service", local: true });
  await waitFor(() => sends(c.driver(), "back").length === 1);
  c.driver().finish(M, "back", "error");
  c.driver().die(M);
  await waitFor(() => c.driver().of("start").length === 3);
  c.driver().die(M);
  await settle();
  assert.equal(c.driver().of("start").length, 3);
  assert.equal(c.agents.manager.stateOf(M), "error");

  // a completed round between crashes clears what came before: the same sequence with a good turn does not give up
  const e = fixture();
  await e.start();
  e.driver().die(M);
  await waitFor(() => e.driver().of("start").length === 2);
  e.driver().die(M);
  await waitFor(() => e.driver().of("start").length === 3);
  await e.call(M, "say", { text: "hi" }, OWNER);
  await waitFor(() => sends(e.driver(), "front").length === 1);
  e.driver().finish(M, "front");
  e.driver().die(M);
  await waitFor(() => e.driver().of("start").length === 4);
  e.driver().die(M);
  await waitFor(() => e.driver().of("start").length === 5);
  assert.ok(reachable(e));
});
