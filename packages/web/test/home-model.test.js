import assert from "node:assert/strict";
import test from "node:test";
import { HomeFeed } from "../js/home-feed.js";
import { activityByDay, chipLabel, dayItems, groupMemory, memoryChip, memoryChips, memoryCount, nextUp, occurrences, turnsToday, urgentGroup, waitingItems, weekStrip } from "../js/home-model.js";
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

test("a memory line becomes a short label: the half before the colon, else the first clause, 12 characters at most", () => {
  assert.equal(memoryChip("生日：3月5日，每年都想收到卡片"), "生日");
  assert.equal(memoryChip("偏好: 咖啡不加糖"), "偏好");
  assert.equal(memoryChip("对花生过敏，吃了会起疹子"), "对花生过敏");
  assert.equal(memoryChip("喜欢安静的地方。不爱热闹"), "喜欢安静的地方");
  assert.equal(memoryChip("先A；再B"), "先A");
  assert.equal(memoryChip("苹果、香蕉和橙子"), "苹果");
  assert.equal(memoryChip("住杭州"), "住杭州", "no colon, no punctuation: the whole line");
  assert.equal(memoryChip("每天 7:30 起床"), "每天 7:30 起床", "a time is not a colon");
  assert.equal(memoryChip("：只有后半句"), "只有后半句", "nothing before the colon: the line itself");
  assert.equal(memoryChip("  "), "");
  assert.equal(memoryChip("一二三四五六七八九十甲乙"), "一二三四五六七八九十甲乙", "12 characters stay whole");
  assert.equal(memoryChip("一二三四五六七八九十甲乙丙"), "一二三四五六七八九十甲…", "13 become 11 and an ellipsis");
  assert.equal(memoryChip("主人的生日是三月五日并且不喜欢惊喜：详情"), "主人的生日是三月五日并…");
});

test("labels count characters the reader sees: an emoji is one, and is never cut in half", () => {
  const fourteen = "😀".repeat(14);
  assert.equal(memoryChip(fourteen), `${"😀".repeat(11)}…`);
  assert.equal(memoryChip("😀".repeat(12)), "😀".repeat(12));
  const family = "👩‍👩‍👧";
  assert.equal(memoryChip(`${family.repeat(12)}`), family.repeat(12), "a joined emoji counts once");
  assert.equal(memoryChip(`${family.repeat(13)}`), `${family.repeat(11)}…`);
  assert.equal(memoryChip("é".normalize("NFD").repeat(13)), `${"é".normalize("NFD").repeat(11)}…`, "a letter with its accent is one");
  assert.equal(memoryChip("𠮷".repeat(13)), `${"𠮷".repeat(11)}…`, "a character outside the BMP is one");
});

test("the home page shows five labels in all: every line up to five, else four and 'N more', the urgent group's first", () => {
  const groups = groupMemory("## 生活\n- 住杭州：西湖边\n- 开电车\n- 养了一只猫，叫团子\n## 要紧的\n- 对花生过敏\n- 不吃香菜\n## 习惯\n- 早起\n- 爱跑步\n");
  const { chips, more } = memoryChips(groups);
  assert.deepEqual(chips.map((chip) => chip.text), ["对花生过敏", "不吃香菜", "住杭州", "开电车"]);
  assert.deepEqual(chips.map((chip) => chip.urgent), [true, true, false, false]);
  assert.equal(more, 3, "seven lines: four shown, N = 7 - 4");
  const five = memoryChips(groupMemory("## 生活\n- 甲\n- 乙\n- 丙\n- 丁\n- 戊\n"));
  assert.deepEqual([five.chips.length, five.more], [5, 0], "exactly five: all shown, no 'more' label");
  const six = memoryChips(groupMemory("## 生活\n- 甲\n- 乙\n- 丙\n- 丁\n- 戊\n- 己\n"));
  assert.deepEqual([six.chips.length, six.more], [4, 2], "six: four and 'N more' where N = 6 - 4");
  assert.deepEqual(memoryChips(groupMemory("## 生活\n- 住杭州\n")), { chips: [{ text: "住杭州", urgent: false }], more: 0 });
  assert.deepEqual(memoryChips(null), { chips: [], more: 0 });
  assert.equal(memoryCount(groups), 7, "the page behind it still lists every line in full");
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
