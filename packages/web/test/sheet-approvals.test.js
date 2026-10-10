import assert from "node:assert/strict";
import test from "node:test";
import { fold, initialView } from "../js/project.js";
import { answerGateAsk, approvalSections, gateRequest, renderApprovalsSheet, renderEvidence } from "../js/sheet-approvals.js";
import { startKernel } from "./kernel.js";
import { netFor, until } from "./support.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.className = ""; this.value = ""; this.listeners = {}; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(""); }
}

function draw(view, now = 5000) {
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  try { const root = new Node("root"); const sections = renderApprovalsSheet(root, view, { now }); return { root, sections, nodes: root.children[0].children }; }
  finally { delete globalThis.document; }
}

const gateAsk = (id, seq, from = "service:gate", expires_at = 9000) => ({ seq, id, ts: seq, from, to: "person:owner", kind: "request", word: "ask",
  body: { title: "Allow sending?", detail: "Send one synthetic note", expires_at,
    options: [{ id: "once", label: "Only once" }, { id: "deny", label: "No" }],
    source: { to: "device:fixture", word: "send", body_preview: "synthetic" } } });

test("the approvals sheet retains the entire original beside its bounded summary", () => {
  const original = "x".repeat(65000) + "\nTAIL <img src=x>\t  spaces";
  const message = gateAsk("full-original", 1);
  message.body.source.body_full = original;
  const view = fold(initialView(), message);
  const { root, sections } = draw(view);
  assert.equal(sections.pending[0].original, original);
  const article = root.children[0].children.find((node) => node.tag === "article");
  const disclosure = article.children.find((node) => node.tag === "details");
  assert.equal(disclosure.children[0].textContent, "查看原文");
  assert.equal(disclosure.children[1].textContent, original);
  assert.equal(disclosure.children[1].children.length, 0);
});

const online = async () => {
  const kernel = startKernel();
  const handle = netFor(kernel);
  handle.net.start();
  await until(() => handle.net.status === "online", 2000, "online");
  return { kernel, ...handle, stop: () => { handle.net.stop(); kernel.close(); } };
};

test("a gate word returns its data, and an answer that arrives on another connection is dropped", async () => {
  const { kernel, net, stop } = await online();
  try {
    kernel.on("service:gate", "rules.list", { rules: [], mode: "auto" });
    kernel.on("service:gate", "history", async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { items: [] }; });
    const binding = net.binding();
    assert.deepEqual(await gateRequest(net, binding, "rules.list", { limit: 100 }), { rules: [], mode: "auto" });
    const pending = gateRequest(net, binding, "history", { limit: 100 });
    kernel.drop();
    await assert.rejects(pending, /连接已经换过|没有收到确认|没有成功|连接/);
    await assert.rejects(gateRequest(net, binding, "rules.list", {}), /连接已经换过/, "an old binding is never used again");
    await until(() => net.status === "online" && net.same(net.binding()), 2000, "reconnected");
    await assert.rejects(gateRequest(net, net.binding(), "pending.list", {}), (error) => error.code === "forbidden",
      "a word that is not for the owner fails in the kernel and the failure surfaces");
  } finally { stop(); }
});

test("only a live gate ask from trusted ledger origin appears; other asks and old answers do not", () => {
  let view = initialView();
  view = fold(view, gateAsk("gate-live", 1));
  view = fold(view, gateAsk("ordinary", 2, "agent:main"));
  view = fold(view, gateAsk("gate-expired", 3, "service:gate", 5000));
  view = fold(view, gateAsk("gate-answered", 4));
  view = fold(view, { seq: 5, id: "answer", ts: 5, from: "person:owner", to: "service:gate", kind: "response", word: "ask", reply_to: "gate-answered", body: { ok: true, result: { choice: "deny" } } });
  assert.equal(view.asks.find((ask) => ask.id === "gate-live").from, "service:gate");
  const { nodes, sections } = draw(view);
  assert.deepEqual(sections.pending.map((ask) => ask.id), ["gate-live"]);
  assert.deepEqual(nodes.filter((node) => node.tag === "article").map((node) => node.dataset.askId), ["gate-live"]);
  assert.equal(nodes.some((node) => node.tag === "button"), false);
  assert.match(nodes.map((node) => node.textContent).join(" "), /暂时读不到审批记录（不代表没有）/);
  assert.match(nodes.map((node) => node.textContent).join(" "), /暂时读不到这些规则（不代表没有）/);
});

test("missing or body-spoofed source fails closed and empty state never claims rules are empty", () => {
  const ordinary = { ...gateAsk("ordinary", 1, "agent:main"), body: { ...gateAsk("ordinary", 1).body, from: "service:gate" } };
  let view = fold(initialView(), ordinary);
  view = fold(view, gateAsk("gate", 2));
  assert.deepEqual(approvalSections(view, 9000).pending, [], "at the exact expiry no action is displayed");
  const { nodes } = draw({ asks: [{ id: "legacy", seq: 3, state: "pending", title: "Legacy", expires_at: 9000, options: [{ id: "deny", label: "No" }] }] });
  assert.equal(nodes.some((node) => node.tag === "article"), false);
  assert.match(nodes.map((node) => node.textContent).join(" "), /看不出来自哪里/);
  assert.match(nodes.map((node) => node.textContent).join(" "), /暂时读不到/);
});

test("malformed raw options cannot be laundered into a valid approval by projection", () => {
  const invalid = gateAsk("invalid-raw", 1);
  invalid.body.options = [{ id: "once", label: "Once" }, { id: 23, label: "Malformed" }];
  let view = fold(initialView(), invalid);
  view = fold(view, gateAsk("valid-control", 2));
  assert.deepEqual(view.asks.find((ask) => ask.id === "invalid-raw").options, [{ id: "once", label: "Once" }], "ordinary conversation still retains its safe option");
  assert.deepEqual(view.conversation.find((item) => item.id === "invalid-raw").ask.options, [{ id: "once", label: "Once" }]);
  assert.equal(view.asks.find((ask) => ask.id === "invalid-raw").options_valid, false);
  assert.equal(view.asks.find((ask) => ask.id === "valid-control").options_valid, true);
  const { sections, nodes } = draw(view);
  assert.deepEqual(sections.pending.map((ask) => ask.id), ["valid-control"]);
  assert.deepEqual(nodes.filter((node) => node.tag === "article").map((node) => node.dataset.askId), ["valid-control"]);
});

test("the read-only sheet limits text, rejects malformed option sets and never renders raw markup", () => {
  const view = { asks: [
    { id: "safe", seq: 2, from: "service:gate", state: "pending", options_valid: true, title: "<script>".repeat(100), detail: "synthetic", expires_at: 9000,
      options: [{ id: "once", label: "Once" }, { id: "deny", label: "Deny" }] },
    { id: "duplicate-option", seq: 3, from: "service:gate", state: "pending", options_valid: true, expires_at: 9000,
      options: [{ id: "once", label: "One" }, { id: "once", label: "Another" }] },
    { id: "invented", seq: 4, from: "service:gate", state: "pending", options_valid: true, expires_at: 9000, options: [{ id: "admin", label: "Admin" }] },
    { id: "mixed", seq: 5, from: "service:gate", state: "pending", options_valid: true, expires_at: 9000,
      options: [{ id: "once", label: "Once" }, { id: "admin", label: "Admin" }] },
    { id: "safe", seq: 6, from: "service:gate", state: "pending", options_valid: true, expires_at: 9000,
      options: [{ id: "always", label: "Always" }] },
  ] };
  const { sections, nodes } = draw(view);
  assert.deepEqual(sections.pending.map((ask) => ask.id), ["safe"]);
  assert.equal(sections.pending[0].title.length, 240);
  assert.equal(nodes.some((node) => node.tag === "script" || node.tag === "button"), false);
  assert.match(nodes.find((node) => node.tag === "article").textContent, /<script>/);
});

const askFor = (kernel, id = "gate-live", extra = {}) => {
  const message = kernel.append({ id, ts: Date.now(), from: "service:gate", to: "person:owner", kind: "request", word: "ask",
    body: { title: "Allow sending?", detail: "Send one synthetic note", expires_at: Date.now() + 60_000,
      options: [{ id: "once", label: "Only once" }, { id: "deny", label: "No" }], ...extra } });
  return approvalSections(fold(initialView(), message)).pending[0];
};

test("answer sends only an offered gate option, and the kernel's result is the confirmation", async () => {
  const { kernel, net, stop } = await online();
  try {
    const ask = askFor(kernel);
    const result = await answerGateAsk(net, ask, "once", "stable-1");
    const recorded = kernel.ledger.find((m) => m.kind === "response" && m.reply_to === ask.id);
    assert.deepEqual(result, { id: recorded.id, seq: recorded.seq });
    const sent = kernel.requests.find((r) => r.kind === "response");
    assert.deepEqual(sent, { to: "service:gate", kind: "response", word: "ask", reply_to: ask.id,
      body: { ok: true, result: { data: { choice: "once" } } }, client_id: "stable-1" });
    await assert.rejects(answerGateAsk(net, ask, "always", "stable-2"), /选项不可用/);
    assert.equal(kernel.requests.filter((r) => r.kind === "response").length, 1, "an unoffered choice sends nothing");
  } finally { stop(); }
});

test("a second answer is refused as already answered: the first answer counts", async () => {
  const { kernel, net, stop } = await online();
  try {
    const ask = askFor(kernel);
    await answerGateAsk(net, ask, "once", "first-id");
    await assert.rejects(answerGateAsk(net, ask, "deny", "other-id"), /被拒绝/);
    assert.equal(kernel.ledger.filter((m) => m.kind === "response" && m.reply_to === ask.id).length, 1);
  } finally { stop(); }
});

test("expired, forged or mismatched asks are refused before anything is sent", async () => {
  const { kernel, net, stop } = await online();
  try {
    const ask = askFor(kernel);
    await assert.rejects(answerGateAsk(net, ask, "once", "stable", { now: () => ask.expires_at }), /已失效/);
    await assert.rejects(answerGateAsk(net, { ...ask, from: "agent:main" }, "once", "stable"), /已失效/);
    await assert.rejects(answerGateAsk(net, ask, "once", ""), /已失效|不可用/);
    assert.equal(kernel.requests.filter((r) => r.kind === "response").length, 0);
  } finally { stop(); }
});

test("a custom answer to a question carries its text", async () => {
  const { kernel, net, stop } = await online();
  try {
    const ask = askFor(kernel, "gate-custom", { allow_custom: true });
    await answerGateAsk(net, ask, "custom", "stable", { answerText: "晚点再说" });
    assert.deepEqual(kernel.requests.at(-1).body, { ok: true, result: { data: { choice: "custom", text: "晚点再说" } } });
    await assert.rejects(answerGateAsk(net, askFor(kernel, "gate-plain"), "custom", "stable-b", { answerText: "x" }), /选项不可用/);
  } finally { stop(); }
});

test("a definite refusal and a lost answer are told apart; a connection that changed discards the result", async () => {
  const ask = approvalSections(fold(initialView(), gateAsk("gate-live", 7)), 5000).pending[0];
  const fake = (answer, same = () => true) => ({ binding: () => ({ session: "s", generation: 1 }), same, answerAsk: answer });
  for (const code of ["conflict", "not_found", "bad_request", "denied"])
    await assert.rejects(answerGateAsk(fake(async () => ({ ok: false, error: { code, message: code } })), ask, "once", "c", { now: () => 5000 }), /被拒绝/);
  await assert.rejects(answerGateAsk(fake(async () => ({ ok: false, error: { code: "forbidden", message: "" } })), ask, "once", "c", { now: () => 5000 }), /无权回答/);
  for (const code of ["offline", "timeout", "result_unknown", "unavailable", "internal"])
    await assert.rejects(answerGateAsk(fake(async () => ({ ok: false, error: { code, message: code } })), ask, "once", "c", { now: () => 5000 }), /回执未知.*原样重试/);
  await assert.rejects(answerGateAsk(fake(async () => ({ ok: true, message: { id: "x", seq: 1 } })), ask, "once", "c", { now: () => 5000 }), /无法配对/, "an answer recorded before the question is not its answer");
  let calls = 0;
  const changing = fake(async () => ({ ok: true, message: { id: "r", seq: 8 } }), () => ++calls < 2);
  await assert.rejects(answerGateAsk(changing, ask, "once", "c", { now: () => 5000 }), /连接已经换过/);
  await assert.rejects(answerGateAsk(fake(async () => assert.fail("not sent"), () => false), ask, "once", "c", { now: () => 5000 }), /还没连上/);
});

test("history says when she judged an action herself and why; a capability-wide rule names no object", () => {
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  try {
    const root = new Node("root");
    renderApprovalsSheet(root, initialView(), { now: 5000, rules: [
      { id: "rule-star", to: "device:phone", word: "file.delete", object_pattern: "*", risk: "outward", expires_at: 90_000 },
    ], history: [
      { id: "h-review", request_id: "m_1", to: "device:phone", word: "browser.click", risk: "outward",
        decision: "review", reason: "你让她打开推特，你来登录", at: 4000 },
      { id: "h-carry", request_id: "m_2", to: "device:phone", word: "browser.click", risk: "outward",
        decision: "carry", reason: "你几分钟前刚允许过同样的操作", at: 4500 },
      { id: "h-once", request_id: "m_3", to: "device:phone", word: "shell.run", risk: "structure", decision: "once", at: 4800 },
    ] });
    const text = root.textContent;
    assert.match(text, /在网页上点击由她判断后放行 · .*你让她打开推特，你来登录/);
    assert.match(text, /刚允许过，沿用 · .*你几分钟前刚允许过同样的操作/);
    assert.match(text, /执行命令仅这一次/);
    assert.doesNotMatch(text, /\*/);
  } finally { delete globalThis.document; }
});

test("a history record opens to its evidence: what was done, what the reviewer saw and said, the card, the answer, and whether it ran", () => {
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  try {
    const history = [{ id: "h1", request_id: "r1", word: "clipboard.set", risk: "outward", label: "改剪贴板", decision: "review", reason: "你要的", at: 4000 },
      { id: "h2", request_id: "r2", word: "rules.set", risk: "structure", decision: "deny", at: 4100 }];
    const opened = [];
    const evidence = new Map([["r1", { status: "ready", entry: { request_id: "r1", requester: "agent:main", word: "clipboard.set", label: "改剪贴板", effect: "act",
      content: "开会", facts: { owner_said: ["把开会复制一下"], context: ["read 日历"] }, review: { decision: "allow", reason: "主人明确要求", ms: 1200 },
      decision: "review", decided_by: "review", executed: { ok: true } } }], ["r2", { status: "missing" }]]);
    const root = new Node("root");
    renderApprovalsSheet(root, { asks: [] }, { now: 5000, history, rules: [], name: "小安", evidence, onEvidence: (id) => opened.push(id) });
    const all = root.children[0].textContent;
    for (const expected of ["小安", "改剪贴板（操作）", "开会", "「把开会复制一下」", "read 日历", "可以直接做，用了 1.2 秒：主人明确要求", "裁判看到的前几步", "裁判（模型判断）", "做成了", "收起", "修改审批规则", "没有留下依据"])
      assert.ok(all.includes(expected), expected);
    const find = (node, label) => node.tag === "button" && node.value === label ? node : node.children.map((child) => find(child, label)).find(Boolean);
    find(root.children[0], "收起").listeners.click();
    assert.deepEqual(opened, ["r1"]);
    const closed = new Node("root");
    renderApprovalsSheet(closed, { asks: [] }, { now: 5000, history, rules: [], evidence: new Map(), onEvidence: () => {} });
    assert.ok(closed.children[0].textContent.includes("查看依据"));
    assert.ok(!closed.children[0].textContent.includes("裁判结论"));
  } finally { delete globalThis.document; }
});

test("the last line of the evidence says what happened without any answer-progress section", () => {
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  try {
    const last = (entry) => { const root = new Node("root"); renderEvidence(root, { request_id: "r", requester: "agent:main", member: "device:phone", word: "x", ...entry }, { now: 5000 });
      return root.textContent; };
    assert.match(last({ decision: "once", decided_by: "owner", executed: { ok: true } }), /最后做成了/);
    assert.match(last({ decision: "once", executed: { ok: false, message: "超时" } }), /没做成（超时）/);
    assert.match(last({ decision: "deny", executed: { ok: false } }), /最后没有做/);
    assert.match(last({ decision: "timeout" }), /最后没有做/);
    assert.match(last({ decision: "once" }), /最后还没有结果/);
    assert.match(last({ decision: "rule", decided_by: "hand_full" }), /设备完全放开/);
    const root = new Node("root");
    renderApprovalsSheet(root, { asks: [{ id: "a", seq: 1, from: "service:gate", state: "answered", choice: "once", title: "旧问题" }] }, { now: 5000, rules: [], history: [] });
    assert.doesNotMatch(root.textContent, /回答后的进展|旧问题/);
  } finally { delete globalThis.document; }
});

test("history names every decision the gate can record and opens evidence for each record", () => {
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  try {
    const decisions = ["once", "always", "deny", "timeout", "cancelled", "rule", "review", "carry", "hand_full", "declared_none", "assessed_none"];
    const history = decisions.map((decision, n) => ({ id: `h${n}`, request_id: `r${n}`, word: "shell.run", risk: "structure", decision, at: 4000 + n }));
    const root = new Node("root");
    renderApprovalsSheet(root, { asks: [] }, { now: 5000, history, rules: [], onEvidence: () => {} });
    const text = root.textContent;
    assert.doesNotMatch(text, /已记录/, "no decision falls back to the generic word");
    assert.match(text, /设备完全放开放行/);
    assert.equal((text.match(/查看依据/g) ?? []).length, decisions.length);
    assert.doesNotMatch(text, /较早的审批/);
  } finally { delete globalThis.document; }
});
