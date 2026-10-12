/**
 * The health meter (`service:health`) on a real hub: the busy loop of 10-12 (a page and the hub reading each other without
 * end while nobody asked for anything) must show up as an event that names the word, within 40 seconds of the first idle
 * bucket, and an idle hub that is only polled now and then must not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dataOf, startScenario, type Scenario } from "./harness";
import { eventually } from "../fixtures/wait";

type Owner = Awaited<ReturnType<Scenario["human"]>>;

/** Moves the hub's clock by `seconds` and waits until the meter has closed the time (it ticks in real time, the clock is ours). */
function pacer(s: Scenario, owner: Owner) {
  let moved = 0;
  return async (seconds: number, each: () => Promise<unknown> = async () => {}) => {
    await each();
    s.advance(seconds * 1000);
    moved += seconds;
    await eventually(async () => dataOf(await owner.call("service:health", "status", { window_s: 3600 })).window_s >= moved - 1, "the meter closing the time");
  };
}
const events = async (owner: Owner): Promise<any[]> => dataOf(await owner.call("service:health", "recent", {})).events;

test("the busy loop is caught: the event names the word; the meter does not count itself", async (t) => {
  const s = await startScenario(t, { fakeNow: true });
  const owner = await s.human();
  const step = pacer(s, owner);

  await step(70); // a quiet minute after the start: idle
  const spin = async () => { for (let i = 0; i < 20; i++) await owner.call("service:history", "current"); };
  let rounds = 0;
  let breach: any;
  while (!breach && rounds < 6) {
    await step(10, spin);
    rounds += 1;
    breach = (await events(owner)).find((e) => e.id === "idle.msg_key_rate");
  }

  assert.ok(breach, "an event was written");
  assert.ok(rounds <= 4, `within 30 seconds of the spin (took ${rounds} rounds of 10)`);
  assert.equal(breach.top[0].key, "service:history/current:person");
  const status = dataOf(await owner.call("service:health", "status"));
  assert.equal(status.invariants.find((i: any) => i.id === "idle.msg_key_rate").ok, false);
  assert.ok(!status.top.some((k: any) => k.key.includes("service:health")), "the meter does not count itself");
});

test("an idle hub that is polled now and then writes no event", async (t) => {
  const s = await startScenario(t, { fakeNow: true });
  const owner = await s.human();
  const step = pacer(s, owner);

  await step(70);
  for (let i = 0; i < 10; i++) await step(30, () => owner.call("service:history", "current"));

  // (The ledger growth is left out: a clock that jumps makes every timer due at once, which writes rows a real minute would not.)
  const found = (await events(owner)).filter((e) => e.type === "breach" && /^(idle\.msg|errors|link)/.test(e.id));
  assert.deepEqual(found, []);
});
