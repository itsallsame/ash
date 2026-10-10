import assert from "node:assert/strict";
import test from "node:test";
import { eventually } from "../../../fixtures/wait";
import { APPROVAL, Channel, GATE, AGENT, quiet, startHumanHub } from "./helpers";

const approvalCard = (over: Record<string, unknown> = {}) =>
  ({ to: "person:owner", kind: "request" as const, word: "ask", body: { title: "要发邮件", detail: "发给老王", options: APPROVAL, expires_at: Date.now() + 60_000, ...over } });

test("an approval card shows on every channel; one answers, the request gets the choice, the other channel sees it closed and the notification is taken down", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { surfaces: ["chat", "notification"] });
  const web = await Channel.open(hub, { surfaces: ["chat"], kind: "browser" });
  phone.follow(); web.follow();
  phone.presence({ visible: false });

  const asking = hub.mini.send(approvalCard(), GATE);
  const cardOnPhone = await phone.seen((m) => m.kind === "request" && m.word === "ask", "the card on the phone");
  const cardOnWeb = await web.seen((m) => m.kind === "request" && m.word === "ask", "the card on the web page");
  assert.equal(cardOnWeb.id, cardOnPhone.id);
  const shown = await phone.present((f) => f.surface === "notification" && f.op === "show", "the notification");
  assert.deepEqual(shown.body, {
    id: cardOnPhone.id, kind: "approval", title: "要发邮件", text: "发给老王", options: APPROVAL, expires_at: (cardOnPhone.body as { expires_at: number }).expires_at,
    reply_to: cardOnPhone.id, reply_target: "service:gate",
  });
  assert.equal(web.presents.length, 0, "a chat-only channel is not sent a notification");

  const answered = await web.answer(cardOnWeb, "once");
  assert.ok(answered.ok);

  const reply = await asking;
  assert.deepEqual(reply, { ok: true, result: { data: { choice: "once" } } });
  const closedOnPhone = await phone.seen((m) => m.kind === "response" && m.reply_to === cardOnPhone.id, "the answer on the phone");
  assert.equal((answered as { message: { id: string } }).message.id, closedOnPhone.id, "the send answer names the recorded response");
  await phone.present((f) => f.surface === "notification" && f.op === "hide", "the notification taken down");
  assert.deepEqual(phone.presented("notification", "hide")[0]!.body, { id: cardOnPhone.id });

  const late = await phone.answer(cardOnPhone, "deny");
  assert.ok(!late.ok && late.error.code === "conflict", "the second answer finds it closed");
});

test("an answer that is not one of the options is refused and the card stays open; a custom answer needs allow_custom", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub); phone.follow();
  const asking = hub.mini.send({ to: "person:owner", kind: "request", word: "ask", body: { title: "吃什么", options: [{ id: "noodle", label: "面" }, { id: "rice", label: "饭" }] } }, AGENT);
  const card = await phone.seen((m) => m.kind === "request" && m.word === "ask", "the question");

  const wrong = await phone.answer(card, "pizza");
  assert.ok(!wrong.ok && wrong.error.code === "bad_request");
  const right = await phone.answer(card, "rice", { text: "加辣" });
  assert.ok(right.ok);

  assert.deepEqual(await asking, { ok: true, result: { data: { choice: "rice", text: "加辣" } } });

  const free = hub.mini.send({ to: "person:owner", kind: "request", word: "ask", body: { title: "还有想法吗", options: [{ id: "no", label: "没有" }], allow_custom: true } }, AGENT);
  const second = await phone.seen((m) => m.kind === "request" && m.word === "ask" && m.id !== card.id, "the second question");
  assert.ok((await phone.answer(second, "custom", { text: "晚点再说" })).ok);
  assert.deepEqual((await free), { ok: true, result: { data: { choice: "custom", text: "晚点再说" } } });
});

test("an approval card that ends unanswered is a deny; a question that ends is a timeout", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { surfaces: ["chat", "notification"] }); phone.follow();

  const approval = await hub.mini.send(approvalCard({ expires_at: Date.now() + 60 }), GATE);
  const question = await hub.mini.send({ to: "person:owner", kind: "request", word: "ask", body: { title: "晚饭", options: [{ id: "a", label: "A" }], expires_at: Date.now() + 60 } }, AGENT);

  assert.deepEqual(approval, { ok: true, result: { data: { choice: "deny" } } });
  assert.ok(!question.ok && question.error.code === "timeout");
  await eventually(() => phone.presented("notification", "hide").length === 2, "both notifications taken down");
});

test("a question without an end time ends after 24 hours; the ends are at most 7 days away", async (t) => {
  const timers: number[] = [];
  const realSet = global.setTimeout;
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub); phone.follow();
  (global as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => { timers.push(ms ?? 0); return realSet(fn, ms, ...rest); }) as typeof setTimeout;
  t.after(() => { global.setTimeout = realSet; });

  void hub.mini.send({ to: "person:owner", kind: "request", word: "ask", body: { title: "没写时间", options: [{ id: "a", label: "A" }] } }, AGENT);
  void hub.mini.send({ to: "person:owner", kind: "request", word: "ask", body: { title: "写得太久", options: [{ id: "a", label: "A" }], expires_at: Date.now() + 30 * 86_400_000 } }, AGENT);
  await eventually(() => timers.filter((ms) => ms > 20 * 3600_000).length >= 2, "both timers");

  const long = timers.filter((ms) => ms > 6 * 86_400_000);
  assert.ok(long.some((ms) => Math.abs(ms - 7 * 86_400_000) < 5000), "the long one is cut at 7 days");
  assert.ok(timers.some((ms) => Math.abs(ms - 86_400_000) < 5000), "the unwritten one is 24 hours");
});

test("a confirmation without options gets yes / no, not the approval card's once / deny", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { surfaces: ["chat", "notification"] }); phone.follow(); phone.presence({ visible: false });

  const asking = hub.mini.send({ to: "person:owner", kind: "request", word: "ask", body: { title: "确定删掉吗", human_kind: "confirmation" } }, AGENT);
  const card = await phone.seen((m) => m.kind === "request" && m.word === "ask", "the confirmation");
  const shown = await phone.present((f) => f.surface === "notification" && f.op === "show", "its notification");
  assert.deepEqual((shown.body as { options: unknown }).options, [{ id: "yes", label: "是" }, { id: "no", label: "否" }]);
  assert.equal((shown.body as { human_kind: string }).human_kind, "question");

  const wrong = await phone.answer(card, "once");
  assert.ok(!wrong.ok && wrong.error.code === "bad_request");
  assert.ok((await phone.answer(card, "no")).ok);
  assert.deepEqual(await asking, { ok: true, result: { data: { choice: "no" } } });
});

test("the router giving up on an ask closes its card", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { surfaces: ["chat", "notification"] }); phone.follow(); phone.presence({ visible: false });
  const asking = hub.mini.send(approvalCard(), GATE);
  const card = await phone.seen((m) => m.kind === "request" && m.word === "ask", "the card");
  await phone.present((f) => f.op === "show", "its notification");

  hub.human.member.cancel!(card.id);

  const reply = await asking;
  assert.ok(!reply.ok && reply.error.code === "cancelled");
  await phone.present((f) => f.surface === "notification" && f.op === "hide", "the notification taken down");
  await quiet(20);
});
