/**
 * `service:clock`: durable timers (HUB-MODULES §3).
 *
 *   set    {at?, every?, to, word, body, label}   store a timer; `at` is Unix ms, `every` seconds (at least 60)
 *   cancel {id}
 *   list
 *   wake.fired (event, from the host module)       the phone's alarm went off: look for due timers
 *
 * A timer sends its stored word to its target as whoever set it, never as `service:clock`: `set` keeps the caller
 * (member, via, local) and the word goes through the router, the callers check and the gate with that identity when it
 * is due. An agent's timer therefore asks the owner at that time like any call of the agent; an app's timer needs the
 * app's grant; the owner's timer is the owner's; a hub service's timer (the semantic layer's pulse) stays a service's.
 * The turn is not kept: it is over by then. `cancel` takes back one's own timer; the owner may take back any.
 * `cancel.owner` (the hub only) takes back all of one member's timers.
 * (The agents module calls it when an agent is deleted, the apps module when an app is removed or loses all its grants.)
 * As a second line, a timer an agent or an app set that cannot be sent because the setter is gone (the refusal is followed by
 * `service:agents/describe` or `service:apps/apps.describe`, see `dropIfGone`) takes all of that member's timers back, with a
 * log line. A member that is only stopped, restarting or disabled is still known, so its timers stay.
 * `at` alone fires once; `every`
 * repeats; both together fire first at `at` and then every period. A repeating timer that was missed (the phone
 * slept, the hub was down) fires once for the missed rounds and goes on from the next slot after now. Precision is
 * the scan period, not the second.
 *
 * The timers live in the ledger's database (table `timers`), so they survive a restart. While the hub is up they are
 * driven by one in-process timeout. The earliest due time is also given to the host as its alarm
 * (`service:host/wake.at`, only the earliest is kept; `wake.clear` when none is left) so a sleeping phone wakes the
 * hub. Sends are not waited for: a target that answers slowly holds up nobody else.
 */
import { randomBytes } from "node:crypto";
import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { OWNER_ID } from "../../../../sdk/src/ids";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Router } from "../../kernel/types";

export const CLOCK_ID = "service:clock";
const HOST_ID = "service:host";
const AGENTS_ID = "service:agents";
const APPS_ID = "service:apps";
/** setTimeout cannot wait longer than this; a longer wait is cut and rechecked. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface ClockOptions {
  ledger: Pick<Ledger, "db" | "tx">;
  /** Where a due timer's word goes, and the host alarm (`service:host`). */
  router: Pick<Router, "send">;
  /** Milliseconds since the epoch. */
  now?: () => number;
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

/** The owner and the hub's services see every timer; an agent or an app only its own. */
const seesAll = (caller: Caller): boolean => caller.member === OWNER_ID || caller.via === "service";

/** The clock's own identity: only for its own calls to the host. */
const SELF: Caller = { member: CLOCK_ID, via: "service", local: true };

type Row = { id: string; next_at: number; every_s: number | null; target: string; word: string; body: string; label: string; created_by: string; created_as: string };
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
  private stopped = false;
  /** Members whose existence is being checked after a failed send. */
  private readonly probing = new Set<string>();

  constructor(private readonly options: ClockOptions) {
    this.db = options.ledger.db();
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? realTimer;
    this.log = options.log ?? ((message, error) => console.error(`[clock] ${message}${error ? `: ${(error as Error).message}` : ""}`));
    this.db.exec(`CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, every_s INTEGER, target TEXT NOT NULL, word TEXT NOT NULL,
      body TEXT NOT NULL, label TEXT NOT NULL, created_by TEXT NOT NULL, created_as TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS timers_next ON timers(next_at);`);
  }

  words(): WordContract[] { return wordsOf(CLOCK_ID); }

  /** Once at start: send what fell due while the hub was down, then arm the in-process timeout and the host alarm. */
  start(): void { this.stopped = false; this.check(); }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  // ---- words ----

  async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    if (msg.word === "wake.fired") { this.check(); return; }
    const body = (msg.body ?? {}) as Record<string, unknown>;
    switch (msg.word) {
      case "set": return { data: this.set(body, ctx.caller) };
      case "cancel": return { data: this.remove(body, ctx.caller) };
      case "cancel.owner": return { data: { cancelled: this.removeOwner(body.member as string) } };
      // An agent or an app sees only the timers it set; the owner and the hub's services see all.
      case "list": return { data: { timers: this.rows().filter((row) => seesAll(ctx.caller) || row.created_by === ctx.caller.member).map(info) } };
      default: throw new WordError("not_found", `service:clock has no word ${msg.word}`);
    }
  }

  private rows(): Row[] { return this.db.prepare("SELECT * FROM timers ORDER BY next_at, rowid").all() as Row[]; }

  private set(body: Record<string, unknown>, caller: Caller) {
    // The router has already checked the body against the contract; what the schema cannot say is left here.
    const at = body.at as number | undefined;
    const every = body.every as number | undefined;
    if (at === undefined && every === undefined) throw new WordError("bad_request", "give at (Unix ms), every (seconds), or both");
    const now = this.now();
    if (at !== undefined && at < now) throw new WordError("bad_request", "at is in the past");
    const next = at ?? now + every! * 1000;
    const id = `tmr_${randomBytes(9).toString("base64url")}`;
    this.db.prepare("INSERT INTO timers (id,next_at,every_s,target,word,body,label,created_by,created_as,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, next, every ?? null, body.to as string, body.word as string, JSON.stringify(body.body), body.label as string,
        caller.member, JSON.stringify({ member: caller.member, via: caller.via, local: caller.local }), now);
    this.arm();
    return { id, next };
  }

  private remove(body: Record<string, unknown>, caller: Caller) {
    const row = this.db.prepare("SELECT created_by FROM timers WHERE id=?").get(body.id as string) as { created_by: string } | undefined;
    if (row && row.created_by !== caller.member && caller.member !== OWNER_ID) {
      throw new WordError("forbidden", "this timer was set by someone else; only its owner or the person:owner can cancel it");
    }
    const removed = this.db.prepare("DELETE FROM timers WHERE id=?").run(body.id as string).changes > 0;
    this.arm();
    return { cancelled: removed };
  }

  /** Delete every timer that `member` set; the number deleted. */
  private removeOwner(member: string): number {
    const removed = Number(this.db.prepare("DELETE FROM timers WHERE created_by=?").run(member).changes);
    if (removed > 0) this.arm();
    return removed;
  }

  // ---- firing ----

  /** Find the due timers, move or delete them, re-arm, and send their words without waiting for the answers. */
  check(): void {
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
    this.arm();
    for (const row of due) void this.send(row);
  }

  private async send(row: Row): Promise<void> {
    const msg: Outgoing = { to: row.target, kind: "request", word: row.word, body: JSON.parse(row.body) };
    try {
      // As the one who set it: the router, the callers check and the gate see that caller, not the clock.
      // The one narrow case: the owner's reminder to the owner. The recipient is the setter, so nothing is raised,
      // but `person:owner` words are not for an owner caller (they are for agents and apps), so it goes as the clock.
      const stored = JSON.parse(row.created_as) as Caller;
      const caller = stored.member === OWNER_ID && row.target === OWNER_ID ? SELF : stored;
      const reply: Reply = await this.options.router.send(msg, caller);
      if (!reply.ok) {
        this.log(`timer ${row.id} (${row.label}): ${row.target}/${row.word} answered ${reply.error.code}: ${reply.error.message}`);
        if ((stored.via === "agent" || stored.via === "app") && ["forbidden", "offline", "not_found"].includes(reply.error.code)) await this.dropIfGone(row, stored.member, stored.via);
      }
    } catch (error) { this.log(`timer ${row.id} (${row.label}): sending to ${row.target}/${row.word} failed`, error); }
  }

  /**
   * The setter was refused or the target was not there. When the setter is an agent that is no longer declared, or an app that is
   * no longer installed (it was deleted and its timers were not cleaned, or from before the cleaning existed), none of its timers
   * can ever be sent again: take them back. Only the owning module's answer says it is gone (`service:agents/describe`: not_found;
   * `service:apps/apps.describe`: not_found, or found with `granted` false, which is a folder left behind after an uninstall). A stopped,
   * restarting or only disabled member is still known, and any other answer or failure leaves the timers alone.
   */
  private async dropIfGone(row: Row, member: string, via: "agent" | "app"): Promise<void> {
    if (this.probing.has(member)) return; // several of its timers fell due together: one question is enough
    this.probing.add(member);
    try {
      const probe = via === "agent"
        ? await this.options.router.send({ to: AGENTS_ID, kind: "request", word: "describe", body: { agent: member } }, SELF)
        : await this.options.router.send({ to: APPS_ID, kind: "request", word: "apps.describe", body: { id: member.replace(/^app:/, "") } }, SELF);
      const gone = probe.ok ? via === "app" && (probe.result?.data as { granted?: unknown } | undefined)?.granted === false : probe.error.code === "not_found";
      if (!gone) return;
      const removed = this.removeOwner(member);
      this.log(`timer ${row.id} (${row.label}): ${member} is no longer ${via === "agent" ? "a declared agent" : "an installed app"}; took back its ${removed} timer(s)`);
    } catch (error) { this.log(`timer ${row.id} (${row.label}): could not check whether ${member} still exists`, error); }
    finally { this.probing.delete(member); }
  }

  // ---- arming: the in-process timeout and the host alarm follow the earliest timer ----

  private arm(): void {
    if (this.stopped) return;
    const first = this.db.prepare("SELECT MIN(next_at) AS at FROM timers").get() as { at: number | null };
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (first.at !== null) {
      const wait = Math.min(Math.max(0, first.at - this.now()), MAX_TIMEOUT_MS);
      this.cancelTimer = this.setTimer(() => { try { this.check(); } catch (error) { this.log("check failed", error); } }, wait);
    }
    // The host keeps only the earliest alarm, so telling it again is harmless. A failure is only logged.
    const msg: Outgoing = first.at === null ? { to: HOST_ID, kind: "request", word: "wake.clear", body: {} }
      : { to: HOST_ID, kind: "request", word: "wake.at", body: { at: first.at } };
    this.options.router.send(msg, SELF).then(
      (reply) => { if (!reply.ok) this.log(`host ${msg.word}: ${reply.error.code}: ${reply.error.message}`); },
      (error) => this.log(`host ${msg.word} failed`, error));
  }
}

export function createClockService(options: ClockOptions): ClockService { return new ClockService(options); }
