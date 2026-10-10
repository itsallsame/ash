/**
 * Long content leaves the message row (SPEC-01 §4.3). A body is long when it is over 16 KB as JSON, when any string in
 * it is over 8 KB, or when it carries binary. What is long is replaced by a reference
 * `{"$blob": <sha256>, "mime", "size", "summary"}` and the content goes to the blob store.
 *
 * Binary is a `Uint8Array`, or an object that has a base64 string in `b64` or `data` next to a mime in `mime`,
 * `mime_type` or `mimeType` (an image, audio or file part). Only the data field is replaced; its siblings stay.
 *
 * A `$blob` object inside an incoming body is only data: it is not registered as a reference, so a sender cannot
 * make a message "hold" somebody else's attachment.
 */
import { binaryNote, textSummary, REF_SUMMARY_MAX } from "./summary";

export const ROW_BODY_LIMIT = 16 * 1024;
export const STRING_LIMIT = 8 * 1024;
/** More than this many fields moved out one by one means the body is mostly small pieces: move the whole body instead. */
const MAX_FIELD_REFS = 32;
/** What one reference costs in the row, rounded up. */
const REF_ESTIMATE = 420;

export interface BlobRef { $blob: string; mime: string; size: number; summary: string }
export interface Externalized {
  /** What goes into the row. */
  stored: unknown;
  /** Every attachment the stored body points to: its place in the original body (JSON Pointer) and its hash. */
  refs: { path: string; hash: string }[];
  /** Descriptions of the binary parts, for the message summary. */
  notes: string[];
  /** Size of the body as it came in (JSON, with binary counted by its real length). */
  size: number;
}
export type PutBlob = (bytes: Uint8Array, mime: string) => string;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_FIELDS = ["b64", "data"] as const;
const MIME_FIELDS = ["mime", "mime_type", "mimeType"] as const;

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const pointer = (parent: string, key: string | number) => `${parent}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
const json = (value: unknown): string => JSON.stringify(value) ?? "null";

function binaryField(value: Record<string, unknown>): { field: string; mime: string } | null {
  const mime = MIME_FIELDS.map((name) => value[name]).find((item) => typeof item === "string" && item !== "") as string | undefined;
  if (!mime) return null;
  for (const field of DATA_FIELDS) {
    const data = value[field];
    if (typeof data === "string" && data.length >= 4 && data.length % 4 === 0 && BASE64.test(data)) return { field, mime };
  }
  return null;
}

export function externalize(body: unknown, put: PutBlob): Externalized {
  const refs: Externalized["refs"] = [];
  const notes: string[] = [];
  let binaryBytes = 0;

  const makeRef = (path: string, bytes: Uint8Array, mime: string, summary: string): BlobRef => {
    const hash = put(bytes, mime);
    refs.push({ path, hash });
    return { $blob: hash, mime, size: bytes.byteLength, summary };
  };

  const walk = (node: unknown, path: string): unknown => {
    if (node instanceof Uint8Array) {
      binaryBytes += node.byteLength;
      notes.push(binaryNote("application/octet-stream", node.byteLength));
      return makeRef(path, node, "application/octet-stream", binaryNote("application/octet-stream", node.byteLength));
    }
    if (typeof node === "string") {
      if (Buffer.byteLength(node) <= STRING_LIMIT) return node;
      return makeRef(path, Buffer.from(node, "utf8"), "text/plain", textSummary(node, REF_SUMMARY_MAX));
    }
    if (Array.isArray(node)) return node.map((item, index) => walk(item, pointer(path, index)));
    if (!isPlain(node)) return node;
    const binary = binaryField(node);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (binary && key === binary.field) {
        const bytes = Buffer.from(value as string, "base64");
        const description = ["name", "alt", "caption", "description"].map((name) => node[name]).find((item) => typeof item === "string" && item !== "") as string | undefined;
        const note = binaryNote(binary.mime, bytes.byteLength, description);
        notes.push(note);
        out[key] = makeRef(pointer(path, key), bytes, binary.mime, note);
      } else out[key] = walk(value, pointer(path, key));
    }
    return out;
  };

  const input = body === undefined ? null : body;
  const size = Buffer.byteLength(JSON.stringify(input, function (this: any, key, value) { return this[key] instanceof Uint8Array ? null : value; }) ?? "null");
  let tree = walk(input, "");
  let text = json(tree);

  if (Buffer.byteLength(text) > ROW_BODY_LIMIT) {
    const fields = fieldsOf(tree);
    const plan: { key: string | number; bytes: number }[] = [];
    let total = Buffer.byteLength(text);
    for (const field of fields.sort((a, b) => b.bytes - a.bytes || String(a.key).localeCompare(String(b.key)))) {
      if (total <= ROW_BODY_LIMIT || plan.length >= MAX_FIELD_REFS || field.bytes <= REF_ESTIMATE) break;
      plan.push(field);
      total -= field.bytes - REF_ESTIMATE;
    }
    if (total <= ROW_BODY_LIMIT) {
      const copy: any = Array.isArray(tree) ? [...tree] : { ...(tree as object) };
      for (const { key } of plan) {
        const child = copy[key];
        const [bytes, mime, summarySource] = typeof child === "string"
          ? [Buffer.from(child, "utf8"), "text/plain", child] as const
          : [Buffer.from(json(child), "utf8"), "application/json", json(child)] as const;
        copy[key] = makeRef(pointer("", key), bytes, mime, textSummary(summarySource, REF_SUMMARY_MAX));
      }
      tree = copy;
      text = json(tree);
    }
    if (Buffer.byteLength(text) > ROW_BODY_LIMIT) {
      const bytes = Buffer.from(json(tree), "utf8");
      tree = makeRef("", bytes, "application/json", textSummary(text, REF_SUMMARY_MAX));
    }
  }
  return { stored: tree, refs, notes, size: size + binaryBytes };
}

/** The direct fields of an object or array body with the JSON size of each. */
function fieldsOf(tree: unknown): { key: string | number; bytes: number }[] {
  if (Array.isArray(tree)) return tree.map((item, key) => ({ key, bytes: Buffer.byteLength(json(item)) }));
  if (isPlain(tree)) return Object.entries(tree).map(([key, item]) => ({ key, bytes: Buffer.byteLength(json(item)) }));
  return [];
}
