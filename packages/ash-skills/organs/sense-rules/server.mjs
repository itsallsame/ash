// app:sense-rules (ash-app/1): MCP over stdio, written by hand, no packages.
//
// The hub delivers every sense.* event to `ash.on_event` (app.json `listens`). The rules in ./rules.mjs decide which facts are
// worth waking an agent for; this file is the glue: it reads what the rules need (the senses archive, PULSE.md, the pause
// switch), asks the small model when a rule cannot settle something, and wakes the primary agent (found with `service:agents/list`; `agent:*/wake`).
//
//   sense_rules.rules   (read)  the rules in force, in a few words
//   sense_rules.recent  (read)  the latest decisions: woke, dropped because it was a repeat, too soon, paused, ...
//   ash.on_event                the reserved tool the hub calls with {word, body, from, at}
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { activityTimeline, cyclingWakes, geofenceWake, importantByRule, importantSection, RIDE_LOOKBACK_MS, sourceWake, WAKE_INTERVAL_MS, WakeLimiter } from "./rules.mjs";

console.log = (...args) => console.error(...args);
const DIR = process.env.ASH_APP_DIR || process.cwd();
const DATA = join(DIR, "data");
const STATE = join(DATA, "state.json");
const PULSE_FILE = process.env.SENSE_RULES_PULSE || "/root/work/PULSE.md";
const KEEP_MS = 3 * 86_400_000;

// ---- the hub's way in ----

async function ash(tool, args) {
  const response = await fetch(process.env.ASH_MCP_URL, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + process.env.ASH_MCP_TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
  const body = await response.text();
  const json = body.trim().startsWith("{") ? body : body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop();
  return JSON.parse(json).result.structuredContent;
}
/** Call a word of the hub. Returns {ok, result} or {ok: false, code}; a long call is awaited. */
async function call(member, word, body = {}) {
  let out = await ash("capability_call", { member, word, body });
  for (let i = 0; out.ok && out.status === "accepted" && i < 3; i++) out = await ash("await_result", { request_id: out.request_id });
  return out.ok && !out.status ? { ok: true, result: out.result } : { ok: false, code: out.error?.code ?? "failed" };
}
const llm = async (messages, max_tokens = 8) => {
  const out = await call("service:llm", "complete", { messages, max_tokens });
  return out.ok ? String(out.result?.text ?? "") : null;
};

// ---- state: what was already woken for, so a restart does not repeat itself ----

function load() {
  try { if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8")); } catch { /* start again */ }
  return {};
}
const state = { woken: {}, last: {}, important: {}, recent: [], ...load() };
function save() {
  const now = Date.now();
  for (const [key, at] of Object.entries(state.woken)) if (now - at > KEEP_MS) delete state.woken[key];
  for (const [key, at] of Object.entries(state.important)) if (typeof at === "object" && now - at.at > KEEP_MS) delete state.important[key];
  state.recent = state.recent.slice(-50);
  mkdirSync(DATA, { recursive: true });
  const temp = `${STATE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, STATE);
}
const limiter = new WakeLimiter(WAKE_INTERVAL_MS);
limiter.last = new Map(Object.entries(state.last));
const note = (entry) => { state.recent.push({ at: Date.now(), ...entry }); save(); };

// ---- waking ----

/** The agent declared primary, asked of service:agents when needed and kept until a wake to it fails. */
let primary = null;
async function findPrimary(fresh) {
  if (primary && !fresh) return primary;
  const out = await call("service:agents", "list");
  primary = out.ok ? (out.result?.agents ?? []).find((agent) => agent.primary)?.id ?? null : null;
  return primary;
}
/** Wake the primary agent. A failed wake (it moved, or is offline) asks again who the primary is, and tries the new one once. */
async function wakePrimary(body) {
  const first = await findPrimary(false);
  if (first) {
    const sent = await call(first, "wake", body);
    if (sent.ok) return sent;
  }
  const again = await findPrimary(true);
  if (again && again !== first) return call(again, "wake", body);
  return { ok: false, code: again ? "failed" : "not_found" };
}

async function paused() {
  const out = await call("service:admin", "status");
  return out.ok && out.result?.paused === true;
}

/** One wake per fact, at most one of a kind per ten minutes (a calendar reminder is one per event, whatever else is going on); a dropped wake stays in the senses archive. */
async function wake(w, word) {
  const now = Date.now();
  if (state.woken[w.key]) { note({ word, kind: w.kind, outcome: "repeat" }); return; }
  if (await paused()) { note({ word, kind: w.kind, outcome: "paused" }); return; }
  const bucket = w.bucket ?? w.kind;
  const before = limiter.last.get(bucket);
  if (!w.unlimited && !limiter.allow(bucket, now)) { note({ word, kind: w.kind, outcome: "too_soon" }); return; }
  state.woken[w.key] = now;
  state.last = Object.fromEntries(limiter.last);
  const sent = await wakePrimary({ lane: "back", reason: w.kind, context: w.context });
  if (!sent.ok) {
    // not taken: neither the fact nor the time slot is used up, so a later event can try again
    delete state.woken[w.key];
    if (before === undefined) limiter.last.delete(bucket); else limiter.last.set(bucket, before);
    state.last = Object.fromEntries(limiter.last);
    note({ word, kind: w.kind, outcome: "failed", code: sent.code });
    return;
  }
  note({ word, kind: w.kind, outcome: "woke" });
}

// ---- the events ----

async function readPulse() { try { return readFileSync(PULSE_FILE, "utf8"); } catch { return ""; } }

/** Is this calendar event worth waking the agent for? The calendar's own mark, the keywords in PULSE.md, then the small model once. */
async function isImportant(event) {
  const section = importantSection(await readPulse());
  const settled = importantByRule(event, section);
  if (settled !== null) return settled;
  const cached = state.important[`${event.id}:${event.start}`];
  if (cached) return cached.yes;
  const answer = await llm([
    { role: "system", content: "You decide whether a calendar event matters enough to wake the owner's assistant about it. The owner's own notes on what matters are given. Answer with one word: yes or no." },
    { role: "user", content: `Notes:\n${section.text}\n\nEvent: ${String(event.title).slice(0, 120)} (starts ${new Date(event.start).toISOString()})\nImportant?` }]);
  const yes = answer !== null && /^\s*(yes|是|对|y\b)/i.test(answer);
  if (answer !== null) { state.important[`${event.id}:${event.start}`] = { yes, at: Date.now() }; save(); }
  return yes;
}

async function lines(kind, from, to) {
  const out = await call("service:senses", "query", { kind, from, to, limit: 1000 });
  return out.ok && Array.isArray(out.result?.rows) ? out.result.rows : [];
}

async function onEvent({ word, body }) {
  const now = Date.now();
  switch (word) {
    case "sense.geofence": {
      const w = geofenceWake(body, now);
      if (w) await wake(w, word); else note({ word, outcome: "not_fresh" });
      return;
    }
    case "sense.source": {
      const w = sourceWake(body, now);
      if (w) await wake(w, word);
      return;
    }
    case "sense.activity": {
      const items = body.items ?? [];
      if (!items.length) return;
      const low = Math.min(...items.map((item) => item.ts_start)), high = Math.max(...items.map((item) => item.ts_end ?? item.ts_start), now);
      const [past, points] = await Promise.all([lines("activity", low - RIDE_LOOKBACK_MS, high + 1), lines("location", low - RIDE_LOOKBACK_MS, high + 1)]);
      const timeline = activityTimeline([...past, ...items]);
      for (const w of cyclingWakes(items, timeline, points, now)) await wake(w, word);
      return;
    }
    case "sense.calendar": {
      if (body.kind !== "upcoming" || !body.event) return;
      const key = `calendar:${body.event.id}:${body.event.start}`;
      if (state.woken[key]) return;
      if (!(await isImportant(body.event))) { note({ word, kind: "calendar_reminder", outcome: "not_important" }); return; }
      await wake({ kind: "calendar_reminder", key, unlimited: true, context: { event: body.event } }, word);
      return;
    }
    default: return;                                  // location, health, battery, screen, notification: archived by the hub, no rule wakes for them
  }
}

// events are taken at once and handled one after another, so the hub's call returns quickly
let queue = Promise.resolve();
const enqueue = (event) => { queue = queue.then(() => onEvent(event)).catch((error) => { note({ word: event.word, outcome: "error", message: String(error?.message ?? error).slice(0, 200) }); }); };

// ---- MCP over stdio ----

const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const RULES = [
  "geofence_enter / geofence_exit: the owner arrived at or left a named place (a crossing less than 30 minutes old)",
  "cycling_start / cycling_end: a ride began, or ended (with minutes and, when the fixes allow, kilometres)",
  "health_source_stale: a health source has stopped bringing readings (once per stop)",
  "calendar_reminder: an event is about to start and is marked important, or matches a keyword in PULSE.md's section on important schedule entries, or the small model judges it matches",
  `the same kind of wake at most once in ${WAKE_INTERVAL_MS / 60_000} minutes; the same fact never twice; nothing while the hub is paused`,
];
const TOOLS = [
  { name: "sense_rules.rules", title: "Rules", description: "The wake rules in force.", inputSchema: object(), annotations: { readOnlyHint: true } },
  { name: "sense_rules.recent", title: "Recent decisions", description: "The latest decisions of the rules: woke, repeat, too_soon, paused, not_fresh, not_important, failed.", inputSchema: object(), annotations: { readOnlyHint: true } },
  { name: "ash.on_event", title: "On event", description: "Reserved: the hub delivers listened events here.", inputSchema: object({ word: { type: "string" }, body: {}, from: { type: "string" }, at: { type: "number" } }, ["word"]) },
];

function tool(name, args) {
  switch (name) {
    case "sense_rules.rules": return { rules: RULES };
    case "sense_rules.recent": return { recent: state.recent };
    case "ash.on_event": enqueue({ word: args.word, body: args.body ?? {}, from: args.from, at: args.at }); return { ok: true };
    default: throw new Error("unknown tool " + name);
  }
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sense-rules", version: "1.0.0" } } });
  else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
  else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  else if (method === "tools/call") {
    try {
      const data = tool(params.name, params.arguments || {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } });
    } catch (error) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(error.message || error) }], isError: true } }); }
  } else send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method " + method } });
});
