import assert from "node:assert/strict";
import test from "node:test";
import { fold, initialView } from "../js/project.js";
import { answerGateAsk, approvalSections, renderEvidence } from "../js/approvals.js";
import { VERB } from "../js/home-waiting.js";
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

const sections = (view, now = 5000) => approvalSections(view, now);

const gateAsk = (id, seq, from = "service:gate", expires_at = 9000) => ({ seq, id, ts: seq, from, to: "person:owner", kind: "request", word: "ask",
  body: { title: "Allow sending?", detail: "Send one synthetic note", expires_at,
    options: [{ id: "once", label: "Only once" }, { id: "deny", label: "No" }],
    source: { to: "device:fixture", word: "send", body_preview: "synthetic" } } });

test("the approval keeps the entire original beside its bounded summary", () => {
  const original = "x".repeat(65000) + "\nTAIL <img src=x>\t  spaces";
  const message = gateAsk("full-original", 1);
  message.body.source.body_full = original;
  const view = fold(initialView(), message);
  assert.equal(sections(view).pending[0].original, original);
});

const online = async () => {
  const kernel = startKernel();
  const handle = netFor(kernel);
  handle.net.start();
  await until(() => handle.net.status === "online", 2000, "online");
  return { kernel, ...handle, stop: () => { handle.net.stop(); kernel.close(); } };
};

test("only a live gate ask from trusted ledger origin appears; other asks and old answers do not", () => {
  let view = initialView();
  view = fold(view, gateAsk("gate-live", 1));
  view = fold(view, gateAsk("ordinary", 2, "agent:main"));
  view = fold(view, gateAsk("gate-expired", 3, "service:gate", 5000));
  view = fold(view, gateAsk("gate-answered", 4));
  view = fold(view, { seq: 5, id: "answer", ts: 5, from: "person:owner", to: "service:gate", kind: "response", word: "ask", reply_to: "gate-answered", body: { ok: true, result: { choice: "deny" } } });
  assert.equal(view.asks.find((ask) => ask.id === "gate-live").from, "service:gate");
  assert.deepEqual(sections(view).pending.map((ask) => ask.id), ["gate-live"]);
});

test("missing or body-spoofed source fails closed and empty state never claims rules are empty", () => {
  const ordinary = { ...gateAsk("ordinary", 1, "agent:main"), body: { ...gateAsk("ordinary", 1).body, from: "service:gate" } };
  let view = fold(initialView(), ordinary);
  view = fold(view, gateAsk("gate", 2));
  assert.deepEqual(approvalSections(view, 9000).pending, [], "at the exact expiry no action is displayed");
  const legacy = sections({ asks: [{ id: "legacy", seq: 3, state: "pending", title: "Legacy", expires_at: 9000, options: [{ id: "deny", label: "No" }] }] });
  assert.deepEqual(legacy.pending, [], "a row of unknown origin is not shown as an approval");
  assert.equal(legacy.unknownSource, 1);
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
  assert.deepEqual(sections(view).pending.map((ask) => ask.id), ["valid-control"]);
});

test("the approvals limit text and reject malformed option sets", () => {
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
  const { pending } = sections(view);
  assert.deepEqual(pending.map((ask) => ask.id), ["safe"]);
  assert.equal(pending[0].title.length, 240);
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

test("a record's evidence says what was done, what the reviewer saw and said, the card, the answer, and whether it ran", () => {
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  try {
    const entry = { request_id: "r1", requester: "agent:main", word: "clipboard.set", label: "改剪贴板", effect: "act",
      content: "开会", facts: { owner_said: ["把开会复制一下"], context: ["read 日历"] }, review: { decision: "allow", reason: "主人明确要求", ms: 1200 },
      decision: "review", decided_by: "review", executed: { ok: true } };
    const root = new Node("root");
    renderEvidence(root, entry, { now: 5000, name: "小安", primary: "agent:main" });
    const all = root.textContent;
    for (const expected of ["小安", "改剪贴板（操作）", "开会", "「把开会复制一下」", "read 日历", "可以直接做，用了 1.2 秒：主人明确要求", "裁判看到的前几步"])
      assert.ok(all.includes(expected), expected);
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
  } finally { delete globalThis.document; }
});

test("every decision the gate can record has its own words", () => {
  for (const decision of ["once", "always", "deny", "timeout", "cancelled", "rule", "review", "carry", "hand_full", "declared_none", "assessed_none"])
    assert.ok(VERB[decision], `${decision} has words`);
});
