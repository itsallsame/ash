// The senses archive: sensor readings as JSON lines, one file per month (<dir>/YYYY-MM.jsonl), months by local time.
// Not in the ledger. A batch already in a month file is not appended again; a torn line is skipped on read.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { localDate } from "./facts";

/** What the archive keeps: `kind` is the sense (location, activity, ...), `ts` the reading's time (Unix ms). */
export type ArchiveKind = "location" | "activity" | "health" | "geofence" | "calendar" | "battery" | "screen";
export interface ArchiveLine { kind: ArchiveKind; ts: number; batch_id?: string; [field: string]: unknown }

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const str = (value: unknown): value is string => typeof value === "string";
const geofenceKey = (b: { name: string; transition: string; ts: number }) =>
  `gf_${createHash("sha256").update(JSON.stringify([b.name, b.transition, b.ts])).digest("hex").slice(0, 32)}`;

/**
 * The archive lines of one `sense.*` event, or null for a word that is not archived (notification, source, unknown).
 * `at` stands in for the time of an event that carries none.
 */
export function linesOf(word: string, body: unknown, at: number): { batch?: string; lines: ArchiveLine[] } | null {
  const b = (body ?? {}) as Record<string, any>;
  const items: Record<string, any>[] = Array.isArray(b.items) ? b.items.filter((i) => i && typeof i === "object") : [];
  const batch = str(b.batch_id) ? b.batch_id : undefined;
  switch (word) {
    case "sense.location":
      return { batch, lines: items.filter((i) => finite(i.ts) && finite(i.lat) && finite(i.lon)).map((i) => ({ kind: "location" as const, ts: i.ts, lat: i.lat, lon: i.lon,
        accuracy_m: finite(i.accuracy_m) ? i.accuracy_m : 0, provider: str(i.provider) ? i.provider : "", ...(typeof i.is_mocked === "boolean" ? { is_mocked: i.is_mocked } : {}) })) };
    case "sense.activity":
      return { batch, lines: items.filter((i) => finite(i.ts_start) && str(i.state)).map((i) => ({ kind: "activity" as const, ts: i.ts_start, ts_start: i.ts_start,
        ...(finite(i.ts_end) ? { ts_end: i.ts_end } : {}), state: i.state })) };
    case "sense.health":
      return { batch, lines: items.filter((i) => finite(i.ts) && str(i.metric) && finite(i.value)).map((i) => ({ kind: "health" as const, ts: i.ts, metric: i.metric, value: i.value,
        unit: str(i.unit) ? i.unit : "", source: str(i.source) ? i.source : "" })) };
    case "sense.geofence":
      if (!str(b.name) || !finite(b.ts) || (b.transition !== "enter" && b.transition !== "exit")) return null;
      return { batch: geofenceKey(b as { name: string; transition: string; ts: number }), lines: [{ kind: "geofence", ts: b.ts, name: b.name, transition: b.transition }] };
    case "sense.calendar":
      return b.event && typeof b.event === "object" ? { lines: [{ kind: "calendar", ts: at, change: b.kind, event: b.event }] } : null;
    case "sense.battery": return finite(b.level) ? { lines: [{ kind: "battery", ts: at, level: b.level }] } : null;
    case "sense.screen": return str(b.state) ? { lines: [{ kind: "screen", ts: at, state: b.state, away_ms: finite(b.away_ms) ? b.away_ms : 0 }] } : null;
    default: return null;
  }
}

export class SenseArchive {
  /** Batch ids per month file, read from the file the first time it is written to in this process. */
  private readonly batches = new Map<string, Set<string>>();
  private readonly tailChecked = new Set<string>();

  constructor(private readonly dir: string, readonly timeZone: string) {}

  private month(at: number): string { return localDate(at, this.timeZone).slice(0, 7); }
  private file(month: string): string { return join(this.dir, `${month}.jsonl`); }

  private read(path: string): ArchiveLine[] {
    if (!existsSync(path)) return [];
    const out: ArchiveLine[] = [];
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (!raw) continue;
      try {
        const line = JSON.parse(raw) as ArchiveLine;
        if (line && typeof line === "object" && str(line.kind) && finite(line.ts)) out.push(line);
      } catch { /* a torn line */ }
    }
    return out;
  }

  private batchIds(month: string): Set<string> {
    let ids = this.batches.get(month);
    if (!ids) {
      ids = new Set(this.read(this.file(month)).flatMap((l) => (str(l.batch_id) ? [l.batch_id] : [])));
      this.batches.set(month, ids);
    }
    return ids;
  }

  /** Append the lines of one event; a batch already archived is skipped. Returns the number of lines written. */
  record(batch: string | undefined, lines: ArchiveLine[]): number {
    if (!lines.length) return 0;
    const byMonth = new Map<string, ArchiveLine[]>();
    for (const line of lines) {
      const month = this.month(line.ts);
      byMonth.set(month, [...(byMonth.get(month) ?? []), line]);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let written = 0;
    for (const [month, group] of byMonth) {
      const ids = this.batchIds(month);
      if (batch && ids.has(batch)) continue;
      const path = this.file(month);
      let text = group.map((l) => `${JSON.stringify(batch ? { ...l, batch_id: batch } : l)}\n`).join("");
      // A line torn by a crash gets its own line rather than swallowing the first new one.
      if (!this.tailChecked.has(path)) {
        this.tailChecked.add(path);
        if (existsSync(path) && statSync(path).size > 0 && lastByte(path) !== 0x0a) text = `\n${text}`;
      }
      appendFileSync(path, text, { mode: 0o600 });
      if (batch) ids.add(batch);
      written += group.length;
    }
    return written;
  }

  /** Lines with from <= ts < to, of the given kinds (all when none given), oldest first. */
  scan(from: number, to: number, kinds?: readonly string[]): ArchiveLine[] {
    if (!(to > from)) return [];
    const months: string[] = [];
    for (let at = from; ; at += 86_400_000 * 27) {
      const month = this.month(Math.min(at, to - 1));
      if (!months.includes(month)) months.push(month);
      if (at >= to - 1) break;
    }
    const out: ArchiveLine[] = [];
    for (const month of months) for (const line of this.read(this.file(month))) {
      if (line.ts >= from && line.ts < to && (!kinds || kinds.includes(line.kind))) out.push(line);
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /** The newest line of each kind in the previous and the current month's files. */
  newest(at: number): Map<string, ArchiveLine> {
    const out = new Map<string, ArchiveLine>();
    const current = this.month(at);
    const [y, m] = current.split("-").map(Number) as [number, number];
    const previous = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    for (const month of [previous, current]) for (const line of this.read(this.file(month))) {
      const prior = out.get(line.kind);
      if (!prior || line.ts >= prior.ts) out.set(line.kind, line);
    }
    return out;
  }
}

function lastByte(path: string): number {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1);
    return readSync(fd, buf, 0, 1, statSync(path).size - 1) === 1 ? buf[0]! : 0x0a;
  } finally { closeSync(fd); }
}
