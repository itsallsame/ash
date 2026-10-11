import assert from "node:assert/strict";
import test from "node:test";
import { ConversationStore } from "../js/conversation-store.js";

const item = (seq, bytes = 100) => ({ id: `m${seq}`, seq, type: "say", text: `text ${seq}`, byte_size: bytes });
const page = (from, count, options = {}) => ({ dataset_id: "one", snapshot_seq: 10000, items: Array.from({ length: count }, (_, i) => item(from + i)),
  has_more_before: from > 1, has_more_after: from + count <= 10000, ...options });

test("continuous reading keeps a finite window in both directions and preserves the joining item", () => {
  const store = new ConversationStore({ maxItems: 60, maxBytes: 6000 });
  store.apply(page(9981, 20));
  for (let from = 9961; from >= 1; from -= 20) {
    const anchor = store.items[0];
    store.apply(page(from, 20), "before");
    assert.equal(store.get(anchor.id), anchor);
    assert.ok(store.items.length <= 60 && store.bytes <= 6000);
    assert.equal(store.byId.size, store.items.length);
  }
  assert.equal(store.before, 1);
  assert.equal(store.hasBefore, false);
  assert.equal(store.hasAfter, true);
  for (let from = 61; from <= 9981; from += 20) {
    store.apply(page(from, 20), "after");
    assert.ok(store.items.length <= 60 && store.bytes <= 6000);
  }
  assert.equal(store.after, 10000);
  assert.equal(store.hasAfter, false);
});

test("byte bounds, including an oversized item, remain independent of history length", () => {
  const store = new ConversationStore({ maxItems: 100, maxBytes: 1000 });
  store.apply(page(1, 30));
  assert.equal(store.items.length, 10);
  store.apply(page(31, 1, { items: [item(31, 2000)] }), "after");
  assert.deepEqual(store.items.map(i => i.seq), [31]);
  assert.equal(store.bytes, 2000);
  store.apply(page(32, 1), "after");
  assert.equal(store.bytes, 100);
  assert.equal(store.get("m31"), null);
});

test("late pages do not undo hydrated answers and a different dataset drops every previous reference", () => {
  const store = new ConversationStore();
  const answered = { ...item(5), type: "ask", ask: { state: "answered" } };
  store.apply(page(5, 1, { snapshot_seq: 20, items: [answered] }));
  store.apply(page(4, 2, { snapshot_seq: 10, items: [item(4), { ...item(5), type: "ask", ask: { state: "pending" } }] }), "before");
  assert.equal(store.get("m5"), answered);
  assert.equal(store.snapshot, 20);
  store.apply(page(1, 1, { dataset_id: "two", snapshot_seq: 1 }), "after");
  assert.deepEqual(store.items.map(i => i.id), ["m1"]);
  assert.equal(store.snapshot, 1);
});

test("expanded text evicts distant summaries without replacing its reading row", () => {
  const store = new ConversationStore({ maxItems: 60, maxBytes: 6000 });
  store.apply(page(1, 60));
  const reading = store.get("m30");
  store.expand("m30", 5000);
  assert.equal(store.get("m30"), reading);
  assert.ok(store.bytes <= 6000);
  assert.equal(store.items.length, 10);
  store.expand("m30", 10000);
  assert.deepEqual(store.items, [reading]);
  assert.equal(store.bytes, 10100);
  assert.equal(store.previous.type, "say");
  assert.equal(store.previous.text, undefined);
});

test("a selected window stops prefetching rather than retaining growing pages", () => {
  const store = new ConversationStore({ maxItems: 20, maxBytes: 2000 });
  store.apply(page(100, 20));
  store.protect(store.items.map(item => item.id));
  for (let i = 0; i < 10000; i++) store.apply(page(80, 20), "before");
  assert.equal(store.before, 100); assert.equal(store.items.length, 20); assert.equal(store.bytes, 2000);
  store.protect([]); store.apply(page(80, 20), "before");
  assert.equal(store.before, 80); assert.equal(store.items.length, 20);
});
