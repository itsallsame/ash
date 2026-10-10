import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply } from "../../../../sdk/src/message";
import { compileSchema } from "../../../../sdk/src/word";
import { Ledger } from "../../../src/kernel/ledger";
import { createClockService, CLOCK_ID, type ClockHost } from "../../../src/services/clock";
import { openLedger } from "../../kernel/ledger/helpers";

const T0 = 1_800_000_000_000;
const ctx: HandleContext = { signal: new AbortController().signal, caller: { member: "agent:main", via: "agent", local: false }, raw: null };
const msg = (word: string, body: unknown, kind: "request" | "event" = "request", from = "agent:main"): Message =>
  ({ seq: 0, id: "m_1", ts: 0, from, to: CLOCK_ID, kind, word, body });

function setup(ledger = openLedger().ledger, withHost = true) {
  const clock = { t: T0 };
  const sent: { msg: Outgoing; caller: Caller }[] = [];
  const router = { send: async (m: Outgoing, caller: Caller): Promise<Reply> => { sent.push({ msg: m, caller }); return { ok: true }; } };
  const alarms: (number | null)[] = [];
  const host: ClockHost = { wakeAt: async (at) => { alarms.push(at); return { supported: true }; }, wakeClear: async () => { alarms.push(null); return { supported: true }; } };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const service = createClockService({ ledger, router, now: () => clock.t, host: withHost ? host : undefined, log: () => {},
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; } });
  const call = async (word: string, body: unknown) => {
    const result = await service.handle(msg(word, body), ctx);
    return (result as { data: any }).data;
  };
  const rejects = async (word: string, body: unknown) => {
    try { await service.handle(msg(word, body), ctx); } catch (e) { assert.ok(e instanceof WordError); return (e as WordError).code; }
    assert.fail("expected a WordError");
  };
  return { service, ledger, clock, sent, alarms, timers, call, rejects };
}
const set = (extra: Record<string, unknown>) => ({ to: "agent:main", word: "wake", body: { reason: "x" }, label: "x", ...extra });

test("the words are the sdk contracts and set/list/cancel work", async () => {
  const s = setup();
  assert.deepEqual(s.service.words().map((w) => w.word).sort(), ["cancel", "list", "set", "wake.fired"]);
  const setContract = s.service.words().find((w) => w.word === "set")!;
  assert.ok(compileSchema(setContract.input_schema)(set({ at: T0 + 1000 })));

  const a = await s.call("set", set({ at: T0 + 60_000, label: "a" }));
  const b = await s.call("set", set({ every: 3600, label: "b", to: "service:agents", word: "session.reload", body: {} }));
  assert.equal(a.next, T0 + 60_000);
  assert.equal(b.next, T0 + 3_600_000);
  const list = await s.call("list", {});
  assert.deepEqual(list.timers.map((t: any) => [t.label, t.every, t.to]), [["a", null, "agent:main"], ["b", 3600, "service:agents"]]);
  assert.equal(list.timers[0].created_by, "agent:main");

  assert.deepEqual(await s.call("cancel", { id: a.id }), { cancelled: true });
  assert.deepEqual(await s.call("cancel", { id: a.id }), { cancelled: false });
  assert.equal((await s.call("list", {})).timers.length, 1);
});

test("set refuses a bad time", async () => {
  const s = setup();
  assert.equal(await s.rejects("set", set({})), "bad_request");
  assert.equal(await s.rejects("set", set({ at: T0 - 1 })), "bad_request");
  assert.equal(await s.rejects("set", set({ every: 59 })), "bad_request");
});

test("a due timer sends its stored word as service:clock, once, and is gone", async () => {
  const s = setup();
  await s.call("set", set({ at: T0 + 5000, to: "agent:main", word: "wake", body: { reason: "water" } }));
  await s.service.check();
  assert.equal(s.sent.length, 0);
  s.clock.t = T0 + 5000;
  await s.service.check();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0]!.msg, { to: "agent:main", kind: "request", word: "wake", body: { reason: "water" } });
  assert.deepEqual(s.sent[0]!.caller, { member: "service:clock", via: "service", local: true });
  await s.service.check();
  assert.equal(s.sent.length, 1);
  assert.equal((await s.call("list", {})).timers.length, 0);
});

test("the in-process timeout fires the check when its time comes", async () => {
  const s = setup();
  await s.call("set", set({ at: T0 + 7000 }));
  const live = s.timers.filter((t) => t.live);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.ms, 7000);
  s.clock.t = T0 + 7000;
  live[0]!.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.length, 1);
});

test("a repeating timer that missed many rounds fires once and goes on from the next slot", async () => {
  const s = setup();
  await s.call("set", set({ every: 60, label: "tick" }));       // next = T0 + 60 s
  s.clock.t = T0 + 60_000 * 10 + 5000;                          // ten rounds later
  await s.service.check();
  assert.equal(s.sent.length, 1);
  const [t] = (await s.call("list", {})).timers;
  assert.equal(t.next, T0 + 60_000 * 11);
  s.clock.t = T0 + 60_000 * 11;
  await s.service.check();
  assert.equal(s.sent.length, 2);
});

test("at with every fires first at `at`, then repeats", async () => {
  const s = setup();
  const r = await s.call("set", set({ at: T0 + 10_000, every: 120 }));
  assert.equal(r.next, T0 + 10_000);
  s.clock.t = T0 + 10_000;
  await s.service.check();
  assert.equal((await s.call("list", {})).timers[0].next, T0 + 130_000);
});

test("timers survive a restart on the same database", async () => {
  const first = openLedger();
  const s1 = setup(first.ledger);
  const { id } = await s1.call("set", set({ at: T0 + 30_000, label: "keep" }));
  s1.service.stop();
  first.ledger.close();
  const reopened = Ledger.open(first.path);
  try {
    const s2 = setup(reopened);
    assert.deepEqual((await s2.call("list", {})).timers.map((t: any) => t.id), [id]);
    s2.clock.t = T0 + 31_000;                                   // the hub was down when it fell due
    await s2.service.start();
    assert.equal(s2.sent.length, 1);
    assert.equal(s2.sent[0]!.msg.word, "wake");
  } finally { reopened.close(); }
});

test("the host alarm follows the earliest timer, and only changes when it does", async () => {
  const s = setup();
  await s.call("set", set({ at: T0 + 100_000, label: "late" }));
  assert.deepEqual(s.alarms, [T0 + 100_000]);
  await s.call("set", set({ at: T0 + 200_000, label: "later" }));
  assert.deepEqual(s.alarms, [T0 + 100_000]);                    // not the earliest: unchanged
  const early = await s.call("set", set({ at: T0 + 50_000, label: "early" }));
  assert.deepEqual(s.alarms, [T0 + 100_000, T0 + 50_000]);
  await s.call("cancel", { id: early.id });
  assert.deepEqual(s.alarms, [T0 + 100_000, T0 + 50_000, T0 + 100_000]);
  s.clock.t = T0 + 100_000;
  await s.service.check();                                        // "late" fired
  assert.deepEqual(s.alarms.at(-1), T0 + 200_000);
  s.clock.t = T0 + 200_000;
  await s.service.check();
  assert.equal(s.alarms.at(-1), null);                           // nothing left: cleared
});

test("wake.fired makes the clock look for due timers", async () => {
  const s = setup();
  await s.call("set", set({ at: T0 + 1000 }));
  s.timers.forEach((t) => (t.live = false));                      // the in-process timeout never ran: the phone was asleep
  s.clock.t = T0 + 2000;
  const result = await s.service.handle(msg("wake.fired", { at: T0 + 1000 }, "event", "service:host"), ctx);
  assert.equal(result, undefined);
  assert.equal(s.sent.length, 1);
});

test("without a host only the in-process timeout is used; a failed host call does not stop the timer", async () => {
  const s = setup(undefined, false);
  await s.call("set", set({ at: T0 + 1000 }));
  assert.deepEqual(s.alarms, []);
  assert.equal(s.timers.filter((t) => t.live).length, 1);

  const { ledger } = openLedger();
  const clock = { t: T0 };
  let failing = true;
  const calls: number[] = [];
  const svc = createClockService({ ledger, router: { send: async () => ({ ok: true }) }, now: () => clock.t, log: () => {},
    host: { wakeAt: async (at) => { calls.push(at); if (failing) throw new Error("host down"); return {}; }, wakeClear: async () => ({}) } });
  await svc.handle(msg("set", set({ at: T0 + 1000 })), ctx);
  assert.equal(calls.length, 1);
  failing = false;
  await svc.handle(msg("set", set({ at: T0 + 2000 })), ctx);      // same earliest, but the first try failed: try again
  assert.equal(calls.length, 2);
  svc.stop();
});

test("a send that fails is logged and does not stop the other timers", async () => {
  const { ledger } = openLedger();
  const sent: string[] = [];
  const logs: string[] = [];
  const svc = createClockService({ ledger, now: () => T0, log: (m) => logs.push(m),
    router: { send: async (m) => { sent.push(m.to!); if (m.to === "app:x") throw new Error("boom"); return { ok: false, error: { code: "offline", message: "gone" } }; } } });
  await svc.handle(msg("set", set({ at: T0, to: "app:x", word: "ping", body: {}, label: "one" })), ctx);
  await svc.handle(msg("set", set({ at: T0, to: "device:phone", word: "ping", body: {}, label: "two" })), ctx);
  await svc.check();
  assert.deepEqual(sent.sort(), ["app:x", "device:phone"]);
  assert.equal(logs.length, 2);
  svc.stop();
});
