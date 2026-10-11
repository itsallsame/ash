import assert from "node:assert/strict";
import test from "node:test";
import { Timeline } from "../js/app.js";
import { appendConversation } from "../js/conversation.js";

const message = (seq) => ({ seq, id: `m${seq}`, ts: seq, kind: "request", from: "person:owner", to: "agent:main", word: "say", body: { text: `text ${seq}` }, summary: `text ${seq}`, size: 1 });

test("older pagination sorts/deduplicates and drops a late page from before a reset", async () => {
  let resolveOld;
  const net = { page: () => new Promise((resolve) => { resolveOld = resolve; }) };
  const timeline = new Timeline(net);
  timeline.add(message(201));
  timeline.add(message(202));
  const pending = timeline.older();
  timeline.reset();
  timeline.add(message(300));
  resolveOld({ messages: [message(198), message(199), message(199), message(200)], end: { has_more: true } });
  assert.equal(await pending, 0);
  assert.deepEqual([...timeline.records.keys()], [300]);
  net.page = async (before) => { assert.equal(before, 300, "the page before the first seq the timeline holds"); return { messages: [message(297), message(296), message(297), message(298), message(299)], end: { has_more: false } }; };
  assert.equal(await timeline.older(), 5);
  assert.deepEqual(timeline.view.conversation.map((item) => item.seq), [296, 297, 298, 299, 300]);
  assert.equal(timeline.exhausted, true, "fewer than a page: the start of the conversation");
  assert.equal(await timeline.older(), 0);
});

test("the first history page marks the timeline ready even when it holds nothing", () => {
  const views = [];
  let timeline = null;
  timeline = new Timeline(null, () => views.push(timeline?.ready));
  assert.equal(timeline.ready, false);
  timeline.addMany([]);
  timeline.historyReady();
  assert.equal(timeline.ready, true);
  assert.equal(views.at(-1), true, "the ready state is painted");
  timeline.reset();
  assert.equal(timeline.ready, false, "a reset waits for the new history again");
});

test("an attachment is found in the owner's own conversation only, as bytes or as the blob that holds them", () => {
  const timeline = new Timeline(null);
  const hash = "b".repeat(64);
  timeline.add({ ...message(1), body: { text: "", attachments: [{ name: "a.png", mime_type: "image/png", data: "QUJD" }, { name: "b.png", mime_type: "image/png", data: { $blob: hash, mime: "text/plain", size: 100, summary: "x" } }] } });
  timeline.add({ ...message(2), from: "service:clock", to: "person:owner", body: { text: "", attachments: [{ name: "c.png", mime_type: "image/png", data: "QUJD" }] } });
  assert.deepEqual(timeline.inlineAttachment("m1", 0).item.name, "a.png");
  assert.deepEqual(timeline.inlineAttachment("m1", 1), { blob: hash, name: "b.png", mime_type: "image/png" });
  assert.equal(timeline.inlineAttachment("m1", 2), null);
  assert.equal(timeline.inlineAttachment("m2", 0), null, "a service is not a party to the conversation");
});

test("a conversation draws the owner's channel label, an agent other than the primary with its name, and no raw markup", () => {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0; }
    append(child) { this.children.push(child); }
    replaceChildren(child) { this.children = child.children; }
    set textContent(value) { this.value = value; }
    get textContent() { return this.value ?? this.children.map((child) => child.textContent).join(""); }
  }
  const elements = { "#log": new Node("main"), "#state": new Node("span"), "#face img": new Node("img") };
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment"), querySelector: (selector) => elements[selector] };
  try {
    appendConversation(elements["#log"], [
      { type: "say", side: "owner", seq: 2, text: "phone", origin: { label: "Phone browser" } },
      { type: "say", side: "owner", seq: 3, text: "<desk>", origin: { label: "Computer browser" } },
    ], { primary: "agent:main" });
    const labels = elements["#log"].children.filter((child) => child.tag === "small").map((child) => child.textContent);
    assert.deepEqual(labels, ["来自 Phone browser", "来自 Computer browser"]);
    assert.equal(elements["#log"].children.find((child) => child.textContent === "<desk>").tag, "div");
    assert.equal(elements["#log"].children.some((child) => child.tag === "button"), false);
  } finally { delete globalThis.document; }
});
