import { LIMITS, frameError, frameType, type Frame, type FrameType } from "../../sdk/src/link";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A fresh random id, e.g. `c_3f2a…`. */
export const newId = (prefix: string): string => `${prefix}${globalThis.crypto.randomUUID()}`;

/** True when [text] is more than one frame may hold (the cheap bound first; encoding only when it is close). */
export const tooLarge = (text: string): boolean => text.length > LIMITS.frameBytes || (text.length * 3 > LIMITS.frameBytes && encoder.encode(text).length > LIMITS.frameBytes);

/** The wire text of [frame]. Throws when the frame breaks the protocol, so a bug is found where it is made. */
export function encodeFrame(frame: Frame): string {
  const t = frameType(frame);
  if (!t) throw new TypeError("not a frame");
  const problem = frameError(t, frame);
  if (problem) throw new TypeError(`invalid ${t} frame: ${problem}`);
  const text = JSON.stringify(frame);
  if (tooLarge(text)) throw new RangeError(`${t} frame is larger than ${LIMITS.frameBytes} bytes; send it as a stream`);
  return text;
}

export type Decoded =
  | { ok: true; frame: Frame }
  | { ok: false; error: string; t: FrameType | null; id?: string; value?: unknown };

function toText(data: unknown, isBinary: boolean | undefined): string | null {
  if (isBinary) return null;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return decoder.decode(data);
  if (ArrayBuffer.isView(data)) return decoder.decode(data);
  if (Array.isArray(data) && data.every(ArrayBuffer.isView)) {
    const parts = data as ArrayBufferView[];
    const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) { joined.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at); at += part.byteLength; }
    return decoder.decode(joined);
  }
  return null;
}

/** Turns a received WebSocket message into a checked frame. */
export function decodeFrame(data: unknown, isBinary?: boolean): Decoded {
  let text: string | null;
  try { text = toText(data, isBinary); } catch { return { ok: false, error: "not valid UTF-8", t: null }; }
  if (text === null) return { ok: false, error: "frames are UTF-8 text messages", t: null };
  if (tooLarge(text)) return { ok: false, error: `frame is larger than ${LIMITS.frameBytes} bytes`, t: null };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, error: "not JSON", t: null }; }
  const t = frameType(value);
  const id = value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : undefined;
  if (!t) return { ok: false, error: "unknown or missing frame type", t: null, id, value };
  const problem = frameError(t, value);
  return problem ? { ok: false, error: `${t}: ${problem}`, t, id, value } : { ok: true, frame: value as Frame };
}
