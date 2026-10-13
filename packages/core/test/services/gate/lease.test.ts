import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../../../sdk/src/message";
import { agent, DEVICE, failure, fake, flush, owner, success, word, world } from "../../kernel/router/world";

const TAP = word(DEVICE, "screen.tap", { effect: "act", risk: "outward", foreground: true, label: { doing: "在点屏幕" } });
const PAY = word(DEVICE, "screen.pay", { effect: "act", risk: "outward", foreground: true, label: { doing: "在付款" } });
const LOOK = word(DEVICE, "screen.read", { effect: "read", risk: "none", label: { doing: "在读屏幕" } });
const TOUCH = word(DEVICE, "screen.touch", { effect: "act", risk: "outward", foreground: true, label: { doing: "在操作触屏" } });

function setup(options: Parameters<typeof world>[0] = {}, hang = false) {
  const w = world(options);
  const taps: unknown[] = [];
  const phone = fake(DEVICE, [TAP, PAY, LOOK, TOUCH], (msg) => {
    if (msg.word === "screen.tap" && hang) return new Promise<never>(() => {});
    taps.push(msg.word);
    return { data: { ok: true } };
  }, { name: "手机" });
  w.main.name = "ash";
  w.registry.add(phone);
  const tap = () => w.router.send({ to: DEVICE, kind: "request", word: "screen.tap", body: {} }, agent());
  const gate = (word: string, body: unknown = {}, caller: any = agent()) => w.router.send({ to: "service:gate", kind: "request", word, body }, caller);
  const grant = async (choice: string, minutes?: number) => {
    const asked = success(await gate("lease.request", { goal: "给小王发消息", ...(minutes ? { minutes } : {}) }));
    await flush();
    w.owner.answer(choice);
    await flush();
    return asked;
  };
  return { ...w, taps, tap, gate, grant };
}

test("a screen word without a lease is refused and says how to ask; a read is not touched", async () => {
  const s = setup();
  const refused = failure(await s.tap());
  assert.equal(refused.code, "denied");
  assert.match(refused.message, /lease\.request/);
  assert.equal(s.taps.length, 0);
  assert.equal(s.ledger.page({ limit: 5 }).some((m) => m.word === "ask"), false, "no card for a tap: only the lease is asked");
  assert.equal(success(await s.router.send({ to: DEVICE, kind: "request", word: "screen.read", body: {} }, agent())).ok, true);
});

test("a lease: the owner's card, the owner's own words to the agent, then the screen words pass until the time is up", async () => {
  const s = setup();
  const asked = success(await s.gate("lease.request", { minutes: 15, goal: "给小王发消息" }));
  assert.equal(asked.status, "waiting_owner");
  await flush();
  const card = s.owner.cards[0]!.msg;
  assert.equal(card.from, "service:gate");
  assert.deepEqual((card.body as any).options.map((o: any) => o.id), ["task", "m15", "h1", "deny"]);
  assert.match((card.body as any).detail, /给小王发消息/);
  // asking twice does not make a second card
  assert.equal(success(await s.gate("lease.request", { minutes: 15, goal: "x" })).lease_id, asked.lease_id);
  assert.equal(s.owner.cards.length, 1);
  assert.match(failure(await s.tap()).message, /还在等主人/);

  s.owner.answer("m15");
  await flush();
  const note = s.main.inbox.at(-1)!;
  assert.deepEqual([note.from, note.word, (note.body as any).text], ["person:owner", "say", "授权操作屏幕 15 分钟"]);
  assert.equal(s.main.inbox.filter((m) => m.word === "tell").length, 0, "no background message for an answer");

  const allowed = await s.tap();
  assert.equal(success(allowed).ok, true);
  assert.equal(s.store.evidence((allowed as { id?: string }).id!)?.decided_by, "lease");
  const status = success(await s.gate("lease.status"));
  assert.equal(status.lease.expires_at, s.clock.now + 15 * 60_000);
  assert.equal(success(await s.gate("lease.request", { minutes: 10, goal: "x" })).status, "active", "enough left: no new question");

  s.clock.now += 15 * 60_000 + 1;
  s.svc.sweep();
  await flush();
  const refused = failure(await s.tap());
  assert.match(refused.message, /到期/);
  assert.match(refused.message, /lease\.request/);
  assert.match((s.main.inbox.filter((m) => m.word === "tell").at(-1)!.body as any).text, /时间到/);
  assert.equal(s.screen.released, 1, "the fingers were let go");
});

test("a refusal or no answer: no lease; the owner's refusal is said to the agent, a missing answer is told in the background", async () => {
  const s = setup();
  await s.grant("deny");
  assert.equal((s.main.inbox.at(-1)!.body as any).text, "拒绝：操作屏幕");
  assert.equal(failure(await s.tap()).code, "denied");
  const t = setup();
  await t.gate("lease.request", { goal: "x" });
  await flush();
  t.owner.cards[0]!.fail(new Error("no answer"));
  await flush();
  assert.match((t.main.inbox.at(-1)!.body as any).text, /没有回答/);
  assert.equal(t.main.inbox.at(-1)!.word, "tell");
  assert.equal(success(await t.gate("lease.status")).asking, false);
});

test("the owner takes it back: the agent is stopped and told, what was on its way to the screen is cancelled, the fingers are let go", async () => {
  const s = setup({}, true);
  await s.grant("h1");
  const hanging = s.tap();
  await flush();
  const revoked = success(await s.gate("lease.revoke", {}, owner));
  assert.equal(revoked.revoked, 1);
  assert.equal(failure(await hanging).code, "cancelled");
  assert.deepEqual(s.screen.cancelled, ["screen.tap"]);
  assert.equal(s.screen.released, 1);
  assert.match((s.main.inbox.filter((m) => m.word === "tell").at(-1)!.body as any).text, /收回/);
  assert.match(failure(await s.tap()).message, /收回/);
  assert.equal(success(await s.gate("lease.revoke", {}, owner)).revoked, 0);
});

test("a task lease ends with the turn it was given for, not before; the agent hands it back itself", async () => {
  const s = setup();
  await s.grant("task");
  // the next turn of the agent that starts is the one the lease belongs to
  const event = (word: string, turn: string) => ({ seq: 0, id: `e${turn}${word}`, ts: 1, from: "agent:main", to: null, kind: "event" as const, word, body: { turn, lane: "front" } });
  s.svc.observe(event("turn.started", "t1"));
  assert.equal(success(await s.tap()).ok, true);
  s.svc.observe(event("turn.ended", "t0"));
  assert.equal(success(await s.tap()).ok, true, "another turn ending changes nothing");
  s.svc.observe(event("turn.ended", "t1"));
  assert.match(failure(await s.tap()).message, /本次任务/);
  assert.equal(s.main.inbox.filter((m) => m.word === "tell").length, 0, "a task ending is silent");

  const t = setup();
  await t.grant("m15");
  assert.equal(success(await t.gate("lease.release")).released, true);
  assert.equal(failure(await t.tap()).code, "denied");
  assert.equal(t.main.inbox.filter((m) => m.word === "tell").length, 0);
});

test("a payment still asks, and no rule can cover a screen word", async () => {
  const s = setup();
  await s.grant("h1");
  const paying = await s.router.send({ to: DEVICE, kind: "request", word: "screen.pay", body: {} }, agent());
  assert.equal(success(paying).status, "waiting_owner");
  const rule = failure(await s.gate("rules.set", { agent: "agent:main", member: DEVICE, word: "screen.tap" }, owner));
  assert.equal(rule.code, "forbidden");
});

test("an asking lease whose card was lost (a restart) gets its card again when the hub starts", async () => {
  const s = setup();
  // the hub restarted: the row is there, its card is not
  const lease = s.store.askLease("agent:main", "x", 15, "t1");
  s.svc.start();
  await flush();
  assert.equal(s.owner.cards.length, 1, "the card is sent again");
  s.owner.answer("m15");
  await flush();
  assert.equal(s.store.getLease(lease.id)?.state, "active");
  s.svc.stop();
});

test("an old asking lease with no answer ends at the next request, which then starts a new one", async () => {
  const s = setup();
  const first = success(await s.gate("lease.request", { goal: "x" }));
  s.clock.now += 6 * 60_000;
  const second = success(await s.gate("lease.request", { goal: "y" }));
  assert.notEqual(second.lease_id, first.lease_id);
  assert.equal(s.store.getLease(first.lease_id)?.state, "ended");
});

test("a screen word an agent sends under its lease tells the owner's screens it is operating, at most once a second; a read does not", async () => {
  const s = setup();
  await s.grant("h1");
  const states = () => s.owner.calls.filter((c) => c.msg.word === "lease.state");
  const sent = (word: string): Message => ({ seq: 0, id: `x${word}`, ts: 1, from: "agent:main", to: DEVICE, kind: "request", word, body: {} });
  assert.equal(success(await s.gate("lease.list", {}, owner)).leases[0].last_action_at, null);
  s.svc.observe(sent("screen.read"));
  await flush();
  assert.equal(success(await s.gate("lease.list", {}, owner)).leases[0].last_action_at, null, "reading is not operating");
  s.clock.now += 1_500;
  const n = states().length;
  s.svc.observe(sent("screen.tap"));
  await flush();
  assert.equal(states().length, n + 1);
  assert.equal((states().at(-1)!.msg.body as any).leases[0].last_action_at, s.clock.now);
  s.svc.observe(sent("screen.tap"));
  await flush();
  assert.equal(states().length, n + 1, "not again within the second");
  s.svc.stop();
});
