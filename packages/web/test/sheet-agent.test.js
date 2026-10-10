import assert from "node:assert/strict";
import test from "node:test";
import { fold, initialView } from "../js/project.js";
import { unwrap } from "../js/link.js";
import { AgentSheet, cancelClock, listClock, safeActivityView } from "../js/sheet-agent.js";
import { approvalSections } from "../js/sheet-approvals.js";
import { startKernel } from "./kernel.js";
import { netFor, until } from "./support.js";

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.hidden = false;
    const classes = new Set();
    this.classList = { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value) };
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value ?? "") + this.children.map((child) => child.textContent).join(""); }
  querySelector(selector) { return this.named?.[selector]; }
}
function findAll(element, predicate) {
  return [...(predicate(element) ? [element] : []), ...element.children.flatMap((child) => findAll(child, predicate))];
}
const settle = async (times = 4) => { for (let n = 0; n < times; n++) await new Promise((resolve) => setImmediate(resolve)); };
const button = (section, label) => findAll(section, (item) => item.tag === "button" && item.textContent === label)[0];

/**
 * The part of Net the sheets use, scripted: handlers are keyed "<member>/<word>" and answer with data or a full Reply.
 * [lose] ends the connection, [reconnect] opens another one.
 */
function fakeNet({ local = true, handlers = {} } = {}) {
  const defaults = {
    "service:persona/get": (body) => ({ files: [{ file: body.file ?? "SOUL.md", content: "沉着、好奇", version: "v1" }] }),
    "body:main/workspace.read": (body) => ({ path: body.path, text: `内容 ${body.path}`, truncated: false }),
  };
  const net = { session: "s1", generation: 1, local, primary: "agent:main", calls: [], answers: [], handlers: { ...defaults, ...handlers },
    binding() { return { session: this.session, generation: this.generation }; },
    same(binding) { return Boolean(binding?.session) && binding.session === this.session && binding.generation === this.generation; },
    async call(to, word, body = {}, options) {
      this.calls.push({ to, word, body, options });
      const handler = this.handlers[`${to}/${word}`];
      if (handler === undefined) return { ok: false, error: { code: "not_found", message: `${to}/${word}` } };
      const given = typeof handler === "function" ? await handler(body, options) : handler;
      return given && typeof given.ok === "boolean" ? given : { ok: true, result: { data: given } };
    },
    async data(to, word, body, options) { return unwrap(await this.call(to, word, body, options)); },
    async answerAsk(ask, answer, clientId) { this.answers.push({ ask: ask.id, answer, clientId }); const script = this.handlers.answer; return typeof script === "function" ? script(this.answers.length) : script; },
    lose() { this.session = null; this.generation++; },
    reconnect() { this.session = `s${this.generation + 1}`; this.generation++; },
    words(to) { return this.calls.filter((call) => call.to === to).map((call) => call.word); } };
  return net;
}

function fixture({ net = fakeNet(), getView = () => ({ turns: {} }), onAskAbout = () => {}, onPrefill, onIdentityChanged, idFactory = () => "cancel-client-one" } = {}) {
  globalThis.document = { createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment") };
  const root = new Element("aside");
  root.named = { "#agentTabs": new Element("nav"), "#agentPanel": new Element("div"), "#agentClose": new Element("button") };
  const sheet = new AgentSheet(root, net, { confirmDiscard: () => false, getView, onAskAbout, onPrefill, onIdentityChanged, idFactory });
  return { root, net, sheet };
}
const done = (f) => { f.sheet.reset(); delete globalThis.document; };

const clockList = (timers) => ({ "service:clock/list": { timers } });
const aTimer = { id: "tmr_a", next: 100000, every: null, label: "带伞", blocked: null };

test("five tabs show safe activity, and a failed clock or gate never claims empty", async () => {
  const f = fixture();
  try {
    f.sheet.open();
    await settle();
    assert.deepEqual(f.root.named["#agentTabs"].children.map((item) => item.textContent), ["身份", "记忆", "活动", "计划", "审批"]);
    assert.equal(f.sheet.activeTab, "identity", "the page opens on who she is");
    await f.sheet.show("activity");
    assert.match(f.sheet.panels.get("activity").textContent, /还没有活动记录/);
    assert.doesNotMatch(f.sheet.panels.get("activity").textContent, /service:|bash|web_search/);
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /暂时读不到计划（不代表没有）/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /暂无计划/);
    assert.ok(button(f.sheet.panels.get("upcoming"), "重试"), "failure offers a plain retry");
    await f.sheet.show("approvals");
    assert.match(f.sheet.panels.get("approvals").textContent, /正在读取/, "history and rules load by themselves");
    await settle();
    assert.match(f.sheet.panels.get("approvals").textContent, /现在没有要你决定的事/);
    assert.match(f.sheet.panels.get("approvals").textContent, /暂时读不到这些规则（不代表没有）/);
    assert.deepEqual(f.net.words("service:gate"), ["history", "rules.list"]);
  } finally { done(f); }
});

test("activity question passes a turn-linked prefill to the composer callback", async () => {
  let asked = null;
  const f = fixture({ getView: () => ({ turns: { t_one: { title: "查天气", started: 1000, steps: [] } } }), onAskAbout: (value) => { asked = value; } });
  try {
    f.sheet.open();
    await settle();
    await f.sheet.show("activity");
    const section = f.sheet.panels.get("activity");
    const turn = findAll(section, (child) => child.dataset.turn === "t_one")[0];
    assert.match(section.textContent, /今天|\d+月\d+日/, "turns are grouped under a day");
    const ask = findAll(turn, (child) => child.tag === "button")[0];
    assert.equal(ask.textContent, "问问她这件事");
    ask.listeners.click();
    assert.deepEqual(asked, { turn: "t_one", text: "关于查天气，" });
  } finally { done(f); }
});

test("activity strips raw route words, keeps background work apart, and a live clock list offers cancellation", async () => {
  const view = { turns: { t_one: { title: "查天气", started: 1000, steps: [
    { label: "service:self · write", requestId: "raw" }, { label: "calendar.search", ts: 1000 },
    { label: "正在查找", ts: 1001 }, { label: "在看网页 · nba.com", ts: 1002 },
  ] }, t_bg: { title: "main 在后台工作", background: true, started: 2000, outcome: "completed", steps: [{ label: "读文件", tool: "read", state: "ok", ts: 2000 }, { label: "service:self", ts: 2001 }] } } };
  assert.equal(JSON.stringify(safeActivityView(view)).includes("service:self"), false);
  const f = fixture({ getView: () => view, net: fakeNet({ handlers: clockList([aTimer]) }) });
  try {
    f.sheet.open();
    await settle();
    await f.sheet.show("activity");
    const activity = f.sheet.panels.get("activity").textContent;
    assert.match(activity, /查天气.*正在查找.*在看网页 · nba\.com/s);
    assert.match(activity, /后台任务 · 1 项.*main 在后台工作.*读文件/s);
    assert.doesNotMatch(activity, /service:self|calendar\.search/);
    await f.sheet.show("upcoming");
    const upcoming = f.sheet.panels.get("upcoming").textContent;
    assert.match(upcoming, /带伞/);
    assert.match(upcoming, /删除/);
    assert.match(upcoming, /只一次/);
    assert.doesNotMatch(upcoming, /service:/);
    assert.deepEqual(f.net.calls.filter((call) => call.to === "service:clock"), [{ to: "service:clock", word: "list", body: {}, options: undefined }]);
  } finally { done(f); }
});

test("a step's details are read through service:history/activity in pieces", async () => {
  const view = { turns: { t_one: { title: "查天气", started: 1000, ended: 2000, outcome: "completed", steps: [{ label: "读文件", tool: "read", state: "ok", ts: 1000, ended: 1500, requestId: "req-1" }] } } };
  const net = fakeNet({ handlers: { "service:history/activity": (body) => body.offset === 0
    ? { items: [{ text: "first part", total: 20, tool: "read", member: "device:phone" }], next_offset: 5 }
    : { items: [{ text: " rest", total: 20 }], next_offset: null } } });
  const f = fixture({ net, getView: () => view });
  try {
    f.sheet.open();
    await settle();
    await f.sheet.show("activity");
    const section = f.sheet.panels.get("activity");
    const details = findAll(section, (item) => item.tag === "details")[0];
    details.open = true;
    details.listeners.toggle();
    await settle();
    assert.match(section.textContent, /first part/);
    await findAll(section, (item) => item.tag === "button" && item.textContent === "继续查看")[0].listeners.click();
    assert.match(section.textContent, /first part rest/);
    assert.deepEqual(net.calls.filter((call) => call.word === "activity").map((call) => call.body), [{ id: "req-1", offset: 0 }, { id: "req-1", offset: 5 }]);
  } finally { done(f); }
});

test("a clock answer that arrives after the connection changed is not displayed", async () => {
  let release;
  const net = fakeNet({ handlers: { "service:clock/list": () => new Promise((resolve) => { release = () => resolve({ timers: [{ id: "x", next: 1, label: "PRIVATE" }] }); }) } });
  const f = fixture({ net });
  try {
    f.sheet.open();
    await settle();
    const pending = f.sheet.show("upcoming");
    await until(() => release);
    net.lose();
    net.reconnect();
    f.sheet.connected();
    release();
    await pending;
    assert.doesNotMatch(f.root.textContent, /PRIVATE/);
    assert.equal(f.root.classList.contains("open"), false);
  } finally { done(f); }
});

test("a malformed clock list, or one with raw route names, cannot produce a false empty list", async () => {
  let data = { timers: [{ id: "bad", next: "tomorrow" }] };
  const f = fixture({ net: fakeNet({ handlers: { "service:clock/list": () => data } }) });
  try {
    f.sheet.open();
    await settle();
    for (const bad of [{ timers: [{ id: "bad", next: "tomorrow" }] }, { timers: "none" }, {},
      { timers: [{ id: "a", next: 1000, label: "带伞", blocked: "service:clock list failed" }] },
      { timers: [{ id: "a", next: 1000, label: "calendar.search" }] }]) {
      data = bad;
      await f.sheet.show("upcoming");
      assert.match(f.sheet.panels.get("upcoming").textContent, /暂时读不到计划/);
      assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /暂无计划|service:clock|calendar\.search/);
    }
    data = { timers: [{ id: "a", next: 1000, label: "带伞", blocked: "internal_adapter_timeout" }] };
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /请稍后再看/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /internal_adapter/);
  } finally { done(f); }
});

test("cancel keeps the timer until the cancel is acknowledged and the clock's own list is read again", async () => {
  let releaseCancel;
  let active = [aTimer];
  const net = fakeNet({ handlers: {
    "service:clock/list": () => ({ timers: active }),
    "service:clock/cancel": () => new Promise((resolve) => { releaseCancel = () => resolve({ cancelled: true }); }),
  } });
  const f = fixture({ net });
  try {
    f.sheet.open();
    await f.sheet.show("upcoming");
    const section = f.sheet.panels.get("upcoming");
    const cancel = findAll(section, (child) => child.tag === "button")[0];
    await cancel.listeners.click();
    assert.equal(net.calls.filter((call) => call.word === "cancel").length, 0, "the first tap only explains what will be lost");
    assert.equal(cancel.textContent, "确认删除");
    assert.match(section.textContent, /删除后，.*「带伞」就取消了/);
    const pending = cancel.listeners.click();
    await cancel.listeners.click();
    assert.equal(net.calls.filter((call) => call.word === "cancel").length, 1, "double click cannot duplicate an effect");
    assert.match(section.textContent, /带伞/, "no optimistic removal before an acknowledgement");
    active = [];
    releaseCancel();
    await pending;
    assert.match(section.textContent, /暂无计划/);
    assert.deepEqual(net.words("service:clock"), ["list", "cancel", "list"]);
    assert.deepEqual(net.calls[net.calls.findIndex((call) => call.word === "cancel")],
      { to: "service:clock", word: "cancel", body: { id: "tmr_a" }, options: { clientId: "cancel-client-one" } });
  } finally { done(f); }
});

test("a lost cancel answer is retried only by a new click, with the same client id", async () => {
  let active = [aTimer];
  let cancels = 0;
  const net = fakeNet({ handlers: {
    "service:clock/list": () => ({ timers: active }),
    "service:clock/cancel": () => {
      cancels++;
      if (cancels === 1) { active = []; return { ok: false, error: { code: "result_unknown", message: "no answer" } }; }
      return { cancelled: true };
    },
  } });
  const f = fixture({ net });
  try {
    f.sheet.open();
    await f.sheet.show("upcoming");
    const section = f.sheet.panels.get("upcoming");
    const cancel = findAll(section, (child) => child.tag === "button")[0];
    await cancel.listeners.click();
    await cancel.listeners.click();
    assert.match(section.textContent, /带伞.*还没确认结果/s);
    assert.equal(cancels, 1, "no automatic retry of an ambiguous effect");
    await cancel.listeners.click();
    assert.deepEqual(net.calls.filter((call) => call.word === "cancel").map((call) => call.options.clientId), ["cancel-client-one", "cancel-client-one"]);
    assert.match(section.textContent, /暂无计划/);
    assert.equal(f.sheet.cancelIntents.size, 0);
  } finally { done(f); }
});

test("cancelled false, a refusal, an unknown answer and a changed connection never remove a timer", async () => {
  const net = fakeNet({ handlers: { "service:clock/cancel": { cancelled: false } } });
  const binding = net.binding();
  await assert.rejects(cancelClock(net, binding, "timer-a", "client-a"), /没能删除/);
  net.handlers["service:clock/cancel"] = { ok: false, error: { code: "forbidden", message: "" } };
  await assert.rejects(cancelClock(net, binding, "timer-a", "client-a"), /不能修改计划/);
  net.handlers["service:clock/cancel"] = { ok: false, error: { code: "timeout", message: "" } };
  await assert.rejects(cancelClock(net, binding, "timer-a", "client-a"), /还没确认结果/);
  net.handlers["service:clock/cancel"] = { ok: false, error: { code: "bad_request", message: "" } };
  await assert.rejects(cancelClock(net, binding, "timer-a", "client-a"), /没有收到确认/);
  await assert.rejects(cancelClock(net, binding, "", "client-a"), TypeError);
  let release;
  net.handlers["service:clock/cancel"] = () => new Promise((resolve) => { release = () => resolve({ cancelled: true }); });
  const pending = cancelClock(net, binding, "timer-a", "client-a");
  await until(() => release);
  net.lose();
  release();
  await assert.rejects(pending, /连接已经换过/);
  await assert.rejects(listClock(net, binding), /还没连上/);
});

test("a cancel acknowledgement that arrives after the connection was lost cannot revive rows or reuse the intent", async () => {
  let releaseCancel;
  let lists = 0;
  const net = fakeNet({ handlers: {
    "service:clock/list": () => { lists++; return { timers: [{ ...aTimer, label: "旧账户计划" }] }; },
    "service:clock/cancel": () => new Promise((resolve) => { releaseCancel = () => resolve({ cancelled: true }); }),
  } });
  const f = fixture({ net });
  try {
    f.sheet.open();
    await f.sheet.show("upcoming");
    const cancel = findAll(f.sheet.panels.get("upcoming"), (child) => child.tag === "button")[0];
    await cancel.listeners.click();
    const pending = cancel.listeners.click();
    await until(() => releaseCancel);
    net.lose();
    net.reconnect();
    f.sheet.connected();
    releaseCancel();
    await pending;
    assert.equal(f.root.named["#agentPanel"].textContent, "");
    assert.equal(f.sheet.cancelIntents.size, 0);
    assert.equal(lists, 1, "the old answer cannot start a list on the new connection");
  } finally { done(f); }
});

test("the approvals page loads gate history and rules, then drops a revoked rule after the authoritative reload", async () => {
  const rule = { id: "rule-a", subject: "agent:main", to: "device:fixture", word: "send", object_pattern: "*", risk: "outward", created_at: 1, expires_at: Date.now() + 60_000 };
  const history = { id: "history-a", request_id: "r1", to: "device:fixture", word: "send", decision: "once", at: Date.now() };
  let revoked = false;
  const net = fakeNet({ handlers: {
    "service:gate/history": { items: [history] },
    "service:gate/rules.list": () => ({ rules: revoked ? [] : [rule], mode: "auto" }),
    "service:gate/rules.revoke": () => { revoked = true; return { revoked: true }; },
  } });
  const f = fixture({ net });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    await settle();
    const panel = f.sheet.panels.get("approvals");
    assert.match(panel.textContent, /以后都允许.*撤销.*最近的决定.*仅这一次/s);
    assert.doesNotMatch(panel.textContent, /device:|service:/);
    assert.deepEqual(net.calls.map((call) => [call.word, call.body]).filter(([word]) => word === "history" || word === "rules.list"),
      [["history", { limit: 100 }], ["rules.list", { limit: 100 }]]);
    button(panel, "撤销").listeners.click();
    assert.deepEqual(net.words("service:gate"), ["history", "rules.list"], "the first tap only explains the consequence");
    assert.match(panel.textContent, /撤销后，Ash 下次做这件事前会先问你/);
    button(panel, "确认撤销").listeners.click();
    await settle();
    assert.deepEqual(net.words("service:gate"), ["history", "rules.list", "rules.revoke", "history", "rules.list"]);
    assert.deepEqual(net.calls.find((call) => call.word === "rules.revoke").body, { id: "rule-a" });
    assert.equal(typeof net.calls.find((call) => call.word === "rules.revoke").options.clientId, "string");
    assert.match(panel.textContent, /没有正在生效的规则/);
    assert.equal(findAll(panel, (item) => item.tag === "button" && /撤销/.test(item.textContent)).length, 0);
  } finally { done(f); }
});

test("opening a history record reads its evidence from the gate's audit", async () => {
  const net = fakeNet({ handlers: {
    "service:gate/history": { items: [{ id: "h1", request_id: "req-9", word: "shell.run", risk: "structure", decision: "review", at: Date.now(), label: "执行命令" }] },
    "service:gate/rules.list": { rules: [] },
    "service:gate/audit": { entries: [{ request_id: "req-9", at: 1, requester: "agent:main", member: "device:phone", word: "shell.run", label: "执行命令", effect: "execute",
      decision: "review", decided_by: "review", review: { decision: "allow", reason: "主人要求", ms: 900 }, executed: { ok: true } }] },
  } });
  const f = fixture({ net });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    await settle();
    const panel = f.sheet.panels.get("approvals");
    button(panel, "查看依据").listeners.click();
    await settle();
    assert.deepEqual(net.calls.find((call) => call.word === "audit").body, { request_id: "req-9", limit: 1 });
    assert.match(panel.textContent, /谁要做Ash/);
    assert.match(panel.textContent, /可以直接做，用了 0.9 秒：主人要求/);
    assert.match(panel.textContent, /最后做成了/);
    button(panel, "收起").listeners.click();
    assert.doesNotMatch(panel.textContent, /裁判结论/);
  } finally { done(f); }
});

test("a page that is not on her machine can inspect rules but is offered no revoke button", async () => {
  const net = fakeNet({ local: false, handlers: {
    "service:gate/history": { items: [] },
    "service:gate/rules.list": { rules: [{ id: "rule-remote", subject: "agent:main", to: "device:fixture", word: "send", object_pattern: "*", risk: "outward", created_at: 1, expires_at: Date.now() + 60_000 }] },
  } });
  const f = fixture({ net });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    await settle();
    assert.match(f.sheet.panels.get("approvals").textContent, /以后都允许/);
    assert.doesNotMatch(f.sheet.panels.get("approvals").textContent, /撤销/);
  } finally { done(f); }
});

const pendingGateAsk = () => ({ id: "gate-ask", seq: 7, from: "service:gate", state: "pending",
  options_valid: true, title: "发送一条测试消息？", detail: "仅合成内容", expires_at: Date.now() + 60_000,
  options: [{ id: "once", label: "仅这次" }, { id: "deny", label: "拒绝" }] });

test("a double click on an approval is single-flight; an unknown answer retries only the same choice with the same client id", async () => {
  const ask = pendingGateAsk();
  let releaseFirst;
  const net = fakeNet({ local: false, handlers: {
    "service:gate/history": { items: [] }, "service:gate/rules.list": { rules: [] },
    answer: (n) => n === 1 ? new Promise((resolve) => { releaseFirst = () => resolve({ ok: false, error: { code: "result_unknown", message: "lost" } }); })
      : { ok: true, message: { id: "answer-1", seq: 8 } },
  } });
  const f = fixture({ net, getView: () => ({ asks: [ask] }), idFactory: () => "stable-answer-id" });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    const shown = approvalSections(f.sheet.getView()).pending[0];
    const binding = f.sheet.session;
    const epoch = f.sheet.loadEpoch;
    const first = f.sheet.answerApproval(shown, "once", binding, epoch);
    await f.sheet.answerApproval(shown, "once", binding, epoch);
    assert.equal(net.answers.length, 1, "double click cannot duplicate a pending response");
    releaseFirst();
    await first;
    assert.equal(f.sheet.answerIntents.get(ask.id).status, "uncertain");
    assert.match(f.sheet.panels.get("approvals").textContent, /还没确认你的回答送到了.*仅这次/);
    await f.sheet.answerApproval(shown, "deny", binding, epoch);
    assert.equal(net.answers.length, 1, "an unknown answer cannot change the intended choice");
    await f.sheet.answerApproval(shown, "once", binding, epoch);
    assert.deepEqual(net.answers.map((item) => item.clientId), ["stable-answer-id", "stable-answer-id"]);
    assert.deepEqual(net.answers.map((item) => item.answer), [{ choice: "once" }, { choice: "once" }]);
    assert.equal(f.sheet.answerIntents.get(ask.id).status, "confirmed");
    assert.match(f.sheet.panels.get("approvals").textContent, /已收到你的回答/);
  } finally { done(f); }
});

test("a refused approval answer is final: it is marked rejected and cannot be sent again", async () => {
  const ask = pendingGateAsk();
  const net = fakeNet({ handlers: { "service:gate/history": { items: [] }, "service:gate/rules.list": { rules: [] },
    answer: { ok: false, error: { code: "conflict", message: "already answered" } } } });
  const f = fixture({ net, getView: () => ({ asks: [ask] }) });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    const shown = approvalSections(f.sheet.getView()).pending[0];
    await f.sheet.answerApproval(shown, "once", f.sheet.session, f.sheet.loadEpoch);
    assert.equal(f.sheet.answerIntents.get(ask.id).status, "rejected");
    assert.match(f.sheet.panels.get("approvals").textContent, /这次回答没有被接受/);
    await f.sheet.answerApproval(shown, "once", f.sheet.session, f.sheet.loadEpoch);
    assert.equal(net.answers.length, 1);
  } finally { done(f); }
});

test("an approval answer that comes back after the connection changed cannot confirm or keep an intent", async () => {
  const ask = pendingGateAsk();
  let release;
  const net = fakeNet({ local: false, handlers: { "service:gate/history": { items: [] }, "service:gate/rules.list": { rules: [] },
    answer: () => new Promise((resolve) => { release = () => resolve({ ok: true, message: { id: "answer-1", seq: 8 } }); }) } });
  const f = fixture({ net, getView: () => ({ asks: [ask] }) });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    const shown = approvalSections(f.sheet.getView()).pending[0];
    const pending = f.sheet.answerApproval(shown, "deny", f.sheet.session, f.sheet.loadEpoch);
    await until(() => release);
    net.lose();
    net.reconnect();
    f.sheet.connected();
    release();
    await pending;
    assert.equal(f.sheet.answerIntents.size, 0);
    assert.equal(f.root.classList.contains("open"), false);
    assert.doesNotMatch(f.root.textContent, /已收到你的回答/);
  } finally { done(f); }
});

test("an approval answered through a real kernel is recorded once and confirmed by the kernel's result", async () => {
  const kernel = startKernel({ local: false });
  const { net } = netFor(kernel);
  net.start();
  await until(() => net.status === "online");
  kernel.on("service:gate", "history", { items: [] });
  kernel.on("service:gate", "rules.list", { rules: [] });
  const asked = kernel.append({ id: "gate-ask", ts: Date.now(), from: "service:gate", to: "person:owner", kind: "request", word: "ask",
    body: { title: "发送一条测试消息？", detail: "仅合成内容", expires_at: Date.now() + 60_000, options: [{ id: "once", label: "仅这次" }, { id: "deny", label: "拒绝" }] } });
  let view = fold(initialView(), asked);
  const f = fixture({ net, getView: () => view });
  try {
    f.sheet.open();
    await until(() => f.sheet.session);
    await f.sheet.show("approvals");
    await settle();
    assert.equal(f.root.named["#agentTabs"].children.find((item) => item.dataset.tab === "approvals").dataset.badge, "1");
    const card = findAll(f.sheet.panels.get("approvals"), (item) => item.dataset.askId === "gate-ask")[0];
    assert.ok(card);
    findAll(card, (item) => item.dataset.choice === "once")[0].listeners.click();
    await until(() => f.sheet.answerIntents.get("gate-ask")?.status === "confirmed");
    const response = kernel.ledger.find((m) => m.kind === "response" && m.reply_to === "gate-ask");
    assert.deepEqual(response.body, { ok: true, result: { data: { choice: "once" } } });
    assert.equal(response.to, "service:gate");
    view = fold(view, response);
    f.sheet.update();
    assert.equal(findAll(f.sheet.panels.get("approvals"), (item) => item.dataset.askId === "gate-ask").length, 0, "the answered card leaves the list");
    assert.equal(f.root.named["#agentTabs"].children.find((item) => item.dataset.tab === "approvals").dataset.badge, "");
  } finally { done(f); net.stop(); kernel.close(); }
});

test("a page that is not on her machine reads identity but cannot edit; losing the connection discards a delayed read", async () => {
  let release;
  const net = fakeNet({ local: false, handlers: { "service:persona/get": () => new Promise((resolve) => { release = () => resolve({ files: [{ file: "SOUL.md", content: "old private text", version: "v" }] }); }) } });
  const f = fixture({ net });
  try {
    f.sheet.open();
    assert.equal(f.sheet.identity.options.canEdit, false);
    net.lose();
    net.reconnect();
    f.sheet.connected();
    assert.equal(f.root.classList.contains("open"), false);
    release();
    await settle();
    assert.equal(f.root.named["#agentPanel"].textContent, "");
    assert.equal(f.sheet.identity, null);
  } finally { done(f); }
});

test("a dirty or unconfirmed editor blocks a voluntary close, but a disconnect clears it", async () => {
  const f = fixture();
  try {
    f.sheet.open();
    await settle();
    f.sheet.identity.editor.setDraft("draft");
    assert.equal(f.sheet.close(), false);
    assert.equal(f.root.classList.contains("open"), true);
    f.sheet.network("offline");
    assert.equal(f.root.classList.contains("open"), false);
    assert.equal(f.sheet.identity, null);
    assert.equal(f.root.named["#agentPanel"].textContent, "");
  } finally { done(f); }
});

test("saving the identity goes through persona propose and tells the page so it can read the name again", async () => {
  let content = "- 名字：小舟\n";
  const changed = [];
  const net = fakeNet({ handlers: {
    "service:persona/get": (body) => ({ files: [{ file: body.file, content: body.file === "IDENTITY.md" ? content : "沉着", version: "v" }] }),
    "service:persona/propose": (body) => { content = body.content; return { proposed: true, applied: true }; },
  } });
  const f = fixture({ net, onIdentityChanged: () => changed.push("changed") });
  try {
    f.sheet.open();
    await settle();
    await f.sheet.identity.open("IDENTITY.md");
    const editor = f.sheet.identity.editor;
    editor.setDraft("- 名字：River\n");
    await editor.save();
    assert.equal(editor.status, "已保存。");
    assert.deepEqual(changed, ["changed"]);
    const propose = net.calls.find((call) => call.word === "propose");
    assert.deepEqual(propose.body, { file: "IDENTITY.md", content: "- 名字：River\n", reason: "主人在人物页修改" });
    assert.equal(net.calls.some((call) => call.to === "body:main" && call.word === "workspace.write"), false, "identity never uses workspace words");
  } finally { done(f); }
});

test("the memory tab reads USER.md and MEMORY.md from the main body and writes them there", async () => {
  const files = { "USER.md": "喜欢茶\n", "MEMORY.md": "上周去了海边\n" };
  const net = fakeNet({ handlers: {
    "body:main/workspace.read": (body) => body.path in files ? { path: body.path, text: files[body.path], truncated: false } : { ok: false, error: { code: "not_found", message: "no" } },
    "body:main/workspace.write": (body) => { files[body.path] = body.content; return { path: body.path, bytes: body.content.length }; },
  } });
  const f = fixture({ net });
  try {
    f.sheet.open();
    await settle();
    await f.sheet.show("memory");
    await settle();
    const memory = f.sheet.panels.get("memory");
    assert.match(memory.textContent, /喜欢茶/);
    assert.doesNotMatch(memory.textContent, /改动记录|恢复|哈希|版本/);
    await f.sheet.memory.open("MEMORY.md");
    assert.match(memory.textContent, /上周去了海边/);
    f.sheet.memory.editor.setDraft("上周去了山里\n");
    await f.sheet.memory.editor.save();
    assert.equal(files["MEMORY.md"], "上周去了山里\n");
    assert.equal(f.sheet.memory.editor.status, "已保存。");
    assert.ok(net.calls.filter((call) => call.to === "body:main").every((call) => call.word.startsWith("workspace.")));
    assert.equal(net.calls.some((call) => call.to === "service:persona" && call.word === "propose"), false);
  } finally { done(f); }
});

test("pending approvals put a count on the tab; the rename row asks her instead of opening a form", async () => {
  const ask = pendingGateAsk();
  let prefill = null;
  const net = fakeNet({ handlers: { "service:persona/get": { files: [{ file: "SOUL.md", content: "沉着", version: "v" }, { file: "IDENTITY.md", content: "# 我的名片\n- 名字：小舟\n", version: "v" }] } } });
  const f = fixture({ net, getView: () => ({ asks: [ask], turns: {} }), onPrefill: (text) => { prefill = text; } });
  try {
    f.sheet.setName("小舟");
    f.sheet.open();
    await settle();
    const approvals = f.root.named["#agentTabs"].children.find((item) => item.dataset.tab === "approvals");
    assert.equal(approvals.dataset.badge, "1");
    const identity = f.sheet.panels.get("identity");
    assert.match(identity.textContent, /这些决定了小舟是谁/);
    assert.match(identity.textContent, /性格.*名片/s);
    assert.doesNotMatch(identity.textContent, /SOUL\.md|IDENTITY\.md|哈希|版本/);
    findAll(identity, (item) => item.tag === "button" && /想给小舟换个名字/.test(item.textContent))[0].listeners.click();
    assert.equal(prefill, "我想给你换个名字，以后叫你");
  } finally { done(f); }
});

test("the sheet opened on one connection is gone when another opens, and offline closes it", async () => {
  const f = fixture();
  try {
    f.sheet.open();
    await settle();
    assert.equal(f.root.classList.contains("open"), true);
    f.net.lose();
    f.net.reconnect();
    f.sheet.connected();
    assert.equal(f.root.classList.contains("open"), false);
    assert.equal(f.sheet.session, null);
    f.sheet.open();
    await settle();
    assert.equal(f.root.classList.contains("open"), true);
    f.sheet.network("offline");
    assert.equal(f.root.classList.contains("open"), false);
  } finally { done(f); }
});
