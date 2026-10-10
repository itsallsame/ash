import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply } from "../../../../sdk/src/message";
import { compileSchema } from "../../../../sdk/src/word";
import { createSensesService, ensureDailyTimer, DAILY_LABEL } from "../../../src/services/senses";
import { openLedger, tempDir } from "../../kernel/ledger/helpers";

const at = (iso: string) => Date.parse(`${iso}Z`);
const NOW = at("2026-10-10T12:00:00");
const owner: Caller = { member: "person:owner", via: "human", local: true };
const clockCaller: Caller = { member: "service:clock", via: "service", local: true };
const ctxOf = (caller: Caller): HandleContext => ({ signal: new AbortController().signal, caller, raw: null });
const msg = (word: string, body: unknown, kind: "request" | "event" = "request", from = "device:phone"): Message =>
  ({ seq: 0, id: "m_1", ts: 0, from, to: "service:senses", kind, word, body });

function setup(dir = tempDir(), ledger = openLedger().ledger) {
  const clock = { t: NOW };
  const service = createSensesService({ ledger, dataDir: dir, now: () => clock.t, timeZone: "UTC", log: () => {} });
  const event = (word: string, body: unknown) => service.handle(msg(word, body, "event"), ctxOf({ member: "device:phone", via: "hand", local: true }));
  const call = async (word: string, body: unknown, caller: Caller = owner) => ((await service.handle(msg(word, body), ctxOf(caller))) as { data: any }).data;
  return { dir, ledger, clock, service, event, call, file: (m: string) => join(dir, "senses", `${m}.jsonl`) };
}
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const loc = (ts: number, lat = 31, lon = 121) => ({ ts, lat, lon, accuracy_m: 10, provider: "fused" });

test("the member is service:senses with the sdk's words, and the sense events validate against their contracts", () => {
  const { service } = setup();
  assert.equal(service.id, "service:senses");
  const words = service.words();
  assert.deepEqual(words.filter((w) => w.kind === "request").map((w) => w.word).sort(), ["daily", "now", "query"]);
  const contract = words.find((w) => w.word === "sense.location")!;
  assert.ok(compileSchema(contract.input_schema)({ batch_id: "b1", items: [loc(NOW)] }));
});

test("events land in the month file, not in the ledger", async () => {
  const s = setup();
  await s.event("sense.location", { batch_id: "b1", items: [loc(at("2026-10-10T11:00:00")), loc(at("2026-10-10T11:05:00"))] });
  await s.event("sense.battery", { level: 80 });
  await s.event("sense.geofence", { name: "home", transition: "enter", ts: at("2026-10-10T11:30:00") });
  assert.deepEqual(readdirSync(join(s.dir, "senses")), ["2026-10.jsonl"]);
  const rows = lines(s.file("2026-10"));
  assert.deepEqual(rows.map((r) => r.kind), ["location", "location", "battery", "geofence"]);
  assert.equal(rows[0].batch_id, "b1");
  assert.equal(rows[2].ts, NOW);
  assert.equal((s.ledger.db().prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
});

test("a re-delivered batch is archived once; a batch across a month end goes to both files", async () => {
  const s = setup();
  const batch = { batch_id: "b9", items: [loc(at("2026-09-30T23:59:00")), loc(at("2026-10-01T00:01:00"))] };
  await s.event("sense.location", batch);
  await s.event("sense.location", batch);
  assert.deepEqual(readdirSync(join(s.dir, "senses")).sort(), ["2026-09.jsonl", "2026-10.jsonl"]);
  assert.equal(lines(s.file("2026-09")).length, 1);
  assert.equal(lines(s.file("2026-10")).length, 1);
});

test("sense.notification is not archived; it is only the latest one", async () => {
  const s = setup();
  await s.event("sense.notification", { app: "chat", title: "Mom", text: "dinner?" });
  assert.equal(existsSync(join(s.dir, "senses")), false);
  s.clock.t += 5000;
  await s.event("sense.notification", { app: "mail", title: "Bill", text: "due" });
  const now = await s.call("now", {});
  assert.deepEqual(now.readings.notification.reading, { app: "mail", title: "Bill", text: "due" });
  assert.equal(now.readings.notification.age_ms, 0);
  assert.deepEqual((await s.call("query", { kind: "notification" })).rows.map((r: any) => r.title), ["Bill"]);
  // a fresh process knows no notification: it was never written down
  const again = setup(s.dir, s.ledger);
  assert.equal((await again.call("now", {})).readings.notification, undefined);
});

test("now gives the newest reading of each kind with its age, also after a restart", async () => {
  const s = setup();
  await s.event("sense.location", { batch_id: "b1", items: [loc(at("2026-10-10T11:00:00"), 31), loc(at("2026-10-10T11:50:00"), 32)] });
  await s.event("sense.battery", { level: 80 });
  s.clock.t += 60_000;
  await s.event("sense.battery", { level: 79 });
  const now = await s.call("now", {});
  assert.equal(now.readings.location.reading.lat, 32);
  assert.equal(now.readings.location.age_ms, NOW + 60_000 - at("2026-10-10T11:50:00"));
  assert.equal(now.readings.battery.reading.level, 79);
  const again = setup(s.dir, s.ledger);
  const back = await again.call("now", {});
  assert.equal(back.readings.location.reading.lat, 32);
  assert.equal(back.readings.battery.reading.level, 79);
});

test("query: by kind and range, oldest first, with a limit; steps are the step readings of health", async () => {
  const s = setup();
  await s.event("sense.location", { batch_id: "b1", items: [loc(at("2026-10-10T10:00:00")), loc(at("2026-10-10T09:00:00")), loc(at("2026-10-08T09:00:00"))] });
  await s.event("sense.health", { batch_id: "h1", items: [
    { ts: at("2026-10-10T10:00:00"), metric: "steps", value: 100, unit: "count", source: "watch" },
    { ts: at("2026-10-10T10:30:00"), metric: "heart_rate", value: 60, unit: "bpm", source: "watch" }] });
  const day = await s.call("query", { kind: "location" });                      // default: the last day
  assert.deepEqual(day.rows.map((r: any) => r.ts), [at("2026-10-10T09:00:00"), at("2026-10-10T10:00:00")]);
  assert.equal(day.truncated, false);
  assert.equal(day.rows[0].batch_id, undefined);
  const wide = await s.call("query", { kind: "location", from: at("2026-10-01T00:00:00"), limit: 2 });
  assert.deepEqual(wide.rows.map((r: any) => r.ts), [at("2026-10-08T09:00:00"), at("2026-10-10T09:00:00")]);
  assert.equal(wide.truncated, true);
  assert.equal((await s.call("query", { kind: "health" })).rows.length, 2);
  assert.deepEqual((await s.call("query", { kind: "steps" })).rows.map((r: any) => r.value), [100]);
  assert.deepEqual((await s.call("query", { kind: "screen" })).rows, []);
});

test("a torn last line does not swallow the next event", async () => {
  const s = setup();
  await s.event("sense.battery", { level: 50 });
  const { appendFileSync } = await import("node:fs");
  appendFileSync(s.file("2026-10"), '{"kind":"battery","ts":1,"lev');
  const again = setup(s.dir, s.ledger);
  await again.event("sense.battery", { level: 49 });
  assert.deepEqual(((await again.call("query", { kind: "battery" })).rows as any[]).map((r) => r.level), [50, 49]);
});

test("unknown words are refused", async () => {
  const s = setup();
  await assert.rejects(s.call("nope", {}), (e) => e instanceof WordError && e.code === "not_found");
});

test("daily: the clock's call works out the recent finished days; other callers read what is stored", async () => {
  const s = setup();
  // 2026-10-09: a ride, a walk, steps from two sources, a stay at home
  await s.event("sense.activity", { batch_id: "a1", items: [
    { ts_start: at("2026-10-09T08:00:00"), ts_end: at("2026-10-09T08:30:00"), state: "walking" },
    { ts_start: at("2026-10-09T09:00:00"), ts_end: at("2026-10-09T09:20:00"), state: "cycling" }] });
  await s.event("sense.health", { batch_id: "h1", items: [
    { ts: at("2026-10-09T10:00:00"), metric: "steps", value: 3000, unit: "count", source: "watch" },
    { ts: at("2026-10-09T11:00:00"), metric: "steps", value: 2000, unit: "count", source: "watch" },
    { ts: at("2026-10-09T10:00:00"), metric: "steps", value: 4000, unit: "count", source: "phone" },
    { ts: at("2026-10-09T12:00:00"), metric: "weight", value: 70, unit: "kg", source: "scale" }] });
  await s.event("sense.geofence", { name: "home", transition: "enter", ts: at("2026-10-09T18:00:00") });
  await s.event("sense.geofence", { name: "home", transition: "exit", ts: at("2026-10-09T19:00:00") });

  // nothing is stored until the clock asks
  assert.deepEqual(await s.call("daily", {}), { date: "2026-10-09", available: false });
  assert.equal((s.ledger.db().prepare("SELECT COUNT(*) AS n FROM senses_daily").get() as { n: number }).n, 0);

  s.clock.t = at("2026-10-10T00:30:00");
  const fromClock = await s.call("daily", {}, clockCaller);
  assert.equal(fromClock.available, true);
  assert.equal(fromClock.date, "2026-10-09");
  assert.equal(fromClock.activity_min.walking, 30);
  assert.equal(fromClock.activity_min.cycling, 20);
  assert.equal(fromClock.cycling.count, 1);
  assert.equal(fromClock.steps.total, 5000);
  assert.deepEqual(fromClock.steps.by_source, { phone: 4000, watch: 5000 });
  assert.equal(fromClock.geofences.home.inside_min, 60);
  assert.equal(fromClock.health_latest.weight.value, 70);

  // the owner reads the same from the table, by date or by default
  const read = await s.call("daily", { date: "2026-10-09" });
  assert.equal(read.steps.total, 5000);
  assert.equal((await s.call("daily", {})).date, "2026-10-09");
  assert.deepEqual(await s.call("daily", { date: "2026-10-08" }), { date: "2026-10-08", available: false });

  // it is the service's own table, and survives a restart
  const again = setup(s.dir, s.ledger);
  again.clock.t = s.clock.t;
  assert.equal((await again.call("daily", { date: "2026-10-09" })).geofences.home.inside_min, 60);
});

test("a late batch for yesterday is picked up by the next daily run", async () => {
  const s = setup();
  s.clock.t = at("2026-10-10T00:30:00");
  await s.event("sense.activity", { batch_id: "a1", items: [{ ts_start: at("2026-10-09T08:00:00"), ts_end: at("2026-10-09T08:10:00"), state: "walking" }] });
  assert.equal((await s.call("daily", {}, clockCaller)).activity_min.walking, 10);
  await s.event("sense.activity", { batch_id: "a2", items: [{ ts_start: at("2026-10-09T09:00:00"), ts_end: at("2026-10-09T09:10:00"), state: "walking" }] });
  s.clock.t = at("2026-10-11T00:30:00");
  assert.equal((await s.call("daily", { date: "2026-10-09" }, clockCaller)).activity_min.walking, 20);
});

test("senses sends nothing by itself: events and words never touch a router", async () => {
  // the service has no router at all; the only thing that ever sends is ensureDailyTimer, to the clock
  const s = setup();
  await s.event("sense.geofence", { name: "home", transition: "enter", ts: NOW });
  await s.event("sense.source", { source: "watch", state: "stale", ts: NOW, stale_hours: 6, summary: "x" });
  await s.event("sense.calendar", { kind: "upcoming", event: { id: "e", title: "t", start: NOW, end: NOW, important: true } });
  await s.event("sense.screen", { state: "app_open", away_ms: 9 * 3_600_000 });
  assert.equal(Object.keys(s.service).filter((k) => /router/i.test(k)).length, 0);
  assert.equal(lines(s.file("2026-10")).filter((l) => l.kind === "source").length, 0);   // a source notice is not a reading
});

test("ensureDailyTimer sets the clock's daily timer once", async () => {
  const sent: { msg: Outgoing; caller: Caller }[] = [];
  const timers: any[] = [];
  const router = { send: async (m: Outgoing, caller: Caller): Promise<Reply> => {
    sent.push({ msg: m, caller });
    if (m.word === "list") return { ok: true, result: { data: { timers } } };
    timers.push({ id: "t1", label: (m.body as any).label });
    return { ok: true, result: { data: { id: "t1", next: 0 } } };
  } };
  const opts = { now: () => NOW, timeZone: "UTC" };
  assert.deepEqual(await ensureDailyTimer(router, opts), { set: true });
  assert.deepEqual(await ensureDailyTimer(router, opts), { set: false });
  const setCalls = sent.filter((c) => c.msg.word === "set");
  assert.equal(setCalls.length, 1);
  assert.deepEqual(setCalls[0]!.msg, { to: "service:clock", kind: "request", word: "set",
    body: { at: at("2026-10-11T00:30:00"), every: 86_400, to: "service:senses", word: "daily", body: {}, label: DAILY_LABEL } });
  assert.equal(setCalls[0]!.caller.member, "service:senses");
  assert.ok(sent.every((c) => c.msg.to === "service:clock"), "nothing but the clock is addressed");
});
