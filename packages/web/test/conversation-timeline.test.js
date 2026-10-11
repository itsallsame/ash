import assert from "node:assert/strict";
import test from "node:test";
import { ConversationTimeline } from "../js/conversation-timeline.js";
import { until } from "./support.js";

const say = seq => ({ id: `m${seq}`, seq, ts: seq, type: "say", side: "agent", from: "agent:main", text: `text ${seq}`, byte_size: 100 });
const page = (seq, count = 10, fields = {}) => ({ dataset_id: "one", snapshot_seq: 10000, items: Array.from({ length: count }, (_, i) => say(seq + i)),
  has_more_before: seq > 1, has_more_after: seq + count <= 10000, ...fields });
const net = fields => ({ binding: () => 1, same: binding => binding === 1, current: async () => ({ dataset_id: "one", snapshot_seq: 10000, items: [], presence: { state: "idle" } }), ...fields });

test("live traffic far from the latest page does not accumulate tail messages or ledger facts", () => {
  const timeline = new ConversationTimeline(net());
  timeline.acceptPage(page(1));
  for (let seq = 11; seq <= 10000; seq++) timeline.add({ ...say(seq), type: "agent.say" });
  assert.equal(timeline.store.items.length, 10);
  assert.equal(timeline.unseen, 9990);
  assert.equal(timeline.view._records.length, 0);
  assert.equal(timeline.targets.size, 0);
});

test("a stale older request cannot overwrite a jump, even if its transport ignores cancellation", async () => {
  let complete;
  const timeline = new ConversationTimeline(net({ window: params => params.before ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(page(500)) }));
  timeline.acceptPage(page(100));
  const older = timeline.older();
  assert.equal(await timeline.jump("m500"), 10);
  complete(page(90));
  assert.equal(await older, 0);
  assert.equal(timeline.store.before, 500);
});

test("answer relations update one hydrated item without retaining the answering event", async () => {
  const ask = { id: "question", seq: 1, ts: 1, type: "ask", ask: { id: "question", state: "pending" } };
  let reads = 0;
  const timeline = new ConversationTimeline(net({ window: async params => { reads++; assert.equal(params.around_id, "question"); return page(1, 1, { items: [{ ...ask, ask: { id: "question", state: "answered" } }] }); } }));
  timeline.acceptPage(page(1, 1, { items: [ask], has_more_after: false }));
  timeline.add({ id: "answer", seq: 2, ts: 2, type: "ask.answer", reply_to: "question" });
  await until(() => timeline.get("question").ask.state === "answered");
  assert.equal(reads, 1);
  assert.equal(timeline.store.items.length, 1);
  assert.equal(timeline.view._records.length, 0);
});
