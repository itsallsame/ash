import assert from "node:assert/strict";
import test from "node:test";
import { cancelClock, isSystemPlan, listClock, userPlans, normalizeClockList, repeatText } from "../js/clock.js";
import { unwrap } from "../js/link.js";
import { until } from "./support.js";

/** The part of Net the clock words use, scripted: handlers are keyed "<member>/<word>"; [lose] ends the connection. */
function fakeNet(handlers = {}) {
  return { session: "s1", generation: 1, calls: [], handlers,
    binding() { return { session: this.session, generation: this.generation }; },
    same(binding) { return Boolean(binding?.session) && binding.session === this.session && binding.generation === this.generation; },
    async call(to, word, body = {}, options) {
      this.calls.push({ to, word, body, options });
      const handler = this.handlers[`${to}/${word}`];
      if (handler === undefined) return { ok: false, error: { code: "not_found", message: `${to}/${word}` } };
      const given = typeof handler === "function" ? await handler(body, options) : handler;
      return given && typeof given.ok === "boolean" ? given : { ok: true, result: { data: given } };
    },
    async data(to, word, body, options) { return unwrap(await this.call(to, word, body, options)); },
    lose() { this.session = null; this.generation++; } };
}

test("clock list data is checked before it is shown; a malformed timer is an error, never an empty list", () => {
  const timer = { id: "timer1", next: 999999999999, every: null, to: "agent:main", by: null, word: "say", label: "带伞", blocked: null };
  assert.deepEqual(normalizeClockList({ timers: [timer] }), [{ ...timer, every: null, blocked: null }]);
  assert.deepEqual(normalizeClockList({ timers: [] }), []);
  for (const bad of [undefined, {}, { timers: "x" }, { timers: [{ id: "bad", next: "tomorrow" }] }, { timers: [{ id: "", next: 1 }] },
    { timers: [{ id: "a", next: 1, every: 5 }] }, { timers: [{ id: "a", next: 1, label: "calendar.search" }] },
    { timers: [{ id: "a", next: 1, label: "带伞", blocked: "service:clock list failed" }] }])
    assert.throws(() => normalizeClockList(bad), /暂时读不到计划（不代表没有）/);
  assert.equal(normalizeClockList({ timers: [{ id: "a", next: 1000, label: "带伞", blocked: "internal_adapter_timeout" }] })[0].blocked, "请稍后再看", "a blocked reason is a fixed human message");
});

test("how often a timer repeats reads in the owner's words", () => {
  assert.deepEqual([null, 86_400, 604_800, 3_600, 1_800, 172_800].map(repeatText), ["只一次", "每天", "每周", "每小时", "每 30 分钟", "每 2 天"]);
});

test("cancelled false, a refusal, an unknown answer and a changed connection never remove a timer", async () => {
  const net = fakeNet({ "service:clock/cancel": { cancelled: false } });
  const binding = net.binding();
  await assert.rejects(cancelClock(net, binding, "timer-a", "client-a"), /没能删除/);
  net.handlers["service:clock/cancel"] = { ok: false, error: { code: "forbidden", message: "" } };
  await assert.rejects(cancelClock(net, binding, "timer-a", "client-a"), /不能修改计划/);
  net.handlers["service:clock/cancel"] = { ok: false, error: { code: "timeout", message: "" } };
  await assert.rejects(cancelClock(net, binding, "timer-a", "client-a"), /还没确认结果/);
  net.handlers["service:clock/cancel"] = { ok: false, error: { code: "bad_request", message: "" } };
  await assert.rejects(cancelClock(net, binding, "timer-a", "client-a"), /没有收到确认/);
  await assert.rejects(cancelClock(net, binding, "", "client-a"), TypeError);
  let release;
  net.handlers["service:clock/cancel"] = () => new Promise((resolve) => { release = () => resolve({ cancelled: true }); });
  const pending = cancelClock(net, binding, "timer-a", "client-a");
  await until(() => release);
  net.lose();
  release();
  await assert.rejects(pending, /连接已经换过/);
  await assert.rejects(listClock(net, binding), /还没连上/);
});

test("a list that arrives after the connection changed is not adopted, and a cancel is sent with the client id it was given", async () => {
  let release;
  const net = fakeNet({ "service:clock/list": () => new Promise((resolve) => { release = () => resolve({ timers: [{ id: "x", next: 1, label: "PRIVATE" }] }); }), "service:clock/cancel": { cancelled: true } });
  const binding = net.binding();
  const pending = listClock(net, binding);
  await until(() => release);
  net.lose();
  release();
  await assert.rejects(pending, /连接已经换过/);
  const fresh = net.binding();
  net.session = "s2"; net.generation++;
  await cancelClock(net, { session: "s2", generation: net.generation }, "tmr_a", "cancel-client-one");
  assert.deepEqual(net.calls.at(-1), { to: "service:clock", word: "cancel", body: { id: "tmr_a" }, options: { clientId: "cancel-client-one" } });
  void fresh;
});

test("a plan the system made for itself carries an internal name and is not the owner's to see", () => {
  assert.equal(isSystemPlan({ label: "semantic:reload:1760" }), true);
  assert.equal(isSystemPlan({ label: "ash:tick" }), true);
  assert.equal(isSystemPlan({ label: "带伞" }), false);
  assert.equal(isSystemPlan({ label: "提醒: 开会" }), false, "words with a space are a person's");
  assert.equal(isSystemPlan({ label: "" }), false);
  assert.equal(isSystemPlan({ label: "每日整理", by: "service:semantic" }), true, "told by who made it");
  assert.equal(isSystemPlan({ label: "pulse:wake:7", by: "agent:main" }), true, "or by the name it carries");
  assert.equal(isSystemPlan({ label: "吃药", by: "agent:main" }), false);
  assert.equal(isSystemPlan({ label: "整理", to: "service:semantic" }), true, "aimed at a service");
  assert.equal(isSystemPlan({ label: "heartbeat_1791734193803" }), true, "a bare code with a timestamp in it");
  assert.equal(isSystemPlan({ label: "给小李打电话 1791734193", to: "agent:main" }), false);
  assert.equal(isSystemPlan({ label: "wake-up", to: "agent:main" }), false);
  assert.equal(isSystemPlan({ label: "吃药", by: "person:owner" }), false);
  assert.deepEqual(userPlans([{ id: "a", label: "semantic:x:1" }, { id: "b", label: "吃药" }]).map((p) => p.id), ["b"]);
});
