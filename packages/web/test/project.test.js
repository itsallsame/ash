import assert from "node:assert/strict";
import test from "node:test";
import { fold, initialView } from "../js/project.js";

const message = (entry, i) => ({ seq: i + 1, id: `m${i + 1}`, ts: (i + 1) * 1000, to: null, summary: "", size: 1, ...entry });
const replay = (entries) => entries.reduce((state, entry, i) => fold(state, message(entry, i)), initialView());
const OWNER = "person:owner";
const say = (text, extra = {}) => ({ id: "q", from: OWNER, to: "agent:main", kind: "request", word: "say", body: { text }, ...extra });
const agentSays = (text, extra = {}) => ({ from: "agent:main", to: OWNER, kind: "request", word: "say", body: { text }, ...extra });
const turnStarted = (turn, extra = {}) => ({ from: "agent:main", kind: "event", word: "turn.started", turn, body: { turn, lane: "front", ...extra } });
const turnEnded = (turn, outcome = "completed") => ({ from: "agent:main", kind: "event", word: "turn.ended", turn, body: { turn, lane: "front", outcome } });

test("fold is pure and idempotent across duplicate delivery and history replay", () => {
  assert.deepEqual(Object.keys(initialView()).sort(), ["asks", "conversation", "presence", "turns"]);
  const owner = message(say("hi"), 0);
  const first = fold(initialView(), owner);
  assert.equal(fold(first, owner), first);
  assert.equal(initialView().conversation.length, 0);
  assert.equal(first.conversation[0].delivery, "sent");
  // rows may arrive out of order (an older page is folded after a newer one)
  const state = fold(fold(initialView(), message(agentSays("later"), 4)), message(agentSays("earlier"), 1));
  assert.deepEqual(state.conversation.map((item) => item.seq), [2, 5]);
});

test("delivery goes sent, delivered (the agent took the say), read (a turn was started with it)", () => {
  const sent = replay([say("hi")]);
  assert.equal(sent.conversation[0].delivery, "sent");
  const delivered = replay([say("hi"), { from: "agent:main", to: OWNER, kind: "response", word: "say", reply_to: "q", body: { ok: true, result: { data: { accepted: true } } } }]);
  assert.equal(delivered.conversation[0].delivery, "delivered");
  const read = replay([say("hi"), turnStarted("t1", { ids: ["q"] }), { from: "agent:main", to: OWNER, kind: "response", word: "say", reply_to: "q", body: { ok: true, result: { data: { accepted: true } } } }]);
  assert.equal(read.conversation[0].delivery, "read", "reading is not undone by a late acknowledgement");
});

test("a turn is its start, its tool calls and its end; the front lane is the conversation, any other lane is background", () => {
  const state = replay([
    say("查一下订单"),
    turnStarted("t1", { ids: ["q"] }),
    { from: "agent:main", kind: "event", word: "agent.tool", turn: "t1", body: { turn: "t1", name: "web_search", phase: "start", summary: "在搜索 订单" } },
    { from: "agent:main", kind: "event", word: "agent.tool", turn: "t1", body: { turn: "t1", name: "web_search", phase: "end", ok: true } },
    turnEnded("t1"),
    { from: "agent:main", kind: "event", word: "turn.started", turn: "t2", body: { turn: "t2", lane: "back" } },
    { from: "agent:main", kind: "event", word: "turn.ended", turn: "t2", body: { turn: "t2", lane: "back", outcome: "interrupted" } },
  ]);
  assert.equal(state.turns.t1.title, "查一下订单");
  assert.equal(state.turns.t1.background, false);
  assert.deepEqual(state.turns.t1.steps.map(({ label, state: s, tool }) => ({ label, s, tool })), [{ label: "在搜索 订单", s: "ok", tool: undefined }], "the raw tool name is not shown");
  assert.equal(state.turns.t1.outcome, "completed");
  assert.equal(state.turns.t2.background, true);
  assert.equal(state.turns.t2.outcome, "cancelled", "an interrupted turn reads as cancelled on the activity page");
});

test("requests an agent makes of the members during a turn become steps, with their answers; secrets in arguments never enter the view", () => {
  const state = replay([
    turnStarted("t1"),
    { id: "call", from: "agent:main", to: "service:clock", kind: "request", word: "set", turn: "t1", body: { at: 1, to: "agent:main", word: "wake", body: { token: "SECRET" }, label: "x" } },
    { from: "service:clock", to: "agent:main", kind: "response", word: "set", reply_to: "call", body: { ok: true, result: { data: { id: "c1", next: 2 } } } },
    { id: "fail", from: "agent:main", to: "device:abcdefghijklmnopqrstuv", kind: "request", word: "screen.tap", turn: "t1", body: { x: 1 } },
    { from: "device:abcdefghijklmnopqrstuv", to: "agent:main", kind: "response", word: "screen.tap", reply_to: "fail", body: { ok: false, error: { code: "offline", message: "off" } } },
  ]);
  const steps = state.turns.t1.steps;
  assert.deepEqual(steps.map((step) => [step.requestId, step.state]), [["call", "ok"], ["fail", "failed"]]);
  assert.equal(JSON.stringify(state).includes("SECRET"), false);
});

test("presence follows the ledger: working while a front turn is open, waiting for you while a question is open, else here", () => {
  assert.equal(replay([]).presence.state, "idle");
  const working = replay([turnStarted("t1")]);
  assert.equal(working.presence.state, "thinking");
  const tool = replay([turnStarted("t1"), { from: "agent:main", kind: "event", word: "agent.tool", turn: "t1", body: { turn: "t1", name: "read", phase: "start", summary: "在看文件" } }]);
  assert.deepEqual([tool.presence.state, tool.presence.text], ["working", "在看文件"]);
  assert.equal(replay([turnStarted("t1"), turnEnded("t1")]).presence.state, "idle");
  const back = replay([{ from: "agent:main", kind: "event", word: "turn.started", turn: "b1", body: { turn: "b1", lane: "back" } }]);
  assert.equal(back.presence.state, "idle", "background work does not make her look busy in the conversation");
  const asking = replay([{ id: "a", ts: Date.now(), from: "agent:main", to: OWNER, kind: "request", word: "ask", body: { title: "OK?", human_kind: "confirmation", expires_at: Date.now() + 60_000 } }]);
  assert.equal(asking.presence.state, "waiting_you");
});

test("an ask: options as given, yes/no for a confirmation without options, 24 hours unless told, 7 at most", () => {
  const gate = replay([{ id: "g", from: "service:gate", to: OWNER, kind: "request", word: "ask", body: { title: "Allow?", human_kind: "confirmation", options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }], expires_at: 9999 } }]);
  assert.deepEqual(gate.asks[0].options.map((option) => option.id), ["once", "deny"]);
  assert.equal(gate.asks[0].expires_at, 9999);
  const confirm = replay([{ id: "c", from: "agent:main", to: OWNER, kind: "request", word: "ask", body: { title: "OK?", human_kind: "confirmation" } }]);
  assert.deepEqual(confirm.asks[0].options, [{ id: "yes", label: "是" }, { id: "no", label: "否" }]);
  assert.equal(confirm.asks[0].options_valid, true);
  assert.equal(confirm.asks[0].expires_at, 1000 + 86_400_000);
  const long = replay([{ id: "l", from: "agent:main", to: OWNER, kind: "request", word: "ask", body: { title: "?", options: [{ id: "a", label: "A" }], expires_at: 1000 + 30 * 86_400_000 } }]);
  assert.equal(long.asks[0].expires_at, 1000 + 7 * 86_400_000);
  const noOptions = replay([{ id: "n", from: "agent:main", to: OWNER, kind: "request", word: "ask", body: { title: "?" } }]);
  assert.equal(noOptions.asks[0].options_valid, false, "a question without options cannot be answered by a button");
});

test("any response to an ask closes the card: the choice, a timeout, or a cancel; the first one counts", () => {
  const ask = { id: "a", from: "service:gate", to: OWNER, kind: "request", word: "ask", body: { title: "Allow?", options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }], expires_at: 99_999 } };
  const answer = (id, body) => ({ id, from: OWNER, to: "service:gate", kind: "response", word: "ask", reply_to: "a", body });
  const choice = replay([ask, answer("r1", { ok: true, result: { data: { choice: "deny" } } }), answer("r2", { ok: true, result: { data: { choice: "once" } } })]);
  assert.deepEqual([choice.asks[0].state, choice.asks[0].choice], ["answered", "deny"]);
  assert.equal(replay([ask, answer("r1", { ok: false, error: { code: "timeout", message: "t" } })]).asks[0].state, "expired");
  assert.equal(replay([ask, answer("r1", { ok: false, error: { code: "cancelled", message: "c" } })]).asks[0].state, "closed");
  const custom = replay([{ ...ask, body: { ...ask.body, human_kind: "question", allow_custom: true } }, answer("r1", { ok: true, result: { data: { choice: "custom", text: "later" } } })]);
  assert.deepEqual([custom.asks[0].state, custom.asks[0].answer_text], ["answered", "later"]);
  assert.equal(replay([ask]).asks[0].state, "pending");
});

test("only the gate's own snapshot is shown as the original of an approval", () => {
  const body = { title: "Allow?", options: [{ id: "once", label: "Once" }], expires_at: 9999, source: { word: "shell.run", to: "device:p", body_preview: "p", body_full: "FULL" } };
  assert.equal(replay([{ id: "a", from: "service:gate", to: OWNER, kind: "request", word: "ask", body }]).asks[0].original, "FULL");
  assert.equal(replay([{ id: "a", from: "agent:main", to: OWNER, kind: "request", word: "ask", body }]).asks[0].original, undefined);
});

test("cards: options lock when an offered option was sent back; show/react/app cards project", () => {
  const card = { id: "card", from: "agent:main", to: OWNER, kind: "request", word: "show", body: { card: { type: "options", options: [{ id: "yes", text: "Yes" }] } } };
  const reply = say("Yes", { id: "answer", body: { text: "Yes", in_reply_to: "card", option_id: "yes" } });
  const state = replay([card, reply]);
  assert.equal(state.conversation[0].locked, true);
  assert.equal(state.conversation[0].selected_option_id, "yes");
  const react = replay([agentSays("hi", { id: "s" }), { from: "agent:main", to: OWNER, kind: "request", word: "react", body: { message_id: "s", emoji: "👍" } }]);
  assert.deepEqual(react.conversation[0].reactions.map((item) => item.emoji), ["👍"]);
  const app = replay([{ from: "app:health", to: OWNER, kind: "event", word: "card", body: { title: "今天", text: "7000 步", name: "健康" } }]);
  assert.deepEqual([app.conversation[0].card.type, app.conversation[0].card.app], ["app", "health"]);
});

test("a long text keeps the ledger's short version and where the whole is; attachments are references, never bytes", () => {
  const blob = (n) => ({ $blob: "a".repeat(64), mime: "text/plain", size: n, summary: "start…end" });
  const state = replay([say("x", { body: { text: blob(9000), attachments: [
    { name: "a.png", mime_type: "image/png", data: "QUJD" },
    { name: "big.png", mime_type: "image/png", data: blob(4_000_000) },
    { name: "report.pdf", mime_type: "application/pdf", workspace: "main", path: "out/report.pdf", size: 10 },
    { name: "evil", mime_type: "x/y", workspace: "main", path: "../x", size: 1 },
  ] } })]);
  const item = state.conversation[0];
  assert.deepEqual([item.text, item.full], ["start…end", "a".repeat(64)]);
  assert.deepEqual(item.attachments.map((a) => [a.source ?? "file", a.name, a.size]), [["inline", "a.png", 3], ["inline", "big.png", 3_000_000], ["file", "report.pdf", 10]]);
  assert.equal(JSON.stringify(item).includes("QUJD"), false);
  const onlyFile = replay([say("", { body: { attachments: [{ name: "a.png", mime_type: "image/png", data: "QUJD" }] } })]);
  assert.equal(onlyFile.conversation.length, 1, "a message of attachments alone is a message");
});

test("rows the page does not know, events of other members, and raw tool data never enter the view", () => {
  let state = initialView();
  state = fold(state, { event: "screen.registered", data: { token: "secret" } });
  assert.deepEqual(state, initialView());
  state = replay([
    { from: "service:link", kind: "event", word: "connected", body: { hand: "x", conn: "c" } },
    { from: "service:admin", kind: "event", word: "settings.changed", body: { keys: ["delivery.quiet_hours"] } },
    { from: "device:abcdefghijklmnopqrstuv", to: "agent:main", kind: "response", word: "shell.run", reply_to: "none", body: { ok: true, result: { data: { args: "secret command" } } } },
    turnStarted("__proto__"),
  ]);
  assert.equal(JSON.stringify(state).includes("secret"), false);
  assert.deepEqual(Object.keys(state.turns), ["__proto__"].filter((k) => Object.hasOwn(state.turns, k)));
});
