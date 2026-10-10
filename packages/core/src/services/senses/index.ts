/**
 * `service:senses`: the archive of what the hands sense, the day's statistics, and the way to look back
 * (HUB-MODULES §3, §7). It is mechanism only: it never decides to wake an agent and never sends a wake; that is the
 * job of an organ (`app:sense-rules`) that listens to the same events.
 *
 *   sense.* (events, from any hand)   archived in <dataDir>/senses/YYYY-MM.jsonl, not in the ledger;
 *                                     sense.notification is kept in memory as "the latest" and nowhere else
 *   query {kind, from?, to?, limit?}  archived readings of one kind, oldest first
 *   now                               the newest reading of each kind and its age
 *   daily {date?}                     the day's statistics from this service's own table; when `service:clock` calls it
 *                                     (the daily timer, `ensureDailyTimer`), it first works out the recent finished days
 */
import { join } from "node:path";
import { WordError, type Caller, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Router } from "../../kernel/types";
import { SenseArchive, linesOf, type ArchiveLine } from "./archive";
import { dailySummary } from "./daily";
import { dayStart, localDate, nextDate, type SenseLines } from "./facts";

export const SENSES_ID = "service:senses";
const CLOCK_ID = "service:clock";
export const DAILY_LABEL = "senses:daily";
/** How many finished days each daily run works out again, so a late batch still lands in its day. */
export const DAILY_DAYS = 3;
/** History read before a day: enough to know an open geofence or the state at midnight. */
const HISTORY_MS = 31 * 86_400_000;
const DAY_MS = 86_400_000;
const DEFAULT_QUERY_LIMIT = 1000;

export interface SensesOptions {
  ledger: Pick<Ledger, "db">;
  /** The archive goes to <dataDir>/senses/. */
  dataDir: string;
  now?: () => number;
  /** Which day a reading belongs to. Default: the machine's. */
  timeZone?: string;
  log?: (message: string, error?: unknown) => void;
}

export class SensesService implements Member {
  readonly id = SENSES_ID;
  readonly kind = "service" as const;
  readonly name = "Senses";
  readonly archive: SenseArchive;
  private readonly db;
  private readonly now: () => number;
  private latest: Map<string, ArchiveLine> | null = null;
  private notification: { ts: number; app: unknown; title: unknown; text: unknown } | null = null;

  constructor(options: SensesOptions) {
    this.db = options.ledger.db();
    this.now = options.now ?? Date.now;
    this.archive = new SenseArchive(join(options.dataDir, "senses"), options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.db.exec("CREATE TABLE IF NOT EXISTS senses_daily (date TEXT PRIMARY KEY, summary TEXT NOT NULL, computed_at INTEGER NOT NULL)");
  }

  words(): WordContract[] { return wordsOf(SENSES_ID); }

  async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    const body = (msg.body ?? {}) as Record<string, unknown>;
    if (msg.word.startsWith("sense.")) { this.take(msg.word, msg.body); return; }
    switch (msg.word) {
      case "query": return { data: this.query(body) };
      case "now": return { data: this.nowReadings() };
      case "daily": return { data: this.daily(body, ctx.caller) };
      default: throw new WordError("not_found", `service:senses has no word ${msg.word}`);
    }
  }

  // ---- events ----

  private take(word: string, body: unknown): void {
    const at = this.now();
    if (word === "sense.notification") {
      const b = (body ?? {}) as Record<string, unknown>;
      this.notification = { ts: at, app: b.app, title: b.title, text: b.text };
      return;
    }
    const found = linesOf(word, body, at);
    if (!found) return;
    this.newest();                                    // read what is on disk before this event changes it
    this.archive.record(found.batch, found.lines);
    for (const line of found.lines) {
      const prior = this.latest!.get(line.kind);
      if (!prior || line.ts >= prior.ts) this.latest!.set(line.kind, line);
    }
  }

  private newest(): Map<string, ArchiveLine> { return this.latest ??= this.archive.newest(this.now()); }

  // ---- query, now ----

  private query(body: Record<string, unknown>) {
    const kind = body.kind;
    if (typeof kind !== "string") throw new WordError("bad_request", "kind is required");
    const to = body.to === undefined ? this.now() + 1 : body.to as number;
    const from = body.from === undefined ? to - DAY_MS : body.from as number;
    const limit = body.limit === undefined ? DEFAULT_QUERY_LIMIT : body.limit as number;
    if (![from, to, limit].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new WordError("bad_request", "from, to and limit must be non-negative integers");
    if (kind === "notification") {
      const n = this.notification;
      return { rows: n && n.ts >= from && n.ts < to ? [{ kind, ...n }] : [], truncated: false };
    }
    // steps are the health readings whose metric is steps; health is all of them
    const archived = kind === "steps" ? "health" : kind;
    const lines = this.archive.scan(from, to, [archived]).filter((l) => kind !== "steps" || l.metric === "steps");
    const rows = lines.slice(0, limit).map(({ batch_id: _batch, ...row }) => row);
    return { rows, truncated: lines.length > limit };
  }

  private nowReadings() {
    const at = this.now();
    const readings: Record<string, unknown> = {};
    for (const [kind, line] of this.newest()) {
      const { batch_id: _batch, kind: _kind, ...reading } = line;
      readings[kind] = { at: line.ts, age_ms: Math.max(0, at - line.ts), reading };
    }
    if (this.notification) {
      const { ts, ...reading } = this.notification;
      readings.notification = { at: ts, age_ms: Math.max(0, at - ts), reading };
    }
    return { now: at, readings };
  }

  // ---- daily ----

  private daily(body: Record<string, unknown>, caller: Caller) {
    const yesterday = () => localDate(dayStart(localDate(this.now(), this.archive.timeZone), this.archive.timeZone) - 1, this.archive.timeZone);
    if (caller.member === CLOCK_ID) this.computeRecent();
    const date = typeof body.date === "string" ? body.date : yesterday();
    const row = this.db.prepare("SELECT summary, computed_at FROM senses_daily WHERE date=?").get(date) as { summary: string; computed_at: number } | undefined;
    if (!row) return { date, available: false };
    return { ...JSON.parse(row.summary), available: true, computed_at: row.computed_at };
  }

  /** Work out the last finished days that have any facts and keep them in the table. Returns the dates written. */
  computeRecent(): string[] {
    const zone = this.archive.timeZone;
    let date = localDate(this.now(), zone);
    const dates: string[] = [];
    for (let i = 0; i < DAILY_DAYS; i++) {
      date = localDate(dayStart(date, zone) - 1, zone);
      dates.unshift(date);
    }
    const written: string[] = [];
    for (const day of dates) {
      const from = dayStart(day, zone), to = dayStart(nextDate(day), zone);
      const all = this.archive.scan(from - HISTORY_MS, to, ["location", "activity", "health", "geofence"]);
      const inDay = (l: ArchiveLine) => l.ts >= from;
      const lines = { location: [], activity: [], health: [], geofence: [] } as SenseLines;
      const history = { activity: [], geofence: [] } as Pick<SenseLines, "activity" | "geofence">;
      for (const l of all) {
        if (inDay(l)) (lines[l.kind as keyof SenseLines] as unknown as ArchiveLine[]).push(l);
        else if (l.kind === "activity" || l.kind === "geofence") (history[l.kind] as unknown as ArchiveLine[]).push(l);
      }
      if (!lines.location.length && !lines.activity.length && !lines.health.length && !lines.geofence.length) continue;
      const summary = JSON.stringify(dailySummary(day, zone, lines, history));
      const prior = this.db.prepare("SELECT summary FROM senses_daily WHERE date=?").get(day) as { summary: string } | undefined;
      if (prior?.summary === summary) continue;
      this.db.prepare("INSERT INTO senses_daily (date,summary,computed_at) VALUES (?,?,?) ON CONFLICT(date) DO UPDATE SET summary=excluded.summary, computed_at=excluded.computed_at")
        .run(day, summary, this.now());
      written.push(day);
    }
    return written;
  }
}

export function createSensesService(options: SensesOptions): SensesService { return new SensesService(options); }

/**
 * At assembly, after both services are registered: make sure the clock holds the daily timer, once. The clock calls
 * `service:senses/daily` every 24 hours, first at the next `hour`:`minute` local time (default 00:30), and that run
 * works out the recent finished days. Safe to call at every start: it only sets the timer when none carries the label.
 */
export async function ensureDailyTimer(router: Pick<Router, "send">, options: { now?: () => number; timeZone?: string; hour?: number; minute?: number } = {}): Promise<{ set: boolean }> {
  const caller: Caller = { member: SENSES_ID, via: "service", local: true };
  const listed = await router.send({ to: CLOCK_ID, kind: "request", word: "list", body: {} }, caller);
  if (!listed.ok) throw new WordError(listed.error.code, `cannot read the clock's timers: ${listed.error.message}`);
  const timers = ((listed.result?.data as { timers?: { label?: string }[] } | undefined)?.timers) ?? [];
  if (timers.some((t) => t.label === DAILY_LABEL)) return { set: false };
  const now = (options.now ?? Date.now)();
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hhmm = ((options.hour ?? 0) * 60 + (options.minute ?? 30)) * 60_000;
  const today = localDate(now, zone);
  let at = dayStart(today, zone) + hhmm;
  if (at <= now) at = dayStart(nextDate(today), zone) + hhmm;
  const set = await router.send({ to: CLOCK_ID, kind: "request", word: "set", body: { at, every: 86_400, to: SENSES_ID, word: "daily", body: {}, label: DAILY_LABEL } }, caller);
  if (!set.ok) throw new WordError(set.error.code, `cannot set the daily timer: ${set.error.message}`);
  return { set: true };
}
