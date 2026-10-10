/**
 * When a message to the owner is allowed to ring (ported from the old delivery service; SPEC-01 §7.3). The
 * conversation itself needs no rule: every message is in the ledger and every channel reads it through `sync`. These
 * rules only govern the notification.
 *
 * Settings (read at the moment of delivery, through the injected `settings()`):
 *   delivery.quiet_hours     "HH:MM-HH:MM" in the host's local time, may cross midnight; "" or absent: no quiet hours. Default "21:30-09:00".
 *   delivery.dedupe_minutes  how long a second reply with the same dedupe_key is a repeat. Default 60; 0 turns it off.
 */
export const QUIET_HOURS_KEY = "delivery.quiet_hours";
export const DEDUPE_MINUTES_KEY = "delivery.dedupe_minutes";
export const DEFAULT_QUIET_HOURS = "21:30-09:00";
export const DEFAULT_DEDUPE_MINUTES = 60;

/** What the message is: say's kind, or an ask. */
export type DeliveryKind = "reply" | "due" | "offer" | "heads_up" | "ask";
/** Offers and heads-ups only appear in the conversation: they never ring, so no rule below touches them. */
export const rings = (kind: DeliveryKind) => kind !== "offer" && kind !== "heads_up";
/** Quiet hours and repeats govern plain replies only; a reminder that is due, a question or approval card and the strong ring at a turn's end still ring: the owner needs them in time. */
const governed = (kind: DeliveryKind) => kind === "reply";

export interface Rules { quiet: string | null; dedupeMs: number }

export function rulesOf(settings: Record<string, unknown>): Rules {
  const quiet = settings[QUIET_HOURS_KEY] === undefined ? DEFAULT_QUIET_HOURS : settings[QUIET_HOURS_KEY];
  const minutes = settings[DEDUPE_MINUTES_KEY] === undefined ? DEFAULT_DEDUPE_MINUTES : settings[DEDUPE_MINUTES_KEY];
  return {
    quiet: typeof quiet === "string" && quiet !== "" ? quiet : null,
    dedupeMs: typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0,
  };
}

const minuteOf = (at: number, zone?: string): number => {
  if (!zone) { const d = new Date(at); return d.getHours() * 60 + d.getMinutes(); }
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return part("hour") * 60 + part("minute");
};

/** Whether [at] is inside "HH:MM-HH:MM" (start inclusive, end exclusive); a malformed interval is never quiet. */
export function isQuiet(at: number, quiet: string | null, zone?: string): boolean {
  const match = quiet ? /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(quiet) : null;
  if (!match) return false;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const now = minuteOf(at, zone);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export type Verdict = "ring" | "silent" | "watching" | "quiet" | "duplicate";

export class Delivery {
  /** dedupe_key -> when it was last seen. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly zone?: string) {}

  /** Whether [at] is inside the quiet hours. */
  quiet(at: number, rules: Rules): boolean { return isQuiet(at, rules.quiet, this.zone); }

  /**
   * Whether a message may ring now. Order: offers and heads-ups never ring; a repeat of a reply is dropped (and counted
   * as seen even when the owner is looking); then "the owner is looking" means no ring; then quiet hours hold back
   * plain replies.
   */
  decide(m: { kind: DeliveryKind; dedupe_key?: string }, at: number, watching: boolean, rules: Rules): Verdict {
    if (!rings(m.kind)) return "silent";
    if (governed(m.kind) && m.dedupe_key && rules.dedupeMs > 0) {
      for (const [key, when] of this.seen) if (at - when >= rules.dedupeMs) this.seen.delete(key);
      if (this.seen.has(m.dedupe_key)) return "duplicate";
      this.seen.set(m.dedupe_key, at);
    }
    if (watching) return "watching";
    if (governed(m.kind) && this.quiet(at, rules)) return "quiet";
    return "ring";
  }
}
