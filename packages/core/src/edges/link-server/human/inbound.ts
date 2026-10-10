/**
 * `send` (SPEC-03 §5.1): the owner's word from a channel becomes `router.send`, stamped `person:owner` with where it
 * came from. A `send` with the same `client_id` and the same content is answered again with the first message
 * (`duplicate: true`), with other content it is a `conflict`.
 *
 * The router does not hand back the message it recorded, so the answer's `{id, seq}` is read from the router's own
 * announcement of it (`subscribe`): the first message of the owner from this channel that matches what was sent.
 *
 * The owner's answer to a question (`kind: "response"`, `reply_to` the ask) is not a request to anyone: it ends the
 * pending `person:owner/ask` here, and the router records it as that request's response.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SendFrame } from "../../../../../sdk/src/link";
import { errorBody, type ErrorBody, type HumanOrigin, type Message, type Outgoing, type Reply } from "../../../../../sdk/src/message";
import { OWNER_ID } from "../../../../../sdk/src/ids";
import type { Ledger } from "../../../kernel/ledger";
import type { Caller, Router } from "../../../kernel/types";
import type { Asks } from "./ask";
import type { LiveClient } from "./clients";

type Request = SendFrame["request"];
export type SendOutcome =
  | { ok: true; message: { id: string; seq: number }; duplicate?: true; response?: Record<string, unknown> }
  | { ok: false; error: ErrorBody };

/** The caller the router is given for the owner on a channel; the origin is how the router fills `Message.origin`. */
export type OwnerCaller = Caller & { origin: HumanOrigin };

export const ownerCaller = (c: Pick<LiveClient, "client" | "hand" | "channel" | "provider" | "label" | "local">): OwnerCaller => ({
  member: OWNER_ID, via: "human", local: c.local, client: c.client,
  origin: { channel: c.channel, client: c.client, hand: c.hand, ...(c.provider ? { provider: c.provider } : {}), label: c.label },
});

/** Waits for the router to announce a message of the owner. */
export class Recorded {
  private readonly waiters = new Set<{ match(m: Message): boolean; found: Message | null; resolve(m: Message): void }>();

  /** Must be called before the thing that makes the message. `value()` is the match once it has come. */
  expect(match: (m: Message) => boolean): { promise: Promise<Message>; value(): Message | null; cancel(): void } {
    let waiter!: { match(m: Message): boolean; found: Message | null; resolve(m: Message): void };
    const promise = new Promise<Message>((resolve) => { waiter = { match, found: null, resolve }; });
    this.waiters.add(waiter);
    return { promise, value: () => waiter.found, cancel: () => void this.waiters.delete(waiter) };
  }

  offer(m: Message): void {
    for (const waiter of this.waiters) {
      if (!waiter.match(m)) continue;
      this.waiters.delete(waiter);
      waiter.found = m;
      waiter.resolve(m);
      return;
    }
  }
}

export interface InboundDeps {
  router: Pick<Router, "send">;
  ledger: Pick<Ledger, "db" | "get">;
  recorded: Recorded;
  asks: Asks;
  now(): number;
  /** How long `wait: true` waits for the response (60 s), and how long an answer waits to be recorded. */
  waitMs: number;
  recordMs: number;
  log(message: string, error?: unknown): void;
}

const hashOf = (r: Request) => createHash("sha256").update(JSON.stringify([r.to, r.kind, r.word, r.body, r.reply_to ?? null])).digest("hex");
const fail = (error: ErrorBody): SendOutcome => ({ ok: false, error });
const later = (ms: number) => new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), ms); t.unref?.(); });
const KEEP_MS = 7 * 24 * 3600_000;

export class Inbound {
  private readonly inflight = new Map<string, Promise<SendOutcome>>();

  constructor(private readonly d: InboundDeps) {
    d.ledger.db().exec(`CREATE TABLE IF NOT EXISTS human_sends (client_id TEXT PRIMARY KEY, hash TEXT NOT NULL, message_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL);`);
    d.ledger.db().prepare("DELETE FROM human_sends WHERE at<?").run(d.now() - KEEP_MS);
  }

  async send(c: LiveClient, req: Request): Promise<SendOutcome> {
    const key = req.client_id;
    if (!key) return this.deliver(c, req);
    const hash = hashOf(req);
    const running = this.inflight.get(key);
    if (running) return this.again(await running, hash, key);
    const row = this.d.ledger.db().prepare("SELECT hash,message_id,seq FROM human_sends WHERE client_id=?").get(key) as { hash: string; message_id: string; seq: number } | undefined;
    if (row) return row.hash === hash ? { ok: true, message: { id: row.message_id, seq: row.seq }, duplicate: true } : fail(errorBody("conflict", "this client_id was used for other content"));
    const work = this.deliver(c, req);
    this.inflight.set(key, work);
    try {
      const outcome = await work;
      if (outcome.ok) this.d.ledger.db().prepare("INSERT OR REPLACE INTO human_sends(client_id,hash,message_id,seq,at) VALUES(?,?,?,?,?)").run(key, hash, outcome.message.id, outcome.message.seq, this.d.now());
      return outcome;
    } finally { this.inflight.delete(key); }
  }

  /** The same client_id again while the first is still running. */
  private again(first: SendOutcome, hash: string, key: string): SendOutcome {
    if (!first.ok) return first;
    const row = this.d.ledger.db().prepare("SELECT hash FROM human_sends WHERE client_id=?").get(key) as { hash: string } | undefined;
    return !row || row.hash === hash ? { ok: true, message: first.message, duplicate: true } : fail(errorBody("conflict", "this client_id was used for other content"));
  }

  private async deliver(c: LiveClient, req: Request): Promise<SendOutcome> {
    if (req.kind === "response") return this.answer(req);
    const out: Outgoing = { to: req.to, kind: req.kind, word: req.word, body: req.body, ...(req.reply_to ? { reply_to: req.reply_to } : {}) };
    const seen = this.d.recorded.expect((m) => m.kind === out.kind && m.word === out.word && m.to === out.to && m.origin?.client === c.client && m.reply_to === out.reply_to);
    const sending: Promise<Reply> = this.d.router.send(out, ownerCaller(c)).catch((error) => {
      this.d.log(`send ${out.to}/${out.word} failed`, error);
      return { ok: false, error: errorBody("internal", "the hub failed while handling this request") } as Reply;
    });
    const first = await Promise.race([seen.promise.then(() => null), sending]);
    const message = seen.value();
    seen.cancel();
    if (first && !first.ok) return fail(first.error);
    if (!message) return fail(errorBody("internal", "the message was accepted but not recorded"));
    const ref = { id: message.id, seq: message.seq };
    if (req.wait !== true) { void sending; return { ok: true, message: ref }; }
    const response = await Promise.race([sending, later(this.d.waitMs)]);
    return { ok: true, message: ref, ...(response ? { response: response as unknown as Record<string, unknown> } : {}) };
  }

  private async answer(req: Request): Promise<SendOutcome> {
    const id = req.reply_to;
    if (req.word !== "ask" || !id) return fail(errorBody("bad_request", "a response from the owner is the answer to an ask: word ask, with reply_to"));
    if (!this.d.asks.has(id)) {
      const known = this.d.ledger.get(id);
      return fail(known?.word === "ask" ? errorBody("conflict", "this question was already answered or has ended") : errorBody("not_found", "no such question"));
    }
    const recorded = this.d.recorded.expect((m) => m.kind === "response" && m.reply_to === id);
    const answered = this.d.asks.answer(id, req.body);
    if (!answered.ok) { recorded.cancel(); return fail(answered.error); }
    const message = await Promise.race([recorded.promise, later(this.d.recordMs)]);
    recorded.cancel();
    return message ? { ok: true, message: { id: message.id, seq: message.seq } } : fail(errorBody("result_unknown", "the answer was accepted; its record has not shown up yet"));
  }
}
