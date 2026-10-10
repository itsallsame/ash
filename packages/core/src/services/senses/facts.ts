// Pure arithmetic on archived sensor lines: distances, activity segments, rides, local dates. No I/O, no model.
import { ACTIVITY_STATES } from "../../../../sdk/src/namespaces";

export type ActivityState = (typeof ACTIVITY_STATES)[number];
export interface LocationLine { kind: "location"; ts: number; lat: number; lon: number; accuracy_m: number; provider: string; is_mocked?: boolean }
export interface ActivityLine { kind: "activity"; ts: number; ts_start: number; ts_end?: number; state: ActivityState }
export interface HealthLine { kind: "health"; ts: number; metric: string; value: number; unit: string; source: string }
export interface GeofenceLine { kind: "geofence"; ts: number; name: string; transition: "enter" | "exit" }
export interface SenseLines { location: LocationLine[]; activity: ActivityLine[]; health: HealthLine[]; geofence: GeofenceLine[] }

/** Great-circle distance in metres. */
export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Points worth measuring with: real fixes of useful accuracy, one per instant, in time order. */
export const MAX_ACCURACY_M = 100;
/** A hop faster than this between two fixes is a glitch, not travel. */
export const MAX_SPEED_MPS = 70;
/** Two fixes further apart than this did not measure the way between them (the phone samples at least every 30 minutes). */
export const MAX_HOP_MS = 35 * 60_000;
export function usablePoints(points: readonly LocationLine[]): LocationLine[] {
  const byTs = new Map<number, LocationLine>();
  for (const point of points) if (point.is_mocked !== true && point.accuracy_m <= MAX_ACCURACY_M) {
    const prior = byTs.get(point.ts);
    if (!prior || point.accuracy_m < prior.accuracy_m) byTs.set(point.ts, point);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** Each measurable hop between consecutive usable points. */
export function hops(points: readonly LocationLine[]): { from: number; to: number; metres: number }[] {
  const usable = usablePoints(points);
  const out: { from: number; to: number; metres: number }[] = [];
  let prior = usable[0];
  for (const point of usable.slice(1)) {
    const metres = haversine(prior, point), seconds = (point.ts - prior.ts) / 1000;
    if (seconds * 1000 > MAX_HOP_MS) { prior = point; continue; }
    if (metres / seconds > MAX_SPEED_MPS) continue; // the glitch is dropped; the next fix is measured from the last good one
    out.push({ from: prior.ts, to: point.ts, metres });
    prior = point;
  }
  return out;
}

/** Track length between two instants; null when fewer than two usable fixes fall inside. */
export function trackDistance(points: readonly LocationLine[], from: number, to: number): number | null {
  const inside = points.filter((point) => point.ts >= from && point.ts <= to);
  if (usablePoints(inside).length < 2) return null;
  return hops(inside).reduce((sum, hop) => sum + hop.metres, 0);
}

export interface Segment { ts_start: number; ts_end?: number; state: ActivityState }
/** One segment per start instant (a closed report supersedes an open one), in time order. */
export function activityTimeline(lines: readonly Segment[]): Segment[] {
  const byStart = new Map<number, Segment>();
  for (const line of lines) {
    const prior = byStart.get(line.ts_start);
    if (!prior || prior.ts_end === undefined || (line.ts_end !== undefined && line.state === prior.state))
      byStart.set(line.ts_start, { ts_start: line.ts_start, ...(line.ts_end !== undefined ? { ts_end: line.ts_end } : {}), state: line.state });
  }
  return [...byStart.values()].sort((a, b) => a.ts_start - b.ts_start);
}

/** Where a segment stops: its own end, else the next segment's start, else the horizon. */
export function segmentEnd(timeline: readonly Segment[], index: number, horizon: number): number {
  const segment = timeline[index];
  const end = segment.ts_end ?? timeline[index + 1]?.ts_start ?? horizon;
  return Math.max(segment.ts_start, end);
}

/** Two cycling reports this close together are one ride. */
export const RIDE_GAP_MS = 5 * 60_000;
export interface Ride { start: number; end: number | null }
/** Rides from the activity timeline: consecutive cycling segments merge across a short gap; any other state ends a ride. */
export function cyclingSessions(timeline: readonly Segment[]): Ride[] {
  const rides: Ride[] = [];
  let current: Ride | null = null;
  for (const segment of timeline) {
    if (segment.state === "cycling") {
      if (current && (current.end === null || segment.ts_start - current.end <= RIDE_GAP_MS)) {
        current.end = segment.ts_end === undefined ? null : Math.max(current.end ?? segment.ts_end, segment.ts_end);
        continue;
      }
      if (current) rides.push(current);
      current = { start: segment.ts_start, end: segment.ts_end ?? null };
    } else if (current) {
      if (current.end === null) current.end = Math.max(current.start, segment.ts_start);
      rides.push(current); current = null;
    }
  }
  if (current) rides.push(current);
  return rides;
}

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

function zoneOffset(at: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(at / 1000) * 1000;
}

/** The instant a local calendar date begins. */
export function dayStart(date: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new TypeError("invalid date");
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let at = wall - zoneOffset(wall, timeZone);
  at = wall - zoneOffset(at, timeZone);
  return at;
}

/** The next local calendar date. */
export function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
