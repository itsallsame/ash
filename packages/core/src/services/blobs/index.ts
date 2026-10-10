/**
 * `service:blobs`: read the attachments of ledger messages (SPEC-01 §4.3 item 7).
 *
 *   read {hash, offset?, limit?}   a text attachment in pieces; offset and limit count bytes of the stored content
 *   get  {hash}                    a binary attachment as a stream reference
 *
 * An attachment can be read only if some message refers to it; otherwise the answer is `not_found`, the same as for a
 * hash that does not exist. Whether the caller may see that message is decided by the gate in front of this service,
 * which can ask `referencingMessages` which messages hold the attachment.
 */
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { HASH_PATTERN, type Ledger } from "../../kernel/ledger";

export const BLOBS_ID = "service:blobs";
/** How much `read` returns when `limit` is not given. */
export const DEFAULT_READ_BYTES = 20_000;
/** The contract's largest `limit`. */
export const MAX_READ_BYTES = 200_000;

export interface BlobsOptions {
  /** Open a stream for the bytes on the connection the caller came in through and return its id (`stream` frames, SPEC-03 §3.4). Without it `get` answers `unavailable`. */
  openStream?: (bytes: Uint8Array, mime: string, ctx: HandleContext) => string | Promise<string>;
}

/** Ids of the messages whose body holds an attachment (oldest first). */
export function referencingMessages(ledger: Pick<Ledger, "db">, hash: string): string[] {
  return (ledger.db().prepare("SELECT message_id FROM message_blobs mb JOIN messages m ON m.id=mb.message_id WHERE mb.hash=? ORDER BY m.seq").all(hash) as { message_id: string }[])
    .map((row) => row.message_id);
}

const isTextMime = (mime: string): boolean => {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  return base.startsWith("text/") || base === "application/json" || base === "application/xml" || base === "application/javascript"
    || base.endsWith("+json") || base.endsWith("+xml");
};
const isContinuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

const fail = (code: ConstructorParameters<typeof WordError>[0], message: string) => new WordError(code, message);

export function createBlobsService(ledger: Ledger, options: BlobsOptions = {}): Member {
  const referenced = (hash: string) => ledger.db().prepare("SELECT 1 FROM message_blobs WHERE hash=? LIMIT 1").get(hash) !== undefined;

  function read(body: Record<string, unknown>): WordResult {
    const hash = body.hash;
    if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) throw fail("bad_request", "hash must be a sha256 in lower-case hex");
    const offset = body.offset === undefined ? 0 : body.offset;
    const limit = body.limit === undefined ? DEFAULT_READ_BYTES : body.limit;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw fail("bad_request", "offset must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_READ_BYTES) throw fail("bad_request", `limit must be an integer from 1 to ${MAX_READ_BYTES}`);
    const found = referenced(hash) ? ledger.blob.get(hash) : null;
    if (!found) throw fail("not_found", "no such attachment");
    if (!isTextMime(found.mime)) throw fail("bad_request", `this attachment is ${found.mime}, not text; use get`);
    const bytes = found.bytes;
    const size = bytes.byteLength;
    const requested = offset as number;
    if (requested >= size) return { data: { text: "", offset: requested, next_offset: null, size, mime: found.mime } };
    // The cut falls on whole characters: skip continuation bytes at the start, step back to a character start at the end.
    let start = requested;
    while (start < size && isContinuation(bytes[start])) start++;
    let end = Math.min(start + (limit as number), size);
    while (end < size && end > start && isContinuation(bytes[end])) end--;
    if (end === start) { end = start + 1; while (end < size && isContinuation(bytes[end])) end++; }
    return { data: {
      text: Buffer.from(bytes.subarray(start, end)).toString("utf8"), offset: start,
      next_offset: end >= size ? null : end, size, mime: found.mime,
    } };
  }

  async function get(body: Record<string, unknown>, ctx: HandleContext): Promise<WordResult> {
    const hash = body.hash;
    if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) throw fail("bad_request", "hash must be a sha256 in lower-case hex");
    const found = referenced(hash) ? ledger.blob.get(hash) : null;
    if (!found) throw fail("not_found", "no such attachment");
    if (!options.openStream) throw fail("unavailable", "this connection cannot receive a stream");
    const stream = await options.openStream(found.bytes, found.mime, ctx);
    return { data: { stream, mime: found.mime, size: found.bytes.byteLength } };
  }

  return {
    id: BLOBS_ID,
    kind: "service",
    name: "blobs",
    words: (): WordContract[] => wordsOf(BLOBS_ID),
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
      const body = msg.body && typeof msg.body === "object" && !Array.isArray(msg.body) ? msg.body as Record<string, unknown> : {};
      if (msg.word === "read") return read(body);
      if (msg.word === "get") return get(body, ctx);
      throw fail("not_found", `service:blobs has no word ${msg.word}`);
    },
  };
}
