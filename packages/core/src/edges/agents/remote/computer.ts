/**
 * One computer's `agent` channel as the hub sees it (SPEC-03 §6): the connection, the operations the hub has asked of it
 * and not yet had an answer to, and what it said that the hub is not ready for.
 *
 * Operations travel as `{t:"agent", id, op, agent, ...fields}` and come back as `{t:"agent", id, op_result, ok, result|error}`.
 * The fields are the driver method's arguments by name (the computer program documents them).
 */
import { randomBytes } from "node:crypto";
import { WordError, isErrorCode } from "../../../../../sdk/src/message";
import type { RuntimeAbilities, RuntimeInfo } from "../../../../../sdk/src/driver";
import type { AgentFrame } from "../../../../../sdk/src/link";
import type { LinkSession } from "../../../../../link/src/server";

export type Frame = Record<string, any>;

/** What the hub assumes of a runtime that did not say (the computer program always does). */
export const DEFAULT_ABILITIES: RuntimeAbilities = {
  resume: true, steer: true, inject_live: false, images: false, compact: "unknown", configure: ["model", "effort"], plugins: false, mcp: true,
  system_prompt: "append", credentials: false, usage: false,
};

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** `hello.channels.agent.runtimes` (SPEC-08 §1.3), read defensively: whatever is not shaped like a runtime is left out. */
export function parseRuntimes(raw: unknown): RuntimeInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: RuntimeInfo[] = [];
  for (const r of raw) {
    if (!isObject(r) || typeof r.kind !== "string" || !r.kind) continue;
    const models = Array.isArray(r.models)
      ? r.models.filter((m): m is Record<string, any> => isObject(m) && typeof m.id === "string").map((m) => ({ id: m.id as string, ...(Array.isArray(m.efforts) ? { efforts: strings(m.efforts) } : {}) }))
      : [];
    out.push({ kind: r.kind, ...(typeof r.version === "string" ? { version: r.version } : {}), models, abilities: { ...DEFAULT_ABILITIES, ...(isObject(r.abilities) ? r.abilities : {}) } });
  }
  return out;
}

/** Operations that change nothing: when the connection drops under one, the answer is `offline`; for the rest it is `result_unknown`. */
const READS = new Set(["agent.list", "config.get"]);

/** A tool call of the computer's agent that the hub has not answered yet. */
export interface Outbound { controller: AbortController; agent: string; key: unknown; turn: unknown; answer(body: Frame): void }

interface Pending { op: string; resolve(result: Frame): void; reject(error: WordError): void; timer: NodeJS.Timeout }

export class Computer {
  readonly handId: string;
  readonly name: string;
  readonly runtimes: Map<string, RuntimeInfo>;
  closed = false;
  /** Events of agents the hub has not started on this connection (what the computer kept while the hub was away), until `start`. */
  readonly held = new Map<string, Frame[]>();
  /** Tool calls the computer's agents have in flight on the hub; they are cancelled with the connection. */
  readonly outbounds = new Set<Outbound>();
  private readonly pending = new Map<string, Pending>();

  constructor(readonly session: LinkSession, handId: string, name: string, runtimes: RuntimeInfo[]) {
    this.handId = handId;
    this.name = name;
    this.runtimes = new Map(runtimes.map((r) => [r.kind, r]));
  }

  /** Send a frame; false when the connection is gone. */
  send(frame: Frame): boolean { return !this.closed && this.session.send({ t: "agent", ...frame } as AgentFrame); }

  /** Ask the computer to do [op] and wait for its answer. Errors are `WordError` with the computer's own code. */
  request(op: string, fields: Frame, timeoutMs: number): Promise<Frame> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new WordError("offline", `computer ${this.name} is not connected`));
      const id = `r_${randomBytes(9).toString("base64url")}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WordError("timeout", `computer ${this.name} did not answer ${op} in time`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { op, resolve, reject, timer });
      if (!this.send({ id, op, ...fields })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new WordError("offline", `computer ${this.name} is not connected`));
      }
    });
  }

  /** A `op_result` frame. An id that is not waited for (answered late, after a timeout) is dropped. */
  settle(frame: Frame): void {
    const pending = typeof frame.id === "string" ? this.pending.get(frame.id) : undefined;
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok === true) { pending.resolve(isObject(frame.result) ? frame.result : {}); return; }
    const error = isObject(frame.error) ? frame.error : {};
    const code = isErrorCode(error.code) ? error.code : "failed";
    pending.reject(new WordError(code, typeof error.message === "string" ? error.message : `${pending.op} failed`, typeof error.recovery_hint === "string" ? { recovery_hint: error.recovery_hint } : {}));
  }

  /** The connection is gone: every waiting operation ends, every tool call in flight is cancelled. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const read = READS.has(pending.op);
      pending.reject(new WordError(read ? "offline" : "result_unknown", `the connection to computer ${this.name} ended during ${pending.op}`));
    }
    for (const call of this.outbounds) call.controller.abort();
    this.outbounds.clear();
    this.held.clear();
  }
}
