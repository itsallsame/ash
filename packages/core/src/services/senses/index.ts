/**
 * `service:senses`: the archive of what the hands sense, the day's statistics, and the way to look back
 * (HUB-MODULES §3, §7). It is mechanism only: it never decides to wake an agent and never sends a wake; that is the
 * job of an organ (`app:sense-rules`) that listens to the same events.
 *
 *   sense.* (events, from any hand)   archived in <dataDir>/senses/YYYY-MM.jsonl, not in the ledger;
 *                                     sense.notification is kept in memory as "the latest" and nowhere else
 *   query {kind, from?, to?, limit?}  archived readings of one kind, oldest first
 *   now                               the newest reading of each kind and its age
 *   daily {date?}                     the day's statistics (default yesterday), worked out from the archive at every call
 */
import { join } from "node:path";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { SenseArchive, linesOf, type ArchiveLine } from "./archive";
import { dailySummary } from "./daily";
import { dayStart, localDate, nextDate, type SenseLines } from "./facts";

export const SENSES_ID = "service:senses";
const DAY_MS = 86_400_000;
/** History read before a day: enough to know an open geofence or the state at midnight. */
const HISTORY_MS = 31 * 86_400_000;
const DEFAULT_QUERY_LIMIT = 1000;

export interface SensesOptions {
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
  private readonly now: () => number;
  private latest: Map<string, ArchiveLine> | null = null;
  private notification: { ts: number; app: unknown; title: unknown; text: unknown } | null = null;

  constructor(options: SensesOptions) {
    this.now = options.now ?? Date.now;
    this.archive = new SenseArchive(join(options.dataDir, "senses"), options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  words(): WordContract[] { return wordsOf(SENSES_ID); }

  async handle(msg: Message, _ctx: HandleContext): Promise<WordResult | void> {
    const body = (msg.body ?? {}) as Record<string, unknown>;
    if (msg.word.startsWith("sense.")) { this.take(msg.word, msg.body); return; }
    switch (msg.word) {
      case "query": return { data: this.query(body) };
      case "now": return { data: this.nowReadings() };
      case "daily": return { data: this.daily(body) };
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
    const kind = body.kind as string;
    const to = body.to === undefined ? this.now() + 1 : body.to as number;
    const from = body.from === undefined ? to - DAY_MS : body.from as number;
    const limit = body.limit === undefined ? DEFAULT_QUERY_LIMIT : body.limit as number;
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

  /** The day's statistics, worked out from the archive each time, so a batch that arrived late is counted. */
  private daily(body: Record<string, unknown>) {
    const zone = this.archive.timeZone;
    const date = (body.date as string | undefined) ?? localDate(dayStart(localDate(this.now(), zone), zone) - 1, zone);
    const from = dayStart(date, zone), to = dayStart(nextDate(date), zone);
    const lines = { location: [], activity: [], health: [], geofence: [] } as SenseLines;
    const history = { activity: [], geofence: [] } as Pick<SenseLines, "activity" | "geofence">;
    for (const l of this.archive.scan(from - HISTORY_MS, to, ["location", "activity", "health", "geofence"])) {
      if (l.ts >= from) (lines[l.kind as keyof SenseLines] as unknown as ArchiveLine[]).push(l);
      else if (l.kind === "activity" || l.kind === "geofence") (history[l.kind] as unknown as ArchiveLine[]).push(l);
    }
    return dailySummary(date, zone, lines, history);
  }
}

export function createSensesService(options: SensesOptions): SensesService { return new SensesService(options); }
