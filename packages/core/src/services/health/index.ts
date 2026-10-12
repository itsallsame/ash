/**
 * `service:health`: how the hub itself behaves. It counts what passes the router, never what it says: a word, who sent
 * it, how often, whether the ledger grew, how the process is doing. Every ten seconds the counts of that time become a
 * bucket (the last hour is kept in memory), the budgets of ./budgets.ts are read against them, and a budget that stays
 * broken for half a minute becomes an event in `health_event`. Once a minute a summary row goes to `health_minute` (a
 * week is kept). The same numbers answer the owner, the agents and the release gate.
 *
 *   status {window_s?}              rates, the busiest words, process, which budgets are kept
 *   recent {since?, limit?, kind?}  the events (default) or the minutes, newest first
 *
 * Counting happens at two places: the router's door (`tap`: every request and event in, every answer out, recorded or not) and
 * what the router publishes (rows the ledger took, turns starting and ending). The meter sends no messages, so counting its own
 * words cannot feed back, and a reader that polls it every second shows. While a budget is broken the host heartbeat says
 * `degraded` (see `heartbeat`).
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { OWNER_ID } from "../../../../sdk/src/ids";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Registry, Router, Traffic } from "../../kernel/types";
import { INVARIANTS, read, topOf, total, type Counts, type Invariant, type Window } from "./budgets";

export const HEALTH_ID = "service:health";

const TICK_MS = 10_000;
const HOUR_BUCKETS = 360;
const EVENT_GAP_MS = 600_000;
const IDLE_QUIET_MS = 60_000;
const TURN_MAX_MS = 1_800_000;
const MINUTES_KEPT = 7 * 24 * 60;
const EVENTS_KEPT = 2000;
const MINUTE_TOP = 20;
const DEFAULT_RECENT = 50;

/** What the process says about itself in one tick. */
export interface Sample { cpu_pct: number; rss: number; heap: number; lag_p99_ms: number }
export interface Sampler { sample(): Sample; close?(): void }

/** CPU is the process time spent since the last sample over the wall time that passed; the event loop delay is the 99th percentile since then. */
export function processSampler(): Sampler {
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  let last = { cpu: process.cpuUsage(), at: performance.now() };
  return {
    sample() {
      const cpu = process.cpuUsage(last.cpu);
      const at = performance.now();
      const wall = (at - last.at) * 1000;
      last = { cpu: process.cpuUsage(), at };
      const p99 = lag.percentile(99) / 1e6;
      lag.reset();
      const memory = process.memoryUsage();
      return { cpu_pct: wall > 0 ? ((cpu.user + cpu.system) / wall) * 100 : 0, rss: memory.rss, heap: memory.heapUsed, lag_p99_ms: Number.isFinite(p99) ? p99 : 0 };
    },
    close: () => lag.disable(),
  };
}

export interface HealthOptions {
  ledger: Pick<Ledger, "db">;
  router: Pick<Router, "subscribe">;
  registry: Pick<Registry, "find">;
  now?: () => number;
  /** The time between ticks (tests shorten it). */
  tickMs?: number;
  sampler?: Sampler;
  /** Default: the built-in invariants. */
  invariants?: readonly Invariant[];
  log?: (message: string) => void;
}

/** The first-party app whose page shows her state (packages/apps/vitals). */
const STATUS_APP = "app:vitals";

interface Open { msg: Counts; ledger: Counts; err: Counts; internal: Counts; link: Counts }
interface Bucket extends Open, Sample { t: number; dt: number; idle: boolean }
interface HealthEvent { at: number; type: "breach" | "start" | "ok"; id: string; value?: number; budget?: number; window_s?: number; idle?: boolean; top?: { key: string; n: number }[]; note?: string; since?: number; peak?: number; last_seen?: number }

const fresh = (): Open => ({ msg: new Map(), ledger: new Map(), err: new Map(), internal: new Map(), link: new Map() });
const bump = (counts: Counts, key: string): void => { counts.set(key, (counts.get(key) ?? 0) + 1); };
const merge = (into: Counts, from: Counts): void => { for (const [key, n] of from) into.set(key, (into.get(key) ?? 0) + n); };
const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits;
const MB = 1024 * 1024;

export class HealthService implements Member {
  readonly id = HEALTH_ID;
  readonly kind = "service" as const;
  readonly name = "Health";
  private readonly db;
  private readonly now: () => number;
  private readonly sampler: Sampler;
  private readonly startedAt: number;
  private readonly invariants: readonly Invariant[];
  private ring: Bucket[] = [];
  private open: Open = fresh();
  private turns = new Map<string, number>();
  private lastActive: number;
  private lastTick: number;
  private lastMinute: number;
  /** Since when each budget is broken; the ones absent are kept. */
  private broken = new Map<string, number>();
  /** The highest value of each budget that is broken now, for the word that it is over. */
  private peaks = new Map<string, number>();
  private values = new Map<string, number | null>();
  private lastEvent = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: HealthOptions) {
    this.now = options.now ?? Date.now;
    this.sampler = options.sampler ?? processSampler();
    this.invariants = options.invariants ?? INVARIANTS;
    this.db = options.ledger.db();
    this.startedAt = this.lastTick = this.lastActive = this.now();
    this.lastMinute = Math.floor(this.startedAt / 60_000);
    this.db.exec(`CREATE TABLE IF NOT EXISTS health_minute (minute INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_event (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, json TEXT NOT NULL)`);
  }

  words(): WordContract[] { return wordsOf(HEALTH_ID); }

  /** Starts counting, and writes down that a process started (with when the last one was seen alive, so a restart or a gap shows). */
  start(): void {
    const seen = this.db.prepare("SELECT MAX(minute) AS minute FROM health_minute").get() as { minute: number | null };
    this.addEvent({ at: this.startedAt, type: "start", id: "start", ...(seen.minute === null ? {} : { last_seen: seen.minute * 60_000 }) });
    this.unsubscribe = this.options.router.subscribe({}, (m) => this.observe(m));
    this.timer = setInterval(() => this.guarded(), this.options.tickMs ?? TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sampler.close?.();
  }

  /** A link event the hub saw: `open` (a hand connected), `close` or `refused`, with the hand or the close code. */
  noteLink(what: "open" | "closed" | "refused", detail: string | number | undefined): void { bump(this.open.link, `${what}:${detail ?? "?"}`); }
  /** Something the router handled internally (its `onError`): the place only, never the error text. */
  noteError(where: string): void { bump(this.open.internal, where); }

  /** For the host: `degraded` while a budget has been broken for long enough to be an event. */
  heartbeat(): { text: string; state: "running" | "degraded" } {
    const ids = this.invariants.filter((inv) => { const since = this.broken.get(inv.id); return since !== undefined && this.now() - since >= inv.persist_s * 1000; }).map((inv) => inv.id);
    return ids.length ? { text: `degraded: ${ids.join(", ")}`.slice(0, 200), state: "degraded" } : { text: "running", state: "running" };
  }

  async handle(msg: Message, _ctx: HandleContext): Promise<WordResult | void> {
    const body = (msg.body ?? {}) as Record<string, any>;
    switch (msg.word) {
      case "status": return { data: this.status(body.window_s ?? 60) };
      case "recent": return { data: this.recent(body) };
      default: throw new WordError("not_found", `service:health has no word ${msg.word}`);
    }
  }

  // ---- counting ----
  /** The router's door (`tap`): every request and event once in, every answer once out, recorded or not. Counts only, O(1). */
  tap(t: Traffic): void {
    const now = this.now();
    if (t.phase === "out") {
      if (t.error) bump(this.open.err, `${t.to ?? t.from}/${t.word}:${t.error}`);
      return;
    }
    // The status app's own reads (it asks the hub about herself every few seconds while its page is open) are not her working: counted, looking
    // at her would make her report the spinning that the looking causes. Anyone else polling still shows (the test below).
    if (t.from === STATUS_APP) return;
    bump(this.open.msg, t.kind === "event" ? `${t.from}/${t.word}:event` : `${t.to}/${t.word}:${t.from.slice(0, t.from.indexOf(":"))}`);
    if (t.from === OWNER_ID && ((t.kind === "event" && t.word === "typing") ||
      (t.kind === "request" && t.to && this.options.registry.find(t.to, t.word)?.contract.effect !== "read"))) this.lastActive = now;
  }

  /** What the router published: the rows the ledger took (they have a seq), and the turns that start and end. */
  private observe(m: Message): void {
    if (m.seq > 0) bump(this.open.ledger, m.word);
    if (m.kind === "event" && m.from.startsWith("agent:") && (m.word === "turn.started" || m.word === "turn.ended")) {
      const turn = String((m.body as { turn?: unknown } | undefined)?.turn ?? m.from);
      if (m.word === "turn.started") this.turns.set(turn, this.now()); else this.turns.delete(turn);
      this.lastActive = this.now();
    }
  }

  // ---- ticking ----
  private guarded(): void {
    try { this.tick(); } catch (error) { this.options.log?.(`tick failed: ${(error as Error).message}`); }
  }

  /** Closes the bucket of the time since the last tick. Nothing to close when no time has passed. */
  tick(): void {
    const t = this.now();
    if (t <= this.lastTick) return;
    for (const [turn, since] of this.turns) if (t - since > TURN_MAX_MS) this.turns.delete(turn);
    const idle = this.turns.size === 0 && t - this.lastActive >= IDLE_QUIET_MS;
    this.ring.push({ ...this.open, ...this.sampler.sample(), t, dt: (t - this.lastTick) / 1000, idle });
    if (this.ring.length > HOUR_BUCKETS) this.ring.shift();
    this.open = fresh();
    this.lastTick = t;
    this.evaluate(t);
    this.flushMinute(t);
  }

  /** The last closed buckets that cover `seconds` (only the idle ones when `idle`), added up. */
  private window(seconds: number, idle: boolean): Window | null {
    const w: Window = { seconds: 0, ...fresh(), cpu_pct: 0, lag_p99_ms: 0 };
    let cpu = 0;
    let covered = 0;
    for (let i = this.ring.length - 1; i >= 0 && covered < seconds; i--) {
      const b = this.ring[i]!;
      covered += b.dt;
      if (idle && !b.idle) continue;
      w.seconds += b.dt;
      for (const key of ["msg", "ledger", "err", "internal", "link"] as const) merge(w[key], b[key]);
      cpu += b.cpu_pct * b.dt;
      w.lag_p99_ms = Math.max(w.lag_p99_ms, b.lag_p99_ms);
    }
    if (w.seconds === 0) return null;
    w.cpu_pct = cpu / w.seconds;
    return w;
  }

  private evaluate(t: number): void {
    for (const inv of this.invariants) {
      const w = this.window(inv.window_s, inv.idle);
      const reading = w ? read(inv, w) : null;
      this.values.set(inv.id, reading ? reading.value : null);
      if (!reading || reading.value <= inv.budget) { this.recovered(inv.id, t); continue; }
      const since = this.broken.get(inv.id) ?? t;
      this.broken.set(inv.id, since);
      this.peaks.set(inv.id, Math.max(this.peaks.get(inv.id) ?? 0, reading.value));
      if (t - since < inv.persist_s * 1000 || t - (this.lastEvent.get(inv.id) ?? -Infinity) < EVENT_GAP_MS) continue;
      this.lastEvent.set(inv.id, t);
      const top = reading.top.map(([key, n]) => ({ key, n }));
      this.addEvent({ at: t, type: "breach", id: inv.id, value: round(reading.value), budget: inv.budget, window_s: Math.round(w!.seconds), idle: inv.idle, top, note: inv.note, since });
      this.options.log?.(`${inv.id} is ${round(reading.value)} against ${inv.budget}${top[0] ? `, most: ${top[0].key}` : ""}`);
    }
  }

  /** A budget is kept again. If its breach was written, the end is written too (`ok`, with when it began and the worst value), so a reader can say how long it lasted. */
  private recovered(id: string, t: number): void {
    const since = this.broken.get(id);
    if (since === undefined) return;
    this.broken.delete(id);
    if ((this.lastEvent.get(id) ?? -Infinity) >= since) this.addEvent({ at: t, type: "ok", id, since, peak: round(this.peaks.get(id) ?? 0) });
    this.peaks.delete(id);
  }

  private addEvent(event: HealthEvent): void {
    this.db.prepare("INSERT INTO health_event (at, json) VALUES (?, ?)").run(event.at, JSON.stringify(event));
    this.db.prepare("DELETE FROM health_event WHERE id <= (SELECT MAX(id) FROM health_event) - ?").run(EVENTS_KEPT);
  }

  /** When the minute changes, the minute that ended becomes one row; old rows go. */
  private flushMinute(t: number): void {
    const minute = Math.floor(t / 60_000);
    if (minute === this.lastMinute) return;
    const rows = this.ring.filter((b) => Math.floor(b.t / 60_000) === this.lastMinute);
    if (rows.length) {
      const w = { seconds: 0, ...fresh() };
      for (const b of rows) { w.seconds += b.dt; for (const key of ["msg", "ledger", "err", "link"] as const) merge(w[key], b[key]); }
      const last = rows[rows.length - 1]!;
      const row = {
        idle: rows.every((b) => b.idle), msg: total(w.msg), ledger: total(w.ledger), err: total(w.err), link_opens: total(new Map([...w.link].filter(([key]) => key.startsWith("open:")))),
        cpu_pct: round(rows.reduce((sum, b) => sum + b.cpu_pct * b.dt, 0) / w.seconds), rss_mb: round(last.rss / MB), lag_p99_ms: round(Math.max(...rows.map((b) => b.lag_p99_ms))),
        top: topOf(w.msg, MINUTE_TOP).map(([key, n]) => ({ key, per_min: round((n * 60) / w.seconds) })),
      };
      this.db.prepare("INSERT OR REPLACE INTO health_minute (minute, json) VALUES (?, ?)").run(this.lastMinute, JSON.stringify(row));
      this.db.prepare("DELETE FROM health_minute WHERE minute < ?").run(minute - MINUTES_KEPT);
    }
    this.lastMinute = minute;
  }

  // ---- reading ----
  private status(windowS: number) {
    const w = this.window(windowS, false);
    const seconds = w?.seconds ?? 0;
    const per = (n: number) => (seconds > 0 ? round((n * 60) / seconds) : 0);
    const last = this.ring[this.ring.length - 1];
    return {
      now: this.now(), uptime_s: Math.floor((this.now() - this.startedAt) / 1000), idle: last?.idle ?? false, window_s: Math.round(seconds),
      rates: { msg_per_min: per(total(w?.msg ?? new Map())), ledger_rows_per_min: per(total(w?.ledger ?? new Map())), link_opens: total(new Map([...(w?.link ?? [])].filter(([key]) => key.startsWith("open:")))), errors_per_min: per(total(w?.err ?? new Map())) },
      top: topOf(w?.msg ?? new Map(), 10).map(([key, n]) => ({ key, per_min: per(n) })),
      proc: { cpu_pct: round(w?.cpu_pct ?? 0), rss_mb: round((last?.rss ?? 0) / MB), heap_mb: round((last?.heap ?? 0) / MB), lag_p99_ms: round(w?.lag_p99_ms ?? 0) },
      invariants: this.invariants.map((inv) => {
        const since = this.broken.get(inv.id);
        const value = this.values.get(inv.id) ?? null;
        return { id: inv.id, ok: since === undefined, value: value === null ? null : round(value), budget: inv.budget, ...(since === undefined ? {} : { since }) };
      }),
      last_events: this.events(0, 5),
    };
  }

  private events(since: number, limit: number): HealthEvent[] {
    return (this.db.prepare("SELECT json FROM health_event WHERE at >= ? ORDER BY id DESC LIMIT ?").all(since, limit) as { json: string }[]).map((r) => JSON.parse(r.json) as HealthEvent);
  }

  private recent(body: { since?: number; limit?: number; kind?: "event" | "minute" }) {
    const since = body.since ?? 0;
    const limit = body.limit ?? DEFAULT_RECENT;
    if (body.kind !== "minute") return { events: this.events(since, limit) };
    const rows = this.db.prepare("SELECT minute, json FROM health_minute WHERE minute >= ? ORDER BY minute DESC LIMIT ?").all(Math.floor(since / 60_000), limit) as { minute: number; json: string }[];
    return { minutes: rows.map((r) => ({ at: r.minute * 60_000, ...JSON.parse(r.json) })) };
  }
}

export function createHealthService(options: HealthOptions): HealthService { return new HealthService(options); }
