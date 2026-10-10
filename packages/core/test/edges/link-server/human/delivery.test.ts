import assert from "node:assert/strict";
import test from "node:test";
import { eventually } from "../../../fixtures/wait";
import { AGENT, Channel, GATE, quiet, startHumanHub, type HumanHub } from "./helpers";

const at = (hour: number, minute = 0, day = 10) => Date.UTC(2026, 9, day, hour, minute);
const tell = (hub: HumanHub, body: Record<string, unknown>, caller = GATE) =>
  hub.mini.send({ to: "person:owner", kind: "request", word: "say", body: { text: "内容", ...body } }, caller);
const shown = (c: Channel) => c.presented("notification", "show").map((f) => (f.body as { text: string; kind: string }).kind + ":" + (f.body as { text: string }).text);

async function phone(hub: HumanHub, over: Parameters<typeof Channel.open>[1] = {}) {
  return Channel.open(hub, { surfaces: ["chat", "notification"], ...over });
}

test("a reminder rings when the owner is away and stays silent while a channel is being looked at", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const p = await phone(hub);
  p.presence({ visible: true });
  await eventually(() => hub.human.clients()[0]?.visible, "visible");

  await tell(hub, { kind: "due", text: "第一条" });
  await quiet();
  assert.deepEqual(shown(p), []);

  p.presence({ visible: false });
  await eventually(() => !hub.human.clients()[0]?.visible, "away");
  await tell(hub, { kind: "due", text: "第二条" });
  await eventually(() => shown(p).length === 1, "the notification");
  assert.deepEqual(shown(p), ["due:第二条"]);
});

test("the task island being on screen counts as looking", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  let showing = true;
  const p = await phone(hub);
  const island = await Channel.open(hub, { surfaces: ["chat", "island"], kind: "browser", present: (f) => (f.surface === "island" ? { ok: true, data: { showing } } : { ok: true }) });

  await tell(hub, { kind: "due", text: "岛上" });
  await eventually(() => island.presented("island", "query").length === 1, "the island asked");
  await quiet();
  assert.deepEqual(shown(p), [], "the owner reads it on the island");

  showing = false;
  await tell(hub, { kind: "due", text: "岛没了" });
  await eventually(() => shown(p).length === 1, "now it rings");
});

test("offers and heads-ups never ring, whatever the hour; they are only in the conversation", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const p = await phone(hub); p.follow();
  hub.settings["delivery.quiet_hours"] = "";
  hub.clock.now = at(12);

  await tell(hub, { kind: "offer", text: "提议", dedupe_key: "k" });
  await tell(hub, { kind: "heads_up", text: "说一声" });
  await tell(hub, { kind: "due", text: "到点了" });

  await eventually(() => shown(p).length === 1, "only the reminder");
  await quiet();
  assert.deepEqual(shown(p), ["due:到点了"]);
  await p.seen((m) => m.kind === "request" && (m.body as { kind?: string }).kind === "offer", "the offer in the conversation");
});

test("quiet hours hold back plain replies, not a reminder that is due, a question or the strong ring; they are read from the settings", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const p = await phone(hub);
  hub.settings["delivery.quiet_hours"] = "22:00-07:00";

  hub.clock.now = at(23);
  await tell(hub, { text: "夜里的回复" });
  void hub.mini.send({ to: "person:owner", kind: "request", word: "ask", body: { title: "夜里的问题", options: [{ id: "a", label: "A" }], expires_at: Date.now() + 60_000 } }, AGENT);
  await tell(hub, { kind: "due", text: "夜里的到点" });
  await eventually(() => shown(p).length === 2, "the question and the reminder");
  await quiet();
  assert.deepEqual(shown(p).sort(), ["approval:", "due:夜里的到点"].sort());

  hub.clock.now = at(12);
  await tell(hub, { text: "白天的回复" });
  await eventually(() => shown(p).length === 3, "by day the reply rings");

  hub.settings["delivery.quiet_hours"] = "";
  hub.clock.now = at(23);
  await tell(hub, { text: "没有安静时段" });
  await eventually(() => shown(p).length === 4, "no quiet hours, it rings at night");
});

test("the default quiet hours are 21:30 to 09:00, and the interval's ends are exact", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const p = await phone(hub);
  const reply = async (when: number, text: string) => { hub.clock.now = when; await tell(hub, { text }); };

  await reply(at(21, 29), "a"); await eventually(() => shown(p).length === 1, "before");
  await reply(at(21, 30), "b"); await reply(at(8, 59, 11), "c");
  await reply(at(9, 0, 11), "d"); await eventually(() => shown(p).length === 2, "from 09:00");
  await quiet();
  assert.deepEqual(shown(p), ["reply:a", "reply:d"]);
});

test("a repeat of a reply with the same key inside the window is dropped; after the window, or with another key, it rings", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const p = await phone(hub);
  hub.clock.now = at(12);

  await tell(hub, { text: "一", dedupe_key: "walk" });
  await eventually(() => shown(p).length === 1, "first");
  hub.clock.now = at(12, 30);
  await tell(hub, { text: "二", dedupe_key: "walk" });
  await tell(hub, { text: "三", dedupe_key: "tea" });
  await eventually(() => shown(p).length === 2, "another key");
  hub.clock.now = at(13, 1);
  await tell(hub, { text: "四", dedupe_key: "walk" });
  await eventually(() => shown(p).length === 3, "after the hour");
  assert.deepEqual(shown(p), ["reply:一", "reply:三", "reply:四"]);

  hub.settings["delivery.dedupe_minutes"] = 0;
  await tell(hub, { text: "五", dedupe_key: "walk" });
  await tell(hub, { text: "六", dedupe_key: "walk" });
  await eventually(() => shown(p).length === 5, "no dedupe when switched off");
});

test("the turn's end still rings strongly when its last quiet reply is not yet answered by the channel", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  // The channel holds its answer to the second reply until the turn has ended.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let shows = 0;
  const p = await phone(hub, { present: async (f) => { if (f.surface === "notification" && f.op === "show" && ++shows === 2) await held; return { ok: true }; } });
  hub.mini.announce("turn.started", { turn: "t1", lane: "front", ids: [] });
  const agentInTurn = { ...AGENT, turn: "t1" };
  await tell(hub, { text: "先说一半" }, agentInTurn);
  void tell(hub, { text: "结果出来了" }, agentInTurn);
  await eventually(() => p.presented("notification", "show").length === 2, "two quiet replies shown");
  hub.mini.announce("turn.ended", { turn: "t1", lane: "front", outcome: "completed" });
  await new Promise((r) => setTimeout(r, 50));
  release();
  const alert = await p.present((f) => f.op === "alert", "the strong ring");
  const last = p.presented("notification", "show")[1]!;
  assert.deepEqual(alert.body, { id: (last.body as { id: string }).id });
});

test("a reply while its turn runs rings quietly; the turn's end rings strongly for the last one if the owner is still away", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const p = await phone(hub);
  hub.mini.announce("turn.started", { turn: "t1", lane: "front", ids: [] });
  const agentInTurn = { ...AGENT, turn: "t1" };

  await tell(hub, { text: "先说一半" }, agentInTurn);
  await tell(hub, { text: "结果出来了" }, agentInTurn);
  await eventually(() => p.presented("notification", "show").length === 2, "two quiet replies");
  const alerts = p.presented("notification", "show").map((f) => (f.body as { alert: string }).alert);
  assert.deepEqual(alerts, ["quiet", "quiet"]);
  assert.equal(p.presented("notification", "alert").length, 0);

  hub.mini.announce("turn.ended", { turn: "t1", lane: "front", outcome: "completed" });
  const alert = await p.present((f) => f.op === "alert", "the strong ring");
  const last = p.presented("notification", "show")[1]!;
  assert.deepEqual(alert.body, { id: (last.body as { id: string }).id });

  await tell(hub, { text: "之后的回复" }, AGENT);
  await eventually(() => p.presented("notification", "show").length === 3, "a reply outside a turn");
  assert.equal((p.presented("notification", "show")[2]!.body as { alert: string }).alert, "strong");
});

test("the end of a turn does not ring when the owner is looking by then", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const p = await phone(hub);
  hub.mini.announce("turn.started", { turn: "t2", lane: "front", ids: [] });
  await tell(hub, { text: "结果" }, { ...AGENT, turn: "t2" });
  await eventually(() => p.presented("notification", "show").length === 1, "the quiet reply");

  p.presence({ visible: true });
  await eventually(() => hub.human.clients()[0]?.visible, "visible");
  hub.mini.announce("turn.ended", { turn: "t2", lane: "front", outcome: "completed" });
  await quiet();

  assert.equal(p.presented("notification", "alert").length, 0);
});

test("with no agent at all there is nobody to reply to: no reply notification is sent", async (t) => {
  let primary: string | null = null;
  const hub = await startHumanHub({ primary: () => primary }); t.after(() => hub.stop());
  const p = await phone(hub);

  await tell(hub, { kind: "due", text: "没人可回" });
  await quiet();
  assert.deepEqual(shown(p), []);

  primary = "agent:main";
  await tell(hub, { kind: "due", text: "有人了" });
  await eventually(() => shown(p).length === 1, "now it rings");
});

test("every notification says who a reply goes to: the agent it came from, else the primary", async (t) => {
  const hub = await startHumanHub({ primary: () => "agent:main" }); t.after(() => hub.stop());
  const p = await phone(hub);
  hub.mini.stub("agent:helper", ["say"]);

  await tell(hub, { kind: "due", text: "来自服务" }, GATE);
  await tell(hub, { kind: "due", text: "来自帮手" }, { member: "agent:helper", via: "agent", local: true });
  await eventually(() => p.presented("notification", "show").length === 2, "both");

  const targets = Object.fromEntries(p.presented("notification", "show").map((f) => [(f.body as { text: string }).text, (f.body as { reply_target: string }).reply_target]));
  assert.deepEqual(targets, { "来自服务": "agent:main", "来自帮手": "agent:helper" });
});

test("an approval card does not ring while the owner is looking at a channel, but is on every channel's conversation", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const p = await phone(hub); p.follow();
  p.presence({ visible: true });
  await eventually(() => hub.human.clients()[0]?.visible, "visible");

  void hub.mini.send({ to: "person:owner", kind: "request", word: "ask", body: { title: "可以吗", options: [{ id: "once", label: "可以" }, { id: "deny", label: "不行" }], expires_at: Date.now() + 60_000 } }, GATE);

  await p.seen((m) => m.kind === "request" && m.word === "ask", "the card in the conversation");
  await quiet();
  assert.deepEqual(shown(p), []);
});

test("the strong ring at a turn's end still rings in quiet hours", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const p = await phone(hub);
  hub.settings["delivery.quiet_hours"] = "00:00-23:59";
  hub.mini.announce("turn.started", { turn: "t9", lane: "front", ids: [] });
  hub.clock.now = at(12);
  // A reply inside a turn is a plain reply: held back in quiet hours, so there is nothing to raise.
  await tell(hub, { text: "静音期间" }, { ...AGENT, turn: "t9" });
  await quiet();
  hub.mini.announce("turn.ended", { turn: "t9", lane: "front", outcome: "completed" });
  await quiet();
  assert.equal(p.presented("notification").length, 0);

  // Once outside quiet hours the quiet reply is shown, and the turn's end raises it although quiet hours come back.
  hub.settings["delivery.quiet_hours"] = "";
  hub.mini.announce("turn.started", { turn: "t10", lane: "front", ids: [] });
  await tell(hub, { text: "正常" }, { ...AGENT, turn: "t10" });
  await eventually(() => p.presented("notification", "show").length === 1, "the quiet reply");
  hub.settings["delivery.quiet_hours"] = "00:00-23:59";
  hub.mini.announce("turn.ended", { turn: "t10", lane: "front", outcome: "completed" });
  await p.present((f) => f.op === "alert", "the strong ring");
});
