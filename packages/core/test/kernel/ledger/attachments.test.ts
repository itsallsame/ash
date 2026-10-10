import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ROW_BODY_LIMIT, type BlobRef } from "../../../src/kernel/ledger";
import { textSummary } from "../../../src/kernel/ledger/summary";
import { openLedger, say } from "./helpers";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const rowBytes = (ledger: ReturnType<typeof openLedger>["ledger"], id: string) =>
  Number((ledger.db().prepare("SELECT length(CAST(body AS BLOB)) AS n FROM messages WHERE id=?").get(id) as { n: number }).n);
const refs = (ledger: ReturnType<typeof openLedger>["ledger"], id: string) =>
  ledger.db().prepare("SELECT hash,path FROM message_blobs WHERE message_id=? ORDER BY path").all(id).map((r) => ({ ...r })) as { hash: string; path: string }[];

test("a short message stays whole: no blob, summary is the text, size is the JSON size", () => {
  const { ledger } = openLedger();
  const m = ledger.append(say("hi there"));
  assert.deepEqual(m.body, { text: "hi there" });
  assert.equal(m.summary, "hi there");
  assert.equal(m.size, Buffer.byteLength(JSON.stringify({ text: "hi there" })));
  assert.deepEqual(refs(ledger, m.id), []);
});

test("a string over 8 KB leaves the row; the content comes back byte for byte", () => {
  const { ledger } = openLedger();
  const text = "长".repeat(9_000) + "尾巴";            // > 8 KB as UTF-8
  const m = ledger.append(say(text));
  const ref = (m.body as { text: BlobRef }).text;
  assert.equal(ref.$blob, sha(text));
  assert.equal(ref.mime, "text/plain");
  assert.equal(ref.size, Buffer.byteLength(text));
  assert.ok(ref.summary.length <= 200 && ref.summary.includes("共9002字"));
  assert.deepEqual(refs(ledger, m.id), [{ hash: ref.$blob, path: "/text" }]);
  const back = ledger.blob.get(ref.$blob)!;
  assert.equal(Buffer.from(back.bytes).toString("utf8"), text);
  assert.equal(back.mime, "text/plain");
  assert.equal(ledger.get(m.id)!.size, Buffer.byteLength(JSON.stringify({ text })));
});

test("a 2 MB message and a 5 MB image: rows stay under 16 KB, summaries exist, content reads back", () => {
  const { ledger } = openLedger();
  const big = "abcdefghij".repeat(200_000);
  const image = randomBytes(5 * 1024 * 1024);
  const m = ledger.append({ from: "agent:main", to: "person:owner", kind: "event", word: "say",
    body: { text: big, attachments: [{ type: "image", mime: "image/png", name: "shot.png", b64: image.toString("base64") }] } });
  assert.ok(rowBytes(ledger, m.id) <= ROW_BODY_LIMIT);
  assert.ok(m.summary.length > 0 && m.summary.length <= 500);
  assert.match(m.summary, /图片 image\/png 5\.0 MB/);
  const stored = m.body as { text: BlobRef; attachments: { type: string; mime: string; name: string; b64: BlobRef }[] };
  assert.equal(stored.attachments[0]!.type, "image");
  assert.equal(stored.attachments[0]!.mime, "image/png");
  assert.equal(stored.attachments[0]!.b64.$blob, sha(image));
  assert.deepEqual(Buffer.from(ledger.blob.get(stored.attachments[0]!.b64.$blob)!.bytes), image);
  assert.equal(ledger.blob.get(stored.attachments[0]!.b64.$blob)!.mime, "image/png");
  assert.equal(Buffer.from(ledger.blob.get(stored.text.$blob)!.bytes).toString(), big);
  assert.deepEqual(refs(ledger, m.id).map((r) => r.path), ["/attachments/0/b64", "/text"]);
});

test("the same content is stored once, however many messages hold it", () => {
  const { ledger, dir } = openLedger();
  const text = "z".repeat(20_000);
  const a = ledger.append(say(text));
  const b = ledger.append(say(text));
  const hash = (a.body as { text: BlobRef }).text.$blob;
  assert.equal((b.body as { text: BlobRef }).text.$blob, hash);
  assert.equal((ledger.db().prepare("SELECT count(*) AS n FROM blobs").get() as { n: number }).n, 1);
  assert.equal((ledger.db().prepare("SELECT count(*) AS n FROM message_blobs WHERE hash=?").get(hash) as { n: number }).n, 2);
  assert.deepEqual(readdirSync(join(dir, "state", "blobs", hash.slice(0, 2))), [hash]);
});

test("summaries are deterministic and short; a sender's summary wins", () => {
  const a = openLedger().ledger;
  const b = openLedger().ledger;
  const text = "开头".repeat(300) + "x".repeat(5000) + "结尾";
  const ma = a.append(say(text)), mb = b.append(say(text));
  assert.equal(ma.summary, mb.summary);
  assert.ok(ma.summary.length <= 500);
  assert.ok(ma.summary.startsWith("开头开头") && ma.summary.endsWith("（共5602字）") && ma.summary.includes("结尾"));
  assert.equal(a.append(say("body text", { body: { text: "ignored", summary: "from the body" } as never })).summary, "from the body");
  assert.equal(a.append({ ...say("x"), body: { text: "T" } }, { summary: "mine" }).summary, "mine");
  assert.equal(a.append({ ...say("x"), body: { text: "T" } }, { summary: "s".repeat(2000) }).summary.length <= 500, true);
});

test("textSummary never splits a character", () => {
  const text = "😀".repeat(1000);
  const s = textSummary(text, 101);
  assert.ok(s.length <= 101);
  assert.doesNotMatch(s, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  assert.equal(textSummary("short", 100), "short");
});

test("a failed response is summarised by its code and message, a successful one by its result", () => {
  const { ledger } = openLedger();
  const bad = ledger.append({ from: "service:x", to: "agent:main", kind: "response", word: "w", body: { ok: false, error: { code: "offline", message: "phone is away" } }, reply_to: "r1" });
  assert.equal(bad.summary, "失败 offline: phone is away");
  const good = ledger.append({ from: "service:x", to: "agent:main", kind: "response", word: "w", body: { ok: true, result: { text: "result text" } }, reply_to: "r2" });
  assert.equal(good.summary, "result text");
});

test("a body over 16 KB made of many small fields: the largest fields go out until the row fits", () => {
  const { ledger } = openLedger();
  const body: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) body[`part${i}`] = { rows: Array.from({ length: 200 }, (_, n) => `line ${i}-${n}`) };
  const m = ledger.append({ from: "agent:main", to: "person:owner", kind: "event", word: "agent.tool", body });
  assert.ok(rowBytes(ledger, m.id) <= ROW_BODY_LIMIT);
  const stored = m.body as Record<string, { $blob?: string }>;
  const outside = Object.values(stored).filter((v) => v.$blob);
  assert.ok(outside.length >= 1);
  for (const part of outside) assert.deepEqual(JSON.parse(Buffer.from(ledger.blob.get(part.$blob!)!.bytes).toString()), body[Object.keys(stored).find((k) => stored[k] === part)!]);
});

test("a body that is only many tiny pieces moves out whole", () => {
  const { ledger } = openLedger();
  const body = Array.from({ length: 6000 }, (_, i) => i);
  const m = ledger.append({ from: "agent:main", to: null, kind: "event", word: "agent.tool", body });
  assert.ok(rowBytes(ledger, m.id) <= ROW_BODY_LIMIT);
  const ref = m.body as BlobRef;
  assert.deepEqual(JSON.parse(Buffer.from(ledger.blob.get(ref.$blob)!.bytes).toString()), body);
  assert.deepEqual(refs(ledger, m.id), [{ hash: ref.$blob, path: "" }]);
});

test("a Uint8Array in a body is binary and leaves the row, however small", () => {
  const { ledger } = openLedger();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const m = ledger.append({ from: "device:abc", to: null, kind: "event", word: "file", body: { name: "a.bin", data: bytes } });
  const ref = (m.body as { data: BlobRef }).data;
  assert.equal(ref.mime, "application/octet-stream");
  assert.deepEqual(Buffer.from(ledger.blob.get(ref.$blob)!.bytes), Buffer.from(bytes));
  assert.equal(m.size, Buffer.byteLength(JSON.stringify({ name: "a.bin", data: null })) + 4);
});

test("a small image part ({mime, b64}) is binary too; plain base64-looking text without a mime is not", () => {
  const { ledger } = openLedger();
  const png = randomBytes(300);
  const m = ledger.append({ from: "agent:main", to: null, kind: "event", word: "say", body: { parts: [{ type: "image", mime_type: "image/jpeg", data: png.toString("base64") }, { data: "AAAA" }] } });
  const parts = (m.body as { parts: { data: BlobRef | string }[] }).parts;
  assert.equal((parts[0]!.data as BlobRef).$blob, sha(png));
  assert.equal(parts[1]!.data, "AAAA");
});

test("a $blob object sent in a body is plain data: it does not make the message hold that attachment", () => {
  const { ledger } = openLedger();
  const secret = ledger.append(say("s".repeat(20_000)));
  const hash = (secret.body as { text: BlobRef }).text.$blob;
  const forged = ledger.append({ from: "app:evil", to: null, kind: "event", word: "x", body: { text: { $blob: hash, mime: "text/plain", size: 1, summary: "x" } } });
  assert.deepEqual(refs(ledger, forged.id), []);
});

test("blob.put/get/info/read: refs are content hashes, unknown refs give null", () => {
  const { ledger } = openLedger();
  const bytes = new TextEncoder().encode("0123456789");
  const ref = ledger.blob.put(bytes, "text/plain");
  assert.equal(ref, sha(bytes));
  assert.deepEqual(ledger.blob.info(ref), { size: 10, mime: "text/plain" });
  assert.equal(Buffer.from(ledger.blob.read(ref, 3, 4)!).toString(), "3456");
  assert.equal(Buffer.from(ledger.blob.read(ref, 8, 100)!).toString(), "89");
  assert.equal(ledger.blob.put(bytes, "text/plain"), ref);
  assert.equal(ledger.blob.get("0".repeat(64)), null);
  assert.equal(ledger.blob.get("../../etc/passwd"), null);
  assert.equal(ledger.blob.read("nope", 0, 1), null);
});

test("blob files are written under blobs/<2 hex>/<hash>, with no temp files left", () => {
  const { ledger, dir } = openLedger();
  const ref = ledger.blob.put(new Uint8Array([9, 9, 9]), "application/octet-stream");
  const file = join(dir, "state", "blobs", ref.slice(0, 2), ref);
  assert.ok(existsSync(file));
  assert.deepEqual(readdirSync(join(dir, "state", "blobs", ref.slice(0, 2))), [ref]);
});
