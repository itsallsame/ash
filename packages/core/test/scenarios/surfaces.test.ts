/**
 * REGRESSION-0.3 §1 and §4 (the parts the hub pushes to the owner's channels): notifications, the island, task status,
 * desktop cards, opening a page. The hub only presents on surfaces a channel declared; the channel answers each `present`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { accepted, bodyOf, byOwnerText, quiet, resultOf, startScenario, textOf, type ToolResult } from "./harness";
import { eventually } from "../fixtures/wait";

test("S075, 设备 23: a reminder reaches a channel that declared 'notification' as a notification; a chat-only channel gets none", async (t) => {
  const s = await startScenario(t);
  s.driver.script(byOwnerText({ "提醒我出门": async (turn) => { await turn.tool("human_say", { text: "该出门了", kind: "due" }); } }));
  const phone = await s.human({ name: "phone", surfaces: ["chat", "notification"] });
  const web = await s.human({ name: "web page", surfaces: ["chat"] });
  phone.presence({ visible: false });

  accepted(await phone.say("提醒我出门"));

  const shown = await phone.nextPresent((f) => f.surface === "notification" && f.op === "show", "a notification");
  assert.match(JSON.stringify(shown.body), /该出门了/);
  await quiet();
  assert.equal(web.presents.length, 0, "a channel without the surface is not sent it");
});

test("S114-S118, 人场景 9: a running turn gives the status surface task frames", async (t) => {
  const s = await startScenario(t);
  s.driver.script((turn) => turn.say("做完了"));
  const phone = await s.human({ name: "phone", surfaces: ["chat", "status", "island"] });

  accepted(await phone.say("做点事"));

  const frame = await phone.nextPresent((f) => f.surface === "status" && f.op === "frame", "a task status frame");
  assert.equal(typeof frame.body, "object");
});

test("人场景 28: an agent opens a page on one chosen channel of the owner, and only there", async (t) => {
  const s = await startScenario(t);
  const first = await s.human({ name: "phone", surfaces: ["chat"] });
  const second = await s.human({ name: "web page", surfaces: ["chat"] });
  const state: { opened?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "打开设置": async (turn) => { state.opened = await turn.call("person:owner", "open", { target: "settings", client: second.clientId }); },
  }));

  accepted(await first.say("打开设置"));

  const frame = await second.nextPresent((f) => f.surface === "chat" && f.op === "open", "the page opening on the chosen channel");
  assert.deepEqual(bodyOf(frame), { target: "settings" });
  await eventually(() => state.opened, "the agent's result");
  assert.equal(resultOf(state.opened!).opened, true);
  assert.equal(first.presents.filter((f) => f.surface === "chat" && f.op === "open").length, 0, "the other channel was not touched");
});

const TODO_CARD = {
  components: [
    { id: "root", component: "Column", style: { background: "translucentDark", color: "white", padding: 14 }, children: ["t", "l"] },
    { id: "t", component: "Text", text: "**待办**", variant: "h3" },
    { id: "l", component: "List", children: { componentId: "row", path: "/todo" } },
    { id: "row", component: "CheckBox", label: { path: "title" }, value: { path: "done" }, action: { event: { name: "toggle" } } },
  ],
  data: { todo: [{ id: "a", title: "买菜", done: false }] },
};

test("S107, S108: a card an agent puts is drawn on the channels that declared 'widget'", async (t) => {
  const s = await startScenario(t);
  const phone = await s.human({ name: "phone", surfaces: ["chat", "widget"] });
  phone.onPresent((frame) => (frame.surface === "widget" && frame.op === "state" ? { ok: true, data: { widgets: [], rendered: [], previews: [] } } : { ok: true }));
  const card = TODO_CARD;
  s.driver.script(byOwnerText({ "放一张卡片": async (turn) => { await turn.call("service:widgets", "widget.card.put", { id: "todo", title: "待办", size: "2x2", a2ui: card }); } }));

  accepted(await phone.say("放一张卡片"));

  // A channel that has just connected first gets the current (still empty) state; the card comes in a later frame.
  const frame = await phone.nextPresent((f) => f.surface === "widget" && f.op === "state" && JSON.stringify(f.body).includes("todo"), "the widget state frame with the card");
  assert.ok(JSON.stringify(frame.body).includes("todo"));
});

test("人场景 6: while the owner is looking at a channel, a reminder does not buzz; when they leave it does", async (t) => {
  const s = await startScenario(t);
  s.driver.script(byOwnerText({
    "第一次提醒": async (turn) => { await turn.tool("human_say", { text: "第一条提醒", kind: "due" }); },
    "第二次提醒": async (turn) => { await turn.tool("human_say", { text: "第二条提醒", kind: "due" }); },
  }));
  const phone = await s.human({ name: "phone", surfaces: ["chat", "notification"] });

  phone.presence({ visible: true });
  accepted(await phone.say("第一次提醒"));
  await phone.seen((m) => textOf(m) === "第一条提醒", "the first reminder in the conversation");
  await quiet();
  assert.equal(phone.presents.filter((f) => f.surface === "notification").length, 0, "no notification while it is being looked at");

  phone.presence({ visible: false });
  accepted(await phone.say("第二次提醒"));
  const shown = await phone.nextPresent((f) => f.surface === "notification" && f.op === "show", "a notification once the owner left");
  assert.match(JSON.stringify(shown.body), /第二条提醒/);
});

test("S111: a tap on a card reaches the agent that made it, as the owner's action", async (t) => {
  const s = await startScenario(t);
  const phone = await s.human({ name: "phone", surfaces: ["chat", "widget"] });
  phone.onPresent(() => ({ ok: true, data: { widgets: [], rendered: [], previews: [] } }));
  s.driver.script(byOwnerText({ "放一张卡片": async (turn) => { await turn.call("service:widgets", "widget.card.put", { id: "todo", title: "待办", size: "2x2", a2ui: TODO_CARD }); } }));
  accepted(await phone.say("放一张卡片"));
  await s.driver.toolCall("capability_call", "the card being put");

  const tapped = await phone.call("service:widgets", "widget.tap", { card: "todo", action: "toggle", component: "row@0", checked: true });

  assert.ok(tapped.ok);
  const { message } = await s.driver.delivery((m) => m.word === "tell" && m.from === "service:widgets" && m.text.includes("[widget.action]"), "the creator being told about the tap");
  assert.ok(message.text.includes("todo"));
});
