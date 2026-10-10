import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply } from "../../../../sdk/src/message";
import { compileSchema } from "../../../../sdk/src/word";
import { Ledger } from "../../../src/kernel/ledger";
import { createClockService, CLOCK_ID } from "../../../src/services/clock";
import { reconcileTimers } from "../../../src/services/semantic/shared";
import { openLedger } from "../../kernel/ledger/helpers";
import { agent, app, failure, fake, flush, owner, service, success, word, world } from "../../kernel/router/world";

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

test("a due timer sends its stored word as whoever set it (not as service:clock), once, and is gone", async () => {
  const s = setup();
  await s.call("set", set({ at: T0 + 5000, to: "agent:main", word: "wake", body: { reason: "water" } }));
  s.service.check();
  assert.equal(s.sent.length, 0);
  s.clock.t = T0 + 5000;
  s.service.check();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0]!.msg, { to: "agent:main", kind: "request", word: "wake", body: { reason: "water" } });
  assert.deepEqual(s.sent[0]!.caller, { member: "agent:main", via: "agent", local: false });
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

// ---- the real router and gate: a timer is the call of the one who set it ----

function hub(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  const logs: string[] = [];
  const clock = createClockService({ ledger: w.ledger, router: w.router, now: () => w.clock.now, log: (m) => logs.push(m), setTimer: () => () => {} });
  w.registry.add(clock);
  const body = fake("body:main", [word("body:main", "execute", { effect: "execute", risk: "structure" })]);
  const quiet = fake("service:quiet", [word("service:quiet", "tick", { effect: "write", risk: "none" })]);
  const kernelOnly = fake("service:inner", [word("service:inner", "due", { effect: "write", risk: "none", callers: ["kernel"] })]);
  w.registry.add(body); w.registry.add(quiet); w.registry.add(kernelOnly);
  const setTimerAs = (caller: Caller, to: string, wd: string, label = "t", body: unknown = { command: "id" }) =>
    w.router.send({ to: CLOCK_ID, kind: "request", word: "set", body: { at: w.clock.now + 1000, to, word: wd, body, label } }, caller);
  const fire = async () => { w.clock.now += 2000; clock.check(); await flush(); };
  return { ...w, body, quiet, kernelOnly, setTimerAs, fire, logs };
}

test("a timer an agent set for body:main/execute meets the gate when it is due: the owner is asked, nothing runs", async () => {
  const h = hub();
  success(await h.setTimerAs(agent(), "body:main", "execute"));
  await h.fire();
  assert.equal(h.body.calls.length, 0, "the command did not run");
  assert.equal(h.owner.cards.length, 1, "the owner got the card");
  const card = h.owner.cards[0]!.msg;
  assert.match(JSON.stringify(card.body), /body:main/);
  assert.ok(h.ledger.unfinished().some((r) => r.state === "waiting_owner"), "the request is parked for the owner");
  assert.ok(h.ledger.page({ limit: 50 }).some((m) => m.from === "agent:main" && m.to === "body:main" && m.word === "execute"), "the request is recorded as the agent's");
  assert.ok(!h.ledger.page({ limit: 50 }).some((m) => m.from === CLOCK_ID && m.to === "body:main"));
});

test("a timer an agent set for a word that is for the kernel alone is refused by the callers check when it is due", async () => {
  const h = hub();
  success(await h.setTimerAs(agent(), "service:inner", "due"));
  await h.fire();
  assert.equal(h.kernelOnly.calls.length, 0);
  assert.equal(h.logs.filter((l) => /answered forbidden/.test(l)).length, 1);
});

test("a timer a service set is still sent as that service", async () => {
  const h = hub();
  success(await h.setTimerAs(service("semantic"), "service:inner", "due", "semantic:daily:1"));
  success(await h.setTimerAs(service("semantic"), "body:main", "execute", "semantic:cmd"));
  await h.fire();
  assert.equal(h.kernelOnly.calls.length, 1);
  assert.deepEqual(h.kernelOnly.calls[0]!.ctx.caller, { member: "service:semantic", via: "service", local: true });
  assert.equal(h.body.calls.length, 1, "a service is the hub's own code: no card");
  assert.equal(h.body.calls[0]!.ctx.caller.member, "service:semantic");
  assert.equal(h.owner.cards.length, 0);
});

test("a timer the owner set is sent as the owner", async () => {
  const h = hub();
  success(await h.setTimerAs(owner, "body:main", "execute"));
  await h.fire();
  assert.equal(h.owner.cards.length, 0, "the owner is not asked about their own command");
  assert.equal(h.body.calls.length, 1);
  assert.deepEqual(h.body.calls[0]!.ctx.caller, { member: "person:owner", via: "human", local: true });
});

test("a timer an app set is sent as the app: only what it was granted, and no word that needs approval", async () => {
  const h = hub({ appGranted: (id, to, wd) => id === "app:todo" && ((to === "service:quiet" && wd === "tick") || (to === "body:main" && wd === "execute") || (to === "service:clock")) });
  success(await h.setTimerAs(app(), "service:quiet", "tick", "ok"));
  success(await h.setTimerAs(app(), "body:main", "execute", "bad"));
  await h.fire();
  assert.equal(h.quiet.calls.length, 1);
  assert.equal(h.quiet.calls[0]!.ctx.caller.member, "app:todo");
  assert.equal(h.body.calls.length, 0, "an app cannot get a command through the clock");
  assert.equal(h.owner.cards.length, 0);
  assert.equal(h.logs.filter((l) => /answered (denied|forbidden)/.test(l)).length, 1);
});

test("cancel: one's own timer, any timer for the owner, someone else's is forbidden", async () => {
  const h = hub();
  const mine = success(await h.setTimerAs(agent("main"), "service:quiet", "tick", "mine")).id;
  const other = success(await h.setTimerAs(agent("main"), "service:quiet", "tick", "other")).id;
  const cancel = (id: string, caller: Caller) => h.router.send({ to: CLOCK_ID, kind: "request", word: "cancel", body: { id } }, caller);
  assert.equal(failure(await cancel(mine, agent("helper"))).code, "forbidden");
  assert.equal(failure(await cancel(mine, service("semantic"))).code, "forbidden");
  assert.equal(failure(await cancel(mine, app())).code, "forbidden");
  assert.equal(success(await h.router.send({ to: CLOCK_ID, kind: "request", word: "list", body: {} }, agent("helper"))).timers.length, 0, "an agent lists only its own");
  assert.deepEqual(success(await cancel(mine, agent("main"))), { cancelled: true });
  assert.deepEqual(success(await cancel(other, owner)), { cancelled: true });
  assert.deepEqual(success(await cancel(other, agent("helper"))), { cancelled: false }, "gone: nothing to forbid");
});

test("list: an agent or an app sees only its own timers; the owner and a service see all", async () => {
  const h = hub({ appGranted: (id, to) => id === "app:todo" && to === CLOCK_ID });
  await h.setTimerAs(agent("main"), "service:quiet", "tick", "a-main");
  await h.setTimerAs(agent("helper"), "service:quiet", "tick", "a-helper");
  await h.setTimerAs(service("semantic"), "service:quiet", "tick", "s");
  await h.setTimerAs(owner, "service:quiet", "tick", "o");
  const labels = async (caller: Caller) =>
    success(await h.router.send({ to: CLOCK_ID, kind: "request", word: "list", body: {} }, caller)).timers.map((t: any) => t.label).sort();
  assert.deepEqual(await labels(agent("main")), ["a-main"]);
  assert.deepEqual(await labels(agent("helper")), ["a-helper"]);
  assert.deepEqual(await labels(app()), []);
  assert.deepEqual(await labels(owner), ["a-helper", "a-main", "o", "s"]);
  assert.deepEqual(await labels(service("other")), ["a-helper", "a-main", "o", "s"]);
});

test("the owner's reminder to the owner is delivered; the owner still cannot reach a kernel-only word through a timer", async () => {
  const h = hub();
  success(await h.setTimerAs(owner, "person:owner", "say", "me", { text: "water" }));
  success(await h.setTimerAs(owner, "service:inner", "due", "inner"));
  await h.fire();
  assert.equal(h.owner.said.length, 1, "the reminder reached the owner");
  assert.equal(h.kernelOnly.calls.length, 0, "the owner's timer is still the owner's: a kernel-only word stays out of reach");
  assert.equal(h.logs.filter((l) => /service:inner\/due answered forbidden/.test(l)).length, 1);
});

test("reconcileTimers only counts the timers its own member set: an agent cannot hold a label of the pulse", async () => {
  const h = hub();
  await h.setTimerAs(agent("main"), "service:quiet", "tick", "pulse:wake:1");       // an agent names its timer like the pulse's
  await h.setTimerAs(service("pulse"), "service:quiet", "tick", "pulse:wake:2");
  const want = new Map([["pulse:wake:1", { at: h.clock.now + 5000, body: {} }]]);
  assert.equal(await reconcileTimers(h.router, "service:pulse", "pulse:", "service:quiet", "tick", want), null);
  const all = success(await h.router.send({ to: CLOCK_ID, kind: "request", word: "list", body: {} }, owner)).timers as any[];
  assert.equal(all.filter((t) => t.label === "pulse:wake:1" && t.created_by === "agent:main").length, 1, "the agent's own timer is left alone");
  assert.equal(all.filter((t) => t.label === "pulse:wake:1" && t.created_by === "service:pulse").length, 1, "the pulse laid down its own");
  assert.equal(all.filter((t) => t.label === "pulse:wake:2").length, 0, "its stale one was taken away");
});
