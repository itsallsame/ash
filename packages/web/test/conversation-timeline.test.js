import assert from "node:assert/strict";
import test from "node:test";
import { ConversationTimeline } from "../js/conversation-timeline.js";
import { until } from "./support.js";

const say = seq => ({ id: `m${seq}`, seq, ts: seq, type: "say", side: "agent", from: "agent:main", text: `text ${seq}`, byte_size: 100 });
const page = (seq, count = 10, fields = {}) => ({ dataset_id: "one", snapshot_seq: 10000, items: Array.from({ length: count }, (_, i) => say(seq + i)),
  has_more_before: seq > 1, has_more_after: seq + count <= 10000, ...fields });
const net = fields => ({ binding: () => 1, same: binding => binding === 1, current: async () => ({ dataset_id: "one", snapshot_seq: 10000, as_of: Date.now(), next_change_at: null, items: [], presence: { state: "idle" } }), ...fields });

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

const currentState = (as_of, next_change_at) => ({ dataset_id: "one", snapshot_seq: 10000, as_of, next_change_at, items: [], presence: { state: "idle" } });
async function advance(t, ms) {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  t.mock.timers.tick(0);
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("current refresh uses server-relative time even when the device clock is years ahead or behind", async t => {
  const serverNow = 1800000000000;
  for (const skew of [-10, 10]) await t.test(`device clock offset ${skew} years`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: serverNow + skew * 365 * 86400000 });
    let reads = 0;
    const timeline = new ConversationTimeline(net({ current: async () => { reads++; return currentState(serverNow + 5000, null); } }));
    timeline.acceptCurrent(currentState(serverNow, serverNow + 5000));
    await advance(t, 5000);
    assert.equal(reads, 0, "clock skew cannot trigger early polling");
    await advance(t, 50);
    assert.equal(reads, 1, "server deadline still triggers without waiting for the local clock to catch up");
    timeline.clearCurrentRefresh();
  });
});

test("repeated past current deadlines back off from one second up to thirty seconds and a future deadline resets them", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const stale = currentState(1800000000000, 1799999999999);
  const timeline = new ConversationTimeline(net({ current: async () => { reads++; return stale; } }));
  timeline.acceptCurrent(stale);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = reads;
    await advance(t, delay - 1);
    assert.equal(reads, before, "no request before the backoff interval");
    await advance(t, 1);
    assert.equal(reads, before + 1);
  }
  timeline.acceptCurrent(currentState(1800000000000, 1800000002000));
  const before = reads;
  await advance(t, 2049);
  assert.equal(reads, before);
  await advance(t, 1);
  assert.equal(reads, before + 1);
  await advance(t, 999);
  assert.equal(reads, before + 1);
  await advance(t, 1);
  assert.equal(reads, before + 2, "normal future response reset the next expired response to one second");
  timeline.clearCurrentRefresh();
});

test("a distant current deadline stays within the browser timer range instead of overflowing into immediate polling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const timeline = new ConversationTimeline(net({ current: async () => { reads++; return currentState(1800000000000, null); } }));
  timeline.acceptCurrent(currentState(1800000000000, 2100000000000));
  await advance(t, 2147483646);
  assert.equal(reads, 0);
  await advance(t, 1);
  assert.equal(reads, 1, "long deadlines recheck at the maximum safe timeout");
  timeline.clearCurrentRefresh();
});

test("invalid current times wait at least one second and no upcoming change stops the timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const timeline = new ConversationTimeline(net({ current: async () => { reads++; return currentState(1800000000000, null); } }));
  for (const fields of [{ as_of: NaN }, { as_of: Infinity }, { next_change_at: Infinity }, { as_of: undefined }, { next_change_at: undefined }]) {
    timeline.clearCurrentRefresh();
    timeline.acceptCurrent({ ...currentState(1800000000000, 1800000002000), ...fields });
    const before = reads;
    await advance(t, 999);
    assert.equal(reads, before);
    await advance(t, 1);
    assert.equal(reads, before + 1);
    assert.equal(timeline.current.as_of, 1800000000000, "a valid response recovers even after an invalid server timestamp");
    await advance(t, 60000);
    assert.equal(reads, before + 1, "null deadline has no recurring poll");
  }
  timeline.clearCurrentRefresh();
});

test("clearing current refresh cancels timers and late replies; reset clears the backoff too", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let complete, reads = 0;
  const stale = currentState(1800000000000, 1799999999999);
  const timeline = new ConversationTimeline(net({ current: () => { reads++; return new Promise(resolve => { complete = resolve; }); } }));
  timeline.acceptCurrent(stale);
  await advance(t, 1000);
  assert.equal(reads, 1);
  timeline.clearCurrentRefresh();
  complete(stale);
  await advance(t, 60000);
  assert.equal(reads, 1, "a reply from before disconnect/disposal cannot recreate a timer");
  timeline.acceptCurrent(stale);
  timeline.reset();
  await advance(t, 60000);
  assert.equal(reads, 1);
  timeline.acceptCurrent(stale);
  await advance(t, 999);
  assert.equal(reads, 1);
  await advance(t, 1);
  assert.equal(reads, 2, "reset restored the one-second initial interval");
  timeline.clearCurrentRefresh();
  complete(currentState(1800000000000, null));
  await advance(t, 0);
});
