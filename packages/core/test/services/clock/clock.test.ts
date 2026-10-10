import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply } from "../../../../sdk/src/message";
import { compileSchema } from "../../../../sdk/src/word";
import { Ledger } from "../../../src/kernel/ledger";
import { createClockService, CLOCK_ID } from "../../../src/services/clock";
import { openLedger } from "../../kernel/ledger/helpers";

const T0 = 1_800_000_000_000;
const ctx: HandleContext = { signal: new AbortController().signal, caller: { member: "agent:main", via: "agent", local: false }, raw: null };
const msg = (word: string, body: unknown, kind: "request" | "event" = "request", from = "agent:main"): Message =>
  ({ seq: 0, id: "m_1", ts: 0, from, to: CLOCK_ID, kind, word, body });

function setup(ledger = openLedger().ledger) {
  const clock = { t: T0 };
  const all: { msg: Outgoing; caller: Caller }[] = [];
  const router = { send: async (m: Outgoing, caller: Caller): Promise<Reply> => { all.push({ msg: m, caller }); return { ok: true }; } };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const service = createClockService({ ledger, router, now: () => clock.t, log: () => {},
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; } });
  const call = async (word: string, body: unknown) => {
    const result = await service.handle(msg(word, body), ctx);
    return (result as { data: any }).data;
  };
  const rejects = async (word: string, body: unknown) => {
    try { await service.handle(msg(word, body), ctx); } catch (e) { assert.ok(e instanceof WordError); return (e as WordError).code; }
    assert.fail("expected a WordError");
  };
  return { service, ledger, clock, timers, call, rejects, router,
    /** what went to targets other than the host */
    get sent() { return all.filter((c) => c.msg.to !== "service:host"); },
    /** the host alarm calls, as the time or null for a clear */
    get alarms() { return all.filter((c) => c.msg.to === "service:host").map((c) => (c.msg.word === "wake.clear" ? null : (c.msg.body as { at: number }).at)); } };
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
});

test("a due timer sends its stored word as service:clock, once, and is gone", async () => {
  const s = setup();
  await s.call("set", set({ at: T0 + 5000, to: "agent:main", word: "wake", body: { reason: "water" } }));
  s.service.check();
  assert.equal(s.sent.length, 0);
  s.clock.t = T0 + 5000;
  s.service.check();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0]!.msg, { to: "agent:main", kind: "request", word: "wake", body: { reason: "water" } });
  assert.deepEqual(s.sent[0]!.caller, { member: "service:clock", via: "service", local: true });
  s.service.check();
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
  s.service.check();
  assert.equal(s.sent.length, 1);
  const [t] = (await s.call("list", {})).timers;
  assert.equal(t.next, T0 + 60_000 * 11);
  s.clock.t = T0 + 60_000 * 11;
  s.service.check();
  assert.equal(s.sent.length, 2);
});

test("at with every fires first at `at`, then repeats", async () => {
  const s = setup();
  const r = await s.call("set", set({ at: T0 + 10_000, every: 120 }));
  assert.equal(r.next, T0 + 10_000);
  s.clock.t = T0 + 10_000;
  s.service.check();
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
    s2.service.start();
    assert.equal(s2.sent.length, 1);
    assert.equal(s2.sent[0]!.msg.word, "wake");
  } finally { reopened.close(); }
});

test("the host alarm (service:host) follows the earliest timer and is cleared when none is left", async () => {
  const s = setup();
  const last = () => s.alarms.at(-1);
  await s.call("set", set({ at: T0 + 100_000, label: "late" }));
  assert.equal(last(), T0 + 100_000);
  await s.call("set", set({ at: T0 + 200_000, label: "later" }));
  assert.equal(last(), T0 + 100_000);                             // not the earliest: still the earliest
  const early = await s.call("set", set({ at: T0 + 50_000, label: "early" }));
  assert.equal(last(), T0 + 50_000);
  await s.call("cancel", { id: early.id });
  assert.equal(last(), T0 + 100_000);
  s.clock.t = T0 + 100_000;
  s.service.check();                                              // "late" fired
  assert.equal(last(), T0 + 200_000);
  s.clock.t = T0 + 200_000;
  s.service.check();
  assert.equal(last(), null);                                     // nothing left: cleared
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

test("a failing host call is only logged; the in-process timeout still runs", async () => {
  const { ledger } = openLedger();
  const logs: string[] = [];
  const timers: { live: boolean }[] = [];
  const svc = createClockService({ ledger, now: () => T0, log: (m) => logs.push(m), setTimer: () => { const t = { live: true }; timers.push(t); return () => { t.live = false; }; },
    router: { send: async (m) => { if (m.to === "service:host") throw new Error("host down"); return { ok: true }; } } });
  await svc.handle(msg("set", set({ at: T0 + 1000 })), ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 1);
  assert.equal(timers.filter((t) => t.live).length, 1);
  svc.stop();
});

test("a target that never answers does not hold up the other timers", async () => {
  const { ledger } = openLedger();
  const sent: string[] = [];
  const svc = createClockService({ ledger, now: () => T0, log: () => {}, setTimer: () => () => {},
    router: { send: (m) => { sent.push(m.to!); return m.to === "app:slow" ? new Promise<Reply>(() => {}) : Promise.resolve({ ok: true }); } } });
  await svc.handle(msg("set", set({ at: T0, to: "app:slow", word: "ping", body: {}, label: "slow" })), ctx);
  await svc.handle(msg("set", set({ at: T0, to: "device:phone", word: "ping", body: {}, label: "fast" })), ctx);
  svc.check();                                                    // returns at once although app:slow never answers
  assert.ok(sent.includes("device:phone"));
  await svc.handle(msg("wake.fired", { at: T0 }, "event", "service:host"), ctx);   // and so does a host wake
  assert.equal((await svc.handle(msg("list", {}), ctx) as { data: any }).data.timers.length, 0);
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
  svc.check();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.filter((t) => t !== "service:host").sort(), ["app:x", "device:phone"]);
  assert.equal(logs.filter((l) => l.startsWith("timer")).length, 2);
  svc.stop();
});
