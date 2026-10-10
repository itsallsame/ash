import { LIMITS, type LinkChannel, type StreamFrame } from "../../sdk/src/link";
import { newId } from "./codec";

const SLICE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += SLICE) binary += String.fromCharCode(...bytes.subarray(at, at + SLICE));
  return btoa(binary);
}
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface StreamSendOptions { ref?: string; mime?: string }

/** Sends [data] as one stream: `open`, `data` chunks of at most 256 KiB, `end`. Returns the stream id. */
export function sendStream(send: (frame: StreamFrame) => void, ch: LinkChannel, data: Uint8Array | string, opts: StreamSendOptions = {}): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const sid = newId("st_");
  send({ t: "stream", sid, op: "open", ch, ...(opts.ref ? { ref: opts.ref } : {}), ...(opts.mime ? { mime: opts.mime } : {}), size: bytes.length });
  let seq = 0;
  for (let at = 0; at < bytes.length; at += LIMITS.streamChunkBytes) {
    send({ t: "stream", sid, op: "data", seq: seq++, b64: bytesToBase64(bytes.subarray(at, at + LIMITS.streamChunkBytes)) });
  }
  send({ t: "stream", sid, op: "end" });
  return sid;
}

export interface ReceivedStream { sid: string; ch: LinkChannel; ref?: string; mime?: string; data: Uint8Array }

/** Largest stream a receiver accepts unless told otherwise. */
export const DEFAULT_MAX_STREAM_BYTES = 64 * 1024 * 1024;

interface Partial_ { ch: LinkChannel; ref?: string; mime?: string; size?: number; next: number; bytes: number; chunks: Uint8Array[] }

/** Puts the chunks of incoming streams back together. */
export class StreamReceiver {
  private readonly open = new Map<string, Partial_>();
  constructor(private readonly o: {
    /** A stream arrived whole. */
    onStream(stream: ReceivedStream): void;
    /** The stream broke (bad order, too big, size mismatch, or the sender gave up). */
    onBroken?(sid: string, code: string, message: string): void;
    send(frame: StreamFrame): void;
    /** Only streams of these channels are taken. */
    accepts(ch: LinkChannel): boolean;
    maxBytes?: number;
  }) {}

  handle(frame: StreamFrame): void {
    if (frame.op === "open") {
      if (!this.o.accepts(frame.ch)) return this.fail(frame.sid, "forbidden", `channel ${frame.ch} is not open on this connection`);
      if (this.open.has(frame.sid)) return this.fail(frame.sid, "conflict", "stream id already in use");
      if (frame.size !== undefined && frame.size > (this.o.maxBytes ?? DEFAULT_MAX_STREAM_BYTES)) return this.fail(frame.sid, "too_large", "stream is larger than this end accepts");
      this.open.set(frame.sid, { ch: frame.ch, ref: frame.ref, mime: frame.mime, size: frame.size, next: 0, bytes: 0, chunks: [] });
      return;
    }
    const partial = this.open.get(frame.sid);
    if (frame.op === "error") {
      if (partial) { this.open.delete(frame.sid); this.o.onBroken?.(frame.sid, frame.code, frame.message); }
      return;
    }
    if (!partial) return this.fail(frame.sid, "not_found", "no such stream");
    if (frame.op === "data") {
      if (frame.seq !== partial.next) return this.fail(frame.sid, "bad_request", `expected chunk ${partial.next}, got ${frame.seq}`);
      const chunk = base64ToBytes(frame.b64);
      partial.next++;
      partial.bytes += chunk.length;
      if (partial.bytes > (partial.size ?? this.o.maxBytes ?? DEFAULT_MAX_STREAM_BYTES)) return this.fail(frame.sid, "too_large", "stream is larger than announced");
      partial.chunks.push(chunk);
      return;
    }
    this.open.delete(frame.sid);
    if (partial.size !== undefined && partial.bytes !== partial.size) { this.o.onBroken?.(frame.sid, "bad_request", "stream ended short of its announced size"); return; }
    const data = new Uint8Array(partial.bytes);
    let at = 0;
    for (const chunk of partial.chunks) { data.set(chunk, at); at += chunk.length; }
    this.o.onStream({ sid: frame.sid, ch: partial.ch, ref: partial.ref, mime: partial.mime, data });
  }

  /** Forgets everything half-received (the connection is gone). */
  reset(): void { this.open.clear(); }

  private fail(sid: string, code: string, message: string): void {
    this.open.delete(sid);
    this.o.send({ t: "stream", sid, op: "error", code, message });
    this.o.onBroken?.(sid, code, message);
  }
}
