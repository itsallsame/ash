/**
 * `person:owner/ask` (SPEC-02 §4.2): a durable question, and the approval card of the gate. `handle` stays pending until
 * the owner answers on any channel (the answer is a `send` of kind `response` to this request) or the question ends at its
 * `expires_at`. The pending request holds nothing of the router: it is one promise and one timer.
 *
 * Ending without an answer: an approval card (from `service:gate`) counts as `deny`; any other question fails with `timeout`.
 * A question that did not say when it ends ends after 24 hours; none lives longer than 7 days.
 */
import { errorBody, WordError, type ErrorBody, type Message, type WordResult } from "../../../../../sdk/src/message";
import type { LiveClient } from "./clients";

export interface AskOption { id: string; label: string }
/** A confirmation without options of its own gets these. They are not the approval card's `once` / `deny`. */
export const YES_NO: readonly AskOption[] = [{ id: "yes", label: "是" }, { id: "no", label: "否" }];
export const DEFAULT_EXPIRY_MS = 24 * 3600_000;
export const MAX_EXPIRY_MS = 7 * 24 * 3600_000;
export const APPROVAL_SENDER = "service:gate";
const MAX_ANSWERERS = 100;

export interface PendingAsk {
  id: string;
  /** Who asked: the answer goes back to it as the response. */
  from: string;
  turn?: string;
  kind: "approval" | "question" | "confirmation";
  title: string;
  detail: string;
  /** What is being approved, in full, when the gate gave it. */
  original: string;
  options: AskOption[];
  allow_custom: boolean;
  expires_at: number;
  since: number;
}
interface Entry extends PendingAsk {
  settle(result: WordResult | WordError): void;
  timer: ReturnType<typeof setTimeout>;
  /** The channels that were shown a notification for it. */
  notified: Set<string>;
}

export type AnswerResult = { ok: true } | { ok: false; error: ErrorBody };

export class Asks {
  private readonly entries = new Map<string, Entry>();
  /** The channel an approval was answered on, until the gate asks for it (an approval that ended by its time has none). */
  private readonly answerers = new Map<string, LiveClient>();

  constructor(private readonly o: { now(): number; ended(ask: PendingAsk, notified: Set<string>): void; changed(): void }) {}

  list(): PendingAsk[] { return [...this.entries.values()]; }
  has(id: string): boolean { return this.entries.has(id); }

  /** Opens the question: `ask` is what to show, `done` settles when it is answered or ends. */
  wait(msg: Message, signal: AbortSignal): { ask: PendingAsk; done: Promise<WordResult> } {
    const body = (msg.body ?? {}) as Record<string, any>;
    const now = this.o.now();
    const kind: PendingAsk["kind"] = msg.from === APPROVAL_SENDER ? "approval" : body.human_kind === "confirmation" ? "confirmation" : "question";
    const given = Array.isArray(body.options) ? body.options as AskOption[] : [];
    const options = given.length ? given.map(({ id, label }) => ({ id, label })) : kind === "confirmation" ? [...YES_NO] : [];
    const source = body.source as { body_full?: unknown; body_preview?: unknown } | undefined;
    const expires = Math.min(typeof body.expires_at === "number" ? body.expires_at : msg.ts + DEFAULT_EXPIRY_MS, msg.ts + MAX_EXPIRY_MS);
    let entry!: Entry;
    const done = new Promise<WordResult>((resolve, reject) => {
      entry = {
        id: msg.id, from: msg.from, ...(msg.turn ? { turn: msg.turn } : {}), kind, title: String(body.title ?? ""), detail: typeof body.detail === "string" ? body.detail : "",
        original: typeof source?.body_full === "string" ? source.body_full : typeof source?.body_preview === "string" ? source.body_preview : "",
        options, allow_custom: body.allow_custom === true, expires_at: expires, since: now,
        settle: (result) => { this.end(entry); if (result instanceof WordError) reject(result); else resolve(result); },
        timer: setTimeout(() => this.expire(entry), Math.max(0, expires - now)), notified: new Set(),
      };
      entry.timer.unref?.();
      this.entries.set(entry.id, entry);
      signal.addEventListener("abort", () => entry.settle(new WordError("cancelled", "the question was withdrawn")), { once: true });
      if (signal.aborted) entry.settle(new WordError("cancelled", "the question was withdrawn"));
      else this.o.changed();
    });
    return { ask: entry, done };
  }

  /** The owner answered on [by]: `body` is the response body `{ok:true, result:{data:{choice, text?}}}`. */
  answer(id: string, body: unknown, by?: LiveClient): AnswerResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: errorBody("conflict", "this question is no longer open") };
    const data = (body as { ok?: unknown; result?: { data?: { choice?: unknown; text?: unknown } } } | null);
    const choice = data?.ok === true ? data.result?.data?.choice : undefined;
    const text = data?.result?.data?.text;
    if (typeof choice !== "string" || !choice || (text !== undefined && typeof text !== "string"))
      return { ok: false, error: errorBody("bad_request", "an answer is {ok: true, result: {data: {choice, text?}}}") };
    if (!entry.options.some((option) => option.id === choice) && !entry.allow_custom)
      return { ok: false, error: errorBody("bad_request", `${choice} is not one of the options: ${entry.options.map((option) => option.id).join(", ")}`) };
    if (by && entry.kind === "approval") {
      this.answerers.set(id, by);
      for (const old of this.answerers.keys()) { if (this.answerers.size <= MAX_ANSWERERS) break; this.answerers.delete(old); }
    }
    entry.settle({ data: { choice, ...(text !== undefined ? { text } : {}) } });
    return { ok: true };
  }

  /** Who answered the approval [id], once: null when the owner did not (it ended by its time) or it was taken already. */
  takeAnswerer(id: string): LiveClient | null {
    const by = this.answerers.get(id) ?? null;
    this.answerers.delete(id);
    return by;
  }

  /** The router gave up on the request (cancelled, or its own time ran out). */
  cancel(id: string): void { this.entries.get(id)?.settle(new WordError("cancelled", "the question was withdrawn")); }

  private expire(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) return;
    entry.settle(entry.kind === "approval" ? { data: { choice: "deny" } } : new WordError("timeout", "the owner did not answer before the question ended"));
  }

  private end(entry: Entry): void {
    clearTimeout(entry.timer);
    if (this.entries.get(entry.id) !== entry) return;
    this.entries.delete(entry.id);
    this.o.ended(entry, entry.notified);
    this.o.changed();
  }

  /** Records that a channel was notified, so it can be told to take the notification down. */
  noted(id: string, client: string): void { this.entries.get(id)?.notified.add(client); }
}
