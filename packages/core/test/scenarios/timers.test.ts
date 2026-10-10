/**
 * REGRESSION-0.3 §3 (定时器 S082-S084, 子 agent 定时醒): timers are `service:clock`. They fire a stored word at a time, and
 * the host's alarm (`service:host/wake.at`) is what wakes the device for it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MAIN, OWNER, accepted, bodyOf, byOwnerText, quiet, startScenario, textOf, toOwner } from "./harness";
import { eventually } from "../fixtures/wait";

test("S082: a reminder the owner sets for themselves arrives as a message to the owner at the time", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();

  const set = await owner.call("service:clock", "set", { at: Date.now() + 400, to: OWNER, word: "say", body: { text: "该喝水了", kind: "due" }, label: "喝水" });

  assert.ok(set.ok, "the timer is accepted");
  const reminder = await owner.seen(toOwner("say"), "the reminder");
  assert.equal(textOf(reminder), "该喝水了");
});

test("S083, agent 9: an agent sets a timer that wakes it later; the wake comes on its back lane", async (t) => {
  const s = await startScenario(t);
  s.driver.script(byOwnerText({
    "过一会叫我": async (turn) => {
      await turn.tool("timer_set", { at: Date.now() + 400, to: MAIN, word: "wake", body: { reason: "timer", context: { note: "喝茶" } }, label: "喝茶" });
    },
  }));
  const owner = await s.human();

  accepted(await owner.say("过一会叫我"));

  const { message } = await s.driver.delivery((m) => m.word === "wake", "the timer waking the agent");
  assert.equal(message.lane, "back");
  assert.equal(bodyOf(message).reason, "timer");
  const turn = await s.driver.turn((r) => r.key === "back" && r.messages.some((m) => m.word === "wake"), "a back-lane turn for the wake");
  assert.equal(turn.agent, MAIN);
});

test("S084: a timer is listed and can be cancelled; a cancelled timer does not fire", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();
  const set = await owner.call("service:clock", "set", { at: Date.now() + 600, to: OWNER, word: "say", body: { text: "不该出现" }, label: "取消我" });
  assert.ok(set.ok);
  const id = (set.result as { id: string }).id;

  const listed = await owner.call("service:clock", "list");
  assert.ok(listed.ok && JSON.stringify(listed.result).includes(id));
  const cancelled = await owner.call("service:clock", "cancel", { id });
  assert.deepEqual(cancelled.ok && cancelled.result, { cancelled: true });

  await quiet(900);
  assert.equal(owner.messages.filter((m) => textOf(m) === "不该出现").length, 0);
});

test("S084, 设备: a timer far away asks the host to wake the device then; when the host says it did, the timer fires", async (t) => {
  const s = await startScenario(t, { fakeNow: true });
  s.driver.script(byOwnerText({
    "一小时后叫我": async (turn) => {
      await turn.tool("timer_set", { at: s.clock.t + 3_600_000, to: MAIN, word: "wake", body: { reason: "timer" }, label: "一小时后" });
    },
  }));
  const owner = await s.human();
  const due = s.clock.t + 3_600_000;

  accepted(await owner.say("一小时后叫我"));

  const alarm = await eventually(() => s.host.callsOf("wake.at").find((c) => (c.body as { at: number }).at === due), "the hub asking the host to wake at the time");
  assert.equal((alarm.body as { at: number }).at, due);
  assert.ok(!s.driver.messages().some((m) => m.word === "wake"), "nothing fires early");

  s.advance(3_600_000 + 1000);
  s.hostEvent({ event: "wake.fired", at: s.clock.t });

  const { message } = await s.driver.delivery((m) => m.word === "wake", "the timer firing after the host's alarm");
  assert.equal(bodyOf(message).reason, "timer");
});

test("timer ids: setting returns an id and the next fire time (SPEC-02 §4.1)", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();
  const at = Date.now() + 60_000;

  const set = await owner.call("service:clock", "set", { at, to: OWNER, word: "say", body: { text: "晚点" }, label: "晚点" });

  assert.ok(set.ok);
  assert.equal(typeof (set.result as { id: string }).id, "string");
  assert.equal((set.result as { next: number }).next, at);
});
