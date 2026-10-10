import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply, type WordResult } from "../../../../sdk/src/message";
import { openLedger } from "../../kernel/ledger/helpers";
import { createReflexService } from "../../../src/services/reflex";

const ctx = (signal = new AbortController().signal): HandleContext => ({ signal, caller: { member: "service:agents", via: "service", local: true }, raw: null });
const request = (word: string, body: unknown): Message => ({ seq: 0, id: "m_req", ts: 0, from: "service:agents", to: "service:reflex", kind: "request", word, body });
const ok = (data: unknown): Reply => ({ ok: true, result: { data } });

const SURFACE = { home_visible: true, page_live: true, visibility_epoch: 3, virtual_available: true };
const SCREEN = { foreground_package: "ai.ash", state_epoch: 10, virtual_generation: 0, virtual_owner_turn: "", virtual_open: false };
const pick = (choice: string, confidence = 0.9) => ({ answers: { execution_screen: { choice, confidence } } });
const cleanup = (virtual: string) => ({ answers: { virtual_screen: { choice: virtual, confidence: 0.9 } } });

function setup(opts: { hand?: boolean; jev?: (() => unknown) | "none"; hands?: Record<string, (body: any, caller: Caller) => Reply> } = {}) {
  const { ledger } = openLedger();
  const sent: { msg: Outgoing; caller: Caller }[] = [];
  const hands: Record<string, (body: any, caller: Caller) => Reply> = {
    "decision.surface": () => ok(SURFACE), "decision.screen": () => ok(SCREEN), "decision.virtual_close": () => ok({ acted: true }), ...opts.hands };
  const router = { send: async (msg: Outgoing, who: Caller): Promise<Reply> => {
    sent.push({ msg, caller: who });
    const h = msg.to === "device:phone" ? hands[msg.word] : undefined;
    return h ? h(msg.body, who) : { ok: false, error: { code: "offline", message: "offline" } };
  } };
  const registry = { findByWord: (word: string) => (opts.hand === false || word !== "decision.surface" ? [] : [{ id: "device:phone", kind: "device", name: "phone", words: () => [], handle: async () => undefined }]) } as any;
  const asked: { state: any; questions: any }[] = [];
  const jev = opts.jev === "none" ? undefined : { evaluate: async (state: unknown, questions: Record<string, unknown>) => {
    asked.push({ state, questions });
    const answer = typeof opts.jev === "function" ? opts.jev() : pick("virtual_task");
    if (answer instanceof Error) throw answer;
    return answer;
  } };
  const service = createReflexService({ ledger, router, registry, log: () => {}, ...(jev ? { jev } : {}) });
  const call = async (word: string, body: unknown): Promise<any> => ((await service.handle(request(word, body), ctx())) as WordResult).data;
  const owner = (text: string) => ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text } });
  const calls = (word: string) => sent.filter((s) => s.msg.to === "device:phone" && s.msg.word === word);
  return { ledger, service, call, owner, sent, asked, calls };
}
const planBody = (m: { id: string }) => ({ agent: "agent:main", lane: "front", ids: [m.id] });
const done = { turn: "t1", agent: "agent:main", lane: "front", outcome: "completed" };

test("the member has the two screen words", () => {
  assert.ok(setup().service.words().map((w) => w.word).includes("screen.plan"));
  assert.ok(setup().service.words().map((w) => w.word).includes("screen.reconcile"));
});

// ---- plan ---------------------------------------------------------------------------------------------------

test("plan: JEV picks a mode, and the text for the turn names it; the owner's words and the phone's state are what JEV saw", async () => {
  for (const mode of ["virtual_task", "foreground_task", "foreground_handoff"]) {
    const f = setup({ jev: () => pick(mode) });
    const data = await f.call("screen.plan", planBody(f.owner("在闲鱼帮我查价格")));
    assert.equal(data.mode, mode);
    assert.match(data.inject, new RegExp(`Mode: ${mode}`));
    assert.deepEqual(f.asked[0]!.state.owner_request, ["在闲鱼帮我查价格"]);
    assert.equal(f.asked[0]!.state.virtual_available, true);
    assert.deepEqual(f.asked[0]!.state.origin, SURFACE);
  }
});

test("plan: no_preference and an unsure answer are mode none with no text", async () => {
  const a = setup({ jev: () => pick("no_preference") });
  assert.deepEqual(await a.call("screen.plan", planBody(a.owner("今天几号"))), { mode: "none" });
  const b = setup({ jev: () => pick("virtual_task", 0.3) });
  assert.deepEqual(await b.call("screen.plan", planBody(b.owner("查一下"))), { mode: "none" });
});

test("plan: a virtual screen that is not available becomes the real screen", async () => {
  const f = setup({ jev: () => pick("virtual_task"), hands: { "decision.surface": () => ok({ ...SURFACE, virtual_available: false }) } });
  assert.equal((await f.call("screen.plan", planBody(f.owner("查价格")))).mode, "foreground_task");
});

test("plan: a virtual screen that went away while JEV thought becomes the real screen", async () => {
  let n = 0;
  const f = setup({ jev: () => pick("virtual_task"), hands: { "decision.surface": () => ok({ ...SURFACE, virtual_available: ++n === 1 }) } });
  assert.equal((await f.call("screen.plan", planBody(f.owner("查价格")))).mode, "foreground_task");
});

test("without JEV neither word asks the phone", async () => {
  const f = setup({ jev: "none" });
  assert.deepEqual(await f.call("screen.plan", planBody(f.owner("x"))), { mode: "none" });
  assert.deepEqual(await f.call("screen.reconcile", done), { acted: [] });
  assert.equal(f.sent.length, 0);
});

test("plan: no hand, a hand that fails, Ash not in front, or a screen that changed while JEV thought: none", async () => {
  const noHand = setup({ hand: false });
  assert.deepEqual(await noHand.call("screen.plan", planBody(noHand.owner("x"))), { mode: "none" });
  assert.equal(noHand.asked.length, 0);
  const failing = setup({ hands: { "decision.surface": () => ({ ok: false, error: { code: "offline", message: "x" } }) } });
  assert.deepEqual(await failing.call("screen.plan", planBody(failing.owner("x"))), { mode: "none" });
  const away = setup({ hands: { "decision.surface": () => ok({ ...SURFACE, home_visible: false }) } });
  assert.deepEqual(await away.call("screen.plan", planBody(away.owner("x"))), { mode: "none" });
  assert.equal(away.asked.length, 0);
  let n = 0;
  const moved = setup({ hands: { "decision.surface": () => ok({ ...SURFACE, visibility_epoch: ++n }) } });
  assert.deepEqual(await moved.call("screen.plan", planBody(moved.owner("x"))), { mode: "none" });
});

test("plan: JEV failing, malformed or missing is mode none and the turn is not delayed by an error", async () => {
  const bad = setup({ jev: () => new Error("down") });
  assert.deepEqual(await bad.call("screen.plan", planBody(bad.owner("x"))), { mode: "none" });
  const junk = setup({ jev: () => ({ answers: { execution_screen: { choice: "teleport", confidence: 1 } } }) });
  assert.deepEqual(await junk.call("screen.plan", planBody(junk.owner("x"))), { mode: "none" });
  const missing = setup({ jev: "none" });
  assert.deepEqual(await missing.call("screen.plan", planBody(missing.owner("x"))), { mode: "none" });
});

test("plan: a batch without an owner's say is not judged at all; a bad body is bad_request", async () => {
  const f = setup();
  const other = f.ledger.append({ from: "service:pulse", to: "agent:main", kind: "request", word: "wake", body: { reason: "pulse" } });
  assert.deepEqual(await f.call("screen.plan", planBody(other)), { mode: "none" });
  assert.equal(f.asked.length, 0);
  await assert.rejects(f.call("screen.plan", { agent: "agent:main" }), (e) => e instanceof WordError && e.code === "bad_request");
});

test("without a registry the words answer none and do nothing", async () => {
  const { ledger } = openLedger();
  const service = createReflexService({ ledger, router: { send: async () => ({ ok: true }) } });
  assert.deepEqual(((await service.handle(request("screen.plan", { agent: "agent:main", lane: "front" }), ctx())) as WordResult).data, { mode: "none" });
  assert.deepEqual(((await service.handle(request("screen.reconcile", { turn: "t", agent: "agent:main", lane: "front" }), ctx())) as WordResult).data, { acted: [] });
});

// ---- reconcile ----------------------------------------------------------------------------------------------

/** A phone whose screen state moves on with `state`, and a plan that saw Ash in front. */
async function planned(mode: string, state: () => Record<string, unknown>, jev: () => unknown, extra: Record<string, (b: any, c: Caller) => Reply> = {}) {
  let answer: () => unknown = () => pick(mode);
  let later = false; // the screen is Ash's while plan looks, and what `state` says afterwards
  const f = setup({ jev: () => answer(), hands: { "decision.screen": () => ok({ ...SCREEN, ...(later ? state() : {}) }), ...extra } });
  await f.call("screen.plan", planBody(f.owner("请办一下")));
  answer = jev;
  later = true;
  return f;
}

test("reconcile: a finished virtual task closes the virtual screen it owns, for that turn and generation", async () => {
  const f = await planned("virtual_task", () => ({ virtual_open: true, virtual_owner_turn: "t1", virtual_generation: 4 }), () => cleanup("close"));
  assert.deepEqual(await f.call("screen.reconcile", done), { acted: ["virtual_close"] });
  const close = f.calls("decision.virtual_close");
  assert.equal(close.length, 1);
  assert.deepEqual({ ...(close[0]!.msg.body as object), decision_id: "x" }, { expected_generation: 4, owner_turn: "t1", decision_id: "x" });
  assert.equal(close[0]!.caller.turn, "t1");
  assert.equal(f.calls("decision.return").length, 0);
  // the phone is told about the turn before anything else
  assert.equal(f.sent.filter((s) => s.msg.to === "device:phone" && s.caller.turn === "t1")[0]!.msg.word, "decision.surface");
});

test("reconcile: the virtual screen of another turn, or JEV saying keep, is left alone", async () => {
  const other = await planned("virtual_task", () => ({ virtual_open: true, virtual_owner_turn: "t9" }), () => cleanup("close"));
  assert.deepEqual(await other.call("screen.reconcile", done), { acted: [] });
  assert.equal(other.calls("decision.virtual_close").length, 0);
  const keep = await planned("virtual_task", () => ({ virtual_open: true, virtual_owner_turn: "t1" }), () => cleanup("keep"));
  assert.deepEqual(await keep.call("screen.reconcile", done), { acted: [] });
  assert.equal(keep.calls("decision.virtual_close").length, 0);
});

test("reconcile: the real screen is never touched, however the turn left it", async () => {
  for (const mode of ["foreground_task", "foreground_handoff", "virtual_task"]) {
    const f = await planned(mode, () => ({ foreground_package: "com.xianyu", state_epoch: 15 }), () => cleanup("close"));
    assert.deepEqual(await f.call("screen.reconcile", done), { acted: [] }, mode);
    assert.equal(f.asked.length, 1, mode); // only the plan asked JEV: no virtual screen, nothing to decide
    assert.equal(f.calls("decision.return").length + f.calls("decision.virtual_close").length, 0, mode);
  }
});

test("reconcile: nothing is done when the screen moved on between the look and the act (epoch, package or generation)", async () => {
  for (const field of ["state_epoch", "foreground_package", "virtual_generation"]) {
    let looks = 0;
    const f = await planned("virtual_task", () => {
      looks++;
      const base = { foreground_package: "com.xianyu", state_epoch: 15, virtual_open: true, virtual_owner_turn: "t1", virtual_generation: 4 };
      return looks <= 1 ? base : { ...base, [field]: field === "foreground_package" ? "com.other" : 99 };
    }, () => cleanup("close"));
    assert.deepEqual(await f.call("screen.reconcile", done), { acted: [] }, field);
    assert.equal(f.calls("decision.virtual_close").length, 0, field);
  }
});

test("reconcile: a turn that used both screens only has its virtual screen closed", async () => {
  const f = await planned("foreground_task", () => ({ foreground_package: "com.xianyu", virtual_open: true, virtual_owner_turn: "t1", virtual_generation: 2 }), () => cleanup("close"));
  assert.deepEqual(await f.call("screen.reconcile", done), { acted: ["virtual_close"] });
  assert.equal(f.calls("decision.return").length, 0);
});

test("reconcile: a phone that says it did not act, a failing JEV or hand, an unfinished turn, or no plan: nothing happens and nothing throws", async () => {
  const state = () => ({ virtual_open: true, virtual_owner_turn: "t1", virtual_generation: 1 });
  const refused = await planned("virtual_task", state, () => cleanup("close"), { "decision.virtual_close": () => ok({ acted: false }) });
  assert.deepEqual(await refused.call("screen.reconcile", done), { acted: [] });
  const jevDown = await planned("virtual_task", state, () => new Error("down"));
  assert.deepEqual(await jevDown.call("screen.reconcile", done), { acted: [] });
  const handDown = await planned("virtual_task", state, () => cleanup("close"), { "decision.virtual_close": () => ({ ok: false, error: { code: "offline", message: "x" } }) });
  assert.deepEqual(await handDown.call("screen.reconcile", done), { acted: [] });
  const cancelled = await planned("virtual_task", state, () => cleanup("close"));
  assert.deepEqual(await cancelled.call("screen.reconcile", { ...done, outcome: "cancelled" }), { acted: [] });
  assert.equal(cancelled.calls("decision.virtual_close").length, 0);
  const noPlan = setup({ hands: { "decision.screen": () => ok({ ...SCREEN, ...state() }) } });
  assert.deepEqual(await noPlan.call("screen.reconcile", done), { acted: [] });
  assert.equal(noPlan.calls("decision.surface").length, 0);
  // what plan saw is used once: a second reconcile finds nothing
  const once = await planned("virtual_task", state, () => cleanup("close"));
  await once.call("screen.reconcile", done);
  assert.deepEqual(await once.call("screen.reconcile", done), { acted: [] });
});

test("reconcile: a plan that gave no advice (JEV down) still lets a virtual screen the turn opened be closed", async () => {
  let down = true;
  const f = setup({ jev: () => (down ? new Error("down") : cleanup("close")), hands: { "decision.screen": () => ok({ ...SCREEN, virtual_open: true, virtual_owner_turn: "t1", virtual_generation: 1 }) } });
  assert.equal((await f.call("screen.plan", planBody(f.owner("查一下")))).mode, "none");
  down = false;
  assert.deepEqual(await f.call("screen.reconcile", done), { acted: ["virtual_close"] });
});
