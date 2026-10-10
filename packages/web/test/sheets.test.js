import assert from "node:assert/strict";
import test from "node:test";
import { fold, initialView } from "../js/project.js";
import { renderActivitySheet } from "../js/sheet-activity.js";
import { safeActivityView } from "../js/sheet-agent.js";
import { normalizeClockList, repeatText, renderUpcomingSheet } from "../js/sheet-upcoming.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; this.value = ""; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
}
function findAll(element, predicate) {
  return [...(predicate(element) ? [element] : []), ...(element.children ?? []).flatMap((child) => findAll(child, predicate))];
}
const withDom = async (fn) => { globalThis.document = { createElement: (tag) => new Node(tag) }; try { await fn(); } finally { delete globalThis.document; } };
const message = (seq, fields) => ({ seq, ts: seq * 1000, id: `m${seq}`, kind: "event", to: null, body: {}, ...fields });
const replay = (messages) => messages.reduce((view, item) => fold(view, item), initialView());
const started = (seq, turn, fields = {}) => message(seq, { from: "agent:main", word: "turn.started", body: { turn, lane: "front", ids: [], ...fields } });
const ended = (seq, turn, outcome = "completed") => message(seq, { from: "agent:main", word: "turn.ended", body: { turn, outcome } });
const tool = (seq, turn, phase, name, summary) => message(seq, { from: "agent:main", word: "agent.tool", body: { turn, name, phase, summary, ok: true } });

test("a native tool call shows its summary and keeps raw route names and arguments out of the activity page", async () => withDom(async () => {
  const view = replay([
    started(1, "t_native"),
    tool(2, "t_native", "start", "read", "读取文件"),
    tool(3, "t_native", "end", "read", "读取文件"),
    message(4, { id: "call", kind: "request", from: "agent:main", to: "service:dsh-tool", word: "read", turn: "t_native", body: { arguments: "SECRET_FILE_PATH" } }),
    ended(5, "t_native"),
  ]);
  const safe = safeActivityView(view);
  assert.ok(safe.turns.t_native.steps.some((step) => step.label === "读取文件" && step.state === "ok"));
  const root = new Node("root");
  renderActivitySheet(root, safe);
  assert.match(root.textContent, /读取文件/);
  assert.match(root.textContent, /调用完成/);
  assert.doesNotMatch(root.textContent, /service:dsh-tool|SECRET_/);
}));

test("activity groups a real batch by turn, separates background work, and omits tool bodies", async () => withDom(async () => {
  const view = replay([
    message(1, { id: "a", kind: "request", from: "person:owner", to: "agent:main", word: "say", body: { text: "查一下天气" } }),
    message(2, { id: "b", kind: "request", from: "person:owner", to: "agent:main", word: "say", body: { text: "还有日程" } }),
    started(3, "t_one", { ids: ["a", "b"] }),
    message(4, { id: "tool", kind: "request", from: "agent:main", to: "device:phone", word: "calendar.list", turn: "t_one", body: { private: "SECRET_ARGUMENT" } }),
    message(5, { kind: "response", from: "device:phone", to: "agent:main", word: "calendar.list", reply_to: "tool", body: { ok: true, result: { data: { private: "SECRET_RESULT" } } } }),
    ended(6, "t_one"),
    started(7, "t_bg", { lane: "heartbeat" }),
    ended(8, "t_bg"),
  ]);
  const safe = safeActivityView(view);
  assert.equal(safe.turns.t_bg.background, true);
  assert.equal(safe.turns.t_bg.outcome, "completed", "a background turn ends like any other");
  const root = new Node("root");
  let prefill;
  let opened = null;
  renderActivitySheet(root, safe, { askAbout: (value) => { prefill = value; }, now: 9000, onToggleBackground: (open) => { opened = open; } });
  assert.equal(root.children.length, 4);
  assert.equal(root.children[0].textContent, "今天", "conversations are grouped by day");
  assert.match(root.children[0].className, /activity-group/);
  assert.match(root.children[1].textContent, /查一下天气 · 2 条/);
  assert.match(root.children[1].textContent, /calendar.list · 调用完成/);
  assert.match(root.children[1].textContent, /完成了 · 用时 3 秒/, "the outcome is said in plain words");
  assert.match(root.children[2].textContent, /^后台任务 · 1 项/);
  assert.equal(root.children[3].hidden, true, "background work starts collapsed");
  assert.equal(root.children[3].children[0].dataset.turn, "t_bg");
  assert.match(root.children[3].textContent, /在后台工作/);
  root.children[2].listeners.click();
  assert.equal(opened, true);
  assert.equal(JSON.stringify(view).includes("SECRET_"), false);
  assert.equal(root.textContent.includes("SECRET_"), false);
  findAll(root.children[1], (child) => child.tag === "button")[0].listeners.click();
  assert.deepEqual(prefill, { turn: "t_one", text: "关于查一下天气 · 2 条，" });
}));

test("the safe view drops raw route words from step labels, keeps web details and accepts any ledger turn id", () => {
  const view = { turns: {
    t_one: { title: "查天气", started: 1000, steps: [
      { label: "service:self · write", requestId: "raw" }, { label: "calendar.search", ts: 1000 },
      { label: "正在查找", ts: 1001 }, { label: "在看网页 · nba.com", ts: 1002 }, { label: "raw tool", tool: "bash", ts: 1003 },
    ] },
    "9f3c-uuid": { title: "", background: true, started: 2000, outcome: "done", steps: [{ label: "x".repeat(200) }] },
    "bad id!": { title: "no", started: 3000, steps: [] },
  } };
  const safe = safeActivityView(view);
  assert.deepEqual(safe.turns.t_one.steps.map((step) => step.label), ["正在查找", "在看网页 · nba.com", "raw tool"]);
  assert.equal(JSON.stringify(safe).includes("service:self"), false);
  assert.equal(safe.turns["9f3c-uuid"].title, "后台任务");
  assert.equal(safe.turns["9f3c-uuid"].outcome, undefined, "the old background outcomes do not exist any more");
  assert.deepEqual(safe.turns["9f3c-uuid"].steps, []);
  assert.equal(safe.turns["bad id!"], undefined);
});

test("a step with a request id offers details that load in pieces", async () => withDom(async () => {
  const root = new Node("root");
  const asked = [];
  const view = { turns: { t_one: { title: "查天气", started: 1000, ended: 2000, outcome: "completed", steps: [{ label: "读取文件", tool: "read", state: "ok", ts: 1000, ended: 1500, requestId: "req-1" }] } } };
  renderActivitySheet(root, view, { now: 3000, loadDetails: async (id, offset) => {
    asked.push([id, offset]);
    return offset === 0 ? { text: "first part", next_offset: 5 } : { text: " second part", next_offset: null };
  } });
  const details = findAll(root, (child) => child.tag === "details")[0];
  details.open = true;
  details.listeners.toggle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(root.textContent, /first part/);
  const more = findAll(root, (child) => child.tag === "button" && child.value === "继续查看")[0];
  await more.listeners.click();
  assert.match(root.textContent, /first part second part/);
  assert.deepEqual(asked, [["req-1", 0], ["req-1", 5]]);
}));

test("clock list data is checked before it is shown; a malformed timer is an error, never an empty list", () => {
  const timer = { id: "timer1", next: 999999999999, every: null, to: "agent:main", word: "say", label: "带伞", blocked: null };
  assert.deepEqual(normalizeClockList({ timers: [timer] }), [{ ...timer, every: null, blocked: null }]);
  assert.deepEqual(normalizeClockList({ timers: [] }), []);
  for (const bad of [undefined, {}, { timers: "x" }, { timers: [{ id: "bad", next: "tomorrow" }] }, { timers: [{ id: "", next: 1 }] },
    { timers: [{ id: "a", next: 1, every: 5 }] }, { timers: [{ id: "a", next: 1, label: "calendar.search" }] },
    { timers: [{ id: "a", next: 1, label: "带伞", blocked: "service:clock list failed" }] }])
    assert.throws(() => normalizeClockList(bad), /暂时读不到计划（不代表没有）/);
});

test("the upcoming sheet groups timers by day, arms deletion with a first tap, and waits for the cancel", async () => withDom(async () => {
  const timers = normalizeClockList({ timers: [{ id: "t1", next: Date.now() + 3_600_000, every: 86_400, label: "带伞" }] });
  const root = new Node("root");
  const cancelled = [];
  renderUpcomingSheet(root, timers, { onCancel: async (id) => { cancelled.push(id); } });
  assert.match(root.textContent, /带伞/);
  assert.match(root.textContent, /每天/);
  const button = findAll(root, (child) => child.tag === "button")[0];
  await button.listeners.click();
  assert.deepEqual(cancelled, [], "the first tap only explains what will be lost");
  assert.equal(button.value, "确认删除");
  assert.match(root.textContent, /以后都不会再有了/);
  await button.listeners.click();
  assert.deepEqual(cancelled, ["t1"]);
  renderUpcomingSheet(root, [], { name: "小舟" });
  assert.match(root.textContent, /暂无计划。小舟答应到点做的事/);
  assert.equal(repeatText(null), "只一次");
  assert.equal(repeatText(604_800), "每周");
}));

test("a failed cancel shows the failure and offers another try", async () => withDom(async () => {
  const root = new Node("root");
  renderUpcomingSheet(root, normalizeClockList({ timers: [{ id: "t", next: 999999999999, label: "later" }] }), { onCancel: async () => { throw new Error("没能删除这条计划，它还在。"); } });
  const cancel = findAll(root, (child) => child.tag === "button")[0];
  await cancel.listeners.click();
  await cancel.listeners.click();
  assert.match(root.textContent, /没能删除这条计划/);
  assert.match(root.textContent, /later/);
  assert.equal(cancel.value, "再试一次");
}));

test("clock blocked diagnostic is rendered as a fixed human message", async () => withDom(async () => {
  const timers = normalizeClockList({ timers: [{ id: "tmr_x", next: 1000, label: "带伞", blocked: "internal_adapter_timeout" }] });
  const root = new Node("root");
  renderUpcomingSheet(root, timers);
  assert.match(root.textContent, /暂时没法执行：请稍后再看/);
  assert.doesNotMatch(root.textContent, /internal_adapter_timeout/);
}));
