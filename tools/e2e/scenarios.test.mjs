// Unit tests of tools/e2e/scenarios.mjs: the judging rules run on recorded samples, the catalog is checked for shape, and the
// runner is driven with stand-ins for adb and owner.mjs. No device, no hub. (The plumbing against a real hub is tested in
// packages/core/test/edges/owner-cli/scenarios.test.ts.)
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Adb, Ctx, GATE, MAIN, OWNER, OwnerCli, Outcome, REMEDY, SCENARIOS, agentSays, answerOnCard, approvalCards, batteryLevel, bodyFromSchema, callResult, check,
  configItems, describeCatalog, effects, errorCodeOf, errorOf, failures, foregroundPackage, gateTells, hhmmIn, jsonOfContent, isAwake, keyguardShowing, looksDisconnected, matchesToken,
  modelOf, optionCards, ownerSpeech, parseArgs, parseLink, parseNotifications, parseOwnerLines, parsePs, pickOf, reportLine, responsesTo, resumedPackage, retryCard,
  runOne, sayAttempts, selectScenarios, sentOf, supplementTurns, textOf, totalPssKb, turnsGiven, turnsIn,
} from "./scenarios.mjs";

const here = new URL(".", import.meta.url);
const text = (name) => readFileSync(new URL(`fixtures/${name}`, here), "utf8");
const json = (name) => JSON.parse(text(name));

// --- owner.mjs output ---------------------------------------------------------------------------------------------------

test("say output: the sent line, the reply bubble, and what a reply is", () => {
  const events = parseOwnerLines(text("owner-say.jsonl"));
  assert.equal(sentOf(events)?.to, "agent:main");
  assert.match(sentOf(events).id, /^m_/);
  const bubble = events.find((e) => e.kind === "msg");
  assert.equal(bubble.raw.body.text, "好");
  assert.equal(events.at(-2).kind, "done");
  assert.equal(parseOwnerLines("not json\n{\"kind\":\"x\"}\n{broken").length, 1, "stray lines are dropped");
});

test("call output: a result is ok with its data, a refusal carries the hub's error code", () => {
  const ok = callResult(parseOwnerLines(text("owner-call-ok.jsonl")));
  assert.equal(ok.ok, true);
  assert.equal(ok.data.paused, false);
  assert.equal(typeof ok.data.uptime_ms, "number");
  const bad = callResult(parseOwnerLines(text("owner-call-fail.jsonl")));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "offline");
  assert.match(bad.message, /service:nothing/);
  assert.equal(callResult([]), null);
  // a hand that answers in text only
  const textOnly = callResult([{ kind: "result", ok: true, content: [{ type: "text", text: '{"battery":{"percent":50}}' }] }]);
  assert.equal(textOnly.data.battery.percent, 50);
  assert.equal(jsonOfContent([{ type: "text", text: "ok" }]), undefined);
});

test("a refused or unreachable connection looks disconnected (fetch the link again); an answered refusal does not", () => {
  const refused = parseOwnerLines(text("owner-refused.jsonl"));
  assert.match(errorOf(refused), /4001/);
  assert.equal(looksDisconnected(1, refused), true);
  assert.equal(looksDisconnected(1, [], "ECONNREFUSED"), true);
  assert.equal(looksDisconnected(3, parseOwnerLines(text("owner-call-fail.jsonl"))), false, "exit 3 is a word that failed, the hub answered");
  assert.equal(looksDisconnected(2, []), false, "no reply in time is not a lost connection");
  assert.equal(looksDisconnected(0, []), false);
});

test("the link file of a debug build", () => {
  assert.deepEqual(parseLink('{"port":43211,"token":"abc","at":1}\n'), { port: 43211, token: "abc", at: 1 });
  assert.equal(parseLink(""), null);
  assert.equal(parseLink('{"port":0,"token":"abc"}'), null);
  assert.equal(parseLink('{"port":80,"token":" "}'), null);
  assert.equal(parseLink("run-as: package not debuggable: ai.ash.agent"), null);
});

// --- the ledger: an approval, an option card, a busy agent, a sub-agent ------------------------------------------------------

const flows = json("ledger-flows.json");
const PHONE = (/device:\S+?(?=[ ,)])/.exec(flows.find((m) => m.word === "clipboard.set")?.to ?? "") ?? [flows.find((m) => m.word === "clipboard.set").to])[0];

test("approval: the card is found with its word and options, the owner's choice, the gate's message to the asker, and the effect counted once", () => {
  const cards = approvalCards(flows);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.word, "clipboard.set");
  assert.equal(card.to, PHONE);
  assert.deepEqual([...card.options].sort(), ["always", "deny", "once"]);
  assert.match(card.pending, /^m_/);
  assert.equal(answerOnCard(flows, card.id), "once");
  assert.equal(gateTells(flows).length, 1);
  assert.equal(gateTells(flows)[0].to, MAIN);
  assert.equal(effects(flows, { from: MAIN, to: PHONE, word: "clipboard.set" }).length, 1);
  assert.equal(answerOnCard(flows.slice(0, 3), card.id), null, "an open card has no answer");
  // before the answer nothing had run
  const beforeAnswer = flows.filter((m) => m.seq < flows.find((x) => x.kind === "response" && x.reply_to === card.id).seq);
  assert.equal(effects(beforeAnswer, { from: MAIN, to: PHONE, word: "clipboard.set" }).length, 0);
});

test("refusal: the request ends 'denied', nothing ran, the asker was told", () => {
  const ms = json("ledger-stop-deny.json");
  const spec = { from: MAIN, to: ms.find((m) => m.word === "clipboard.set").to, word: "clipboard.set" };
  assert.equal(effects(ms, spec).length, 0);
  const codes = failures(ms, spec).flatMap((r) => responsesTo(ms, r.id).map(errorCodeOf));
  assert.deepEqual(codes, ["denied"]);
  assert.equal(gateTells(ms).length, 1);
  assert.equal(answerOnCard(ms, approvalCards(ms)[0].id), "deny");
});

test("an option card and the pick that answers it", () => {
  const cards = optionCards(flows);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].options, ["a", "b"]);
  const pick = pickOf(flows, cards[0].id);
  assert.equal(pick.body.option_id, "b");
  assert.equal(turnsGiven(flows, pick.id).length, 1);
  assert.equal(turnsGiven(flows, pick.id)[0].outcome, "completed");
  assert.equal(pickOf(flows, "m_nothing"), null);
});

test("turns: lanes, ids and outcomes come from the turn events", () => {
  const turns = turnsIn(flows);
  const ask = [...turns.values()].find((t) => t.agent === "agent:e2e-helper" && t.lane === "back");
  assert.ok(ask && ask.outcome === "completed" && ask.ids.length === 1);
  const front = [...turns.values()].filter((t) => t.agent === MAIN && t.lane === "front");
  assert.ok(front.length >= 5);
  assert.ok(front.every((t) => t.startedSeq < t.endedSeq));
  assert.equal(turns.get("t_x"), undefined);
});

test("stop: the running turn ended 'interrupted', and the stop message got its own turn", () => {
  const ms = json("ledger-stop-deny.json");
  const turns = [...turnsIn(ms).values()];
  assert.equal(turns[0].outcome, "interrupted");
  const stop = ms.find((m) => m.word === "say" && textOf(m).startsWith("停下"));
  const next = turnsGiven(ms, stop.id)[0] ?? turns.find((t) => t.ids.some((id) => id !== turns[0].ids[0]));
  assert.ok(next && next.id !== turns[0].id && next.outcome === "completed");
});

test("failure: the retry card is found by its option id prefix (retry:<turn>), and the failed turn says why", () => {
  const ms = json("ledger-failure.json");
  const card = retryCard(ms);
  assert.match(card.retry, /^retry:t_\d+$/);
  assert.equal(optionCards(ms).length, 1);
  const failed = [...turnsIn(ms).values()].find((t) => t.outcome === "error");
  assert.equal(failed.error, "model unavailable");
  assert.equal(retryCard(flows), null, "an ordinary option card is not a retry card");
  const pick = pickOf(ms, card.id);
  assert.equal(turnsGiven(ms, pick.id)[0].outcome, "completed");
});

test("busy supplements: separate turns are counted, a batch is one turn", () => {
  const ids = flows.filter((m) => m.word === "say" && m.from === OWNER && /^补充/.test(textOf(m))).map((m) => m.id);
  assert.equal(ids.length, 3);
  const separate = supplementTurns(flows, ids);
  assert.equal(separate.turns.length, 3, "this recording ran each follow-up as its own turn");
  assert.equal(separate.read, 3);
  const batched = flows.map((m) => (m.word === "turn.started" && m.body.ids?.includes(ids[0]) ? { ...m, body: { ...m.body, ids } } : m)).filter((m) => !(m.word === "turn.started" && !m.body.ids?.includes(ids[0]) && m.body.ids?.some((i) => ids.includes(i))));
  const one = supplementTurns(batched, ids);
  assert.equal(one.turns.length, 1);
  assert.equal(one.read, 3);
  assert.equal(supplementTurns(flows, ["m_other"]).turns.length, 0);
});

test("sub-agent: speech to the owner carries the lane; a refused attempt from a background turn is visible; only the front lane may speak", () => {
  const helper = "agent:e2e-helper";
  const speech = ownerSpeech(flows, helper);
  assert.equal(speech.length, 1);
  assert.deepEqual([speech[0].delivered, speech[0].lane, speech[0].text], [true, "front", "在的"]);
  const attempts = sayAttempts(flows, helper);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].refused, true);
  assert.equal(turnsIn(flows).get(attempts[0].turn).lane, "back");
  assert.equal(agentSays(flows, helper).length, 1);
  // a leak would show as a delivered say from a back-lane turn
  const back = [...turnsIn(flows).values()].find((t) => t.agent === helper && t.lane === "back");
  const leaked = [...flows, { seq: 9999, id: "m_leak", ts: 1, from: helper, to: OWNER, kind: "request", word: "say", body: { text: "偷偷说" }, turn: back.id },
    { seq: 10000, id: "m_leakr", ts: 1, from: OWNER, to: helper, kind: "response", word: "say", reply_to: "m_leak", body: { ok: true, result: { data: { accepted: true } } } }];
  const bad = ownerSpeech(leaked, helper).filter((s) => s.delivered && s.lane !== "front");
  assert.equal(bad.length, 1, "the judge would catch a background turn that spoke");
});

test("the creation of a helper and the answers to ask and tell are effects with the right bodies", () => {
  const declared = effects(flows, { from: MAIN, to: "service:agents", word: "declare" }).find((r) => r.body.id === "agent:e2e-helper");
  assert.ok(declared);
  assert.ok(effects(flows, { from: MAIN, to: "service:agents", word: "ask" }).find((r) => r.body.agent === "agent:e2e-helper"));
  assert.ok(effects(flows, { from: MAIN, to: "service:agents", word: "tell" }).find((r) => r.body.agent === "agent:e2e-helper"));
  assert.equal(effects(flows, { from: MAIN, to: "service:agents", word: /^(ask|tell)$/ }).length, 3);
});

// --- Android output -----------------------------------------------------------------------------------------------------

test("foreground package: from the focused window, with fallbacks for a shade, no focus, and the resumed activity", () => {
  assert.equal(foregroundPackage(text("dumpsys-window.txt")), "com.android.settings");
  assert.equal(foregroundPackage(text("dumpsys-window-shade.txt")), "NotificationShade");
  assert.equal(foregroundPackage(text("dumpsys-window-transition.txt")), "ai.ash.agent", "no focus: the focused app");
  assert.equal(foregroundPackage(""), null);
  assert.equal(resumedPackage("  mResumedActivity: ActivityRecord{1a2b3c u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity t88}"), "com.android.chrome");
  assert.equal(resumedPackage("  topResumedActivity=ActivityRecord{e1f u0 com.miui.home/.launcher.Launcher t2}"), "com.miui.home");
  assert.equal(keyguardShowing(text("dumpsys-window-locked.txt")), true);
  assert.equal(keyguardShowing(text("dumpsys-window.txt")), false);
  assert.equal(isAwake("  mWakefulness=Awake\n"), true);
  assert.equal(isAwake("  mWakefulness=Asleep\n"), false);
});

test("notifications: package, title, text and the action buttons of each record", () => {
  const all = parseNotifications(text("dumpsys-notification.txt"));
  assert.equal(all.length, 3);
  assert.deepEqual([all[0].pkg, all[0].id, all[0].tag, all[0].title], ["ai.ash.agent", 7, "reminder", "后台提醒"]);
  assert.match(all[0].text, /bgremind-lq3k9zab/);
  assert.deepEqual(all[1].actions, ["可以", "以后都可以", "不行"]);
  assert.equal(all[1].tag, null);
  assert.match(all[1].title, /需要你确认/);
  assert.equal(all[2].pkg, "com.android.shell");
  assert.match(all[2].text, /notice-lq3k9zab/, "bigText falls back when text is absent, here both are read");
  assert.equal(all.find((n) => n.pkg === "ai.ash.agent" && `${n.title} ${n.text}`.includes("bgremind-lq3k9zab")).id, 7);
  assert.deepEqual(parseNotifications("nothing here"), []);
});

test("processes: the hub and DSH are found by their arguments", () => {
  const ps = text("ps-all.txt");
  assert.deepEqual(parsePs(ps, /ash-core\.mjs/).map((p) => p.pid), [9034]);
  assert.deepEqual(parsePs(ps, /--profile[ =]acp/).map((p) => p.pid), [9120, 9188]);
  assert.deepEqual(parsePs(ps, /nothing/), []);
});

test("memory and battery numbers", () => {
  assert.equal(totalPssKb(text("meminfo-new.txt")), 214567);
  assert.equal(totalPssKb(text("meminfo-old.txt")), 198765);
  assert.equal(totalPssKb("no memory here"), null);
  assert.equal(batteryLevel(text("dumpsys-battery.txt")), 87);
  assert.equal(batteryLevel(""), null);
});

test("the phone's own permission report: item -> state", () => {
  const items = configItems(json("config-status.json"));
  assert.equal(items.get("calendar").state, "granted");
  assert.equal(items.get("photos").state, "missing");
  assert.equal(items.get("shizuku").state, "unsupported");
  assert.equal(items.get("nothing"), undefined);
});

// --- small pure helpers ---------------------------------------------------------------------------------------------------

test("the model read back from DSH is a JSON pair, a plain name or an array", () => {
  assert.deepEqual(modelOf({ model: '["deepseek-official","deepseek-flash"]' }), ["deepseek-official", "deepseek-flash"]);
  assert.deepEqual(modelOf({ model: "deepseek-v4-pro" }), [undefined, "deepseek-v4-pro"]);
  assert.deepEqual(modelOf({ config: { model: ["a", "b"] } }), ["a", "b"]);
  assert.equal(modelOf({}), null);
});

test("a body made from an input schema fills the required fields only", () => {
  const schema = { type: "object", required: ["text", "n", "ok", "kind"], properties: { text: { type: "string" }, n: { type: "integer", minimum: 3 }, ok: { type: "boolean" }, kind: { enum: ["x", "y"] }, more: { type: "string" } } };
  assert.deepEqual(bodyFromSchema(schema, "M"), { text: "M", n: 3, ok: true, kind: "x" });
  assert.deepEqual(bodyFromSchema(undefined, "M"), {});
});

test("the review time is written in the phone's zone, not this machine's", () => {
  const at = Date.UTC(2026, 9, 10, 15, 30, 0);
  assert.equal(hhmmIn(at, "Asia/Shanghai"), "23:30");
  assert.equal(hhmmIn(at, "America/Los_Angeles"), "08:30");
  assert.equal(hhmmIn(Date.UTC(2026, 9, 10, 16, 5, 0), "Asia/Shanghai"), "00:05", "midnight reads 00, not 24");
});

test("report lines: status, id, name, then the detail on one line", () => {
  assert.equal(reportLine("PASS", "R19", "审批", "ran once"), "PASS R19 审批 -- ran once");
  assert.equal(reportLine("SKIP", "S086", "日历", "line one\n  line two"), "SKIP S086 日历 -- line one line two");
  assert.equal(reportLine("PASS", "S1", "n", ""), "PASS S1 n");
});

test("arguments: defaults, values, a bad number, an unknown option", () => {
  const o = parseArgs(["--serial", "ABC", "--link-file=/tmp/l.json", "--only", "R19,S085", "--safe", "--manual-wait", "0"], {});
  assert.deepEqual([o.serial, o.linkFile, o.only, o.safe, o.manualWait, o.pkg, o.kpkg, o.timeoutScale], ["ABC", "/tmp/l.json", "R19,S085", true, 0, "ai.ash.agent", "ai.ash.kernel", 1]);
  assert.equal(parseArgs([], { ANDROID_SERIAL: "ENV" }).serial, "ENV");
  assert.throws(() => parseArgs(["--timeout-scale", "x"], {}), /number/);
  assert.throws(() => parseArgs(["--timeout-scale", "0"], {}), /above 0/);
  assert.throws(() => parseArgs(["--nope"], {}), /unknown option/);
  assert.throws(() => parseArgs(["--only"], {}), /needs a value/);
  assert.throws(() => parseArgs(["stray"], {}), /unexpected/);
});

// --- the catalog ------------------------------------------------------------------------------------------------------------

const KNOWN_NEEDS = new Set(["phone", "llm", "kill", "network", "notification-sense", "calendar", "location", "photos", "notifications", "notification_listener", "accessibility", "shizuku"]);

test("the catalog: unique ids, old numbers named, nothing claims another scenario's number, every need has a remedy", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  assert.ok(SCENARIOS.length >= 30 && SCENARIOS.length <= 55, `${SCENARIOS.length} scenarios`);
  for (const s of SCENARIOS) {
    assert.equal(s.codes[0], s.id);
    assert.ok(s.codes.some((c) => /^(R|S)\d+/.test(c)), `${s.id} names an old R or S number`);
    assert.ok(s.name && s.category && typeof s.run === "function", s.id);
    for (const c of s.codes.slice(1)) assert.ok(!ids.includes(c), `${s.id} lists ${c}, which is another scenario's own number`);
    for (const n of s.needs) { assert.ok(KNOWN_NEEDS.has(n), `${s.id} needs unknown '${n}'`); assert.ok(REMEDY[n], `${s.id}: no remedy text for '${n}'`); }
  }
  const categories = new Set(SCENARIOS.map((s) => s.category));
  for (const c of ["smoke", "conversation", "approval", "agents", "phone", "apps", "senses", "settings", "recovery"]) assert.ok(categories.has(c), `category ${c}`);
  assert.deepEqual(SCENARIOS.filter((s) => s.manual).map((s) => s.id).sort(), ["S033", "S114"]);
  assert.ok(SCENARIOS.filter((s) => s.disruptive).every((s) => s.needs.includes("kill") || s.id === "S157"), "what kills a process says it needs to");
  for (const need of Object.keys(REMEDY)) assert.ok(typeof REMEDY[need] === "string" && REMEDY[need].length > 10);
});

test("every adb command in the remedies is a command a person can paste, with the package filled in", () => {
  for (const [k, text] of Object.entries(REMEDY)) {
    for (const m of text.matchAll(/adb -s \{ser\} shell (pm grant|appops set|settings put|dumpsys deviceidle|cmd notification) /g)) assert.ok(m[1], k);
    assert.ok(!/\{(?!ser\}|pkg\}|kpkg\})[a-z]+\}/.test(text), `${k} has an unknown placeholder`);
  }
});

test("the scenarios the owner asked for are all there", () => {
  const has = (code) => assert.ok(SCENARIOS.some((s) => s.codes.includes(code)), `a scenario for ${code}`);
  for (const code of ["R6", "S028", "S082", "S075", "S161", "R17", "R18", "S016", "R19", "S032", "S039", "S033", "S046", "S048", "S051", "S085", "S086", "S087", "S088", "S089", "S090", "S091", "S092", "S093", "S094",
    "S119", "S120", "S121", "S122", "S123", "S124", "S097", "S066", "S061", "S164", "R20", "S159", "S157", "S040", "S170", "S005", "S168", "S174", "S114"]) has(code);
});

test("--only picks by id, old code or category; --skip removes; --safe leaves out what kills a process; unknown tokens are reported", () => {
  const pick = (o) => selectScenarios(SCENARIOS, o);
  assert.deepEqual(pick({ only: "R19" }).chosen.map((s) => s.id), ["R19"]);
  assert.ok(pick({ only: "r19,s085" }).chosen.length === 2, "case does not matter");
  assert.ok(pick({ only: "approval" }).chosen.length >= 5);
  assert.ok(pick({ only: "S002" }).chosen.some((s) => s.id === "R17"), "an old number a scenario covers");
  assert.equal(pick({ only: "nothing" }).chosen.length, 0);
  assert.deepEqual(pick({ only: "nothing,R6" }).unknown, ["nothing"]);
  assert.ok(!pick({ skip: "phone" }).chosen.some((s) => s.category === "phone"));
  const safe = pick({ safe: true }).chosen;
  assert.ok(safe.length < SCENARIOS.length && safe.every((s) => !s.disruptive));
  assert.ok(pick({ safe: true, only: "S170" }).chosen.some((s) => s.id === "S170"), "naming a disruptive scenario runs it even with --safe");
  assert.equal(pick({}).chosen.length, SCENARIOS.length);
  const order = pick({}).chosen.map((s) => s.disruptive);
  assert.deepEqual(order, [...order].sort((a, b) => Number(a) - Number(b)), "the scenarios that kill a process run last");
  assert.ok(matchesToken(SCENARIOS[0], "all"));
  assert.match(describeCatalog(SCENARIOS), /MANUAL/);
});

// --- the runner, with stand-ins ---------------------------------------------------------------------------------------------

function fakeCtx({ calls = {}, scenario, perms, shots = [] } = {}) {
  const opts = { ...parseArgs([], {}), serial: "SER", timeoutScale: 0.001, shots: mkdtempSync(join(tmpdir(), "sc-shots-")) };
  const owner = { call: async (member, word) => { const f = calls[`${member}/${word}`]; return f ? f() : { ok: false, code: "not_found", message: "no stub" }; } };
  const adb = new Adb({ serial: "SER", run: async () => ({ code: 1, out: "", err: "" }) });
  adb.screencap = async (file) => { shots.push(file); return true; };
  const ctx = new Ctx({ adb, owner, opts, shared: { cleanup: [] } });
  ctx.scenario = scenario;
  return ctx;
}
const hubOk = { "service:admin/status": () => ({ ok: true, data: { paused: false } }) };
const phoneOk = { "service:devices/list": () => ({ ok: true, data: { devices: [{ device: "device:P", kind: "phone", online: true, tier: "ask" }] } }) };

test("runner: a returned text is PASS, a failed check is FAIL with a screenshot, a script error is FAIL not a crash", async () => {
  const shots = [];
  const pass = await runOne(fakeCtx({ calls: hubOk, shots }), { id: "T1", name: "n", needs: [], run: async () => "all good" });
  assert.deepEqual([pass.status, pass.detail], ["PASS", "all good"]);
  const bad = await runOne(fakeCtx({ calls: hubOk, shots }), { id: "T2", name: "n", needs: [], run: async () => check(false, "it broke") });
  assert.deepEqual([bad.status, bad.detail], ["FAIL", "it broke"]);
  assert.equal(shots.length, 1, "a FAIL leaves a screenshot");
  assert.match(shots[0], /T2-fail\.png$/);
  const boom = await runOne(fakeCtx({ calls: hubOk }), { id: "T3", name: "n", needs: [], run: async () => { throw new TypeError("x is not a function"); } });
  assert.equal(boom.status, "FAIL");
  assert.match(boom.detail, /script error: TypeError: x is not a function/);
});

test("runner: MANUAL keeps its screenshot, a deferred clean-up always runs, a slow scenario times out", async () => {
  const shots = [];
  let cleaned = 0;
  const m = await runOne(fakeCtx({ calls: hubOk, shots }), { id: "T4", name: "n", needs: [], run: async (ctx) => { ctx.defer(() => { cleaned++; }); throw new Outcome("MANUAL", "look at the island"); } });
  assert.deepEqual([m.status, m.detail, cleaned], ["MANUAL", "look at the island", 1]);
  assert.match(shots[0], /T4\.png$/, "named after the scenario");
  const failed = await runOne(fakeCtx({ calls: hubOk }), { id: "T5", name: "n", needs: [], run: async (ctx) => { ctx.defer(() => { cleaned++; throw new Error("restore failed"); }); check(false, "no"); } });
  assert.equal(failed.status, "FAIL");
  assert.match(failed.detail, /cleanup problem: restore failed/);
  const slow = await runOne(fakeCtx({ calls: hubOk }), { id: "T6", name: "n", needs: [], timeoutMs: 30, run: () => new Promise(() => {}) });
  assert.equal(slow.status, "FAIL");
  assert.match(slow.detail, /did not finish/);
});

test("runner: a missing permission is a SKIP that says what to switch on; granted ones run; no hub is a SKIP", async () => {
  const status = (items) => ({ "device:P/config.status": () => ({ ok: true, data: { items } }) });
  const calls = (items) => ({ ...hubOk, ...phoneOk, ...status(items) });
  const run = async () => "ran";
  const missing = await runOne(fakeCtx({ calls: calls([{ item: "calendar", state: "missing" }]) }), { id: "T7", name: "n", needs: ["phone", "calendar"], run });
  assert.equal(missing.status, "SKIP");
  assert.match(missing.detail, /"calendar" is not granted\. adb -s SER shell pm grant ai\.ash\.agent android\.permission\.READ_CALENDAR/);
  const granted = await runOne(fakeCtx({ calls: calls([{ item: "calendar", state: "granted" }]) }), { id: "T8", name: "n", needs: ["phone", "calendar"], run });
  assert.equal(granted.status, "PASS");
  const unsupported = await runOne(fakeCtx({ calls: calls([{ item: "shizuku", state: "unsupported", detail: "not installed" }]) }), { id: "T9", name: "n", needs: ["shizuku"], run });
  assert.match(unsupported.detail, /not supported on this phone \(not installed\)/);
  const offline = await runOne(fakeCtx({ calls: { "service:admin/status": () => ({ ok: false, code: "offline", message: "down" }) } }), { id: "T10", name: "n", needs: [], run });
  assert.equal(offline.status, "SKIP");
  const noPhone = await runOne(fakeCtx({ calls: { ...hubOk, "service:devices/list": () => ({ ok: true, data: { devices: [] } }) } }), { id: "T11", name: "n", needs: ["phone"], run });
  assert.match(noPhone.detail, /no phone is online/);
  const noKey = await runOne(fakeCtx({ calls: { ...hubOk, "service:vault/list": () => ({ ok: true, data: { entries: [{ ref: "DEEPSEEK_API_KEY", configured: false }] } }) } }), { id: "T12", name: "n", needs: ["llm"], run });
  assert.match(noKey.detail, /no model key.*set-key DEEPSEEK_API_KEY/);
  const key = await runOne(fakeCtx({ calls: { ...hubOk, "service:vault/list": () => ({ ok: true, data: { entries: [{ ref: "DEEPSEEK_API_KEY", configured: true }] } }) } }), { id: "T13", name: "n", needs: ["llm"], run });
  assert.equal(key.status, "PASS");
});

test("the ledger reader pages with next_before and returns oldest first; wait gives up at the deadline", async () => {
  const page = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: to - i }));
  let n = 0;
  const calls = { "service:history/query": () => { n++; return n === 1 ? { ok: true, data: { messages: page(201, 400), next_before: 201 } } : { ok: true, data: { messages: page(101, 150) } }; } };
  const ctx = fakeCtx({ calls });
  const all = await ctx.since(100);
  assert.equal(all.length, 250);
  assert.equal(all[0].seq, 101);
  assert.equal(all.at(-1).seq, 400);
  const nothing = await ctx.wait(0, () => null, { ms: 100, every: 10 });
  assert.equal(nothing, null);
  await assert.rejects(ctx.expect(0, () => null, "never", { ms: 50, every: 10 }), (e) => e instanceof Outcome && e.status === "FAIL" && /never/.test(e.detail));
});

test("the link is fetched with run-as, written private, and the port forwarded; a missing file says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-link-"));
  try {
    const seen = [];
    const run = async (_bin, args) => {
      seen.push(args.join(" "));
      if (args.includes("forward")) return { code: 0, out: "", err: "" };
      if (/cat files\/debug\/local-link\.json/.test(args.join(" "))) return { code: 0, out: '{"port":43001,"token":"tok-1","at":5}\r\n', err: "" };
      return { code: 1, out: "", err: "" };
    };
    const adb = new Adb({ serial: "SER", run });
    const owner = new OwnerCli({ ownerPath: "/nope/owner.mjs", linkFile: join(dir, "sub", "link.json"), stateDir: dir, adb, pkg: "ai.ash.agent" });
    const link = await owner.refreshLink();
    assert.equal(link.port, 43001);
    assert.ok(seen.some((a) => a === "-s SER shell run-as ai.ash.agent cat files/debug/local-link.json"));
    assert.ok(seen.some((a) => a === "-s SER forward tcp:43001 tcp:43001"));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "sub", "link.json"), "utf8")), { port: 43001, token: "tok-1", at: 5 });
    assert.equal(statSync(join(dir, "sub", "link.json")).mode & 0o777, 0o600, "the token file is private");
    const lacking = new OwnerCli({ ownerPath: "/nope", linkFile: join(dir, "x.json"), stateDir: dir, adb: new Adb({ serial: "SER", run: async () => ({ code: 1, out: "run-as: package not debuggable: ai.ash.agent", err: "" }) }), pkg: "ai.ash.agent" });
    await assert.rejects(lacking.refreshLink(), /cannot read ai\.ash\.agent:files\/debug\/local-link\.json.*debuggable/);
    assert.equal(existsSync(join(dir, "x.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("owner.mjs is retried once with a fresh link when it could not get in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-retry-"));
  try {
    let linkReads = 0;
    const adb = new Adb({ serial: "SER", run: async (_b, args) => (args.includes("forward") ? { code: 0, out: "", err: "" } : { code: 0, out: `{"port":43002,"token":"tok-${++linkReads}"}`, err: "" }) });
    // a stand-in owner.mjs: refuses the first token, answers for the second
    const fs = await import("node:fs");
    const stand = join(dir, "owner.mjs");
    fs.writeFileSync(stand, `import fs from "node:fs";
const i = process.argv.indexOf("--link-file");
const token = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8")).token;
if (token === "tok-1") { console.log(JSON.stringify({ kind: "error", message: "the hub refused this connection (4001 bad token)" })); process.exit(1); }
console.log(JSON.stringify({ kind: "result", to: "service:admin", word: "status", ok: true, data: { paused: false } }));`);
    const owner = new OwnerCli({ ownerPath: stand, linkFile: join(dir, "link.json"), stateDir: dir, adb, pkg: "ai.ash.agent" });
    await owner.refreshLink();
    const r = await owner.call("service:admin", "status");
    assert.deepEqual([r.ok, r.data.paused, linkReads], [true, false, 2], "one retry with a link read again");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
