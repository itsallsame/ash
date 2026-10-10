/**
 * What a tool call gives back (the coordinator's decision 5 of BUILD-PROGRESS §7, SPEC-02 §3.5):
 *
 *   success   {content: WordResult.content ?? [the data as JSON text], structuredContent: data}
 *   failure   {isError: true, content: [the error as JSON text], structuredContent: {error: ErrorBody}}
 *   receipt   a success whose data is {status, request_id | pending_id, ...}
 *
 * Images: at most 8, each at most 10 MB, 20 MB together, the bytes must be a PNG, JPEG, GIF or WebP; a failed call carries
 * none. A result over 60000 characters is kept as an attachment: the caller gets a 40000 character preview and the
 * reference to read the rest with `service:blobs/read`.
 */
import { errorBody, isErrorCode, type ErrorBody, type ErrorCode, type WordResult } from "../../../../sdk/src/message";
import type { ContentPart } from "../../../../sdk/src/link";

export const MAX_RESULT_CHARS = 60_000;
export const PREVIEW_CHARS = 40_000;
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;

export type McpPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
/** The MCP `CallToolResult`. */
export interface Shaped { content: McpPart[]; structuredContent?: Record<string, unknown>; isError?: boolean }

/** Keeps `full` as an attachment and says where it is. Throws when it cannot. */
export type KeepAttachment = (full: string) => { hash: string; size: number; mime: string };

const text = (value: string): McpPart => ({ type: "text", text: value });
const json = (value: unknown): string => JSON.stringify(value) ?? "null";

/** `structuredContent` must be an object; anything else a word returns is carried as `{value}`. */
const structured = (data: unknown): Record<string, unknown> | undefined =>
  data === undefined ? undefined : data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { value: data };

/** The image format the bytes are, whatever the part claims. */
function sniffImage(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function failure(code: ErrorCode, message: string, extra: { detail?: unknown; recovery_hint?: string } = {}): Shaped {
  return shapeError(errorBody(code, message.slice(0, 1000), extra), () => { throw new Error("no attachments for a refusal"); });
}

/** An error, with a recovery hint, in the shape every tool failure has. A code that is not one of the fourteen becomes `internal`. */
export function shapeError(error: ErrorBody, keep: KeepAttachment): Shaped {
  const code = isErrorCode(error.code) ? error.code : "internal";
  let body = errorBody(code, String(error.message ?? "").slice(0, 2000), { detail: error.detail, recovery_hint: error.recovery_hint || undefined });
  const full = json({ error: body });
  if (full.length > MAX_RESULT_CHARS) {
    let detail: unknown = { truncated: true, preview: json(error.detail).slice(0, PREVIEW_CHARS) };
    try { detail = { ...(detail as object), attachment: keep(json(error.detail)) }; } catch { /* the preview stands */ }
    body = { ...body, detail };
  }
  return { isError: true, content: [text(json({ error: body }))], structuredContent: { error: body } };
}

/** A word's result: images taken out under the limits, an over-long result kept as an attachment. */
export function shapeSuccess(result: WordResult | undefined, keep: KeepAttachment): Shaped {
  const data = result?.data;
  const parts: ContentPart[] | undefined = result?.content;
  const content: McpPart[] = [];
  const images: McpPart[] = [];
  const textual: { type: "text"; text: string }[] = [];
  let chars = data === undefined ? 0 : json(data).length;
  let imageBytes = 0;

  for (const part of parts ?? []) {
    if (part.type === "text") { const p = text(part.text) as { type: "text"; text: string }; content.push(p); textual.push(p); chars += part.text.length; continue; }
    if (part.type === "resource") {
      const p = text(`[resource: stream ${part.stream}, ${part.mime}, ${part.size} bytes; it is not carried here]`) as { type: "text"; text: string };
      content.push(p); textual.push(p); continue;
    }
    const omitted = (why: string) => { const p = text(`[image omitted: ${why}]`) as { type: "text"; text: string }; content.push(p); textual.push(p); };
    const bytes = Buffer.from(String(part.b64).replace(/\s+/g, ""), "base64");
    const mimeType = sniffImage(bytes);
    if (!mimeType) omitted("not a PNG, JPEG, GIF or WebP image");
    else if (images.length >= MAX_IMAGES) omitted(`only the first ${MAX_IMAGES} images of one result are shown`);
    else if (bytes.length > MAX_IMAGE_BYTES || imageBytes + bytes.length > MAX_IMAGES_TOTAL_BYTES) omitted("too large to show");
    else { images.push({ type: "image", data: bytes.toString("base64"), mimeType }); imageBytes += bytes.length; }
  }
  if (!parts) content.push(text(json(data ?? {})));

  if (chars <= MAX_RESULT_CHARS) return { content: [...content, ...images], ...optional(structured(data)) };

  const full = json(textual.length ? { data, content: textual } : { data });
  const preview = full.slice(0, PREVIEW_CHARS);
  let attachment: { hash: string; size: number; mime: string } | undefined;
  try { attachment = keep(full); } catch { /* only the preview can be given */ }
  const cut = { truncated: true, preview, ...(attachment ? { attachment: { ...attachment, read_with: "service:blobs/read {hash, offset?, limit?}" } } : {}),
    note: attachment ? "The result was too long to carry. Read the rest in pieces with service:blobs/read, using attachment.hash." : "The result was too long to carry and could not be stored; ask for a smaller piece." };
  return { content: [text(json(cut)), ...images], structuredContent: cut };
}

const optional = (value: Record<string, unknown> | undefined) => (value ? { structuredContent: value } : {});

/** A success that is only data (a receipt, a list). */
export function plain(data: Record<string, unknown>): Shaped {
  return { content: [text(json(data))], structuredContent: data };
}

/** The same result without its image bytes, for the copy kept in the table. */
export function withoutImages(shaped: Shaped): Shaped {
  return { ...shaped, content: shaped.content.map((part) => (part.type === "image" ? text("[image: delivered with the first answer only]") : part)) };
}
