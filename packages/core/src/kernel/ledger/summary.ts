/**
 * Deterministic summaries (SPEC-01 §4.3 item 4). Nothing here calls a model: the same input always gives the same text,
 * so a summary can be recomputed and compared.
 */

export const MESSAGE_SUMMARY_MAX = 500;
export const REF_SUMMARY_MAX = 200;

/** Number of Unicode code points. */
export function codePointLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Short text as it is; long text as its start, its end and 「共 N 字」. The result is never longer than `max` UTF-16 units.
 * `max` must leave room for the marker (at least 40).
 */
export function textSummary(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `（共${codePointLength(text)}字）`;
  const budget = Math.max(max - marker.length - 1, 2);
  let headLen = Math.floor(budget * 0.65);
  const tailLen = budget - headLen;
  if (isHigh(text.charCodeAt(headLen - 1))) headLen--;
  let tailStart = text.length - tailLen;
  if (isLow(text.charCodeAt(tailStart))) tailStart++;
  return `${text.slice(0, headLen)}…${text.slice(tailStart)}${marker}`;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What an attachment looks like in a summary: the kind, the mime and the size, plus a description when the sender gave one. */
export function binaryNote(mime: string, size: number, description?: string): string {
  const kind = mime.startsWith("image/") ? "图片" : mime.startsWith("audio/") ? "音频" : mime.startsWith("video/") ? "视频" : "文件";
  return `[${kind} ${mime} ${humanSize(size)}${description ? ` ${textSummary(description, 60)}` : ""}]`;
}

const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const TEXT_FIELDS = ["text", "message", "title", "content", "output"] as const;

/**
 * The summary of one whole message, at most 500 characters. Order of preference:
 *  1. the sender's own summary (`given`, or a string `summary` in the body);
 *  2. a failed response: the code and the message; a successful response: its result is what is summarised;
 *  3. the first text field (`text`, `message`, `title`, `content`, `output`), or the body if it is a string;
 *  4. the body as compact JSON, cut.
 * Then the notes of the attachments, if any.
 */
export function messageSummary(kind: string, word: string, body: unknown, notes: string[], given?: string): string {
  const own = given ?? (obj(body) && typeof obj(body)!.summary === "string" ? obj(body)!.summary as string : undefined);
  const tail = notes.length ? ` ${notes.join(" ")}` : "";
  const room = Math.max(MESSAGE_SUMMARY_MAX - tail.length, 60);
  let head: string;
  if (own !== undefined && own !== "") head = textSummary(own, room);
  else {
    let subject: unknown = body;
    let prefix = "";
    const reply = obj(body);
    if (kind === "response" && reply && typeof reply.ok === "boolean") {
      if (reply.ok === false) {
        const error = obj(reply.error);
        prefix = `失败 ${typeof error?.code === "string" ? error.code : "unknown"}: `;
        subject = typeof error?.message === "string" ? error.message : "";
      } else subject = reply.result;
    }
    const fields = obj(subject);
    const field = fields ? TEXT_FIELDS.map((name) => fields[name]).find((value) => typeof value === "string" && value !== "") : undefined;
    let text: string;
    if (typeof subject === "string") text = subject;
    else if (typeof field === "string") text = field;
    else if (subject === undefined || subject === null) text = "";
    else text = safeJson(subject);
    head = prefix + textSummary(text, Math.max(room - prefix.length, 40));
    if (head === "") head = word;
  }
  const full = head + tail;
  return full.length <= MESSAGE_SUMMARY_MAX ? full : textSummary(full, MESSAGE_SUMMARY_MAX);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}
