import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import { compileSchema } from "../../../../sdk/src/word";
import { openLedger, say } from "../../kernel/ledger/helpers";
import type { BlobRef } from "../../../src/kernel/ledger";
import { createBlobsService, DEFAULT_READ_BYTES, referencingMessages } from "../../../src/services/blobs";

const ctx: HandleContext = { signal: new AbortController().signal, caller: { member: "agent:main", via: "agent", local: false }, raw: null };
const request = (word: string, body: unknown): Message => ({ seq: 0, id: "m_req", ts: 0, from: "agent:main", to: "service:blobs", kind: "request", word, body });

function setup(openStream?: Parameters<typeof createBlobsService>[1]) {
  const { ledger } = openLedger();
  const service = createBlobsService(ledger, openStream);
  const call = async (word: string, body: unknown): Promise<WordResult | WordError> => {
    try { return await service.handle(request(word, body), ctx) as WordResult; } catch (error) { if (error instanceof WordError) return error; throw error; }
  };
  return { ledger, service, call };
}
const okResult = (reply: WordResult | WordError) => { assert.ok(!(reply instanceof WordError), String(reply)); return (reply as WordResult).data as Record<string, any>; };
const errorCode = (reply: WordResult | WordError) => { assert.ok(reply instanceof WordError, "expected a WordError"); return (reply as WordError).code; };

test("the member is service:blobs and its words are the contracts of the sdk", () => {
  const { service } = setup();
  assert.equal(service.id, "service:blobs");
  assert.equal(service.kind, "service");
  assert.deepEqual(service.words().map((w) => w.word).sort(), ["get", "read"]);
  assert.ok(service.words().every((w) => w.member === "service:blobs"));
});

test("read returns the text of an attachment in pieces that join back to the original", async () => {
  const { ledger, call } = setup();
  const text = "第一行\n".repeat(3000) + "ends 😀 here";                  // over 8 KB, multi-byte on purpose
  const m = ledger.append(say(text));
  const hash = (m.body as { text: BlobRef }).text.$blob;
  const size = Buffer.byteLength(text);

  const whole = okResult(await call("read", { hash, limit: 200_000 }));
  assert.equal(whole.text, text); assert.equal(whole.size, size); assert.equal(whole.next_offset, null); assert.equal(whole.mime, "text/plain");

  for (const step of [1, 2, 7, 1000, 4096]) {
    let offset = 0; let joined = ""; let rounds = 0;
    while (offset !== null && rounds++ < 100_000) {
      const result = okResult(await call("read", { hash, offset, limit: step }));
      assert.ok(result.offset >= offset && result.offset - offset < 4, "the start moves on at most to the next character");
      joined += result.text;
      offset = result.next_offset;
    }
    assert.equal(joined, text, `step ${step}`);
  }
});

test("read: default limit, offset past the end, text only, bad input", async () => {
  const { ledger, call } = setup();
  const text = "a".repeat(DEFAULT_READ_BYTES + 5000);
  const hash = (ledger.append(say(text)).body as { text: BlobRef }).text.$blob;
  const first = okResult(await call("read", { hash }));
  assert.equal(first.text.length, DEFAULT_READ_BYTES); assert.equal(first.next_offset, DEFAULT_READ_BYTES);
  const past = okResult(await call("read", { hash, offset: text.length + 10 }));
  assert.deepEqual([past.text, past.next_offset, past.size], ["", null, text.length]);

  const image = ledger.append({ from: "a", to: null, kind: "event", word: "w", body: { mime: "image/png", b64: Buffer.from([0, 255, 1, 7]).toString("base64") } });
  const imageHash = (image.body as { b64: BlobRef }).b64.$blob;
  assert.equal(errorCode(await call("read", { hash: imageHash })), "bad_request");
  assert.equal(errorCode(await call("read", { hash: "xyz" })), "bad_request");
  assert.equal(errorCode(await call("read", { hash, offset: -1 })), "bad_request");
  assert.equal(errorCode(await call("read", { hash, limit: 0 })), "bad_request");
  assert.equal(errorCode(await call("read", { hash, limit: 200_001 })), "bad_request");
});

test("an attachment no message refers to is not_found, even though the content exists", async () => {
  const { ledger, call } = setup();
  const loose = ledger.blob.put(new TextEncoder().encode("loose text"), "text/plain");
  assert.ok(ledger.blob.get(loose));
  assert.equal(errorCode(await call("read", { hash: loose })), "not_found");
  assert.equal(errorCode(await call("get", { hash: loose })), "not_found");
  assert.equal(errorCode(await call("read", { hash: "0".repeat(64) })), "not_found");
  assert.equal(errorCode(await call("get", { hash: "0".repeat(64) })), "not_found");
});

test("an attachment of a rolled-back message is not_found", async () => {
  const { ledger, call } = setup();
  let hash = "";
  assert.throws(() => ledger.tx(() => { hash = (ledger.append(say("q".repeat(20_000))).body as { text: BlobRef }).text.$blob; throw new Error("no"); }));
  assert.equal(errorCode(await call("read", { hash })), "not_found");
});

test("get hands the bytes to the stream opener and answers with the stream reference", async () => {
  const seen: { bytes: Uint8Array; mime: string; ctx: HandleContext }[] = [];
  const { ledger, call } = setup({ openStream: (bytes, mime, c) => { seen.push({ bytes, mime, ctx: c }); return "s_42"; } });
  const png = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
  const m = ledger.append({ from: "agent:main", to: null, kind: "event", word: "say", body: { type: "image", mime: "image/png", b64: png.toString("base64") } });
  const hash = (m.body as { b64: BlobRef }).b64.$blob;
  const result = okResult(await call("get", { hash }));
  assert.deepEqual(result, { stream: "s_42", mime: "image/png", size: 3000 });
  assert.deepEqual(Buffer.from(seen[0]!.bytes), png);
  assert.equal(seen[0]!.ctx, ctx);
});

test("get without a way to open streams is unavailable", async () => {
  const { ledger, call } = setup();
  const hash = (ledger.append(say("w".repeat(20_000))).body as { text: BlobRef }).text.$blob;
  assert.equal(errorCode(await call("get", { hash })), "unavailable");
});

test("results fit the contract's result schema; inputs the contract accepts are accepted", async () => {
  const { ledger, service, call } = setup({ openStream: () => "s_1" });
  const hash = (ledger.append(say("v".repeat(20_000))).body as { text: BlobRef }).text.$blob;
  for (const word of service.words()) {
    const input = word.word === "read" ? { hash, offset: 0, limit: 10 } : { hash };
    assert.ok(compileSchema(word.input_schema)(input));
    const result = okResult(await call(word.word, input));
    assert.ok(compileSchema(word.result_schema!)(result), `${word.word}: ${JSON.stringify(result)}`);
  }
});

test("an unknown word is not_found; referencingMessages lists the holders in order", async () => {
  const { ledger, call } = setup();
  assert.equal(errorCode(await call("delete", {})), "not_found");
  const text = "r".repeat(20_000);
  const a = ledger.append(say(text)), b = ledger.append(say(text));
  const hash = (a.body as { text: BlobRef }).text.$blob;
  assert.deepEqual(referencingMessages(ledger, hash), [a.id, b.id]);
  assert.deepEqual(referencingMessages(ledger, "1".repeat(64)), []);
});
