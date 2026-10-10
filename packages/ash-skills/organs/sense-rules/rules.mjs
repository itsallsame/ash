// The sense rules of app:sense-rules: which phone facts are worth waking an agent for. Pure functions, no I/O, no model.
// Ported from the rules that used to be wired into the hub (geofence crossings, rides, a stalled health source, an
// important calendar event); this file is yours to change when the owner wants different rules (then `apps.install` again).

const iso = (at) => new Date(at).toISOString();

/** A fact older than this is only archived: waking for it would be news about the past. */
export const WAKE_FRESH_MS = 30 * 60_000;
/** The same kind of wake at most once in this window. */
export const WAKE_INTERVAL_MS = 10 * 60_000;
/** A source notice older than this is not worth a turn. */
export const SOURCE_WAKE_FRESH_MS = 24 * 3_600_000;
/** How far back the activity timeline is read to find where a ride began. */
export const RIDE_LOOKBACK_MS = 12 * 3_600_000;
/** Two cycling reports this close together are one ride. */
export const RIDE_GAP_MS = 5 * 60_000;
const MAX_ACCURACY_M = 100;
const MAX_SPEED_MPS = 70;
const MAX_HOP_MS = 35 * 60_000;

// ---- geometry ----

export function haversine(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Real fixes of useful accuracy, one per instant, in time order. */
export function usablePoints(points) {
  const byTs = new Map();
  for (const point of points) if (point.is_mocked !== true && point.accuracy_m <= MAX_ACCURACY_M) {
    const prior = byTs.get(point.ts);
    if (!prior || point.accuracy_m < prior.accuracy_m) byTs.set(point.ts, point);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export function hops(points) {
  const usable = usablePoints(points);
  const out = [];
  let prior = usable[0];
  for (const point of usable.slice(1)) {
    const metres = haversine(prior, point), seconds = (point.ts - prior.ts) / 1000;
    if (seconds * 1000 > MAX_HOP_MS) { prior = point; continue; }
    if (metres / seconds > MAX_SPEED_MPS) continue;
    out.push({ from: prior.ts, to: point.ts, metres });
    prior = point;
  }
  return out;
}

/** Track length between two instants; null when fewer than two usable fixes fall inside. */
export function trackDistance(points, from, to) {
  const inside = points.filter((point) => point.ts >= from && point.ts <= to);
  if (usablePoints(inside).length < 2) return null;
  return hops(inside).reduce((sum, hop) => sum + hop.metres, 0);
}

// ---- activity ----

/** One segment per start instant (a closed report supersedes an open one), in time order. */
export function activityTimeline(lines) {
  const byStart = new Map();
  for (const line of lines) {
    const prior = byStart.get(line.ts_start);
    if (!prior || prior.ts_end === undefined || (line.ts_end !== undefined && line.state === prior.state))
      byStart.set(line.ts_start, { ts_start: line.ts_start, ...(line.ts_end !== undefined ? { ts_end: line.ts_end } : {}), state: line.state });
  }
  return [...byStart.values()].sort((a, b) => a.ts_start - b.ts_start);
}

/** Rides from the activity timeline: consecutive cycling segments merge across a short gap; any other state ends a ride. */
export function cyclingSessions(timeline) {
  const rides = [];
  let current = null;
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

// ---- the wakes: { kind, key, bucket?, context } or null ----

export function geofenceWake(event, now) {
  if (now - event.ts > WAKE_FRESH_MS || event.ts - now > WAKE_FRESH_MS) return null;
  return { kind: event.transition === "enter" ? "geofence_enter" : "geofence_exit", key: `geofence:${event.name}:${event.transition}:${event.ts}`,
    context: { place: event.name, transition: event.transition, at: iso(event.ts), summary: `${event.transition === "enter" ? "到达" : "离开"}${event.name}` } };
}

/** A health source that stopped bringing new readings (the phone says so once per stop). Its coming back is not a wake. */
export function sourceWake(event, now) {
  if (event.state !== "stale" || Math.abs(now - event.ts) > SOURCE_WAKE_FRESH_MS) return null;
  return { kind: "health_source_stale", key: `source_stale:${event.source}:${event.last_data_ts ?? "none"}`, bucket: `health_source_stale:${event.source}`,
    context: { source: event.source, stale_hours: event.stale_hours, ...(event.last_data_ts === undefined ? {} : { last_data_at: iso(event.last_data_ts) }), summary: event.summary } };
}

/**
 * Ride starts and ends touched by one activity batch. An open ride that started recently wakes once at its start; a ride
 * that ended recently wakes once at its end, with its duration and, when the fixes allow, its distance.
 * `batch` is the new segments, `timeline` all known segments (archive + batch), `points` the location fixes.
 */
export function cyclingWakes(batch, timeline, points, now) {
  if (!batch.length) return [];
  const low = Math.min(...batch.map((item) => item.ts_start)), high = Math.max(...batch.map((item) => item.ts_end ?? item.ts_start));
  const wakes = [];
  for (const ride of cyclingSessions(timeline)) {
    if (ride.start > high || (ride.end ?? Number.POSITIVE_INFINITY) < low) continue;
    if (ride.end === null) {
      if (Math.abs(now - ride.start) <= WAKE_FRESH_MS)
        wakes.push({ kind: "cycling_start", key: `cycling_start:${ride.start}`, context: { started_at: iso(ride.start), summary: "开始骑行" } });
      continue;
    }
    if (Math.abs(now - ride.end) > WAKE_FRESH_MS) continue;
    const minutes = Math.round((ride.end - ride.start) / 60_000);
    const metres = trackDistance(points, ride.start, ride.end);
    wakes.push({ kind: "cycling_end", key: `cycling_end:${ride.start}`, context: { started_at: iso(ride.start), ended_at: iso(ride.end), duration_min: minutes,
      ...(metres === null ? {} : { distance_km: Math.round(metres / 10) / 100 }),
      summary: `骑行结束，${minutes} 分钟${metres === null ? "" : `，${(metres / 1000).toFixed(1)} 公里`}` } });
  }
  return wakes;
}

// ---- the calendar: which events are important ----

/**
 * The owner's words about important events, from PULSE.md: the section whose heading names important schedule entries
 * (「重要的日程」). Each bullet line is a keyword; the whole section is what the small model is shown.
 */
export function importantSection(pulseText) {
  const lines = String(pulseText ?? "").split(/\r?\n/);
  const heading = /^#{1,6}\s.*(重要.*(日程|日历|事件)|important\s+(calendar|schedule|events?))/i;
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return { keywords: [], text: "" };
  const body = [];
  for (const line of lines.slice(start + 1)) { if (/^#{1,6}\s/.test(line)) break; body.push(line); }
  // a bullet in brackets is a note to oneself (the template's 「还没有列」), not a keyword
  const keywords = body.map((line) => /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/.exec(line)?.[1]).filter((word) => word && !/^[（(]/.test(word));
  return { keywords, text: body.join("\n").trim() };
}

/** Settled without a model: the calendar marked it, or its title and a keyword contain one another. null: needs judging. */
export function importantByRule(event, section) {
  if (event.important === true) return true;
  const title = String(event.title ?? "").trim().toLowerCase();
  if (!title) return false;
  if (section.keywords.some((word) => { const w = word.toLowerCase(); return title.includes(w) || w.includes(title); })) return true;
  return section.keywords.length ? null : false;
}
