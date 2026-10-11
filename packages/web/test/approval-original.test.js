import assert from "node:assert/strict";
import test from "node:test";
import { appendApprovalOriginal, appendFullAnswer } from "../js/approval-original.js";

test("an externalized gate snapshot reads complete plain text only on disclosure and releases on close", async () => {
  class Node {
    constructor() { this.children = []; this.events = {}; this.isConnected = true; }
    append(node) { this.children.push(node); }
    addEventListener(name, fn) { this.events[name] = fn; }
  }
  globalThis.document = { createElement: () => new Node() };
  try {
    const parent = new Node(), lifetime = { disposed: false, cleanup: new Set() };
    let reads = 0, released = 0, signal;
    const full = "<script>plain text</script>\n".repeat(5000);
    appendApprovalOriginal(parent, { from: "service:gate", original: "preview", original_full: "hash" }, "查看完整原文", {
      lifetime, onReadOriginal: async (_ask, abort) => { reads++; signal = abort; return { text: full, release: () => released++ }; },
    });
    assert.equal(reads, 0);
    const details = parent.children[0], pre = details.children[1];
    details.open = true; await details.events.toggle();
    assert.equal(reads, 1); assert.equal(pre.textContent, full);
    details.open = false; await details.events.toggle();
    assert.equal(released, 1); assert.equal(pre.textContent, ""); assert.equal(signal.aborted, true);
    for (const cleanup of lifetime.cleanup) cleanup();
    assert.equal(released, 1);
  } finally { delete globalThis.document; }
});


test("closing and reopening a pending original cancels its old read without overwriting the new disclosure", async () => {
  class Node {
    constructor() { this.children = []; this.events = {}; this.isConnected = true; }
    append(node) { this.children.push(node); }
    addEventListener(name, fn) { this.events[name] = fn; }
  }
  globalThis.document = { createElement: () => new Node() };
  try {
    const parent = new Node(), pending = [];
    let releases = 0;
    appendApprovalOriginal(parent, { from: "service:gate", original: "preview", original_full: "hash" }, "original", {
      onReadOriginal: (_ask, signal) => new Promise(resolve => pending.push({ resolve, signal })),
    });
    const details = parent.children[0], pre = details.children[1];
    details.open = true; const first = details.events.toggle();
    details.open = false; await details.events.toggle();
    details.open = true; const second = details.events.toggle();
    assert.equal(pending.length, 2); assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve({ text: "new complete original", release: () => releases++ }); await second;
    pending[0].resolve({ text: "obsolete original", release: () => releases++ }); await first;
    assert.equal(pre.textContent, "new complete original"); assert.equal(releases, 1);
    details.open = false; await details.events.toggle(); assert.equal(releases, 2);
  } finally { delete globalThis.document; }
});


test("a large custom answer exposes its exact selectable text only on explicit disclosure", async () => {
  class Node {
    constructor() { this.children = []; this.events = {}; this.isConnected = true; }
    append(node) { this.children.push(node); }
    addEventListener(name, fn) { this.events[name] = fn; }
  }
  globalThis.document = { createElement: () => new Node() };
  try {
    const parent = new Node(), complete = "我自己的完整回答。".repeat(3000);
    let reads = 0, releases = 0;
    appendFullAnswer(parent, { state: "answered", answer_text: "summary", answer_full: "hash" }, {
      onReadAnswer: async ask => { assert.equal(ask.answer_full, "hash"); reads++; return { text: complete, release: () => releases++ }; },
    });
    assert.equal(reads, 0);
    const details = parent.children[0], pre = details.children[1];
    details.open = true; await details.events.toggle(); assert.equal(pre.textContent, complete);
    details.open = false; await details.events.toggle(); assert.equal(releases, 1); assert.equal(pre.textContent, "");
  } finally { delete globalThis.document; }
});
