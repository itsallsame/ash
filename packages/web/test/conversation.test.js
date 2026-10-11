import assert from "node:assert/strict";
import test from "node:test";
import { appendConversation, appendOutbox, fileRef } from "../js/conversation.js";
import { dayStamp, letterOf, validUntil } from "../js/chat-ui.js";
import { failedTurns } from "../js/app.js";
import { fold, initialView } from "../js/project.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; }
  append(child) { this.children.push(child); }
  setAttribute(name, value) { this.attributes[name] = value; }
  /** Every node below this one, in order. */
  all() { return this.children.flatMap((child) => [child, ...(child.all?.() ?? [])]); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
}

function draw(entries, options) {
  globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: (value) => { const node = new Node("#text"); node.textContent = value; return node; } };
  try { const fragment = new Node("fragment"); appendConversation(fragment, entries, options); return fragment; }
  finally { delete globalThis.document; }
}

test("a gate approval shows its original in a closed plain-text disclosure while it waits, and folds to a result line once decided", () => {
  const original = "x".repeat(65000) + "\nTAIL <script>not HTML</script>\t  spaces";
  const message = { id: "ask-original", seq: 1, ts: 1, from: "service:gate", to: "person:owner", kind: "request", word: "ask",
    body: { title: "确认", detail: "摘要", expires_at: Date.now() + 60_000, options: [{ id: "once", label: "允许这一次" }],
      source: { word: "shell.run", to: "device:phone", body_preview: "摘要", body_full: original } } };
  const view = fold(initialView(), message);
  assert.equal(view.asks[0].original, original);
  for (const state of ["pending", "answered", "expired", "closed"]) {
    const rendered = draw([{ ...view.conversation[0], ask: { ...view.asks[0], state, expires_at: Date.now() + 60_000 } }]);
    const card = rendered.children.find((node) => node.className?.includes("a-card"));
    const disclosure = card.children.find((node) => node.tag === "details");
    if (state !== "pending") {
      assert.equal(disclosure, undefined, `${state}: no original text on a decided card`);
      assert.deepEqual(card.children.map((node) => node.className.split(" ")[0]), ["card-hd", "card-title", "resolved"], `${state}: head, title, one result line`);
      continue;
    }
    assert.ok(disclosure);
    assert.notEqual(disclosure.open, true);
    assert.equal(disclosure.children[0].tag, "summary");
    assert.equal(disclosure.children[0].textContent, "查看完整原文");
    assert.equal(disclosure.children[1].tag, "pre");
    assert.equal(disclosure.children[1].textContent, original);
    assert.equal(disclosure.children[1].children.length, 0, "markup is text, never executable HTML");
  }
  const ordinary = fold(initialView(), { ...message, from: "agent:main" });
  assert.equal(ordinary.asks[0].original, undefined, "only a gate-authored snapshot is accepted");
  const legacy = fold(initialView(), { ...message, body: { ...message.body, source: { body_preview: "summary only" } } });
  assert.equal(legacy.asks[0].original, undefined, "old summaries are not relabeled as original text");
});

test("conversation shows receipt stages, grouped agent burst, and reactions on the correct bubble", () => {
  const fragment = draw([
    { id: "m1", seq: 1, type: "say", side: "owner", text: "first", delivery: "sent", reactions: [] },
    { id: "m2", seq: 2, type: "say", side: "owner", text: "second", delivery: "delivered", reactions: [] },
    { id: "m3", seq: 3, type: "say", side: "owner", text: "third", delivery: "read", reactions: [{ id: "r1", emoji: "👍" }] },
    { id: "m4", seq: 4, type: "say", side: "agent", text: "one", group: "t_1", reactions: [] },
    { id: "m5", seq: 5, type: "say", side: "agent", text: "two", group: "t_1", reactions: [] },
    { id: "m6", seq: 6, type: "say", side: "agent", text: "other", group: "t_2", reactions: [] },
  ]);
  const bubbles = fragment.children.filter((node) => node.className?.startsWith("msg "));
  const statuses = fragment.children.filter((node) => node.className === "delivery meta r").map((node) => node.textContent);
  assert.deepEqual(statuses, ["发送中", "已送达", "已读"]);
  assert.deepEqual(bubbles.map((node) => node.dataset.seq), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(bubbles[2].textContent, "third👍");
  assert.equal(bubbles[1].textContent, "second");
  assert.match(bubbles[3].className, /group-first/);
  assert.match(bubbles[4].className, /group-last/);
  assert.match(bubbles[5].className, /group-single/);
  assert.equal(fragment.children.some((node) => node.tag === "button"), false);
});

test("three first-meeting replies are visible as three conversation bubbles", () => {
  let view = initialView();
  for (let i = 1; i <= 3; i++) view = fold(view, { id: `first-${i}`, seq: i, ts: i,
    from: "agent:main", to: "person:owner", kind: "request", word: "say",
    body: { text: `FIRST_MEETING_${i}`, kind: "reply" } });
  const rendered = draw(view.conversation);
  assert.deepEqual(rendered.children.filter((item) => item.className?.startsWith("msg "))
    .map((item) => item.textContent), ["FIRST_MEETING_1", "FIRST_MEETING_2", "FIRST_MEETING_3"]);
});

test("only bounded file references become buttons, and they open through the viewer", async () => {
  assert.deepEqual(fileRef({ workspace: "main", path: "inbox/a b.png" }), { workspace: "main", path: "inbox/a b.png" });
  for (const ref of [
    { workspace: "home", path: "../secret" }, { workspace: "home", path: "a\\b" }, { workspace: "home", path: "a//b" },
    { workspace: "home?x", path: "a" }, { workspace: "home", path: "a/./b" }, { workspace: "home", path: "" },
  ]) assert.equal(fileRef(ref), null);
  const opened = [];
  const fragment = draw([{ id: "m", seq: 7, type: "say", side: "agent", from: "agent:main", text: "<script>", attachments: [{ workspace: "main", path: "inbox/a b.png", name: "picture.png" }, { workspace: "main", path: "../nope", name: "bad" }] }],
    { onOpenFile: (ref) => opened.push(ref.path) });
  const atts = fragment.children.find((node) => node.className?.startsWith("atts "));
  assert.equal(atts.children.length, 1, "the unsafe reference is not drawn");
  assert.ok(fragment.children.indexOf(atts) < fragment.children.findIndex((node) => node.className?.startsWith("msg ")), "attachments stand above the words");
  await atts.children[0].listeners.click();
  assert.deepEqual(opened, ["inbox/a b.png"]);
});

test("a long text shows the ledger's short version and reads the rest on demand", async () => {
  const asked = [];
  const entry = { id: "m", seq: 1, type: "say", side: "owner", text: "start…end（共9000字）", full: "a".repeat(64), delivery: "sent", reactions: [] };
  let fragment = draw([entry], { onExpand: async (hash) => asked.push(hash), fullTexts: new Map() });
  const bubble = fragment.children.find((node) => node.className?.startsWith("msg "));
  const more = bubble.children.find((node) => node.className === "expand");
  await more.listeners.click();
  assert.deepEqual(asked, ["a".repeat(64)]);
  fragment = draw([entry], { onExpand: async () => {}, fullTexts: new Map([["a".repeat(64), "the whole text"]]) });
  const shown = fragment.children.find((node) => node.className?.startsWith("msg "));
  assert.equal(shown.textContent, "the whole text");
  assert.equal(shown.children.some((node) => node.className === "expand"), false);
});

test("option card sends one selected action, locks locally, and shows authoritative cross-screen lock", async () => {
  const selected = [];
  const entry = { id: "card-1", type: "card", card: { type: "options", prompt: "Choose", options: [{ id: "yes", text: "Yes" }] }, locked: false };
  let card = draw([entry], { onSelect: async (item, option) => selected.push([item.id, option.id, option.text]) });
  const button = card.children[0].all().find((node) => node.tag === "button");
  await button.listeners.click();
  await button.listeners.click();
  assert.deepEqual(selected, [["card-1", "yes", "Yes"]]);
  card = draw([{ ...entry, locked: true, selected_option_id: "yes" }], { onSelect: async () => selected.push("unexpected") });
  const chosen = card.children[0].all().find((node) => node.tag === "button");
  assert.equal(chosen.disabled, true);
  assert.match(chosen.className, /\bon\b/, "the chosen option stands out");
});

test("custom option uses the reserved id only when the card allows it", async () => {
  const selected = [];
  const entry = { id: "card-2", type: "card", card: { type: "options", options: [{ id: "yes", text: "Yes" }], allow_custom: true }, locked: false };
  const card = draw([entry], { onSelect: async (_item, option) => selected.push(option) });
  const input = card.children[0].all().find((node) => node.tag === "input");
  input.value = "  Another answer  ";
  const send = card.children[0].all().filter((node) => node.tag === "button").at(-1);
  await send.listeners.click();
  assert.deepEqual(selected, [{ id: "__custom", text: "Another answer" }]);
  assert.equal(draw([{ ...entry, card: { ...entry.card, allow_custom: false } }]).children[0].all().some((node) => node.tag === "input"), false);
});

test("file, image, and link cards open safe references and approval buttons expire", async () => {
  const opened = [];
  const files = draw([{ type: "card", card: { type: "file", workspace: "main", path: "a.pdf", name: "a.pdf" } },
    { type: "card", card: { type: "image", workspace: "main", path: "a.png", alt: "a" } },
    { type: "card", card: { type: "link", url: "https://example.com/a", title: "Example" } }], { onOpenFile: (ref) => opened.push(ref.path) });
  await files.children[0].children[0].listeners.click();
  await files.children[1].children[0].listeners.click();
  assert.deepEqual(opened, ["a.pdf", "a.png"]);
  assert.equal(files.children[2].children[0].href, "https://example.com/a");
  const ask = { id: "ask-1", seq: 1, from: "service:gate", title: "Confirm", detail: "Do it?", state: "pending",
    expires_at: Date.now() + 60_000, options: ["once", "always", "deny"].map((id) => ({ id, label: id })) };
  const choices = [];
  let rendered = draw([{ type: "ask", ask }], { onAnswerAsk: async (_ask, choice) => choices.push(choice) });
  // The head says what kind of card it is and until when; then the title, the detail and the choices, each on its own line.
  assert.deepEqual(rendered.children[0].children.map((node) => node.className), ["card-hd c-warn", "card-title ask-title", "card-body ask-detail", "card-acts ask-actions"]);
  assert.match(rendered.children[0].children[0].textContent, /需要你确认.*前有效/);
  const buttons = rendered.children[0].all().filter((node) => node.tag === "button");
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map((node) => node.className), ["a-btn btn-primary btn-block", "a-btn btn-secondary", "a-btn btn-neutral"], "the first choice is the main one");
  await buttons[1].listeners.click();
  assert.deepEqual(choices, ["always"]);
  rendered = draw([{ type: "ask", ask: { ...ask, expires_at: Date.now() - 1 } }], { onAnswerAsk: async () => choices.push("unexpected") });
  assert.equal(rendered.children[0].all().filter((node) => node.tag === "button").length, 0);
  assert.match(rendered.textContent, /已过期/);
  // Answered elsewhere (a notification, another screen): the card states the outcome and offers no buttons.
  for (const [choice, outcome] of [["deny", /已拒绝/], ["once", /已允许这一次/], ["always", /已选择：always/]]) {
    rendered = draw([{ type: "ask", ask: { ...ask, state: "answered", choice } }], { onAnswerAsk: async () => choices.push("unexpected") });
    assert.equal(rendered.children[0].all().filter((node) => node.tag === "button").length, 0, choice);
    assert.match(rendered.textContent, outcome);
  }
});

test("permission card delegates one owner tap to the native settings action", () => {
  const opened = [];
  const rendered = draw([{ type: "card", card: { type: "permission", permission: "calendar", why: "Read calendar" } }],
    { onPermission: (permission) => opened.push(permission) });
  const button = rendered.children[0].all().find((node) => node.tag === "button");
  button.listeners.click();
  assert.deepEqual(opened, ["calendar"]);
  assert.match(rendered.textContent, /需要授权打开「日历」权限Read calendar/);
});

test("a conversation that has not arrived shows bubble-shaped skeletons without any words; an empty one says what to try", () => {
  const loading = draw([], { loading: true });
  assert.equal(loading.children.length, 5);
  assert.ok(loading.children.every((node) => node.className.startsWith("sk ")));
  assert.equal(loading.textContent, "", "loading needs no explanation");
  const empty = draw([]);
  assert.equal(empty.children[0].className, "empty");
  assert.match(empty.textContent, /有事就跟我说.*明早 8 点提醒我带伞/);
});

test("a conversation she began shows who she is on top; the owner's pauses and days get a time line", () => {
  const entries = [
    { id: "m1", seq: 1, ts: Date.parse("2026-10-10T22:40:00"), type: "say", side: "agent", text: "hi", reactions: [] },
    { id: "m2", seq: 2, ts: Date.parse("2026-10-10T22:41:00"), type: "say", side: "agent", text: "there", reactions: [] },
    { id: "m3", seq: 3, ts: Date.parse("2026-10-11T07:05:00"), type: "say", side: "owner", text: "later", delivery: "read", reactions: [] },
  ];
  const now = Date.parse("2026-10-11T09:00:00");
  const fragment = draw(entries, { atStart: true, herName: "小舟", now });
  assert.equal(fragment.children[0].className, "daysep", "the owner has spoken: the first meeting is over");
  assert.deepEqual(fragment.children.filter((node) => node.className === "daysep").map((node) => node.textContent), ["昨天 22:40", "今天 07:05"]);
  const first = draw(entries.slice(0, 2), { atStart: true, herName: "小舟", now });
  assert.equal(first.children[0].className, "intro");
  assert.match(first.children[0].textContent, /小舟刚刚住进你的手机/);
  assert.equal(draw(entries.slice(0, 2), { now }).children[0].className, "daysep", "without the start of the history there is no introduction");
  assert.equal(dayStamp(Date.parse("2026-09-03T08:00:00"), now), "9月3日 08:00");
  assert.equal(validUntil(Date.parse("2026-10-11T23:59:00"), now), "今天 23:59 前有效");
});

test("a message of attachments alone has no empty bubble, and a turn that ended badly gets one card with a way to try again", async () => {
  const sent = [];
  const fragment = draw([
    { id: "m1", seq: 1, ts: 1_000, type: "say", side: "owner", text: "", delivery: "sent", reactions: [], attachments: [{ workspace: "main", path: "a.png", name: "a.png" }] },
    { id: "m2", seq: 2, ts: 2_000, type: "say", side: "owner", text: "again", delivery: "sent", reactions: [] },
  ], { onOpenFile: () => {}, failures: [{ turn: "t1", ts: 3_000, retry: { text: "again" } }], onRetry: async (failure) => sent.push(failure.retry.text) });
  assert.equal(fragment.children.filter((node) => node.className?.startsWith("msg ")).length, 1);
  const card = fragment.children.find((node) => node.className === "a-card card failure");
  assert.match(card.textContent, /没做成.*重试/);
  await card.all().find((node) => node.tag === "button").listeners.click();
  assert.deepEqual(sent, ["again"]);
  assert.equal(draw([{ id: "m2", seq: 2, ts: 2_000, type: "say", side: "owner", text: "x", reactions: [] }], { failures: [{ turn: "t1", ts: 3_000, retry: null }] }).all().some((node) => node.tag === "button"), false, "no text to say again: no button");
});

test("failedTurns: a front turn that ended in error with nothing said after it, and what to say again", () => {
  const view = { conversation: [{ type: "say", side: "owner", ts: 100, text: "查天气", to: "agent:main" }],
    turns: { t1: { background: false, started: 150, ended: 200, outcome: "error" }, t2: { background: true, started: 150, ended: 200, outcome: "error" }, t3: { background: false, started: 150, ended: 200, outcome: "completed" } } };
  assert.deepEqual(failedTurns(view, 1000), [{ turn: "t1", ts: 200, retry: { text: "查天气", to: "agent:main" } }]);
  assert.deepEqual(failedTurns(view, 200 + 86_400_000), [], "a failure from yesterday is history");
  view.conversation.push({ type: "say", side: "owner", ts: 300, text: "算了" });
  assert.deepEqual(failedTurns(view, 1000), [], "the owner has moved on");
});

test("a message that waits to be sent says so under the bubble", () => {
  const fragment = draw([]);
  globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: (value) => { const node = new Node("#text"); node.textContent = value; return node; } };
  try {
    appendOutbox(fragment, [{ client_id: "c1", text: "改成 7:45 吧", status: "unsent" }, { client_id: "c2", text: "x", status: "rejected" }]);
  } finally { delete globalThis.document; }
  assert.deepEqual(fragment.children.filter((node) => node.className?.startsWith("meta-pending")).map((node) => node.textContent), ["等连上就发", "没发出去"]);
  assert.match(fragment.children.find((node) => node.className?.includes("pending-local")).className, /\bwaiting\b/);
});

test("the gate's own review line becomes a note under the sentence, and the sentence keeps its lines", () => {
  const ask = { id: "a2", seq: 1, from: "service:gate", title: "在改剪贴板", detail: "审核：会覆盖你剪贴板里现在的内容\nAsh 想做这件事：在改剪贴板。\n目的：发给朋友", state: "pending", expires_at: Date.now() + 60_000, options: [] };
  const card = draw([{ type: "ask", ask }]).children[0];
  assert.equal(card.children.find((node) => node.className === "card-note").textContent, "审核：会覆盖你剪贴板里现在的内容");
  assert.equal(card.children.find((node) => node.className.includes("ask-detail")).textContent, "Ash 想做这件事：在改剪贴板。\n目的：发给朋友");
  const plain = draw([{ type: "ask", ask: { ...ask, detail: "只有一句" } }]).children[0];
  assert.equal(plain.children.some((node) => node.className === "card-note"), false);
});

test("an approval card keeps the line breaks of its detail", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(css, /\.a-card \.card-body\{[^}]*white-space:pre-(line|wrap)/);
  const detail = "健康 1.0.0：概览\n它需要：\n· 读取健康数据\n· 给你发通知";
  const card = draw([{ type: "ask", seq: 1, ask: { id: "a1", title: "安装「健康」", detail, expires_at: Date.now() + 60_000, state: "pending", options: [] } }]).children[0];
  assert.equal(card.children.find((node) => node.className.includes("ask-detail")).textContent, detail);
});

test("a helper's face carries the letter that tells it apart; a question that allows free answers has the box", async () => {
  assert.deepEqual(["小研", "阿福", "老王", "记账员", "Ash", "小", "", "翻译"].map(letterOf), ["研", "福", "王", "记", "A", "小", "?", "翻"]);
  const ask = { id: "q", seq: 1, from: "agent:main", title: "晚饭吃什么？", detail: "", human_kind: "question", allow_custom: true, state: "pending", expires_at: Date.now() + 60_000, options: [{ id: "a", label: "面" }] };
  const answers = [];
  const card = draw([{ type: "ask", ask }], { onAnswerAsk: async (_ask, choice, words) => answers.push([choice, words]) }).children[0];
  const input = card.all().find((node) => node.tag === "input");
  assert.equal(input.placeholder, "自己说…");
  input.value = "  随便  ";
  await card.all().filter((node) => node.tag === "button").at(-1).listeners.click();
  assert.deepEqual(answers, [["custom", "随便"]]);
  const without = draw([{ type: "ask", ask: { ...ask, allow_custom: false } }], { onAnswerAsk: async () => {} }).children[0];
  assert.equal(without.all().some((node) => node.tag === "input"), false);
});
