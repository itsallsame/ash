/**
 * What the hub may do, as numbers. Each invariant reads one window of the last minutes and answers with a value that is
 * compared to its budget; the meter (index.ts) decides when a broken budget becomes an event. The budgets are first
 * guesses, to be calibrated on a real phone; changing one is changing a number here.
 *
 * An `idle` invariant looks only at the stretches when nobody asked anything of Ash (no turn running, the owner has
 * done nothing for a minute): then a busy hub is spinning.
 */

export type Counts = Map<string, number>;

/** The sum of closed buckets that a window covers. */
export interface Window {
  /** Seconds the window really covers (fewer than asked right after a start). */
  seconds: number;
  msg: Counts;
  ledger: Counts;
  err: Counts;
  internal: Counts;
  link: Counts;
  /** Time-weighted mean of the process CPU, percent of one core. */
  cpu_pct: number;
  lag_p99_ms: number;
}

export interface Reading { value: number; top: [string, number][] }

export interface Invariant {
  id: string;
  /** The window this looks at, in seconds. */
  window_s: number;
  idle: boolean;
  budget: number;
  read(w: Window): Reading;
}

export const total = (counts: Counts): number => { let n = 0; for (const v of counts.values()) n += v; return n; };
export const topOf = (counts: Counts, limit: number): [string, number][] => [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit);
const perMin = (n: number, w: Window): number => (w.seconds > 0 ? (n * 60) / w.seconds : 0);

const rate = (pick: (w: Window) => Counts) => (w: Window): Reading => ({ value: perMin(total(pick(w)), w), top: topOf(pick(w), 5) });
const CALLER_FAULT = new Set(["not_found", "cancelled", "denied"]);

export const INVARIANTS: readonly Invariant[] = [
  // Nothing asked of Ash, and still traffic: the busy loop of 10-12 (the page and the hub reading each other 44 times a second).
  { id: "idle.msg_rate", window_s: 60, idle: true, budget: 30, read: rate((w) => w.msg) },
  { id: "idle.msg_key_rate", window_s: 60, idle: true, budget: 6, read: (w) => ({ value: perMin(Math.max(0, ...w.msg.values()), w), top: topOf(w.msg, 5) }) },
  { id: "idle.ledger_growth", window_s: 60, idle: true, budget: 10, read: rate((w) => w.ledger) },
  { id: "idle.cpu", window_s: 60, idle: true, budget: 5, read: (w) => ({ value: w.cpu_pct, top: topOf(w.msg, 5) }) },
  // A hand that keeps reconnecting is a flapping link or a refused token that is retried.
  { id: "link.reconnect_storm", window_s: 300, idle: false, budget: 5, read: (w) => {
    const opens = new Map([...w.link].filter(([key]) => key.startsWith("open:")));
    return { value: Math.max(0, ...opens.values()), top: topOf(opens, 5) };
  } },
  // Answers that failed (a caller asking for what does not exist or is refused is not the hub's fault), and what the hub caught itself.
  { id: "errors.rate", window_s: 60, idle: false, budget: 20, read: (w) => {
    const errors = new Map([...w.err].filter(([key]) => !CALLER_FAULT.has(key.slice(key.lastIndexOf(":") + 1))));
    return { value: perMin(total(errors), w), top: topOf(errors, 5) };
  } },
  { id: "errors.internal", window_s: 60, idle: false, budget: 5, read: rate((w) => w.internal) },
  { id: "loop.lag", window_s: 60, idle: false, budget: 200, read: (w) => ({ value: w.lag_p99_ms, top: [] }) },
];
