import assert from "node:assert/strict";
import test from "node:test";
import { HomeFeed } from "../js/home-feed.js";
import { activityByDay, chipLabel, dayItems, groupMemory, memoryCount, nextUp, occurrences, turnsToday, urgentGroup, waitingItems, weekStrip } from "../js/home-model.js";
import { quoteOf } from "../js/home-data.js";
import { fold, initialView, projectMessages } from "../js/project.js";

const DAY = 86_400_000;
const message = (seq, fields) => ({ seq, ts: seq * 1000, id: `m${seq}`, kind: "event", to: null, body: {}, ...fields });
const started = (seq, turn, fields = {}, ts) => message(seq, { ts, from: "agent:main", word: "turn.started", body: { turn, lane: "front", ids: [], ...fields } });
const ask = (seq, fields = {}) => message(seq, { id: `ask${seq}`, kind: "request", from: "agent:main", to: "person:owner", word: "ask", ts: Date.now(),
  body: { title: "订哪个？", human_kind: "question", expires_at: Date.now() + 3_600_000, options: [{ id: "a", label: "甲" }], ...fields.body }, ...fields.top });
const gate = (seq) => ask(seq, { top: { from: "service:gate" }, body: { title: "要发消息", human_kind: "confirmation", options: [{ id: "once", label: "允许这一次" }, { id: "deny", label: "不允许" }] } });

test("a batch of ledger rows projects to the same view as folding them one by one", () => {
  const rows = [message(1, { from: "person:owner", to: "agent:main", kind: "request", word: "say", id: "a", body: { text: "hi" } }), started(2, "t1", { ids: ["a"] }), message(3, { from: "agent:main", word: "turn.ended", body: { turn: "t1", outcome: "completed" } })];
  const folded = rows.reduce((view, row) => fold(view, row), initialView());
  const batch = projectMessages([...rows].reverse());
  assert.deepEqual(batch.turns, folded.turns);
  assert.deepEqual(batch.conversation, folded.conversation);
});

test("the home retains only the authoritative current page and ignores late snapshots", () => {
  const feed = new HomeFeed();
  const page = (seq, id) => ({ dataset_id: "one", snapshot_seq: seq, items: [{ ask: { id, state: "pending" } }], total_count: 10000,
    presence: { state: "waiting_you" }, progress: null });
  feed.setCurrent(page(2, "a"));
  const first = feed.view();
  assert.equal(feed.view(), first);
  assert.equal(first.waiting_count, 10000, "counts do not come from the bounded page");
  feed.setCurrent(page(1, "old"));
  assert.equal(feed.view(), first);
  feed.setCurrent(page(3, "b"));
  assert.deepEqual(feed.view().asks.map(item => item.id), ["b"]);
  assert.equal(feed.rows, undefined, "the home has no second ledger cache");
  feed.reset();
  assert.deepEqual(feed.view().asks, []);
});

test("what waits for you: approvals first, then questions; answered, expired and other people's rows do not", () => {
  const view = projectMessages([gate(1), ask(2), ask(3, { body: { expires_at: Date.now() - 1000 } }), { ...ask(4), id: "answered" },
    message(5, { kind: "response", word: "ask", from: "person:owner", to: "agent:main", reply_to: "answered", body: { ok: true, result: { data: { choice: "a" } } } })]);
  assert.deepEqual(waitingItems(view).map((item) => [item.kind, item.ask.id]), [["approval", "ask1"], ["question", "ask2"]]);
});

test("today's turns are counted per agent; the days are newest first with background work apart", () => {
  const now = Date.now();
  const view = projectMessages([started(1, "t1", {}, now - 1000), started(2, "t2", { lane: "back" }, now - 2000), { ...started(3, "t3", {}, now - 2 * DAY), from: "agent:xiao" }]);
  assert.equal(turnsToday(view, now), 2);
  assert.equal(turnsToday(view, now, "agent:xiao"), 0);
  const days = activityByDay(view, now);
  assert.equal(days.length, 2);
  assert.deepEqual([days[0].front.map((t) => t.id), days[0].back.map((t) => t.id)], [["t1"], ["t2"]]);
  assert.equal(chipLabel(days[0].day, now), "今天");
  assert.equal(chipLabel(now - DAY, now), "昨天");
});

test("memory is one group per second-level heading and one row per line", () => {
  const groups = groupMemory("# 关于你\n\n开头一句\n## 生活\n- 住杭州\n- **开电车**，充电在 `B2`\n## 要紧的\n1. 对花生过敏\n\n---\n## 空的\n");
  assert.deepEqual(groups, [{ title: "", items: ["开头一句"] }, { title: "生活", items: ["住杭州", "开电车，充电在 B2"] }, { title: "要紧的", items: ["对花生过敏"] }]);
  assert.equal(memoryCount(groups), 4);
  assert.equal(urgentGroup("要紧的"), true);
  assert.equal(urgentGroup("生活"), false);
  assert.deepEqual(groupMemory(""), []);
});

test("a repeating timer falls on every day of its repeat; the week strip counts what happens each day", () => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const at = today.getTime() + 22 * 3_600_000;
  const daily = { id: "d", next: at, every: 86_400 };
  const once = { id: "o", next: at + 2 * DAY + 3_600_000 };
  assert.equal(occurrences(daily, today.getTime(), today.getTime() + 7 * DAY).length, 7);
  assert.deepEqual(occurrences(once, today.getTime(), today.getTime() + DAY), []);
  const week = weekStrip([daily, once], today.getTime() + 3_600_000);
  assert.equal(week.length, 7);
  assert.deepEqual(week.map((day) => day.count), [1, 1, 2, 1, 1, 1, 1]);
  assert.deepEqual(dayItems([daily, once], today.getTime() + 2 * DAY).map((item) => item.timer.id), ["d", "o"]);
  assert.deepEqual(nextUp([once, daily], 1).map((timer) => timer.id), ["d"]);
});

test("the quote on the home page has no headings or list marks and is cut at a length", () => {
  assert.equal(quoteOf("# 灵魂\n\n我叫 Ash。\n- 说话**简短**\n"), "我叫 Ash。说话简短");
  assert.equal([...quoteOf("字".repeat(200), 10)].length, 11);
});
