// app:sense-rules, the default organ (packages/ash-skills/organs/sense-rules), run by the real app runtime as a built-in app:
// sample sense.* events go in through the router, and the stand-ins for the agent, the senses archive, the small model and
// the pause switch show what the organ asked of the hub.
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkManifest } from "../../../src/edges/apps/check";
import { call, dataOf, later, stubMember, tempDir, until, world, type World } from "../../edges/apps/helpers";

const ORGAN = fileURLToPath(new URL("../../../../ash-skills/organs/sense-rules", import.meta.url));
const PHONE = { member: "device:ABCDEFGHIJKLMNOPQRSTUV", via: "hand" as const, local: true };
const MIN = 60_000;

interface Rig {
  w: World;
  wakes: { reason: string; lane: string; context: any; to: string }[];
  llm: { messages: any[] }[];
  /** What the senses archive holds; the stand-in answers `query` from these. */
  archive: { activity: any[]; location: any[] };
  state: { paused: boolean; llmAnswer: string; llmDown: boolean; agentDown: boolean; nextDown: boolean; primary: string };
  pulse: string;
  event(word: string, body: unknown): Promise<void>;
  recent(): Promise<any[]>;
  settled(count?: number): Promise<any[]>;
}

async function rig(options: { pulse?: string; edit?: (app: Record<string, any>) => void } = {}): Promise<Rig> {
  const root = tempDir("organ-");
  cpSync(ORGAN, join(root, "sense-rules"), { recursive: true });
  const pulseFile = join(tempDir("pulse-"), "PULSE.md");
  writeFileSync(pulseFile, options.pulse ?? "");
  const manifest = join(root, "sense-rules", "app.json");
  const app = JSON.parse(readFileSync(manifest, "utf8"));
  app.server.env = { SENSE_RULES_PULSE: pulseFile };
  options.edit?.(app);
  writeFileSync(manifest, JSON.stringify(app, null, 2));

  const w = world({ builtinApps: ["sense-rules"], fixture: false, root });
  const r = { w, wakes: [], llm: [], archive: { activity: [], location: [] }, state: { paused: false, llmAnswer: "no", llmDown: false, agentDown: false, nextDown: false, primary: "agent:main" }, pulse: pulseFile } as unknown as Rig;
  const agentStub = (id: string) => stubMember(id, "agent", [{ word: "wake", effect: "act" }], { wake: (msg) => {
    if ((r.state.agentDown && id === "agent:main") || (r.state.nextDown && id === "agent:next")) throw Object.assign(new Error("gone"), { code: "offline" });
    r.wakes.push({ ...(msg.body as object), to: id } as never); return { accepted: true };
  } });
  const agents = stubMember("service:agents", "service", [{ word: "list" }], { list: () => ({ agents: ["agent:main", "agent:next"].map((id) => ({ id, primary: id === r.state.primary })) }) });
  const senses = stubMember("service:senses", "service", [{ word: "query" }], { query: (msg) => {
    const b = msg.body as { kind: "activity" | "location"; from: number; to: number };
    return { rows: (r.archive[b.kind] ?? []).filter((row) => row.ts >= b.from && row.ts < b.to), truncated: false };
  } });
  const model = stubMember("service:llm", "service", [{ word: "complete" }], { complete: (msg) => {
    if (r.state.llmDown) throw new Error("model is away");
    r.llm.push(msg.body as never); return { text: r.state.llmAnswer };
  } });
  const admin = stubMember("service:admin", "service", [{ word: "status" }], { status: () => ({ now: Date.now(), paused: r.state.paused }) });
  for (const m of [agentStub("agent:main"), agentStub("agent:next"), agents, senses, model, admin]) w.registry.add(m);
  await w.apps.start();

  r.event = async (word, body) => { await w.router.send({ to: null, kind: "event", word, body }, PHONE); };
  r.recent = async () => dataOf(await call(w, "app:sense-rules", "sense_rules.recent")).recent;
  // wait until the organ has made `count` decisions in all (a wake or a reason not to), then return them
  r.settled = async (count = 1) => until(async () => { const list = await r.recent(); return list.length >= count ? list : null; }, `${count} decisions`);
  return r;
}

test("app.json is a valid ash-app/1 manifest, and the organ is a built-in: installed without a card, listening to sense.*", async () => {
  const text = readFileSync(join(ORGAN, "app.json"), "utf8");
  const { manifest, problems } = checkManifest(text, "sense-rules");
  assert.deepEqual(problems.filter((p) => p.level === "error"), []);
  assert.deepEqual(manifest!.listens, ["sense.*"]);
  const r = await rig();
  assert.equal(r.w.router.cards.length, 0);
  const info = dataOf(await call(r.w, "service:apps", "apps.describe", { id: "sense-rules" }));
  assert.equal(info.running, true);
  assert.equal(info.origin, "builtin");
  assert.deepEqual(info.listens, ["sense.*"]);
  assert.deepEqual(info.needs.map((n: any) => `${n.member}/${n.words}`).sort(), ["agent:*/wake", "service:admin/status", "service:agents/list", "service:llm/complete", "service:senses/query"]);
  assert.ok(r.w.registry.members.get("app:sense-rules")!.listens!.includes("sense.*"));
});

test("a geofence crossing wakes the agent on the back lane; a repeat, a stale one and a second one too soon do not", async () => {
  const r = await rig();
  const now = Date.now();
  await r.event("sense.geofence", { name: "Home", transition: "exit", ts: now - MIN });
  await r.settled(1);
  assert.equal(r.wakes.length, 1);
  assert.equal(r.wakes[0]!.reason, "geofence_exit");
  assert.equal(r.wakes[0]!.lane, "back");
  assert.equal(r.wakes[0]!.context.place, "Home");
  assert.equal(r.wakes[0]!.context.summary, "离开Home");

  await r.event("sense.geofence", { name: "Home", transition: "exit", ts: now - MIN });             // the same fact again
  await r.event("sense.geofence", { name: "Office", transition: "exit", ts: now - 2 * MIN });       // another exit within ten minutes
  await r.event("sense.geofence", { name: "Gym", transition: "enter", ts: now - 3 * 3_600_000 });   // news from the past
  await r.event("sense.geofence", { name: "Office", transition: "enter", ts: now });                // a different kind: wakes
  const decisions = await r.settled(5);
  assert.deepEqual(decisions.map((d) => d.outcome), ["woke", "repeat", "too_soon", "not_fresh", "woke"]);
  assert.deepEqual(r.wakes.map((x) => x.reason), ["geofence_exit", "geofence_enter"]);
});

test("a ride: an open cycling segment wakes at its start, a closed one at its end with minutes and kilometres", async () => {
  const r = await rig();
  const now = Date.now();
  await r.event("sense.activity", { batch_id: "b1", items: [{ ts_start: now - 3 * MIN, state: "cycling" }] });
  await r.settled(1);
  assert.deepEqual(r.wakes.map((x) => x.reason), ["cycling_start"]);

  // the ride ended 2 minutes ago after 18 minutes; the archive holds the fixes (about 100 m apart, a minute apart)
  const start = now - 20 * MIN;
  r.archive.activity.push({ kind: "activity", ts: start, ts_start: start, state: "cycling" });
  for (let i = 0; i <= 18; i++) r.archive.location.push({ kind: "location", ts: start + i * MIN, lat: 31 + i * 0.0009, lon: 121, accuracy_m: 5, provider: "gps" });
  // let the ten-minute limit pass for this kind: it is a different kind (cycling_end), so it is not held back anyway
  await r.event("sense.activity", { batch_id: "b2", items: [{ ts_start: start, ts_end: start + 18 * MIN, state: "cycling" }] });
  await r.settled(2);
  assert.deepEqual(r.wakes.map((x) => x.reason), ["cycling_start", "cycling_end"]);
  const end = r.wakes[1]!.context;
  assert.equal(end.duration_min, 18);
  assert.ok(end.distance_km > 1.5 && end.distance_km < 2, `distance ${end.distance_km}`);
  assert.match(end.summary, /^骑行结束，18 分钟，1\.\d 公里$/);
});

test("an activity that is not cycling, and readings that no rule wakes for, make no wake and no calls", async () => {
  const r = await rig();
  const now = Date.now();
  await r.event("sense.activity", { batch_id: "b1", items: [{ ts_start: now - 3 * MIN, state: "walking" }] });
  await r.event("sense.location", { batch_id: "b2", items: [{ ts: now, lat: 1, lon: 1, accuracy_m: 5, provider: "gps" }] });
  await r.event("sense.battery", { level: 15 });
  await r.event("sense.health", { batch_id: "b3", items: [{ ts: now, metric: "steps", value: 10, unit: "count", source: "watch" }] });
  await r.event("sense.geofence", { name: "Home", transition: "enter", ts: now });                  // the last one is a real decision, to wait on
  await r.settled(1);
  assert.deepEqual(r.wakes.map((x) => x.reason), ["geofence_enter"]);
  assert.equal(r.llm.length, 0);
});

test("a health source that stopped is one wake per stop; its coming back is not a wake", async () => {
  const r = await rig();
  const now = Date.now();
  const stale = { source: "watch", state: "stale", ts: now, stale_hours: 30, summary: "手表 30 小时没有数据了", last_data_ts: now - 30 * 3_600_000 };
  await r.event("sense.source", stale);
  await r.settled(1);
  assert.equal(r.wakes[0]!.reason, "health_source_stale");
  assert.equal(r.wakes[0]!.context.summary, "手表 30 小时没有数据了");
  await r.event("sense.source", stale);                                                         // the same stop
  await r.event("sense.source", { ...stale, state: "fresh" });
  await r.event("sense.source", { ...stale, ts: now - 3 * 86_400_000 });                       // a notice from three days ago
  await r.event("sense.geofence", { name: "Home", transition: "enter", ts: now });             // to wait on
  await r.settled(3);
  assert.deepEqual(r.wakes.map((x) => x.reason), ["health_source_stale", "geofence_enter"]);
});

test("a calendar event wakes the agent only when it is important: the calendar's mark, a keyword in PULSE.md, or the small model", async () => {
  const pulse = "# PULSE\n\n## 重要的日程\n说明文字。\n- 牙医\n- flight\n\n## 别的\n- 咖啡\n";
  const r = await rig({ pulse });
  const now = Date.now();
  const event = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ kind: "upcoming", event: { id, title, start: now + 20 * MIN, end: now + 80 * MIN, ...extra } });
  await r.event("sense.calendar", event("e1", "周会", { important: true }));                    // marked by the calendar
  await r.settled(1);
  assert.equal(r.llm.length, 0);
  await r.event("sense.calendar", event("e2", "Flight to Tokyo"));                              // a keyword, any case
  await r.settled(2);
  assert.deepEqual(r.wakes.map((x) => x.context.event.id), ["e1", "e2"]);
  assert.equal(r.llm.length, 0);

  await r.event("sense.calendar", event("e3", "咖啡"));                                         // the keyword below is in another section: asks the model
  r.state.llmAnswer = "no";
  const decisions = await r.settled(3);
  assert.equal(decisions.at(-1).outcome, "not_important");
  assert.equal(r.llm.length, 1);
  assert.match(r.llm[0]!.messages[1].content, /牙医/);
  assert.match(r.llm[0]!.messages[1].content, /咖啡/);
  assert.ok(!r.llm[0]!.messages[1].content.includes("别的"), "only the section on important entries is shown");

  r.state.llmAnswer = "Yes.";
  await r.event("sense.calendar", event("e4", "看牙齿"));                                       // not literally a keyword: the model says yes
  await r.settled(4);
  assert.deepEqual(r.wakes.map((x) => x.context.event.id), ["e1", "e2", "e4"]);
  assert.equal(r.llm.length, 2);

  r.state.llmDown = true;                                                                        // the model is away: not important, no wake
  await r.event("sense.calendar", event("e5", "看牙"));
  await r.event("sense.calendar", { kind: "changed", event: { id: "e6", title: "flight", start: now, end: now + MIN, important: true } });   // only "upcoming" counts
  await r.event("sense.geofence", { name: "Home", transition: "enter", ts: now });
  await r.settled(6);
  assert.deepEqual(r.wakes.map((x) => x.reason), ["calendar_reminder", "calendar_reminder", "calendar_reminder", "geofence_enter"]);
});

test("with no section for important entries in PULSE.md, only the calendar's own mark counts and the model is not asked", async () => {
  const r = await rig({ pulse: "# PULSE\nnothing listed\n" });
  const now = Date.now();
  await r.event("sense.calendar", { kind: "upcoming", event: { id: "x1", title: "Dentist", start: now + 20 * MIN, end: now + 80 * MIN } });
  await r.event("sense.calendar", { kind: "upcoming", event: { id: "x2", title: "Dentist", start: now + 20 * MIN, end: now + 80 * MIN, important: true } });
  await r.settled(2);
  assert.deepEqual(r.wakes.map((x) => x.context.event.id), ["x2"]);
  assert.equal(r.llm.length, 0);
});

test("the PULSE.md the hub starts from lists no keyword, so the model is not asked about every event", async () => {
  const template = readFileSync(fileURLToPath(new URL("../../../../ash-skills/persona/PULSE.template.md", import.meta.url)), "utf8");
  const r = await rig({ pulse: template });
  const now = Date.now();
  await r.event("sense.calendar", { kind: "upcoming", event: { id: "t1", title: "Dentist", start: now + 20 * MIN, end: now + 80 * MIN } });
  await r.event("sense.calendar", { kind: "upcoming", event: { id: "t2", title: "Board", start: now + 20 * MIN, end: now + 80 * MIN, important: true } });
  await r.settled(2);
  assert.deepEqual(r.wakes.map((x) => x.context.event.id), ["t2"]);
  assert.equal(r.llm.length, 0);
});

test("nothing wakes while the hub is paused; a wake the agent could not take is not remembered, so it can be tried again", async () => {
  const r = await rig();
  const now = Date.now();
  r.state.paused = true;
  await r.event("sense.geofence", { name: "Home", transition: "exit", ts: now });
  await r.settled(1);
  assert.equal(r.wakes.length, 0);
  assert.equal((await r.recent())[0].outcome, "paused");

  r.state.paused = false;
  r.state.agentDown = true;
  await r.event("sense.geofence", { name: "Home", transition: "exit", ts: now });
  const second = await r.settled(2);
  assert.equal(second[1].outcome, "failed");
  r.state.agentDown = false;
  await r.event("sense.geofence", { name: "Home", transition: "exit", ts: now });
  await r.settled(3);
  assert.deepEqual(r.wakes.map((x) => x.reason), ["geofence_exit"]);
});

test("the wake goes to whoever is primary now: remembered until a wake fails, then asked for again; no agent is named in app.json", async () => {
  const r = await rig();
  const now = Date.now();
  assert.ok(!readFileSync(join(ORGAN, "app.json"), "utf8").includes("agent:main"));
  assert.ok(!readFileSync(join(ORGAN, "server.mjs"), "utf8").includes("agent:main"));
  await r.event("sense.geofence", { name: "Home", transition: "exit", ts: now });
  await r.settled(1);
  assert.deepEqual(r.wakes.map((x) => x.to), ["agent:main"]);
  // the owner hands primary to another agent and the old one goes away: the next wake finds the new one
  r.state.primary = "agent:next";
  r.state.agentDown = true;
  await r.event("sense.geofence", { name: "Office", transition: "enter", ts: now });
  await r.settled(2);
  assert.deepEqual(r.wakes.map((x) => `${x.to} ${x.reason}`), ["agent:main geofence_exit", "agent:next geofence_enter"]);
  // and it is remembered: the next wake goes straight to the new primary
  await r.event("sense.activity", { batch_id: "b", items: [{ ts_start: now - 2 * MIN, state: "cycling" }] });
  await r.settled(3);
  assert.equal(r.wakes.at(-1)!.to, "agent:next");
  // no primary at all: the wake is not taken and not remembered
  r.state.primary = "";
  r.state.nextDown = true;
  await r.event("sense.source", { source: "watch", state: "stale", ts: now, stale_hours: 30, summary: "x" });
  const last = await r.settled(4);
  assert.notEqual(last.at(-1).outcome, "woke");
});

test("what it already woke for is remembered across a restart of the app", async () => {
  const r = await rig();
  const now = Date.now();
  await r.event("sense.geofence", { name: "Home", transition: "exit", ts: now });
  await r.settled(1);
  await r.w.apps.runtime.stop("sense-rules");
  await r.w.apps.runtime.refresh();
  await until(() => r.w.apps.runtime.isRunning("sense-rules"), "the organ is running again");
  await r.event("sense.geofence", { name: "Home", transition: "exit", ts: now });
  await until(async () => (await r.recent()).length >= 2, "second decision");
  assert.equal(r.wakes.length, 1);
  assert.equal((await r.recent())[1].outcome, "repeat");
});
