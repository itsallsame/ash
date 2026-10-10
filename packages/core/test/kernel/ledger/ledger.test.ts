import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Ledger, LedgerVersionError, SCHEMA_VERSION } from "../../../src/kernel/ledger";
import { openLedger, say, tempDir } from "./helpers";

const tables = (ledger: Ledger) =>
  (ledger.db().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test("an empty database gets exactly the five tables and the schema version", () => {
  const { ledger } = openLedger();
  assert.deepEqual(tables(ledger), ["blobs", "kv", "message_blobs", "messages", "requests"].sort());
  assert.equal((ledger.db().prepare("SELECT value FROM kv WHERE key='schema'").get() as { value: string }).value, SCHEMA_VERSION);
  assert.equal(ledger.get("nothing"), null);
  assert.deepEqual(ledger.page({ limit: 10 }), []);
  assert.deepEqual(ledger.unfinished(), []);
});

test("pragmas: WAL, synchronous FULL, foreign keys on", () => {
  const { ledger } = openLedger();
  const one = (sql: string) => Object.values(ledger.db().prepare(sql).get() as object)[0];
  assert.equal(one("PRAGMA journal_mode"), "wal");
  assert.equal(one("PRAGMA synchronous"), 2);
  assert.equal(one("PRAGMA foreign_keys"), 1);
});

test("reopening the same file keeps the data and does not recreate the tables", () => {
  const { ledger, path } = openLedger();
  const first = ledger.append(say("hello"));
  ledger.close();
  const again = Ledger.open(path);
  try { assert.equal(again.get(first.id)?.body && (again.get(first.id)!.body as { text: string }).text, "hello"); } finally { again.close(); }
});

test("a database of another version is refused with exit code 78 and left untouched", () => {
  const dir = tempDir();
  const path = join(dir, "ash.db");
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES('schema','0');");
  raw.close();
  const before = readFileSync(path);
  assert.throws(() => Ledger.open(path), (error: unknown) => {
    assert.ok(error instanceof LedgerVersionError);
    assert.equal(error.exitCode, 78);
    assert.equal(error.found, "0");
    assert.match(error.message, /state/);
    return true;
  });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(dir).sort(), ["ash.db"]);
});

test("an old database without a schema key (or without kv) is refused too", () => {
  for (const sql of ["CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)", "CREATE TABLE events (seq INTEGER PRIMARY KEY)"]) {
    const path = join(tempDir(), "ash.db");
    const raw = new DatabaseSync(path); raw.exec(sql); raw.close();
    assert.throws(() => Ledger.open(path), (error: unknown) => (error as { exitCode?: number }).exitCode === 78);
  }
});

test("there is one connection: db() is always the same object and this module opens the file once", () => {
  const { ledger } = openLedger();
  assert.equal(ledger.db(), ledger.db());
  assert.ok(ledger.db() instanceof DatabaseSync);
  ledger.append(say("x"));
  assert.equal(ledger.db(), ledger.db());
  const sources = readdirSync(new URL("../../../src/kernel/ledger/", import.meta.url));
  let count = 0;
  for (const file of sources) count += (readFileSync(new URL(`../../../src/kernel/ledger/${file}`, import.meta.url), "utf8").match(/new DatabaseSync\(/g) ?? []).length;
  assert.equal(count, 1);
});

test("append assigns id, seq and ts and get returns the same message", () => {
  const { ledger } = openLedger();
  const a = ledger.append(say("one", { origin: { channel: "app", client: "client:s1", label: "手机 · 对话" }, turn: "t1", thread: "th1" }));
  const b = ledger.append({ from: "agent:main", to: "person:owner", kind: "event", word: "say", body: { text: "two" }, reply_to: a.id });
  assert.ok(a.seq >= 1 && b.seq === a.seq + 1);
  assert.match(a.id, /^m_/);
  assert.notEqual(a.id, b.id);
  assert.ok(Math.abs(a.ts - Date.now()) < 60_000);
  assert.deepEqual(ledger.get(a.id), a);
  assert.deepEqual(ledger.get(a.id)?.origin, { channel: "app", client: "client:s1", label: "手机 · 对话" });
  assert.equal(ledger.get(a.id)?.turn, "t1");
  assert.equal(ledger.get(a.id)?.thread, "th1");
  assert.equal(ledger.get(b.id)?.reply_to, a.id);
  assert.equal(ledger.get(b.id)?.origin, undefined);
  assert.equal(a.summary, "one");
});

test("a caller-chosen id and ts are kept; a duplicate id is refused and leaves nothing behind", () => {
  const { ledger } = openLedger();
  const m = ledger.append(say("x", { id: "m_fixed", ts: 1234 }));
  assert.equal(m.id, "m_fixed"); assert.equal(m.ts, 1234);
  assert.throws(() => ledger.append(say("y", { id: "m_fixed" })));
  assert.equal(ledger.page({ limit: 10 }).length, 1);
});

test("page filters: after, before, limit, from, to, word, text, thread", () => {
  const { ledger } = openLedger();
  const ms = [
    ledger.append({ from: "person:owner", to: "agent:main", kind: "event", word: "say", body: { text: "alpha beta" } }),
    ledger.append({ from: "agent:main", to: "person:owner", kind: "event", word: "say", body: { text: "gamma 100% done" }, thread: "t-a" }),
    ledger.append({ from: "agent:main", to: "service:clock", kind: "request", word: "set", body: { at: 5 }, thread: "t-a" }),
    ledger.append({ from: "service:clock", to: "agent:main", kind: "response", word: "set", body: { ok: true }, reply_to: "x", thread: "t-b" }),
    ledger.append({ from: "person:owner", to: "agent:main", kind: "event", word: "say", body: { text: "under_score" } }),
  ];
  const seqs = (q: Parameters<Ledger["page"]>[0]) => ledger.page(q).map((m) => m.seq);
  const [s0, s1, s2, s3, s4] = ms.map((m) => m.seq);
  assert.deepEqual(seqs({ limit: 100 }), [s0, s1, s2, s3, s4]);
  assert.deepEqual(seqs({ limit: 2 }), [s0, s1]);
  assert.deepEqual(seqs({ after: s1, limit: 2 }), [s2, s3]);
  assert.deepEqual(seqs({ before: s4, limit: 2 }), [s2, s3], "before takes the newest ones before it, returned oldest first");
  assert.deepEqual(seqs({ after: s0, before: s4, limit: 100 }), [s1, s2, s3]);
  assert.deepEqual(seqs({ from: "agent:main", limit: 100 }), [s1, s2]);
  assert.deepEqual(seqs({ to: "agent:main", limit: 100 }), [s0, s3, s4]);
  assert.deepEqual(seqs({ word: "set", limit: 100 }), [s2, s3]);
  assert.deepEqual(seqs({ thread: "t-a", limit: 100 }), [s1, s2]);
  assert.deepEqual(seqs({ text: "BETA", limit: 100 }), [s0], "LIKE is case-insensitive for ASCII");
  assert.deepEqual(seqs({ text: "100%", limit: 100 }), [s1], "% in the needle is literal");
  assert.deepEqual(seqs({ text: "_", limit: 100 }), [s4], "_ in the needle is literal");
  assert.deepEqual(seqs({ text: "no such text", limit: 100 }), []);
  assert.deepEqual(seqs({ from: "agent:main", to: "person:owner", word: "say", thread: "t-a", text: "gamma", limit: 100 }), [s1]);
  assert.deepEqual(seqs({ limit: 0 }), [s0], "limit is at least 1");
});

test("text also matches a long message through its summary", () => {
  const { ledger } = openLedger();
  ledger.append(say(`NEEDLE-START ${"x".repeat(20_000)} NEEDLE-END`));
  assert.equal(ledger.page({ text: "NEEDLE-START", limit: 10 }).length, 1);
  assert.equal(ledger.page({ text: "NEEDLE-END", limit: 10 }).length, 1);
  assert.equal(ledger.page({ text: "not there", limit: 10 }).length, 0);
});

test("requests: waiting_owner, dispatched, done, interrupted; unfinished is the ones still open", () => {
  const { ledger } = openLedger();
  const req = (word: string, options?: Parameters<Ledger["append"]>[1]) =>
    ledger.append({ from: "agent:main", to: "service:clock", kind: "request", word, body: {} }, options);
  const a = req("a");
  const b = req("b", { request: { state: "waiting_owner", deadline: 99 } });
  const c = req("c");
  ledger.append({ from: "agent:main", to: null, kind: "event", word: "note", body: {} });

  assert.deepEqual(ledger.request(a.id), { id: a.id, from: "agent:main", to: "service:clock", word: "a", state: "dispatched", deadline: 0 });
  assert.deepEqual(ledger.request(b.id), { id: b.id, from: "agent:main", to: "service:clock", word: "b", state: "waiting_owner", deadline: 99 });
  assert.equal(ledger.request("nope"), null);
  assert.deepEqual(ledger.unfinished().map((r) => r.id), [a.id, b.id, c.id]);

  ledger.setRequest(b.id, "dispatched");
  assert.equal(ledger.request(b.id)?.state, "dispatched");
  ledger.setRequest(a.id, "done");
  ledger.setRequest(c.id, "interrupted");
  assert.deepEqual(ledger.unfinished().map((r) => [r.id, r.state]), [[b.id, "dispatched"]], "interrupted is final: it is not reported again");
  assert.equal(ledger.request(c.id)?.state, "interrupted");
  ledger.setRequest(b.id, "done");
  assert.deepEqual(ledger.unfinished(), []);
});

test("setRequest refuses an unknown request and an unknown state", () => {
  const { ledger } = openLedger();
  assert.throws(() => ledger.setRequest("m_none", "done"), /unknown request/);
  const r = ledger.append({ from: "a", to: "b", kind: "request", word: "w", body: null });
  assert.throws(() => ledger.setRequest(r.id, "weird" as never), RangeError);
  assert.equal(ledger.request(r.id)?.state, "dispatched");
});

test("only requests get a request row, and a request needs a recipient", () => {
  const { ledger } = openLedger();
  const e = ledger.append({ from: "a", to: "b", kind: "event", word: "w", body: 1 });
  assert.equal(ledger.request(e.id), null);
  assert.throws(() => ledger.append({ from: "a", to: null, kind: "request", word: "w", body: 1 }), TypeError);
});

test("tx commits on return and rolls back on throw, including appended messages and blobs", () => {
  const { ledger } = openLedger();
  const kept = ledger.tx(() => ledger.append(say("kept")));
  assert.ok(ledger.get(kept.id));

  let lost = "";
  assert.throws(() => ledger.tx(() => {
    lost = ledger.append(say("lost")).id;
    ledger.append(say("y".repeat(30_000)));
    throw new Error("boom");
  }), /boom/);
  assert.equal(ledger.get(lost), null);
  assert.equal(ledger.page({ limit: 10 }).length, 1);
  assert.equal((ledger.db().prepare("SELECT count(*) AS n FROM message_blobs").get() as { n: number }).n, 0);
  assert.equal((ledger.db().prepare("SELECT count(*) AS n FROM blobs").get() as { n: number }).n, 0);
  assert.equal(ledger.append(say("after")).seq > kept.seq, true, "the ledger still works after a rollback");
});

test("a tx inside a tx joins it: it commits or rolls back with the outer one", () => {
  const { ledger } = openLedger();
  const kept = ledger.tx(() => {
    const a = ledger.append(say("outer"));
    ledger.tx(() => ledger.append(say("inner")));
    return a;
  });
  assert.equal(ledger.page({ limit: 10 }).length, 2);
  assert.ok(ledger.get(kept.id));
  assert.throws(() => ledger.tx(() => { ledger.tx(() => ledger.append(say("x"))); throw new Error("outer"); }));
  assert.equal(ledger.page({ limit: 10 }).length, 2, "the inner work went with the outer failure");
  ledger.tx(() => { ledger.append(say("after")); });
  assert.equal(ledger.page({ limit: 10 }).length, 3, "the ledger still works after a failed nested tx");
});

test("tx refuses an async function and leaves nothing open", () => {
  const { ledger } = openLedger();
  assert.throws(() => ledger.tx((() => Promise.resolve(1)) as never), TypeError);
  ledger.append(say("still works"));
  assert.equal(ledger.page({ limit: 10 }).length, 1);
});

test("other modules can create their own tables through db() and take part in tx", () => {
  const { ledger } = openLedger();
  ledger.db().exec("CREATE TABLE mine (k TEXT PRIMARY KEY)");
  assert.throws(() => ledger.tx(() => { ledger.db().prepare("INSERT INTO mine VALUES('a')").run(); throw new Error("x"); }));
  assert.equal((ledger.db().prepare("SELECT count(*) AS n FROM mine").get() as { n: number }).n, 0);
  ledger.tx(() => ledger.db().prepare("INSERT INTO mine VALUES('a')").run());
  assert.equal((ledger.db().prepare("SELECT count(*) AS n FROM mine").get() as { n: number }).n, 1);
});
