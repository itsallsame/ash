/**
 * REGRESSION-0.3 §3 (唤醒: S097, S098, S100) and HUB-MODULES §7: a hand's `sense.*` events go to `service:senses` (the
 * archive, nothing else), and the built-in organ `app:sense-rules` listens for them and wakes the primary agent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MAIN, bodyOf, quiet, startScenario, dataOf } from "./harness";
import { eventually } from "../fixtures/wait";

test("S097: the owner enters a geofence: the phone says so, the organ wakes agent:main on its back lane", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  await s.human();

  await phone.emit("sense.geofence", { name: "home", transition: "enter", ts: Date.now() });

  const { message } = await s.driver.delivery((m) => m.word === "wake", "the wake from the sense rules");
  assert.equal(message.lane, "back");
  assert.ok(JSON.stringify(message.body).includes("home"), "the wake carries the place");
  const turn = await s.driver.turn((r) => r.agent === MAIN && r.messages.some((m) => m.word === "wake"), "a turn for the wake");
  assert.equal(turn.key, "back");
});

test("S100: a health source goes stale: the organ wakes the agent with the source named", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();

  await phone.emit("sense.source", { source: "gadgetbridge", state: "stale", ts: Date.now(), stale_hours: 6, summary: "手表已经 6 小时没有新数据" });

  const { message } = await s.driver.delivery((m) => m.word === "wake", "the wake for a stale source");
  assert.ok(JSON.stringify(message.body).includes("gadgetbridge"));
});

test("S098: an important calendar event is about to start: the organ wakes the agent", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  const start = Date.now() + 15 * 60_000;

  await phone.emit("sense.calendar", { kind: "upcoming", event: { id: "ev1", title: "和投资人开会", start, end: start + 3_600_000, important: true } });

  const { message } = await s.driver.delivery((m) => m.word === "wake", "the wake for the event");
  assert.ok(JSON.stringify(message.body).includes("和投资人开会"));
});

test("S102, S103: a reading that no rule cares about wakes nobody, but it is archived in service:senses", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  const owner = await s.human();

  await phone.emit("sense.battery", { level: 73 });

  const archived = await eventually(async () => {
    const reply = await owner.call("service:senses", "query", { kind: "battery" });
    return reply.ok && JSON.stringify(dataOf(reply)).includes("73") ? reply : null;
  }, "the reading in the archive");
  assert.ok(archived.ok);
  await quiet();
  assert.ok(!s.driver.messages().some((m) => m.word === "wake"), "no wake");
});

test("SPEC-03 §11.4a, SPEC-00 §6.12: sense events are not in the ledger and are not sent to anyone but the archive and the organ", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  const owner = await s.human();

  await phone.emit("sense.battery", { level: 12 });
  await phone.emit("sense.location", { batch_id: "b1", items: [{ ts: Date.now(), lat: 31.2, lon: 121.5, accuracy_m: 20, provider: "fused" }] });
  await eventually(async () => {
    const reply = await owner.call("service:senses", "now");
    return reply.ok && JSON.stringify(dataOf(reply)).includes("31.2") ? reply : null;
  }, "the location in the archive");

  const ledger = await owner.ledger();
  assert.ok(!ledger.some((m) => m.word.startsWith("sense.")), "no sense.* message in the ledger");
  assert.ok(!ledger.some((m) => m.from === phone.member && m.kind === "event"), "no event of the hand in the ledger");
  assert.ok(!owner.messages.some((m) => m.word.startsWith("sense.")), "and none reached the owner's conversation");
  assert.ok(!JSON.stringify(s.driver.messages().map(bodyOf)).includes("battery"), "the agent was told nothing");
});
