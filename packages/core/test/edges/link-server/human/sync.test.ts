import assert from "node:assert/strict";
import test from "node:test";
import { eventually } from "../../../fixtures/wait";
import { Channel, quiet, startHumanHub } from "./helpers";

const say = (n: number) => ({ to: "agent:main", kind: "request" as const, word: "say", body: { text: `第${n}条` } });

test("a message one channel sends reaches the other channel through sync, stamped with where it came from", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { label: "手机 · 对话" });
  const web = await Channel.open(hub, { label: "网页 · Mac", kind: "browser" });
  phone.follow(); web.follow();
  await eventually(() => phone.pages.length && web.pages.length, "both first pages");

  const sent = await phone.send(say(1));

  assert.ok(sent.ok);
  const seen = await web.seen((m) => m.word === "say", "the message on the other channel");
  assert.equal(seen.from, "person:owner");
  assert.equal(seen.origin?.client, phone.clientId);
  assert.equal(seen.origin?.label, "手机 · 对话");
  assert.equal(seen.origin?.channel, "app");
  assert.equal(web.messages.find((m) => m.origin?.client === web.clientId), undefined);
  // The sender gets it too, and the answer of send names the same message.
  await phone.seen((m) => m.id === (sent as { message: { id: string } }).message.id, "the sender's own copy");
});

test("sync with neither after nor before gives the newest page, oldest first; before pages back; after catches up in pages", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub);
  for (let n = 1; n <= 7; n++) assert.ok((await phone.send(say(n))).ok);

  const newest = await phone.read({ limit: 6 });  // 7 requests + 7 responses in the ledger: 14 rows
  assert.equal(newest.length, 1);
  assert.equal(newest[0]!.end, true);
  const rows = newest[0]!.messages as { seq: number }[];
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.seq), [...rows.map((r) => r.seq)].sort((a, b) => a - b), "oldest first");
  assert.equal(rows.at(-1)!.seq, 14, "the newest row is last");

  const older = await phone.read({ before: rows[0]!.seq, limit: 6 });
  const olderRows = older[0]!.messages as { seq: number }[];
  assert.equal(olderRows.length, 6);
  assert.equal(olderRows.at(-1)!.seq, rows[0]!.seq - 1, "before n ends right before n");

  const caught = await phone.read({ after: 3, limit: 4 });
  assert.deepEqual(caught.map((p) => p.end), [false, false, true], "11 rows after seq 3, four per page; end only on the last");
  assert.equal(caught.flatMap((p) => p.messages).length, 11);
});

test("a following sync gets what was recorded after its pages, once; before cannot follow", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub);
  await phone.send(say(1));
  const rows = (await phone.read({ limit: 10 }))[0]!.messages.length;
  phone.follow({ limit: 1 });
  await eventually(() => phone.messages.length === rows, "the history by pages of one");

  await phone.send(say(2));
  await eventually(() => phone.messages.length === rows + 2, "the new request and its response");
  assert.equal(new Set(phone.messages.map((m) => m.id)).size, phone.messages.length);

  phone.client.openSync({ before: 5, follow: true }, { page: () => {}, message: () => {} });
  await eventually(() => phone.logs.some((l) => l.includes("bad_request")), "the refusal");
});

test("a message sent with the same client_id again is the same message; with other content it is a conflict", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub);

  const first = await phone.client.send({ ...say(1), client_id: "retry-1" });
  const again = await phone.client.send({ ...say(1), client_id: "retry-1" });
  const other = await phone.client.send({ ...say(2), client_id: "retry-1" });

  assert.ok(first.ok && again.ok);
  assert.deepEqual((again as { message: unknown }).message, (first as { message: unknown }).message);
  assert.equal((again as { duplicate?: boolean }).duplicate, true);
  assert.equal(hub.mini.sent.length, 1, "the router heard it once");
  assert.ok(!other.ok && other.error.code === "conflict");
});

test("wait: true answers with the response; a refusal comes back as an error", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub);

  const waited = await phone.send({ ...say(1), wait: true });
  const refused = await phone.send({ to: "agent:nobody", kind: "request", word: "say", body: { text: "x" } });

  assert.ok(waited.ok);
  assert.deepEqual((waited as { response?: unknown }).response, { ok: true, result: { data: { accepted: true } } });
  assert.ok(!refused.ok && refused.error.code === "offline");
  await quiet(50);
});

test("send is answered at once with the id the hub made, before a slow word has been handled", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  hub.mini.stub("agent:slow", ["say"], () => new Promise(() => {}));
  const phone = await Channel.open(hub);

  const sent = await phone.send({ to: "agent:slow", kind: "request", word: "say", body: { text: "慢" } });

  assert.ok(sent.ok);
  assert.equal(hub.ledger.get(sent.message.id)?.seq, sent.message.seq);
  assert.match(hub.mini.sent.at(-1)!.msg.word, /say/);
});
