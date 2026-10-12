/**
 * What the hub may do, as data. An invariant is a plain record, not code: what is counted, over which window, against which
 * budget, for how long it must stay broken, and what to say about it. One engine (`read`) evaluates any of them, and the
 * built-in ones below are instances of it, so adding or removing one is adding or removing a record. The budgets are first
 * guesses, to be calibrated on a real phone.
 *
 * An `idle` invariant looks only at the stretches when nobody asked anything of Ash (no turn running, the owner has done
 * nothing for a minute): then a busy hub is spinning.
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

/**
 * `metric` says what is looked at: a counter family (`msg`: requests and events by `<to>/<word>:<caller class>`, `ledger`: rows by word,
 * `err`: failed answers by `<from>/<word>:<code>`, `internal`: what the router caught, by place, `link`: `open:<hand>` and the like) or a
 * process value (`cpu`, `lag`). `match` and `skip` are regular expressions over the counter's keys. `agg` is how the matched counts
 * become one number: `rate` (all together, per minute), `peak_rate` (the busiest key, per minute), `peak` (the busiest key, as counted),
 * `value` (a process value as it is).
 */
export interface Invariant {
  id: string;
  metric: "msg" | "ledger" | "err" | "internal" | "link" | "cpu" | "lag";
  agg: "rate" | "peak_rate" | "peak" | "value";
  match?: string;
  skip?: string;
  /** The window this looks at, in seconds. */
  window_s: number;
  idle: boolean;
  budget: number;
  /** How long it must stay broken before it is an event, in seconds. */
  persist_s: number;
  /** What a breach means, for whoever reads the event. */
  note: string;
}

export interface Reading { value: number; top: [string, number][] }

export const total = (counts: Counts): number => { let n = 0; for (const v of counts.values()) n += v; return n; };
export const topOf = (counts: Counts, limit: number): [string, number][] => [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit);

/** The one engine: an invariant over a window. The top is the keys that count most (what to look at first). */
export function read(inv: Invariant, w: Window): Reading {
  if (inv.metric === "cpu" || inv.metric === "lag") return { value: inv.metric === "cpu" ? w.cpu_pct : w.lag_p99_ms, top: inv.metric === "cpu" ? topOf(w.msg, 5) : [] };
  const match = inv.match && new RegExp(inv.match), skip = inv.skip && new RegExp(inv.skip);
  const counts = new Map([...w[inv.metric]].filter(([key]) => (!match || match.test(key)) && (!skip || !skip.test(key))));
  const peak = Math.max(0, ...counts.values());
  const perMin = (n: number) => (w.seconds > 0 ? (n * 60) / w.seconds : 0);
  const value = inv.agg === "rate" ? perMin(total(counts)) : inv.agg === "peak_rate" ? perMin(peak) : peak;
  return { value, top: topOf(counts, 5) };
}

const idle = { idle: true, window_s: 60, persist_s: 30 } as const;
const always = { idle: false, window_s: 60, persist_s: 30 } as const;

export const INVARIANTS: readonly Invariant[] = [
  // Nothing asked of Ash, and still traffic: the busy loop of 10-12 (the page and the hub reading each other 44 times a second).
  { id: "idle.msg_rate", metric: "msg", agg: "rate", budget: 30, ...idle, note: "The hub is passing messages while nothing is asked of it: something is looping." },
  { id: "idle.msg_key_rate", metric: "msg", agg: "peak_rate", budget: 6, ...idle, note: "One word is called again and again while nothing is asked of the hub: a loop between two members." },
  { id: "idle.ledger_growth", metric: "ledger", agg: "rate", budget: 10, ...idle, note: "The ledger keeps growing while nothing is asked of the hub." },
  { id: "idle.cpu", metric: "cpu", agg: "value", budget: 5, ...idle, note: "The hub process is busy while nothing is asked of it." },
  // A hand that keeps reconnecting is a flapping link or a refused token that is retried.
  { id: "link.reconnect_storm", metric: "link", agg: "peak", match: "^open:", budget: 5, idle: false, window_s: 300, persist_s: 30, note: "A hand connected again and again within five minutes: a flapping link, or a refused token that is retried." },
  // A part of the phone that keeps coming and going (the phone's debug identity, the accessibility service ...): the hand says so with config.changed.
  { id: "hand.part_flap", metric: "msg", agg: "peak", match: "/config\\.changed:event$", budget: 6, idle: false, window_s: 600, persist_s: 0, note: "A part of the phone keeps coming and going (config.changed again and again): a host service that keeps dropping, such as the debug identity or the accessibility service." },
  // Answers that failed (a caller asking for what does not exist or is refused is not the hub's fault), and what the hub caught itself.
  { id: "errors.rate", metric: "err", agg: "rate", skip: ":(not_found|cancelled|denied)$", budget: 20, ...always, note: "Requests are failing at a high rate." },
  { id: "errors.internal", metric: "internal", agg: "rate", budget: 5, ...always, note: "The hub keeps catching errors of its own." },
  { id: "loop.lag", metric: "lag", agg: "value", budget: 200, ...always, note: "The event loop is late: something blocks it." },
];
