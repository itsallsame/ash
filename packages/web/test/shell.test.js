import assert from "node:assert/strict";
import test from "node:test";
import { Timeline, render } from "../js/app.js";

const item = seq => ({ seq, id: `m${seq}`, ts: seq, type: "say", side: "owner", text: `text ${seq}`, attachments: [], byte_size: 100 });
const page = (items, extra = {}) => ({ dataset_id: "one", snapshot_seq: 1000, items, has_more_before: true, has_more_after: false, ...extra });

test("older pagination sorts hydrated entities and drops a late page from before a reset", async () => {
  let resolveOld;
  const net = { window: () => new Promise(resolve => { resolveOld = resolve; }) };
  const timeline = new Timeline(net);
  timeline.acceptPage(page([item(201), item(202)]));
  const pending = timeline.older();
  timeline.reset(); timeline.acceptPage(page([item(300)]));
  resolveOld(page([item(198), item(199), item(199), item(200)]));
  assert.equal(await pending, 0);
  assert.deepEqual(timeline.store.items.map(item => item.seq), [300]);
  net.window = async params => { assert.equal(params.before, 300); return page([item(297), item(296), item(297), item(298), item(299)], { has_more_before: false }); };
  assert.equal(await timeline.older(), 5);
  assert.deepEqual(timeline.view.conversation.map(item => item.seq), [296, 297, 298, 299, 300]);
  assert.equal(timeline.exhausted, true);
  assert.equal(await timeline.older(), 0);
});

test("an empty display snapshot becomes ready and a reset waits for a new one", () => {
  const timeline = new Timeline(null);
  assert.equal(timeline.ready, false);
  timeline.acceptPage(page([], { has_more_before: false })); timeline.historyReady();
  assert.equal(timeline.ready, true);
  timeline.reset(); assert.equal(timeline.ready, false);
});

test("hydrated pages replace replay state without retaining raw attachment bytes", () => {
  const timeline = new Timeline(null);
  const attachment = { source: "inline", message_id: "m1", index: 0, name: "a.png", mime_type: "image/png" };
  timeline.acceptPage(page([{ ...item(1), attachments: [attachment] }]));
  assert.equal(timeline.get("m1").attachments[0], attachment);
  assert.equal(timeline.records, undefined);
  assert.equal(timeline.view._records.length, 0);
  assert.equal(timeline.get("m1").body, undefined);
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
    render({ presence: { text: "", avatar: "default" }, conversation: [
      { type: "say", side: "owner", seq: 2, text: "phone", origin: { label: "Phone browser" } },
      { type: "say", side: "owner", seq: 3, text: "<desk>", origin: { label: "Computer browser" } },
    ] }, [], undefined, undefined, { primary: "agent:main" });
    const labels = elements["#log"].children.filter((child) => child.tag === "small").map((child) => child.textContent);
    assert.deepEqual(labels, ["来自 Phone browser", "来自 Computer browser"]);
    assert.equal(elements["#log"].children.find((child) => child.textContent === "<desk>").tag, "div");
    assert.equal(elements["#log"].children.some((child) => child.tag === "button"), false);
  } finally { delete globalThis.document; }
});
