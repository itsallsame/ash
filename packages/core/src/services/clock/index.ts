/**
 * `service:clock`: durable timers (HUB-MODULES §3).
 *
 *   set    {at?, every?, to, word, body, label}   store a timer; `at` is Unix ms, `every` seconds (at least 60)
 *   cancel {id}
 *   list
 *   wake.fired (event, from the host module)       the phone's alarm went off: look for due timers
 *
 * A timer sends its stored word to its target as `service:clock` when it is due. `at` alone fires once; `every`
 * repeats; both together fire first at `at` and then every period. A repeating timer that was missed (the phone
 * slept, the hub was down) fires once for the missed rounds and goes on from the next slot after now. Precision is
 * the scan period, not the second.
 *
 * The timers live in the ledger's database (table `timers`), so they survive a restart. While the hub is up they are
 * driven by one in-process timeout; when a host is given the earliest due time is also set as the host's alarm
 * (`wake.at`, only the earliest is kept) so a sleeping phone wakes the hub.
 */
import { randomBytes } from "node:crypto";
import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Router } from "../../kernel/types";

export const CLOCK_ID = "service:clock";
/** The most timers kept at once; a runaway agent should not fill the table. */
export const MAX_TIMERS = 1000;
/** setTimeout cannot wait longer than this; a longer wait is cut and rechecked. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** The part of the host client the clock uses (`HostClient` fits). Answers are not looked at; a host without the capability simply does nothing. */
export interface ClockHost {
  wakeAt(at: number): Promise<unknown>;
  wakeClear(): Promise<unknown>;
}

export interface ClockOptions {
  ledger: Pick<Ledger, "db" | "tx">;
  /** Where a due timer's word goes. */
  router: Pick<Router, "send">;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Absent in tests and on hosts without the wake capability: only the in-process timeout then drives the clock. */
  host?: ClockHost;
  /** Injectable in-process timer; returns the canceller. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  log?: (message: string, error?: unknown) => void;
}

export interface TimerInfo {
  id: string;
  next: number;
  every: number | null;
  to: string;
  word: string;
  body: unknown;
  label: string;
  created_by: string;
}

const realTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

const SELF: Caller = { member: CLOCK_ID, via: "service", local: true };

type Row = { id: string; next_at: number; every_s: number | null; target: string; word: string; body: string; label: string; created_by: string };
const info = (row: Row): TimerInfo => ({ id: row.id, next: row.next_at, every: row.every_s, to: row.target, word: row.word,
  body: JSON.parse(row.body), label: row.label, created_by: row.created_by });

export class ClockService implements Member {
  readonly id = CLOCK_ID;
  readonly kind = "service" as const;
  readonly name = "Clock";
  private readonly db;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly log: (message: string, error?: unknown) => void;
  private cancelTimer: (() => void) | null = null;
  /** What the host alarm is set to: a time, null = cleared, undefined = unknown (set again next time). */
  private armed: number | null | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private armChain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: ClockOptions) {
    this.db = options.ledger.db();
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? realTimer;
    this.log = options.log ?? ((message, error) => console.error(`[clock] ${message}${error ? `: ${(error as Error).message}` : ""}`));
    this.db.exec(`CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, every_s INTEGER, target TEXT NOT NULL, word TEXT NOT NULL,
      body TEXT NOT NULL, label TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS timers_next ON timers(next_at);`);
  }

  words(): WordContract[] { return wordsOf(CLOCK_ID); }

  /** Once at start: send what fell due while the hub was down, then arm the in-process timeout and the host alarm. */
  start(): Promise<void> { this.stopped = false; return this.check(); }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  // ---- words ----

  async handle(msg: Message, _ctx: HandleContext): Promise<WordResult | void> {
    if (msg.word === "wake.fired") { await this.check(); return; }
    const body = (msg.body ?? {}) as Record<string, unknown>;
    switch (msg.word) {
      case "set": return { data: await this.set(body, msg.from) };
      case "cancel": return { data: await this.remove(body) };
      case "list": return { data: { timers: this.rows().map(info) } };
      default: throw new WordError("not_found", `service:clock has no word ${msg.word}`);
    }
  }

  private rows(): Row[] { return this.db.prepare("SELECT * FROM timers ORDER BY next_at, rowid").all() as Row[]; }

  private async set(body: Record<string, unknown>, from: string) {
    const { at, every, to, word, label } = body;
    const bad = (message: string) => new WordError("bad_request", message);
    if (at === undefined && every === undefined) throw bad("give at (Unix ms), every (seconds), or both");
    if (at !== undefined && (!Number.isSafeInteger(at) || (at as number) < 0)) throw bad("at must be a non-negative integer (Unix ms)");
    if (every !== undefined && (!Number.isSafeInteger(every) || (every as number) < 60)) throw bad("every must be an integer of at least 60 seconds");
    if (typeof to !== "string" || !to || typeof word !== "string" || !word || typeof label !== "string" || !label) throw bad("to, word and label are required");
    if (body.body === undefined) throw bad("body is required");
    const now = this.now();
    if (at !== undefined && (at as number) < now) throw bad("at is in the past");
    const next = at !== undefined ? (at as number) : now + (every as number) * 1000;
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM timers").get() as { n: number }).n;
    if (count >= MAX_TIMERS) throw new WordError("too_large", `there are already ${MAX_TIMERS} timers; cancel some first`);
    const id = `tmr_${randomBytes(9).toString("base64url")}`;
    this.db.prepare("INSERT INTO timers (id,next_at,every_s,target,word,body,label,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, next, (every as number | undefined) ?? null, to, word, JSON.stringify(body.body), label, from, now);
    await this.arm();
    return { id, next };
  }

  private async remove(body: Record<string, unknown>) {
    if (typeof body.id !== "string" || !body.id) throw new WordError("bad_request", "id is required");
    const removed = this.db.prepare("DELETE FROM timers WHERE id=?").run(body.id).changes > 0;
    await this.arm();
    return { cancelled: removed };
  }

  // ---- firing ----

  /** Find the due timers, move or delete them, re-arm, and send their words. Resolves when the sends are answered. */
  check(): Promise<void> {
    const run = this.chain.then(() => this.fireDue());
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async fireDue(): Promise<void> {
    const now = this.now();
    const due = this.db.prepare("SELECT * FROM timers WHERE next_at<=? ORDER BY next_at, rowid").all(now) as Row[];
    // Move first, send after: a crash between the two loses a send rather than repeating it on restart.
    this.options.ledger.tx(() => {
      for (const row of due) {
        if (row.every_s === null) this.db.prepare("DELETE FROM timers WHERE id=?").run(row.id);
        else {
          const period = row.every_s * 1000;
          // The next slot after now: missed rounds are not made up one by one.
          const next = row.next_at + (Math.floor((now - row.next_at) / period) + 1) * period;
          this.db.prepare("UPDATE timers SET next_at=? WHERE id=?").run(next, row.id);
        }
      }
    });
    await this.arm();
    await Promise.all(due.map((row) => this.send(row)));
  }

  private async send(row: Row): Promise<void> {
    const msg: Outgoing = { to: row.target, kind: "request", word: row.word, body: JSON.parse(row.body) };
    try {
      const reply: Reply = await this.options.router.send(msg, SELF);
      if (!reply.ok) this.log(`timer ${row.id} (${row.label}): ${row.target}/${row.word} answered ${reply.error.code}: ${reply.error.message}`);
    } catch (error) { this.log(`timer ${row.id} (${row.label}): sending to ${row.target}/${row.word} failed`, error); }
  }

  // ---- arming: the in-process timeout and the host alarm follow the earliest timer ----

  private arm(): Promise<void> {
    const run = this.armChain.then(() => this.doArm());
    this.armChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async doArm(): Promise<void> {
    if (this.stopped) return;
    const first = this.db.prepare("SELECT MIN(next_at) AS at FROM timers").get() as { at: number | null };
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (first.at !== null) {
      const wait = Math.min(Math.max(0, first.at - this.now()), MAX_TIMEOUT_MS);
      this.cancelTimer = this.setTimer(() => { this.check().catch((error) => this.log("check failed", error)); }, wait);
    }
    const host = this.options.host;
    if (!host || this.armed === first.at) return;
    try {
      if (first.at === null) await host.wakeClear(); else await host.wakeAt(first.at);
      this.armed = first.at;
    } catch (error) {
      this.armed = undefined;
      this.log("setting the host alarm failed", error);
    }
  }
}

export function createClockService(options: ClockOptions): ClockService { return new ClockService(options); }
