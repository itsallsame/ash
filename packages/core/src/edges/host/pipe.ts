/**
 * The kernel's end of its private pipe to the host (ash-host/1): its own standard input and output, which only the host
 * that started it holds. No port, no token: nothing else on the machine can reach the host through the kernel's
 * contract. JSON lines both ways (sdk/host.ts):
 *   stdin   {"boot":{"seal_key":…}} first; then {"reply":id,"ok":…} answers and {"event":…} host events
 *   stdout  {"call":id,"method":…,"params":…}
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { HostEvent, HostResponse } from "../../../../sdk/src/host";
import { parseHostEvent } from "./events";

export interface HostEventReader {
  /** Resolves when the input ends (the host closed the pipe, or the pipe was closed). */
  done: Promise<void>;
  /** Stops handing over events (later ones are dropped); calls still go through until the pipe is closed. */
  close(): void;
}

/** A call that got no answer within its time ([name] "TimeoutError"), or a pipe that is gone ("ClosedError"). */
export class HostPipeError extends Error {
  constructor(readonly name: "TimeoutError" | "ClosedError", message: string) { super(message); }
}

export interface HostPipe {
  /** The secrets from the first line. Rejects when the input ends first, when the line is malformed, or after [ms]. */
  boot(ms?: number): Promise<{ sealKey: Buffer }>;
  /** One call to the host and its answer line (ok or error). */
  request(method: string, params: unknown, timeoutMs: number): Promise<HostResponse<unknown>>;
  /** Hands the host's events to [onEvent], those that came before first; a bad line or a throwing handler is logged. */
  events(onEvent: (event: HostEvent) => void | Promise<void>): HostEventReader;
  /** Resolves when the host closed the pipe. */
  done: Promise<void>;
  close(): void;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createHostPipe(input: Readable, output: Writable, log: (line: string) => void = (line) => console.error(line)): HostPipe {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let closed = false;
  const done = new Promise<void>((resolve) => lines.on("close", () => {
    closed = true;
    for (const [, p] of pending) p.reject(new HostPipeError("ClosedError", "the host closed the pipe"));
    pending.clear();
    bootWaiter?.reject(new Error("the host closed the pipe before the secrets"));
    resolve();
  }));

  let bootLine: { sealKey: Buffer } | Error | null = null;
  let bootWaiter: { resolve: (v: { sealKey: Buffer }) => void; reject: (e: Error) => void } | null = null;
  const pending = new Map<number, { resolve: (r: HostResponse<unknown>) => void; reject: (e: Error) => void }>();
  let seq = 0;
  const queued: HostEvent[] = [];
  let handler: ((event: HostEvent) => void | Promise<void>) | null = null;

  const deliver = (event: HostEvent) => {
    Promise.resolve()
      .then(() => handler!(event))
      .catch((error: unknown) => log(`[host] event handler failed for ${event.event}: ${(error as Error).message}`));
  };

  const takeBoot = (value: unknown): { sealKey: Buffer } | Error => {
    const text = isObject(value) ? value.seal_key : undefined;
    const key = typeof text === "string" && /^[A-Za-z0-9_-]+$/.test(text) ? Buffer.from(text, "base64url") : Buffer.alloc(0);
    return key.length === 32 ? { sealKey: key } : new Error("the seal key is not 32 bytes of base64url");
  };

  lines.on("line", (line) => {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { log(`[host] skipped line (not JSON): ${line.slice(0, 120)}`); return; }
    if (!isObject(value)) { log("[host] skipped line (not an object)"); return; }
    if ("boot" in value) {
      if (bootLine) { log("[host] skipped a second boot line"); return; }
      bootLine = takeBoot(value.boot);
      if (bootWaiter) { bootLine instanceof Error ? bootWaiter.reject(bootLine) : bootWaiter.resolve(bootLine); bootWaiter = null; }
      return;
    }
    if (typeof value.reply === "number") {
      const p = pending.get(value.reply);
      if (!p) { log(`[host] skipped a reply to no call (${value.reply})`); return; }
      pending.delete(value.reply);
      const { reply: _id, ...response } = value;
      p.resolve(response as HostResponse<unknown>);
      return;
    }
    const parsed = parseHostEvent(line);
    if (!parsed.ok) { log(`[host] skipped event line (${parsed.reason}): ${line.slice(0, 200)}`); return; }
    if (handler) deliver(parsed.event); else queued.push(parsed.event);
  });

  return {
    boot: (ms = 15_000) => new Promise((resolve, reject) => {
      if (bootLine) return bootLine instanceof Error ? reject(bootLine) : resolve(bootLine);
      if (closed) return reject(new Error("the host closed the pipe before the secrets"));
      const timer = setTimeout(() => { bootWaiter = null; reject(new Error(`no secrets from the host within ${ms} ms`)); }, ms);
      bootWaiter = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    }),
    request: (method, params, timeoutMs) => new Promise((resolve, reject) => {
      if (closed) return reject(new HostPipeError("ClosedError", "the host closed the pipe"));
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new HostPipeError("TimeoutError", `no answer to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      output.write(`${JSON.stringify({ call: id, method, params })}\n`);
    }),
    events: (onEvent) => {
      handler = onEvent;
      for (const event of queued.splice(0)) deliver(event);
      return { done, close: () => { handler = () => {}; } };
    },
    done,
    close: () => lines.close(),
  };
}
