#!/usr/bin/env node
// Real-phone scenario script (T13c). One file, no dependencies, Node 22 or newer; it runs on the machine that has adb.
//
//   node scenarios.mjs --serial <adb serial> --link-file link.json [--only R19,S085] [--shots ./shots]
//
// What it does: for each scenario it checks what the scenario needs (a permission, a paired hand, a model key; a missing
// one is a SKIP that says what to switch on), acts on the phone (words called as the owner through owner.mjs, the owner's
// "say", and adb: screencap, dumpsys, input) and judges by facts it can read: the ledger (which word was called, whether a
// card came, the result code), the foreground package, the notifications, the permission list the phone itself reports.
// It never judges wording. What only an eye can judge (the island, how a card is drawn, a tap on a notification) is
// MANUAL, with a screenshot named after the scenario in --shots.
//
// One line per scenario: `PASS|FAIL|SKIP|MANUAL <id> <name> -- <detail>`. Exit 0 when nothing FAILed.
// The pure judging functions are exported and tested without a device (scenarios.test.mjs).
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "0.1.0";
export const OWNER = "person:owner";
export const MAIN = "agent:main";
export const GATE = "service:gate";
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------------------------------
// Part 1. Judging: pure functions over recorded output (no device, no clock). Everything a scenario decides on is here.
// ---------------------------------------------------------------------------------------------------------------------

/** The lines `owner.mjs --json` printed, as objects (a line that is not JSON is dropped). */
export function parseOwnerLines(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { out.push(JSON.parse(t)); } catch { /* a stray line */ }
  }
  return out;
}

/** The result of `owner.mjs call`: `{ok, data, code, message, content}`, or null when no result line came. */
export function callResult(events) {
  const r = [...events].reverse().find((e) => e.kind === "result");
  if (!r) return null;
  return r.ok === false
    ? { ok: false, code: r.code ?? "failed", message: r.message ?? "", data: undefined }
    : { ok: true, data: r.data ?? r.raw?.result?.data ?? jsonOfContent(r.content ?? r.raw?.result?.content), content: r.content, code: undefined, message: "" };
}
/** A hand that answers in text only: the first text part, when it is a JSON object. */
export function jsonOfContent(content) {
  const t = Array.isArray(content) ? content.find((c) => c?.type === "text" && typeof c.text === "string")?.text : undefined;
  if (!t || !t.trim().startsWith("{")) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

/** The `sent` line of a `say`: `{seq, id, to}` or null. */
export const sentOf = (events) => { const s = events.find((e) => e.kind === "sent"); return s ? { seq: Number(s.seq), id: s.id, to: s.to } : null; };

/** The error line of a failed run, if any. */
export const errorOf = (events) => events.find((e) => e.kind === "error")?.message ?? null;

/** Did the run fail because it could not get in (stale token, hub down, port not forwarded)? Then a fresh link may help. */
export function looksDisconnected(code, events, stderr = "") {
  if (code === 0 || code === 2 || code === 3 || code === 64) return false;
  const text = `${errorOf(events) ?? ""} ${events.filter((e) => e.kind === "conn").map((e) => `${e.state} ${e.code} ${e.reason}`).join(" ")} ${stderr}`;
  return code === 1 || /4001|could not connect|ECONN|refused|closed/i.test(text);
}

/** The link file a debug build writes: `{port, token}` or null. */
export function parseLink(text) {
  try {
    const j = JSON.parse(String(text).trim());
    const port = Number(j.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof j.token !== "string" || !j.token.trim()) return null;
    return { port, token: j.token.trim(), at: typeof j.at === "number" ? j.at : undefined };
  } catch { return null; }
}

// --- the ledger ---------------------------------------------------------------------------------------------------------

export const textOf = (m) => (m && m.body && typeof m.body.text === "string" ? m.body.text : "");
export const isRequest = (m) => m.kind === "request";
export const isOwnerSay = (m) => m.from === OWNER && m.kind === "request" && m.word === "say";
/** Something an agent said or showed to the owner. */
export const toOwner = (m, word = "say", from) => m.kind === "request" && m.to === OWNER && m.word === word && (from === undefined || m.from === from);
export const agentSays = (ms, agent = MAIN) => ms.filter((m) => toOwner(m, "say", agent));

/** Turns from the `turn.started` / `turn.ended` events: id -> {agent, lane, ids, outcome?, startedSeq, endedSeq?}. */
export function turnsIn(ms) {
  const turns = new Map();
  for (const m of ms) {
    if (m.kind !== "event" || !/^agent:/.test(m.from)) continue;
    const b = m.body ?? {};
    if (m.word === "turn.started" && b.turn) turns.set(b.turn, { id: b.turn, agent: m.from, lane: b.lane, ids: Array.isArray(b.ids) ? b.ids : [], startedSeq: m.seq, outcome: undefined });
    if (m.word === "turn.ended" && b.turn) {
      const t = turns.get(b.turn) ?? { id: b.turn, agent: m.from, lane: b.lane, ids: [], startedSeq: undefined };
      turns.set(b.turn, { ...t, outcome: b.outcome, error: b.error, endedSeq: m.seq });
    }
  }
  return turns;
}
/** The turns that were given this message (by id). */
export const turnsGiven = (ms, messageId) => [...turnsIn(ms).values()].filter((t) => t.ids.includes(messageId));

/** The turns that were given any of these messages, and how many of the messages some turn was started with. */
export function supplementTurns(ms, ids) {
  const turns = [...turnsIn(ms).values()].filter((t) => ids.some((id) => t.ids.includes(id)));
  return { turns, read: ids.filter((id) => turns.some((t) => t.ids.includes(id))).length };
}

/** Requests matching `{from, to, word}` (any may be omitted; `word` may be a RegExp). */
export function requestsOf(ms, { from, to, word } = {}) {
  const wordOk = (w) => (word === undefined ? true : word instanceof RegExp ? word.test(w) : w === word);
  return ms.filter((m) => m.kind === "request" && (from === undefined || m.from === from) && (to === undefined || m.to === to) && wordOk(m.word));
}
export const responsesTo = (ms, requestId) => ms.filter((m) => m.kind === "response" && m.reply_to === requestId);
export const isWaiting = (r) => r?.body?.ok === true && r.body?.result?.data?.status === "waiting_owner";
export const succeeded = (r) => r?.body?.ok === true && !isWaiting(r);
export const errorCodeOf = (r) => (r?.body?.ok === false ? r.body?.error?.code : undefined);
/** Requests that got a real answer, not "waiting for the owner": the action ran. */
export const effects = (ms, spec) => requestsOf(ms, spec).filter((req) => responsesTo(ms, req.id).some(succeeded));
/** Requests that got an error answer. */
export const failures = (ms, spec) => requestsOf(ms, spec).filter((req) => responsesTo(ms, req.id).some((r) => r.body?.ok === false));

/** The approval cards: the gate asks the owner. `{id, seq, pending, options[], word, to, expires_at, ts, title}`. */
export function approvalCards(ms) {
  return ms.filter((m) => m.kind === "request" && m.from === GATE && m.to === OWNER && m.word === "ask").map((m) => {
    const b = m.body ?? {};
    return { id: m.id, seq: m.seq, ts: m.ts, pending: m.reply_to, options: (b.options ?? []).map((o) => o.id), word: b.source?.word, to: b.source?.to, expires_at: b.expires_at, title: b.title ?? "" };
  });
}
/** What the owner answered on a card (the `choice`), or null while open. */
export function answerOnCard(ms, cardId) {
  const r = ms.find((m) => m.kind === "response" && m.reply_to === cardId && m.from === OWNER);
  return r ? (r.body?.result?.data?.choice ?? null) : null;
}
/** The gate's background messages to the agent that asked (`tell` from service:gate). */
export const gateTells = (ms, agent = MAIN) => ms.filter((m) => m.kind === "request" && m.from === GATE && m.to === agent && m.word === "tell");
/** An option card an agent showed. `{id, seq, options[]}`. */
export function optionCards(ms, agent = MAIN) {
  return ms.filter((m) => toOwner(m, "show", agent) && m.body?.card?.type === "options")
    .map((m) => ({ id: m.id, seq: m.seq, prompt: m.body.card.prompt, options: (m.body.card.options ?? []).map((o) => o.id) }));
}
/** The failure card an agent shows after a failed turn: an option card whose option id starts with `retry` (it is `retry:<turn>`). */
export function retryCard(ms, agent = MAIN) {
  for (const c of optionCards(ms, agent)) { const retry = c.options.find((o) => /^retry/.test(o)); if (retry) return { ...c, retry }; }
  return null;
}
/** The owner's pick on an option card, as it lands in the ledger. */
export const pickOf = (ms, cardId) => ms.find((m) => isOwnerSay(m) && m.body?.in_reply_to === cardId) ?? null;

/**
 * What a sub-agent said to the owner, and in which lane the turn was. A sub-agent may speak to the owner only in a turn
 * where the owner addressed it, which is a front-lane turn. Returns the successful ones with `lane`.
 */
export function ownerSpeech(ms, agent) {
  const turns = turnsIn(ms);
  return ms.filter((m) => toOwner(m, "say", agent)).map((m) => ({
    id: m.id, seq: m.seq, text: textOf(m), turn: m.turn, lane: m.turn ? turns.get(m.turn)?.lane : undefined,
    delivered: responsesTo(ms, m.id).some((r) => r.body?.ok === true), refused: responsesTo(ms, m.id).find((r) => r.body?.ok === false)?.body?.error?.code,
  }));
}

/** The times an agent tried `human_say` in a turn, from the tool events (a refused call leaves no request): `[{turn, refused}]`. */
export function sayAttempts(ms, agent) {
  return ms.filter((m) => m.kind === "event" && m.from === agent && m.word === "agent.tool" && m.body?.name === "human_say" && m.body?.phase === "end")
    .map((m) => ({ turn: m.body.turn, refused: /forbidden/.test(String(m.body.summary ?? "")) }));
}

// --- Android output ----------------------------------------------------------------------------------------------------

/** The package in front, from `dumpsys window` (focus), falling back to the focused app. */
export function foregroundPackage(windowDump) {
  const text = String(windowDump ?? "");
  const focus = /mCurrentFocus=Window\{[0-9a-f]+ u\d+ ([^\s}/]+)(?:\/[^\s}]*)?\}/.exec(text);
  if (focus) return focus[1];
  const app = /mFocusedApp=(?:Token\{[^ ]+ )?ActivityRecord\{[0-9a-f]+ u\d+ ([^\s/]+)\//.exec(text);
  return app ? app[1] : null;
}

/** The package of the resumed activity, from `dumpsys activity activities` (the fallback when the window has no focus). */
export function resumedPackage(dump) {
  const m = /(?:mResumedActivity|topResumedActivity|ResumedActivity)[:=]\s*(?:ActivityRecord\{[0-9a-f]+ u\d+ )([^\s/]+)\//.exec(String(dump ?? ""));
  return m ? m[1] : null;
}

/** Notifications from `dumpsys notification --noredact`: `{pkg, id, tag, title, text, actions[]}`. */
export function parseNotifications(dump) {
  const out = [];
  const blocks = String(dump ?? "").split(/\n(?=\s*NotificationRecord\()/);
  for (const block of blocks) {
    const head = /NotificationRecord\([0-9a-fx]+: pkg=(\S+) user=\S+ id=(-?\d+) tag=(\S+)/.exec(block);
    if (!head) continue;
    const extra = (name) => new RegExp(`^\\s*android\\.${name}=\\w+ \\((.*)\\)\\s*$`, "m").exec(block)?.[1] ?? "";
    out.push({
      pkg: head[1], id: Number(head[2]), tag: head[3] === "null" ? null : head[3], title: extra("title"), text: extra("text") || extra("bigText"),
      actions: [...block.matchAll(/^\s*\[\d+\] "(.*)" ->/gm)].map((a) => a[1]),
    });
  }
  return out;
}

/** `ps -A -o PID,ARGS` lines whose arguments match: `[{pid, args}]`. */
export function parsePs(out, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
  const found = [];
  for (const line of String(out ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m && re.test(m[2])) found.push({ pid: Number(m[1]), args: m[2] });
  }
  return found;
}

/** Total PSS in KB from `dumpsys meminfo <pkg>` (both the old table and the `TOTAL PSS:` summary), or null. */
export function totalPssKb(dump) {
  const text = String(dump ?? "");
  const summary = /TOTAL PSS:\s*([\d,]+)/.exec(text);
  if (summary) return Number(summary[1].replace(/,/g, ""));
  const row = /^\s*TOTAL\s+(\d+)\s/m.exec(text);
  return row ? Number(row[1]) : null;
}

export const batteryLevel = (dump) => { const m = /^\s*level:\s*(\d+)/m.exec(String(dump ?? "")); return m ? Number(m[1]) : null; };
export const isAwake = (powerDump) => /mWakefulness=Awake/.test(String(powerDump ?? ""));
export const keyguardShowing = (windowDump) => /(?:isKeyguardShowing|mShowingLockscreen|mKeyguardShowing)=true/.test(String(windowDump ?? "")) || /mDreamingLockscreen=true/.test(String(windowDump ?? ""));

/** The `items` of `config.status` as a map: item -> {state, detail}. */
export function configItems(data) {
  const map = new Map();
  for (const it of data?.items ?? []) if (it?.item) map.set(it.item, { state: it.state, detail: it.detail });
  return map;
}

/** The model `[provider, model]` out of the `configure` read-back, whichever way DSH spells it. */
export function modelOf(config) {
  const v = config?.model ?? config?.config?.model;
  if (typeof v === "string" && v.startsWith("[")) { try { const p = JSON.parse(v); if (Array.isArray(p)) return [p[0], p[1]]; } catch { /* fallthrough */ } }
  if (Array.isArray(v)) return [v[0], v[1]];
  return typeof v === "string" ? [undefined, v] : null;
}

/** A body for a word, made from its input schema: required strings get the marker, numbers 1, booleans true. */
export function bodyFromSchema(schema, marker) {
  const body = {};
  for (const key of schema?.required ?? []) {
    const p = schema.properties?.[key] ?? {};
    body[key] = p.enum ? p.enum[0] : p.type === "integer" || p.type === "number" ? Math.max(1, p.minimum ?? 1) : p.type === "boolean" ? true : p.type === "array" ? [] : p.type === "object" ? {} : marker;
  }
  return body;
}

/** "HH:MM" of an instant in a time zone (the phone's, as its `admin/status` reports it). */
export function hhmmIn(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

/** A line of the report. */
export const reportLine = (status, id, name, detail) => `${status} ${id} ${name}${detail ? ` -- ${String(detail).replace(/\s+/g, " ").trim()}` : ""}`;

/** Does a scenario answer to one `--only` token? Matches its id, any old code it covers, or its category (case-insensitive). */
export const matchesToken = (s, token) => {
  const t = token.trim().toLowerCase();
  return t === "all" || s.id.toLowerCase() === t || s.codes.some((c) => c.toLowerCase() === t) || s.category.toLowerCase() === t;
};

// ---------------------------------------------------------------------------------------------------------------------
// Part 2. Running: adb, owner.mjs, outcomes, the context a scenario gets.
// ---------------------------------------------------------------------------------------------------------------------

/** How a scenario ends other than by returning a PASS text. */
export class Outcome extends Error {
  constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}
export const skip = (detail) => { throw new Outcome("SKIP", detail); };
export const fail = (detail) => { throw new Outcome("FAIL", detail); };
export const check = (cond, detail) => { if (!cond) throw new Outcome("FAIL", typeof detail === "function" ? detail() : detail); };
export const manual = (detail) => new Outcome("MANUAL", detail);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marker = (prefix = "ash-e2e") => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function run(cmd, args, { input, timeoutMs = 60_000, binary = false } = {}) {
  return new Promise((resolveP) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { resolveP({ code: 127, out: "", err: String(e.message) }); return; }
    const out = []; const err = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => { clearTimeout(timer); resolveP({ code: 127, out: "", err: String(e.message) }); });
    child.on("close", (code) => { clearTimeout(timer); const o = Buffer.concat(out); resolveP({ code: code ?? 124, out: binary ? o : o.toString("utf8"), err: Buffer.concat(err).toString("utf8") }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** adb for one device. */
export class Adb {
  constructor({ bin = "adb", serial, run: runner = run }) { this.bin = bin; this.serial = serial; this.runner = runner; }
  base() { return this.serial ? ["-s", this.serial] : []; }
  raw(args, o) { return this.runner(this.bin, [...this.base(), ...args], o); }
  /** `adb shell <command>`; the command is one string run by the phone's shell. */
  async shell(command, o) { const r = await this.raw(["shell", command], o); return { ...r, out: String(r.out).replace(/\r/g, "") }; }
  async runAs(pkg, command, o) { return this.shell(`run-as ${pkg} ${command}`, o); }
  async state() { return (await this.raw(["get-state"], { timeoutMs: 15_000 })).out.trim(); }
  async forward(port) { return this.raw(["forward", `tcp:${port}`, `tcp:${port}`], { timeoutMs: 15_000 }); }
  async screencap(file) {
    const r = await this.raw(["exec-out", "screencap", "-p"], { binary: true, timeoutMs: 30_000 });
    if (r.code !== 0 || !r.out.length) return false;
    writeFileSync(file, r.out);
    return true;
  }
  tap(x, y) { return this.shell(`input tap ${x} ${y}`); }
  key(code) { return this.shell(`input keyevent ${code}`); }
  async foreground() {
    const focus = foregroundPackage((await this.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'")).out);
    if (focus && !/^(NotificationShade|StatusBar|Keyguard)/.test(focus)) return focus;
    return resumedPackage((await this.shell("dumpsys activity activities | grep -E 'ResumedActivity'")).out) ?? focus;
  }
}

/** owner.mjs as a child process, with the link taken from the phone again whenever it has gone stale. */
export class OwnerCli {
  constructor({ node = process.execPath, ownerPath, linkFile, stateDir, adb, pkg, name = "scenarios", relink }) {
    Object.assign(this, { node, ownerPath, linkFile, stateDir, adb, pkg, name });
    this.relink = relink;
  }

  /**
   * Fetches `files/debug/local-link.json` from the debuggable app (`run-as`), writes it to the link file (mode 600) and
   * forwards the port. Call it at the start and again after the hub restarted: its token and port change.
   */
  async refreshLink() {
    const r = await this.adb.runAs(this.pkg, "cat files/debug/local-link.json");
    const link = parseLink(r.out);
    if (!link) throw new Error(`cannot read ${this.pkg}:files/debug/local-link.json (${r.err.trim() || r.out.trim().slice(0, 120) || "empty"}); is it a debuggable build and has the kernel attached?`);
    mkdirSync(dirname(resolve(this.linkFile)), { recursive: true });
    writeFileSync(this.linkFile, `${JSON.stringify(link)}\n`, { mode: 0o600 });
    try { chmodSync(this.linkFile, 0o600); } catch { /* best effort */ }
    const f = await this.adb.forward(link.port);
    if (f.code !== 0) throw new Error(`adb forward tcp:${link.port} failed: ${f.err.trim()}`);
    this.link = link;
    return link;
  }

  async exec(args, { timeoutS = 150, input } = {}, retried = false) {
    const argv = [this.ownerPath, "--link-file", this.linkFile, "--state", this.stateDir, "--name", this.name, "--json", ...args];
    const r = await run(this.node, argv, { input, timeoutMs: (timeoutS + 20) * 1000 });
    const events = parseOwnerLines(r.out);
    if (!retried && looksDisconnected(r.code, events, r.err)) {
      try { await this.refreshLink(); } catch (e) { return { code: r.code, events, err: `${r.err}\n${e.message}`, disconnected: true }; }
      return this.exec(args, { timeoutS, input }, true);
    }
    return { code: r.code, events, err: r.err, disconnected: looksDisconnected(r.code, events, r.err) };
  }

  /** Calls a word as the owner: `{ok, data, code, message}`; a hub that cannot be reached is `{ok:false, code:"offline"}`. */
  async call(member, word, body = {}, o = {}) {
    const r = await this.exec(["call", member, word, JSON.stringify(body)], o);
    const res = callResult(r.events);
    if (res) return res;
    return { ok: false, code: r.disconnected ? "offline" : "internal", message: errorOf(r.events) ?? (r.err.trim() || `owner.mjs exited ${r.code}`), data: undefined };
  }

  /** Sends text to an agent and waits for its reply (see owner.mjs say). `{sent, replies[], code}`. */
  async say(text, { to, timeoutS = 120, settleS = 1.5 } = {}) {
    const r = await this.exec(["say", text, "--timeout", String(timeoutS), "--settle", String(settleS), ...(to ? ["--to", to] : [])], { timeoutS });
    return { code: r.code, sent: sentOf(r.events), replies: r.events.filter((e) => ["msg", "card", "ask"].includes(e.kind)).map((e) => e.raw ?? e), events: r.events, disconnected: r.disconnected };
  }

  /** Sends text and returns at once (the answer is read from the ledger). */
  async send(text, { to } = {}) {
    const r = await this.exec(["say", text, "--timeout", "0.3", "--settle", "0", ...(to ? ["--to", to] : [])], { timeoutS: 30 });
    return { sent: sentOf(r.events), code: r.code, error: errorOf(r.events) };
  }

  /** Answers a card (approval, question or option card). */
  async answer(cardRef, option, text) {
    const r = await this.exec(["answer", String(cardRef), option, ...(text ? [text] : [])], { timeoutS: 40 });
    return { ok: r.code === 0, code: r.code, events: r.events, message: errorOf(r.events) ?? r.err.trim() };
  }

  /** Saves a secret in the vault through owner.mjs set-key (the value goes through a private file, never an argument). */
  async setKey(ref, value) {
    const dir = mkdtempSync(join(tmpdir(), "ash-e2e-key-"));
    const file = join(dir, "key");
    writeFileSync(file, value, { mode: 0o600 });
    try { const r = await this.exec(["set-key", ref, "--key-file", file], { timeoutS: 40 }); return { ok: r.code === 0, message: errorOf(r.events) ?? r.err.trim() }; } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

/** What to do when something a scenario needs is missing. `{pkg}` and `{ser}` are filled in. */
export const REMEDY = {
  phone: "pair the phone: open the Ash app and wait for 'connected' (kernel attached, device channel up)",
  llm: "put a model key in the vault: owner.mjs set-key DEEPSEEK_API_KEY < key.txt",
  calendar: "adb -s {ser} shell pm grant {pkg} android.permission.READ_CALENDAR; adb -s {ser} shell pm grant {pkg} android.permission.WRITE_CALENDAR",
  location: "adb -s {ser} shell pm grant {pkg} android.permission.ACCESS_FINE_LOCATION; adb -s {ser} shell pm grant {pkg} android.permission.ACCESS_COARSE_LOCATION (an emulator needs a fix: adb -s {ser} emu geo fix 121.47 31.23)",
  location_background: "adb -s {ser} shell pm grant {pkg} android.permission.ACCESS_BACKGROUND_LOCATION",
  activity_recognition: "adb -s {ser} shell pm grant {pkg} android.permission.ACTIVITY_RECOGNITION",
  photos: "adb -s {ser} shell pm grant {pkg} android.permission.READ_MEDIA_IMAGES (Android 13+) or android.permission.READ_EXTERNAL_STORAGE; adb -s {ser} shell pm grant {pkg} android.permission.ACCESS_MEDIA_LOCATION",
  all_files: "adb -s {ser} shell appops set {pkg} MANAGE_EXTERNAL_STORAGE allow",
  notifications: "adb -s {ser} shell pm grant {pkg} android.permission.POST_NOTIFICATIONS",
  notification_listener: "adb -s {ser} shell cmd notification allow_listener {pkg}/ai.ash.caps.senses.NotificationSense",
  accessibility: "adb -s {ser} shell settings put secure enabled_accessibility_services {pkg}/ai.ash.caps.screen.A11yService; adb -s {ser} shell settings put secure accessibility_enabled 1",
  usage_access: "adb -s {ser} shell appops set {pkg} GET_USAGE_STATS allow",
  overlay: "adb -s {ser} shell appops set {pkg} SYSTEM_ALERT_WINDOW allow",
  write_settings: "adb -s {ser} shell appops set {pkg} WRITE_SETTINGS allow",
  exact_alarm: "adb -s {ser} shell appops set {pkg} SCHEDULE_EXACT_ALARM allow",
  battery_optimization: "adb -s {ser} shell dumpsys deviceidle whitelist +{pkg}",
  kernel_battery_optimization: "adb -s {ser} shell dumpsys deviceidle whitelist +{kpkg}",
  shizuku: "start Shizuku (adb -s {ser} shell sh /sdcard/Android/data/moe.shizuku.privileged.api/start.sh) and authorize Ash in the Shizuku app",
  "notification-sense": "turn on 通知读取 in the Ash app (the opt-in is a switch in the app, not a system permission) and grant the listener: adb -s {ser} shell cmd notification allow_listener {pkg}/ai.ash.caps.senses.NotificationSense",
  kill: "the hub process can be killed from adb only on a debuggable kernel build where SELinux allows run-as to signal it (emulators), or with root (su) on the phone",
  "network": "give the phone internet access",
};

// ---------------------------------------------------------------------------------------------------------------------
// Part 3. The context a scenario gets: ledger reading, waiting, the phone, the hub process, screenshots, clean-up.
// ---------------------------------------------------------------------------------------------------------------------

const fill = (text, ctx) => text.replaceAll("{ser}", ctx.opts.serial || "<serial>").replaceAll("{pkg}", ctx.pkg).replaceAll("{kpkg}", ctx.kpkg);

export class Ctx {
  constructor({ adb, owner, opts, shared }) {
    this.adb = adb; this.owner = owner; this.opts = opts; this.shared = shared;
    this.deferred = []; this.notes = []; this.scenario = null; this.shots = [];
  }
  get pkg() { return this.opts.pkg; }
  get kpkg() { return this.opts.kpkg; }
  sleep(ms) { return sleep(ms); }
  scale(ms) { return Math.round(ms * this.opts.timeoutScale); }
  /** A pause to let something that should NOT happen have its chance to (scaled by --timeout-scale). */
  settle(ms) { return sleep(this.scale(ms)); }
  marker(prefix) { return marker(prefix); }
  note(text) { this.notes.push(text); }
  defer(fn) { this.deferred.push(fn); }
  async cleanup() {
    const errs = [];
    for (const fn of this.deferred.splice(0).reverse()) { try { await fn(); } catch (e) { errs.push(e.message); } }
    return errs;
  }

  // --- words
  call(member, word, body, o) { return this.owner.call(member, word, body, o); }
  /** Calls a word and returns its data; a refusal fails the scenario. */
  async must(member, word, body, o) {
    const r = await this.call(member, word, body, o);
    if (!r.ok) fail(`${member}/${word} -> ${r.code}: ${String(r.message).slice(0, 200)}`);
    return r.data ?? {};
  }

  // --- the ledger
  async head() {
    const r = await this.call("service:history", "query", { limit: 1 });
    if (!r.ok) fail(`cannot read the ledger (${r.code}: ${r.message}); is the hub up and the link fresh?`);
    return r.data?.messages?.[0]?.seq ?? 0;
  }
  /** Everything recorded after `seq`, oldest first. */
  async since(seq) {
    const all = [];
    let before;
    for (let i = 0; i < 60; i++) {
      const r = await this.call("service:history", "query", { after: seq, limit: 200, ...(before ? { before } : {}) });
      if (!r.ok) fail(`cannot read the ledger (${r.code}: ${r.message})`);
      const ms = r.data?.messages ?? [];
      all.push(...ms);
      if (ms.length < 200 || !r.data?.next_before) break;
      before = r.data.next_before;
    }
    return all.sort((a, b) => a.seq - b.seq);
  }
  /** Polls the ledger after `base` until `pred(messages)` is truthy: `{value, ms, waited}`, or null at the deadline. */
  async wait(base, pred, { ms = 120_000, every = 3000 } = {}) {
    const limit = this.scale(ms), t0 = Date.now();
    every = Math.max(150, Math.min(every, this.scale(every)));
    for (;;) {
      const messages = await this.since(base);
      this.lastLedger = messages;
      const value = pred(messages);
      if (value) return { value, ms: messages, waited: Date.now() - t0 };
      if (Date.now() - t0 + every > limit) return null;
      await sleep(every);
    }
  }
  async expect(base, pred, what, o) {
    const r = await this.wait(base, pred, o);
    if (!r) fail(`${what} (waited ${Math.round(this.scale(o?.ms ?? 120_000) / 1000)} s)`);
    return r;
  }
  /** Sends text to an agent without waiting. Returns the message id and its seq. */
  async send(text, o) {
    const r = await this.owner.send(text, o);
    if (!r.sent) fail(`the hub did not take the message (${r.error ?? `exit ${r.code}`})`);
    return r.sent;
  }
  /** Waits for the turn that was given this message to end. */
  async turnOf(base, messageId, o = {}) {
    const r = await this.wait(base, (ms) => turnsGiven(ms, messageId).find((t) => t.outcome), o);
    return r?.value ?? null;
  }
  async startedTurnOf(base, messageId, o = {}) {
    const r = await this.wait(base, (ms) => turnsGiven(ms, messageId)[0], { every: 1500, ...o });
    return r?.value ?? null;
  }

  // --- the phone and the hub
  async phone() {
    if (this._phone && Date.now() - this._phone.at < 20_000) return this._phone.d.device;
    const r = await this.call("service:devices", "list");
    const d = r.ok ? (r.data?.devices ?? []).find((x) => x.kind === "phone" && x.online && !x.revoked_at) : null;
    if (!d) skip(`no phone is online as a hand (${r.ok ? "devices/list has none" : `${r.code}: ${r.message}`}). ${fill(REMEDY.phone, this)}`);
    this._phone = { d, at: Date.now() };
    return d.device;
  }
  phoneInfo() { return this._phone?.d; }
  /** `device:<id>` word call as the owner. */
  async dev(word, body, o) { return this.call(await this.phone(), word, body, o); }
  async devMust(word, body, o) { return this.must(await this.phone(), word, body, o); }
  async configStatus() { return configItems((await this.dev("config.status", {})).data); }
  async status() { const r = await this.call("service:admin", "status"); return r.ok ? r.data : null; }
  /** The phone's clock (this machine's may differ): every time a scenario hands to the phone comes from here. */
  async hubNow() { const st = await this.status(); return { now: st?.now ?? Date.now(), timeZone: st?.time_zone ?? "UTC" }; }

  /** The hub process ids on the phone. */
  async hubPids() { return parsePs((await this.adb.shell("ps -A -o PID,ARGS")).out, /ash-core\.mjs/).map((p) => p.pid); }
  async dshPids() { return parsePs((await this.adb.shell("ps -A -o PID,ARGS")).out, /--profile[ =]acp/).map((p) => p.pid); }
  /** SIGKILL for these pids, as the kernel app (run-as, debuggable build) or, failing that, as the shell. Returns the pids that are gone. */
  async kill(pids) {
    for (const pid of pids) {
      // run-as works on a debuggable build where SELinux lets it (emulators); Android 12 phones deny runas_app a SIGKILL
      // to the app's own processes, so a rooted test phone falls back to su, then to the plain shell.
      const viaApp = await this.adb.shell(`run-as ${this.kpkg} kill -9 ${pid}`);
      if (viaApp.code === 0 && !/not permitted|not debuggable|unknown package|unknown pid/i.test(viaApp.out + viaApp.err)) continue;
      const viaSu = await this.adb.shell(`su -c 'kill -9 ${pid}'`);
      if (viaSu.code !== 0) await this.adb.shell(`kill -9 ${pid}`);
    }
    await sleep(1500);
    const alive = new Set([...(await this.hubPids()), ...(await this.dshPids())]);
    return pids.filter((p) => !alive.has(p));
  }
  async killHub() {
    const before = await this.hubPids();
    if (!before.length) skip(`cannot find the hub process (ps shows no ash-core.mjs). ${fill(REMEDY.kill, this)}`);
    const gone = await this.kill(before);
    if (!gone.length) skip(`could not kill the hub (pid ${before.join(",")}). ${fill(REMEDY.kill, this)}`);
    return before;
  }
  /** Waits until the hub answers again (a fresh link is fetched each try). Returns its status. */
  async hubBack({ ms = 240_000 } = {}) {
    const t0 = Date.now();
    await sleep(2000);
    for (;;) {
      try { await this.owner.refreshLink(); } catch { /* the app has not written it yet */ }
      const s = await this.status();
      if (s) return s;
      if (Date.now() - t0 > this.scale(ms)) fail(`the hub did not come back within ${Math.round(this.scale(ms) / 1000)} s`);
      await sleep(4000);
    }
  }

  // --- needs
  /** Checks one thing a scenario needs; a missing one is a SKIP that says how to get it. */
  async need(item) {
    const hint = (k) => fill(REMEDY[k] ?? k, this);
    if (item === "phone") { await this.phone(); return; }
    if (item === "llm") {
      const r = await this.call("service:vault", "list");
      const ok = r.ok && (r.data?.entries ?? []).some((e) => e.configured && /API_KEY$/.test(e.ref));
      if (!ok) skip(`no model key in the vault. ${hint("llm")}`);
      return;
    }
    if (item === "kill") {
      if (!(await this.hubPids()).length) skip(`cannot see the hub process from adb. ${hint("kill")}`);
      return;
    }
    if (item === "network") {
      const r = await this.adb.shell("ping -c 1 -W 4 1.1.1.1");
      if (r.code !== 0) skip(`the phone has no internet (ping failed). ${hint("network")}`);
      return;
    }
    if (item === "notification-sense") {
      await this.need("notification_listener");
      const prefs = await this.adb.runAs(this.pkg, "cat shared_prefs/sense_notification.xml");
      if (!/name="enabled" value="true"/.test(prefs.out)) skip(`the 通知读取 opt-in is off. ${hint("notification-sense")}`);
      return;
    }
    const items = await this.configStatus();
    const it = items.get(item);
    if (!it) skip(`the phone's config.status does not list "${item}" (an older app?)`);
    if (it.state === "unsupported") skip(`"${item}" is not supported on this phone${it.detail ? ` (${it.detail})` : ""}`);
    if (it.state !== "granted") skip(`"${item}" is not granted. ${hint(item)}`);
  }

  // --- the screen
  async wake() {
    await this.adb.key("KEYCODE_WAKEUP");
    await this.adb.shell("wm dismiss-keyguard");
    await sleep(800);
  }
  async home() { await this.adb.key("KEYCODE_HOME"); await sleep(1200); }
  async launchAsh() { await this.adb.shell(`monkey -p ${this.pkg} -c android.intent.category.LAUNCHER 1`); await sleep(2500); }
  async foreground() { return this.adb.foreground(); }
  async waitForeground(pred, ms = 12_000) {
    const t0 = Date.now();
    for (;;) {
      const pkg = await this.foreground();
      if (pkg && pred(pkg)) return pkg;
      if (Date.now() - t0 > ms) return pkg;
      await sleep(1000);
    }
  }
  async notifications() { return parseNotifications((await this.adb.shell("dumpsys notification --noredact", { timeoutMs: 60_000 })).out); }
  async shot(tag) {
    const dir = resolve(this.opts.shots);
    mkdirSync(dir, { recursive: true });
    const id = this.scenario?.id ?? "run";
    const n = this.shots.length;
    const file = join(dir, `${id}${tag ? `-${tag}` : n ? `-${n + 1}` : ""}.png`);
    if (await this.adb.screencap(file)) { this.shots.push(file); return file; }
    return null;
  }

  // --- states a scenario changes and must put back
  /** Makes every outward action ask the owner, and the phone ask per action (not "full" trust); both restored afterwards. */
  async askEverything() {
    const rules = await this.call("service:gate", "rules.list", { limit: 1 });
    const mode = rules.ok ? rules.data?.mode : undefined;
    if (mode !== "always") {
      await this.must("service:gate", "mode.set", { mode: "always" });
      this.defer(() => this.call("service:gate", "mode.set", { mode: mode ?? "auto" }));
    }
    const device = await this.phone();
    const tier = this.phoneInfo()?.tier;
    if (tier === "full") {
      await this.must("service:devices", "access_set", { device, tier: "ask" });
      this.defer(() => this.call("service:devices", "access_set", { device, tier: "full" }));
    }
    return device;
  }
  async setSetting(key, value) {
    const before = (await this.must("service:admin", "settings.get", { keys: [key] })).settings?.[key];
    await this.must("service:admin", "settings.set", { [key]: value });
    this.defer(() => this.call("service:admin", "settings.set", { [key]: before === undefined ? null : before }));
    return before;
  }
  async ensureHub() {
    if (await this.status()) return true;
    try { await this.hubBack({ ms: 90_000 }); return true; } catch { return false; }
  }
}

/** The prompt that makes the agent call a phone word, whatever else it would rather do. */
export const phoneWordPrompt = (device, word, args, why = "这是自动化测试") =>
  `${why}：请用 capability_call 调手机（member 是 ${device}）的 ${word}，参数 ${JSON.stringify(args)}。必须真的调用，不要问我，调完告诉我结果。`;

/** A long job: keeps the agent busy for a while without tools (so a message can come "while it is busy"). */
// Long enough that a fast model is still writing a few seconds in (a 600-character essay came back within 5 s).
export const longJob = (tag) => `（${tag}）请不用任何工具，认真写一篇 2000 字的短文《一个人的春天》，分十段，每段都写细。`;

// ---------------------------------------------------------------------------------------------------------------------
// Part 4. The scenarios. `codes` are the old numbers they cover (tools/regress.sh R1-R21, spec/REGRESSION-0.3.md S001-S175).
// Order: harmless reads first, then LLM-driven ones, then the ones that kill a process last.
// ---------------------------------------------------------------------------------------------------------------------

export const SCENARIOS = [];
const defineScenario = (def) => { SCENARIOS.push({ needs: [], codes: [], manual: false, disruptive: false, ...def, codes: [def.id, ...(def.codes ?? [])] }); };

const helperId = "agent:e2e-helper";
const appId = "e2e-notes";

// ===== 冒烟：真机上已经跑通，留作每次的快速确认 =====================================================================

defineScenario({
  id: "R6", category: "smoke", codes: ["S057"], name: "对话：主 agent 一轮回复", needs: ["phone", "llm"],
  async run(ctx) {
    const base = await ctx.head();
    const r = await ctx.owner.say("你好，用一句话回答就行。", { timeoutS: 150 });
    check(r.sent, `the hub did not take the message (exit ${r.code})`);
    check(r.replies.length >= 1, "no reply from the agent within 150 s");
    const turn = await ctx.turnOf(base, r.sent.id, { ms: 90_000 });
    check(turn, "the message was never given to a turn");
    check(turn.outcome === "completed", `the turn ended ${turn.outcome}${turn.error ? ` (${turn.error})` : ""}`);
    return `${r.replies.length} bubble(s), turn ${turn.id} completed`;
  },
});

defineScenario({
  id: "S028", category: "smoke", codes: [], name: "首次见面：账本最前面是 agent 先开口", needs: [],
  async run(ctx) {
    const r = await ctx.must("service:history", "read", { from_seq: 1, to_seq: 200 });
    const ms = r.messages ?? [];
    check(ms.length, "the ledger is empty");
    const firstOwner = ms.findIndex(isOwnerSay);
    const firstAgent = ms.findIndex((m) => toOwner(m, "say") || toOwner(m, "show"));
    if (firstAgent < 0 || (firstOwner >= 0 && firstOwner < firstAgent)) skip("this install's history starts with the owner talking; the first meeting is only visible on a fresh install (reinstall, then run S028)");
    return `the agent spoke first (seq ${ms[firstAgent].seq}) before the owner's first words`;
  },
});

defineScenario({
  id: "S082", category: "smoke", codes: [], name: "提醒（前台）：到点消息落进对话", needs: ["phone"],
  async run(ctx) {
    await ctx.wake(); await ctx.launchAsh();
    const m = ctx.marker("remind"), base = await ctx.head(), { now } = await ctx.hubNow();
    const set = await ctx.must("service:clock", "set", { at: now + Math.max(2000, ctx.scale(15_000)), to: OWNER, word: "say", body: { text: `提醒 ${m}`, kind: "due" }, label: `e2e ${m}` });
    ctx.defer(() => ctx.call("service:clock", "cancel", { id: set.id }));
    const got = await ctx.expect(base, (ms) => ms.find((x) => toOwner(x, "say") && textOf(x).includes(m)), "the reminder never arrived in the conversation", { ms: 70_000, every: 2500 });
    const fg = await ctx.foreground();
    return `arrived ${Math.round(got.waited / 1000)} s after the timer was set (foreground: ${fg ?? "?"})`;
  },
});

defineScenario({
  id: "S075", category: "smoke", codes: ["设备23"], name: "提醒（后台）：回到桌面后到点出系统通知", needs: ["phone", "notifications"],
  async run(ctx) {
    await ctx.wake(); await ctx.home();
    const m = ctx.marker("bgremind"), base = await ctx.head(), { now } = await ctx.hubNow();
    const set = await ctx.must("service:clock", "set", { at: now + Math.max(2000, ctx.scale(15_000)), to: OWNER, word: "say", body: { text: `后台提醒 ${m}`, kind: "due" }, label: `e2e ${m}` });
    ctx.defer(() => ctx.call("service:clock", "cancel", { id: set.id }));
    await ctx.expect(base, (ms) => ms.find((x) => toOwner(x, "say") && textOf(x).includes(m)), "the reminder never reached the ledger", { ms: 70_000 });
    let seen = null;
    for (let i = 0; i < 8 && !seen; i++) { seen = (await ctx.notifications()).find((n) => n.pkg === ctx.pkg && `${n.title} ${n.text}`.includes(m)); if (!seen) await sleep(2500); }
    await ctx.adb.shell("cmd statusbar expand-notifications"); await sleep(1200);
    await ctx.shot("shade");
    await ctx.adb.shell("cmd statusbar collapse");
    check(seen, "the reminder reached the ledger but no notification of the app carries it (notifications off, or the channel muted?)");
    return `notification posted (id ${seen.id}${seen.tag ? `, tag ${seen.tag}` : ""}); shade screenshot saved`;
  },
});

defineScenario({
  id: "S161", category: "smoke", codes: [], name: "用量：一轮之后今日调用数增加", needs: ["llm"],
  async run(ctx) {
    const before = (await ctx.must("service:cost", "usage.get", { days: 1 })).periods?.today?.calls ?? 0;
    const r = await ctx.owner.say("只回复两个字：收到", { timeoutS: 150 });
    check(r.replies.length >= 1, "the agent did not answer");
    let after = before;
    for (let i = 0; i < 20 && after <= before; i++) { await sleep(ctx.scale(6000)); after = (await ctx.must("service:cost", "usage.get", { days: 1 })).periods?.today?.calls ?? 0; }
    check(after > before, `today's model calls stayed at ${before} after a turn (the usage plug-in reports late or not at all; waited up to 2 min)`);
    return `today's calls ${before} -> ${after}`;
  },
});

defineScenario({
  id: "S174", category: "smoke", codes: [], name: "内存压测：连续多轮后中枢没有重启、内存有界", needs: ["llm", "phone"],
  async run(ctx) {
    const rounds = ctx.opts.stressRounds;
    const st0 = await ctx.status();
    const pss = async () => totalPssKb((await ctx.adb.shell(`dumpsys meminfo ${ctx.kpkg}`, { timeoutMs: 40_000 })).out);
    const before = await pss();
    for (let i = 1; i <= rounds; i++) {
      const r = await ctx.owner.say(`第 ${i} 轮，只回复一个字：好`, { timeoutS: 150, settleS: 1 });
      check(r.replies.length >= 1, `round ${i} got no answer`);
    }
    const st1 = await ctx.status();
    check(st1, "the hub does not answer after the rounds");
    check(st1.uptime_ms === undefined || st0?.uptime_ms === undefined || st1.uptime_ms >= st0.uptime_ms, `the hub restarted during the rounds (uptime ${st0.uptime_ms} -> ${st1.uptime_ms})`);
    const after = await pss();
    const mb = (kb) => (kb === null ? "?" : `${Math.round(kb / 1024)} MB`);
    check(after === null || after / 1024 <= ctx.opts.memLimitMb, `kernel app PSS ${mb(after)} is over the ${ctx.opts.memLimitMb} MB limit`);
    return `${rounds} rounds answered; hub not restarted; kernel app PSS ${mb(before)} -> ${mb(after)}`;
  },
});

// ===== 对话 ========================================================================================================

defineScenario({
  id: "R17", category: "conversation", codes: ["S002", "S003"], name: "连发：忙时连发三条，不会每条各开一轮", needs: ["llm"],
  async run(ctx) {
    const base = await ctx.head();
    const a = await ctx.send(longJob("R17"));
    check(await ctx.startedTurnOf(base, a.id, { ms: 60_000 }), "the first message never started a turn");
    const ids = [];
    for (const t of ["补充一：标题请用楷体风格的描述。", "补充二：结尾加一句祝福。", "补充三：全文不要出现“春天”两个字以外的比喻。"]) { ids.push((await ctx.send(t)).id); }
    const last = ids[ids.length - 1];
    const sofar = await ctx.since(base);
    const lastSeq = sofar.find((m) => m.id === last)?.seq ?? Infinity;
    if (turnsGiven(sofar, a.id).some((t) => t.endedSeq !== undefined && t.endedSeq < lastSeq)) skip("the first turn ended before the last supplement was sent (the model was too fast to prove 'busy')");
    const done = await ctx.expect(base, (ms) => {
      const turns = [...turnsIn(ms).values()];
      const settled = turns.length && turns.every((t) => t.outcome);
      const lastSeq = ms.find((m) => m.id === last)?.seq ?? 0;
      return settled && agentSays(ms).some((m) => m.seq > lastSeq) ? turns : null;
    }, "the agent did not settle with an answer after the supplements", { ms: 300_000, every: 4000 });
    const { turns, read } = supplementTurns(ctx.lastLedger, ids);
    check(turns.length <= 2, `the ${ids.length} supplements opened ${turns.length} separate turns`);
    return `${ids.length} supplements while busy -> ${turns.length} follow-up turn(s) read ${read}/${ids.length} (the rest steered into the running turn); answered after the last one`;
  },
});

defineScenario({
  id: "R18", category: "conversation", codes: ["S004"], name: "插话停：说「停下」，在途的一轮被取消", needs: ["llm"],
  async run(ctx) {
    // "Stop" has to arrive while the turn still runs; when the model was faster, ask again.
    let base, turn, stop, ended, t0;
    for (let attempt = 1; ; attempt++) {
      base = await ctx.head();
      const a = await ctx.send(longJob(`R18-${attempt}`));
      turn = await ctx.startedTurnOf(base, a.id, { ms: 60_000, every: 300 });
      check(turn, "the first message never started a turn");
      await sleep(800);
      const before = (await ctx.since(base));
      if (turnsIn(before).get(turn.id)?.outcome) { if (attempt >= 3) fail("the turn kept finishing before 'stop' could be sent"); continue; }
      t0 = Date.now();
      stop = await ctx.send("停下，别写了");
      ended = await ctx.expect(base, (ms) => { const t = turnsIn(ms).get(turn.id); return t?.outcome ? t : null; }, "the running turn did not end after 'stop'", { ms: 40_000, every: 1500 });
      if (ended.value.outcome !== "completed" || attempt >= 3) break;
      const stopSeq = ctx.lastLedger.find((m) => m.id === stop.id)?.seq ?? stop.seq;
      if (!(ended.value.endedSeq < stopSeq)) break;   // it completed after the stop arrived: a real failure, checked below
    }
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    check(["cancelled", "interrupted"].includes(ended.value.outcome), `the turn ended '${ended.value.outcome}', not cancelled/interrupted`);
    const next = await ctx.turnOf(base, stop.id, { ms: 120_000 });
    check(next, "the 'stop' message was never given to a following turn");
    return `turn ${ended.value.outcome} ${secs} s after the stop; the stop message went to turn ${next.id} (${next.outcome})`;
  },
});

defineScenario({
  id: "S016", category: "conversation", codes: [], name: "选项卡：出卡、点选、下一轮收到", needs: ["llm"],
  async run(ctx) {
    const base = await ctx.head();
    await ctx.send("请用选项卡（human_show，card.type=options，选项 id 分别是 a 和 b）让我在“方案A”和“方案B”里选一个，不要用文字问。");
    const got = await ctx.expect(base, (ms) => optionCards(ms)[0], "no option card came", { ms: 150_000 });
    const card = got.value;
    check(card.options.includes("b"), `the card has options ${card.options.join(",")}, not b`);
    const ans = await ctx.owner.answer(card.id, "b");
    check(ans.ok, `the pick was refused: ${ans.message}`);
    const pick = (await ctx.expect(base, (ms) => pickOf(ms, card.id), "the pick is not in the ledger")).value;
    check(pick.body?.option_id === "b", "the pick in the ledger is not option b");
    const turn = await ctx.turnOf(base, pick.id, { ms: 150_000 });
    check(turn?.outcome === "completed", "the pick did not run a turn to completion");
    return `card ${card.id} (${card.options.join("/")}); pick b reached turn ${turn.id}`;
  },
});

// ===== 审批 ========================================================================================================

/** Starts an approval: the agent is told to set the clipboard; resolves with the card. */
async function clipboardCard(ctx, base, text, extra = "") {
  const device = await ctx.askEverything();
  const first = await ctx.send(phoneWordPrompt(device, "clipboard.set", { text }) + extra);
  const got = await ctx.expect(base, (ms) => approvalCards(ms).find((c) => c.word === "clipboard.set"), "no approval card for clipboard.set came", { ms: 180_000 });
  return { device, card: got.value, first };
}
const clipboardEffects = (ms, device) => effects(ms, { from: MAIN, to: device, word: "clipboard.set" });

defineScenario({
  id: "R19", category: "approval", codes: [], name: "审批：出卡、批一次、只执行一次", needs: ["phone", "llm"],
  async run(ctx) {
    await ctx.wake(); await ctx.launchAsh();
    const base = await ctx.head(), m = ctx.marker("clip");
    const { device, card } = await clipboardCard(ctx, base, m);
    await ctx.shot("card");
    check(card.options.includes("once") && card.options.includes("deny"), `card options are ${card.options.join(",")}`);
    check(clipboardEffects(await ctx.since(base), device).length === 0, "the action ran before the owner answered");
    const ans = await ctx.owner.answer(card.id, "once");
    check(ans.ok, `the answer was refused: ${ans.message}`);
    await ctx.expect(base, (ms) => clipboardEffects(ms, device).length >= 1, "the approved action never ran (the asker did not redeem it)", { ms: 180_000 });
    await ctx.settle(8000);
    const ms = await ctx.since(base);
    check(clipboardEffects(ms, device).length === 1, `the action ran ${clipboardEffects(ms, device).length} times`);
    check(gateTells(ms).length >= 1, "the asker was not told the answer");
    return `card ${card.id} -> once -> clipboard.set ran once on ${device}`;
  },
});

defineScenario({
  id: "S032", category: "approval", codes: [], name: "审批：拒绝后不执行，发起者被告知", needs: ["phone", "llm"],
  async run(ctx) {
    const base = await ctx.head();
    const { device, card } = await clipboardCard(ctx, base, ctx.marker("deny"));
    const ans = await ctx.owner.answer(card.id, "deny");
    check(ans.ok, `the answer was refused: ${ans.message}`);
    await ctx.expect(base, (ms) => gateTells(ms).length >= 1, "the asker was not told about the refusal", { ms: 60_000 });
    await ctx.settle(15_000);
    const ms = await ctx.since(base);
    check(clipboardEffects(ms, device).length === 0, "the refused action ran anyway");
    const codes = failures(ms, { from: MAIN, to: device, word: "clipboard.set" }).flatMap((req) => responsesTo(ms, req.id).map(errorCodeOf)).filter(Boolean);
    check(codes.includes("denied"), `the refused request's answer is ${codes.length ? codes.join(",") : "missing"}, not 'denied'`);
    return `card ${card.id} -> deny; the request ended 'denied'; the asker was told; clipboard.set never ran`;
  },
});

defineScenario({
  id: "S036", category: "approval", codes: ["S034", "S035", "S037", "S038"], name: "审批：以后都可以 → 生成规则，再来不出卡", needs: ["phone", "llm"],
  async run(ctx) {
    const base = await ctx.head();
    const { device, card } = await clipboardCard(ctx, base, ctx.marker("always1"));
    check(card.options.includes("always"), `the card does not offer 'always' (${card.options.join(",")})`);
    check((await ctx.owner.answer(card.id, "always")).ok, "the answer was refused");
    await ctx.expect(base, (ms) => clipboardEffects(ms, device).length >= 1, "the approved action never ran", { ms: 180_000 });
    const rules = await ctx.must("service:gate", "rules.list", { limit: 50 });
    const rule = (rules.rules ?? []).find((r) => r.word === "clipboard.set" && r.subject === MAIN && !r.revoked_at);
    check(rule, "no rule for clipboard.set was made");
    ctx.defer(() => ctx.call("service:gate", "rules.revoke", { id: rule.id }));
    await ctx.must("service:gate", "mode.set", { mode: "auto" });
    const mark = await ctx.head();
    await ctx.send(phoneWordPrompt(device, "clipboard.set", { text: ctx.marker("always2") }));
    await ctx.expect(mark, (ms) => clipboardEffects(ms, device).length >= 1, "the second request did not run", { ms: 180_000 });
    const ms = await ctx.since(mark);
    check(approvalCards(ms).filter((c) => c.word === "clipboard.set").length === 0, "the second request asked again although the rule exists");
    const audit = await ctx.must("service:gate", "audit", { word: "clipboard.set", limit: 5 });
    check(JSON.stringify(audit).includes("clipboard.set"), "the audit has no trace of the decisions");
    return `rule ${rule.id} made; the second clipboard.set ran without a card; audit has the decisions`;
  },
});

defineScenario({
  id: "S039", category: "approval", codes: [], name: "审批：过期作废，迟到的批准不执行", needs: ["phone", "llm"],
  async run(ctx) {
    const base = await ctx.head();
    const { device, card } = await clipboardCard(ctx, base, ctx.marker("ttl"), " 调用时把 approval_ttl_minutes 设为 1。");
    const life = (card.expires_at ?? 0) - card.ts;
    if (!(life > 0 && life <= 150_000)) skip(`the agent did not shorten the card's life (it lasts ${Math.round(life / 60000)} min); this scenario needs approval_ttl_minutes=1`);
    const left = card.expires_at - (await ctx.hubNow()).now;
    await sleep(Math.max(0, left) + 8000);
    await ctx.expect(base, (ms) => gateTells(ms).length >= 1, "the asker was not told the request expired", { ms: 60_000 });
    const late = await ctx.owner.answer(card.id, "once");
    await ctx.settle(20_000);
    const ms = await ctx.since(base);
    check(clipboardEffects(ms, device).length === 0, "an expired request ran after a late approval");
    return `card expired after ~${Math.round(life / 1000)} s; the asker was told; the late 'once' ${late.ok ? "was taken but did nothing" : "was refused"}`;
  },
});

defineScenario({
  id: "S033", category: "approval", codes: ["人场景8"], name: "通知上答审批（系统通知出现自动查，点按钮 MANUAL）", manual: true, needs: ["phone", "llm", "notifications"],
  async run(ctx) {
    await ctx.wake(); await ctx.home();
    const base = await ctx.head();
    const { card } = await clipboardCard(ctx, base, ctx.marker("notif"));
    let shown = null;
    for (let i = 0; i < 6 && !shown; i++) { shown = (await ctx.notifications()).find((n) => n.pkg === ctx.pkg && n.actions.length >= 2); if (!shown) await sleep(2000); }
    await ctx.adb.shell("cmd statusbar expand-notifications"); await sleep(1500);
    const shot = await ctx.shot();
    let answered = null;
    const waitS = ctx.opts.manualWait;
    if (waitS > 0) {
      console.log(`  [S033] the approval notification is up; tap its button now (waiting ${waitS} s)...`);
      const got = await ctx.wait(base, (ms) => answerOnCard(ms, card.id), { ms: waitS * 1000, every: 3000 });
      answered = got?.value ?? null;
    }
    await ctx.adb.shell("cmd statusbar collapse");
    if (!answered) await ctx.owner.answer(card.id, "deny");
    const auto = `notification with ${shown ? `${shown.actions.length} actions (${shown.actions.join(" / ")})` : "NO action buttons found in dumpsys"}`;
    throw manual(`${auto}; ${answered ? `the tap on the phone answered '${answered}' (ledger)` : "no tap seen, card denied from here"}; look at ${shot ?? "the screenshot"}: title and buttons readable?`);
  },
});

defineScenario({
  id: "S040", category: "recovery", codes: [], name: "恢复：审批卡等待时杀中枢，重启后重新出卡，批了照样只执行一次", disruptive: true, needs: ["phone", "llm", "kill"],
  async run(ctx) {
    const base = await ctx.head();
    const { device, card } = await clipboardCard(ctx, base, ctx.marker("restart"));
    await ctx.killHub();
    await ctx.hubBack();
    const again = await ctx.expect(base, (ms) => approvalCards(ms).find((c) => c.word === "clipboard.set" && c.id !== card.id), "after the restart the question was not asked again as a new card", { ms: 180_000 });
    check(ctx.lastLedger.every((m) => !(m.kind === "request" && m.to === device && m.word === "clipboard.set" && responsesTo(ctx.lastLedger, m.id).some(succeeded))), "the action ran before anyone answered again");
    check((await ctx.owner.answer(again.value.id, "once")).ok, "the new card was refused");
    await ctx.expect(base, (ms) => clipboardEffects(ms, device).length >= 1, "after the answer the asker did not carry the action out", { ms: 240_000 });
    await ctx.settle(8000);
    const n = clipboardEffects(await ctx.since(base), device).length;
    check(n === 1, `the action ran ${n} times`);
    return `old card ${card.id} withdrawn, new card ${again.value.id} answered; clipboard.set ran once`;
  },
});

// ===== 子 agent ====================================================================================================

async function runtimeKind(ctx) {
  const r = await ctx.call("service:agents", "runtimes");
  const first = r.ok ? (r.data?.runtimes ?? [])[0] : null;
  return first?.kind ?? first?.id ?? first?.name ?? "dsh";
}
/** Has the main agent make agent:e2e-helper (a sub-agent of its own), once per run. */
async function ensureHelper(ctx) {
  if (ctx.shared.helper) return ctx.shared.helper;
  await ctx.call("service:agents", "remove", { agent: helperId });
  const kind = await runtimeKind(ctx);
  const base = await ctx.head(), m = ctx.marker("hq");
  await ctx.send(`这是自动化测试，请依次做：1) 用 agent_create 声明一个子 agent：id ${helperId}，name "E2E 帮手"，summary "测试用帮手"，brief "收到问题就一句话回答；收到消息就简短确认。"，runtime {"kind":"${kind}"}，不要限制它的 tools；2) agent_start 启动它；3) 用 agent_ask 问它："${m}，一加一等于几？"；4) 再用 agent_tell 告诉它："${m} 已收到"。做完告诉我。`);
  const made = await ctx.expect(base, (ms) => effects(ms, { from: MAIN, to: "service:agents", word: "declare" }).find((r) => r.body?.id === helperId), "the main agent did not declare the helper", { ms: 240_000 });
  ctx.shared.helper = { base, marker: m, made: made.value };
  ctx.shared.cleanup.push(async () => { await ctx.call("service:agents", "remove", { agent: helperId }); });
  return ctx.shared.helper;
}

defineScenario({
  id: "S046", category: "agents", codes: ["S049", "S050"], name: "子 agent：主 agent 建、启动、问、告诉", needs: ["llm"],
  async run(ctx) {
    const h = await ensureHelper(ctx);
    const asked = await ctx.expect(h.base, (ms) => effects(ms, { from: MAIN, to: "service:agents", word: "ask" }).find((r) => r.body?.agent === helperId), "the helper was never asked (or never answered)", { ms: 240_000 });
    const told = await ctx.expect(h.base, (ms) => effects(ms, { from: MAIN, to: "service:agents", word: "tell" }).find((r) => r.body?.agent === helperId), "the helper was never told anything", { ms: 120_000 });
    const list = await ctx.must("service:agents", "list");
    const entry = (list.agents ?? []).find((a) => a.id === helperId);
    check(entry, "the helper is not in agents/list");
    check(entry.created_by === MAIN || entry.created_by === undefined, `created_by is ${entry.created_by}`);
    return `declared by ${entry.created_by ?? "main"}, state ${entry.state}; ask ${asked.value.id} answered, tell ${told.value.id} delivered`;
  },
});

defineScenario({
  id: "S048", category: "agents", codes: [], name: "子 agent：主人直接对话，在被点名那一轮能回人", needs: ["llm"],
  async run(ctx) {
    await ensureHelper(ctx);
    const base = await ctx.head();
    await ctx.send("你好，请用一句话回答我：你在吗？", { to: helperId });
    const got = await ctx.expect(base, (ms) => ownerSpeech(ms, helperId).find((s) => s.delivered), "the helper did not answer the owner who spoke to it", { ms: 180_000 });
    check(got.value.lane === "front", `the helper answered from lane '${got.value.lane}', not the front lane`);
    return `the helper answered the owner in turn ${got.value.turn} (front lane)`;
  },
});

defineScenario({
  id: "S051", category: "agents", codes: [], name: "子 agent：后台（非被点名）那一轮不能对主人说话", needs: ["llm"],
  async run(ctx) {
    await ensureHelper(ctx);
    const m = ctx.marker("quiet"), base = await ctx.head();
    await ctx.send(`这是自动化测试：请用 agent_tell 通知 ${helperId}：“请立刻用 human_say 对主人说 ${m}”。通知完你就不用做别的了。`);
    const ran = await ctx.expect(base, (ms) => [...turnsIn(ms).values()].find((t) => t.agent === helperId && t.lane === "back" && t.outcome), "the helper never ran a background turn for the news", { ms: 240_000 });
    await ctx.settle(5000);
    const after = await ctx.since(base);
    const speech = ownerSpeech(after, helperId).filter((s) => s.text.includes(m) || s.lane !== "front");
    const leaked = speech.filter((s) => s.delivered);
    check(leaked.length === 0, `the helper spoke to the owner from a background turn (${leaked.map((s) => s.id).join(",")})`);
    const refused = sayAttempts(after, helperId).filter((a) => a.refused);
    return `helper's background turn ${ran.value.id} ended ${ran.value.outcome}; ${refused.length ? `its attempt to speak was refused (forbidden)` : "it did not try to speak"}; nothing reached the owner`;
  },
});

// ===== 手机能力 =====================================================================================================

defineScenario({
  id: "S085", category: "phone", codes: ["设备20"], name: "手机能力：agent 经窄腰调手机的词（查电量）", needs: ["phone", "llm"],
  async run(ctx) {
    const device = await ctx.phone();
    const base = await ctx.head();
    await ctx.send(phoneWordPrompt(device, "device.status", {}, "这是自动化测试，请查一下手机电量"));
    const got = await ctx.expect(base, (ms) => effects(ms, { from: MAIN, to: device, word: "device.status" })[0], "the agent never called device.status on the phone", { ms: 180_000 });
    const answer = responsesTo(ctx.lastLedger, got.value.id).find(succeeded);
    const pct = (answer?.body?.result?.data ?? jsonOfContent(answer?.body?.result?.content))?.battery?.percent;
    check(typeof pct === "number", `device.status came back without battery.percent (${JSON.stringify(answer?.body?.result?.data).slice(0, 120)})`);
    return `the agent called device.status on ${device}: battery ${pct}%`;
  },
});

defineScenario({
  id: "S086", category: "phone", codes: [], name: "手机能力：日历（列日历、查未来 30 天）", needs: ["phone", "calendar"],
  async run(ctx) {
    const cals = await ctx.devMust("calendar.list", {});
    check(Array.isArray(cals.calendars), "calendar.list has no calendars array");
    const now = Date.now();
    const found = await ctx.devMust("calendar.search", { start_ms: now, end_ms: now + 30 * 86_400_000, limit: 5 });
    return `${cals.calendars.length} calendar(s); the next 30 days answered (${JSON.stringify(found).length} bytes)`;
  },
});

defineScenario({
  id: "S087", category: "phone", codes: [], name: "手机能力：位置", needs: ["phone", "location"],
  async run(ctx) {
    const r = await ctx.dev("location.get", { accuracy: "balanced", timeout_s: 30 });
    check(r.ok, `location.get -> ${r.code}: ${r.message}`);
    const { lat, lon } = r.data ?? {};
    check(Math.abs(lat) <= 90 && Math.abs(lon) <= 180, `an impossible fix: ${lat}, ${lon}`);
    return `fix ${Number(lat).toFixed(3)}, ${Number(lon).toFixed(3)} (${r.data.source ?? "?"}, ${r.data.accuracy_m ?? "?"} m)`;
  },
});

defineScenario({
  id: "S088", category: "phone", codes: [], name: "手机能力：相册（相册列表、图片列表、读一张）", needs: ["phone", "photos"],
  async run(ctx) {
    const albums = await ctx.devMust("media.albums", { type: "image" });
    check(Array.isArray(albums.albums), "media.albums has no albums array");
    const list = await ctx.devMust("media.list", { type: "image", limit: 3 });
    check(Array.isArray(list.items), "media.list has no items array");
    if (!list.items.length) return `${albums.albums.length} album(s); no images on the phone, so nothing to read`;
    const one = await ctx.dev("media.read", { id: list.items[0].id, max_size: 256 });
    check(one.ok, `media.read -> ${one.code}: ${one.message}`);
    return `${albums.albums.length} album(s); ${list.items.length} image(s) listed; one read`;
  },
});

defineScenario({
  id: "S026", category: "phone", codes: ["人场景27"], name: "文件：主人直接在主 body 里写、读、列文件", needs: [],
  async run(ctx) {
    const m = ctx.marker("file"), path = `e2e/${m}.txt`;
    await ctx.must("body:main", "workspace.write", { path, content: `hello ${m}\n` });
    ctx.defer(() => ctx.call("body:main", "workspace.bash", { command: `rm -f ${path}` }));
    const read = await ctx.must("body:main", "workspace.read", { path });
    check(JSON.stringify(read).includes(m), "the file read back does not hold what was written");
    const ls = await ctx.must("body:main", "workspace.ls", { path: "e2e" });
    check(JSON.stringify(ls).includes(`${m}.txt`), "the new file is not in the directory listing");
    return `wrote, read back and listed ${path}`;
  },
});

defineScenario({
  id: "S089", category: "phone", codes: [], name: "手机能力：读通知（adb 发一条，感知档案里查到）", needs: ["phone", "notification-sense"],
  async run(ctx) {
    const m = ctx.marker("notice"), t0 = (await ctx.hubNow()).now - 1000;
    const post = await ctx.adb.shell(`cmd notification post -S bigtext -t "ash-e2e" e2etag "${m}"`);
    check(post.code === 0, `cmd notification post failed: ${post.err.trim() || post.out.trim()}`);
    let hit = null;
    for (let i = 0; i < 10 && !hit; i++) {
      await sleep(2000);
      const q = await ctx.must("service:senses", "query", { kind: "notification", from: t0, limit: 50 });
      hit = (q.rows ?? []).find((row) => JSON.stringify(row).includes(m));
    }
    check(hit, "the notification was posted but did not reach the sense archive within 20 s");
    return `a notification from adb (${hit.app ?? "shell"}) was read and archived`;
  },
});

defineScenario({
  id: "S090", category: "phone", codes: [], name: "手机能力：电量（和 dumpsys battery 对得上）", needs: ["phone"],
  async run(ctx) {
    const st = await ctx.devMust("device.status", {});
    const pct = st.battery?.percent;
    check(Number.isInteger(pct) && pct >= 0 && pct <= 100, `device.status battery.percent is ${JSON.stringify(st.battery)}`);
    const real = batteryLevel((await ctx.adb.shell("dumpsys battery")).out);
    check(real === null || Math.abs(real - pct) <= 3, `the hand says ${pct}% but dumpsys battery says ${real}%`);
    return `battery ${pct}% (dumpsys ${real ?? "?"}%), charging=${st.battery?.charging}`;
  },
});

defineScenario({
  id: "S091", category: "phone", codes: [], name: "手机能力：剪贴板（写入再读出）", needs: ["phone"],
  async run(ctx) {
    await ctx.wake(); await ctx.launchAsh();
    const m = ctx.marker("clipboard");
    await ctx.devMust("clipboard.set", { text: m });
    const got = await ctx.dev("clipboard.get", {});
    check(got.ok, `clipboard.get -> ${got.code}: ${got.message}`);
    check(got.data?.text === m, `the clipboard holds '${String(got.data?.text).slice(0, 40)}', not what was set`);
    return "set and read back the same text";
  },
});

defineScenario({
  id: "S092", category: "phone", codes: [], name: "手机能力：打开应用（设置），前台包名对", needs: ["phone"],
  async run(ctx) {
    await ctx.wake(); await ctx.home();
    const r = await ctx.dev("apps.open", { app: "com.android.settings" });
    check(r.ok, `apps.open -> ${r.code}: ${r.message}`);
    const fg = await ctx.waitForeground((p) => /settings/i.test(p), 12_000);
    await ctx.home();
    check(fg && /settings/i.test(fg), `the foreground package is '${fg}', not Settings`);
    return `apps.open ok; foreground became ${fg}`;
  },
});

defineScenario({
  id: "S093", category: "phone", codes: [], name: "手机能力：打开网址，前台换成了浏览器", needs: ["phone", "network"],
  async run(ctx) {
    await ctx.wake(); await ctx.home();
    const before = await ctx.foreground();
    const r = await ctx.dev("apps.open_url", { uri: "https://example.com" });
    check(r.ok, `apps.open_url -> ${r.code}: ${r.message}`);
    const fg = await ctx.waitForeground((p) => p !== before && p !== ctx.pkg, 12_000);
    await ctx.shot("browser");
    await ctx.home();
    check(fg && fg !== before && fg !== ctx.pkg, `the foreground stayed '${fg}' (was '${before}')`);
    return `opened a URL; foreground ${before} -> ${fg}`;
  },
});

defineScenario({
  id: "S094", category: "phone", codes: [], name: "手机能力：浏览器任务（开页、读页、截图、关）", needs: ["phone", "network"],
  async run(ctx) {
    const space = "e2e";
    const page = await ctx.devMust("browser.open", { url: "https://example.com", space });
    ctx.defer(() => ctx.dev("browser.close", { space }));
    check(/^https?:\/\/(www\.)?example\.com/.test(page.url ?? ""), `the page url is '${page.url}'`);
    check(page.title && Array.isArray(page.elements), "the page has no title or element list");
    const read = await ctx.devMust("browser.read", { space });
    check(read.url === page.url, "browser.read returned another page");
    const shot = await ctx.dev("browser.screenshot", { space });
    check(shot.ok, `browser.screenshot -> ${shot.code}: ${shot.message}`);
    return `opened ${page.url} ("${String(page.title).slice(0, 30)}", ${page.elements.length} elements), read and screenshot ok`;
  },
});

defineScenario({
  id: "S094b", category: "phone", codes: ["S095"], name: "手机能力：屏幕读取和操作（无障碍）", needs: ["phone", "accessibility"],
  async run(ctx) {
    await ctx.wake(); await ctx.home();
    await ctx.devMust("apps.open", { app: "com.android.settings" });
    await ctx.waitForeground((p) => /settings/i.test(p), 12_000);
    const read = await ctx.devMust("screen.read", {});
    check(/settings/i.test(read.package ?? ""), `screen.read saw package '${read.package}', not Settings`);
    check(read.count > 0 && Array.isArray(read.nodes), "screen.read returned no nodes");
    const shot = await ctx.dev("screen.screenshot", {});
    check(shot.ok && shot.data?.bytes > 0, `screen.screenshot -> ${shot.ok ? "empty file" : `${shot.code}: ${shot.message}`}`);
    await ctx.devMust("screen.global_action", { action: "home" });
    const fg = await ctx.waitForeground((p) => !/settings/i.test(p), 10_000);
    check(fg && !/settings/i.test(fg), `after the 'home' action the foreground is still '${fg}'`);
    return `read ${read.count} nodes of ${read.package}; screenshot ${shot.data.bytes} bytes; 'home' left Settings (now ${fg})`;
  },
});

defineScenario({
  id: "S094c", category: "phone", codes: ["设备33"], name: "手机能力：Shizuku shell（跑命令、权限是 shell 用户）", needs: ["phone", "shizuku"],
  async run(ctx) {
    const r = await ctx.devMust("shell.run", { command: "echo $((6*7)); id -u", timeout_ms: 20_000 });
    const lines = String(r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    check(r.exit_code === 0 && lines[0] === "42", `shell.run gave exit ${r.exit_code}, output '${String(r.stdout).slice(0, 60)}'`);
    check(lines[1] === "2000" || lines[1] === "0", `the command ran as uid ${lines[1]}, not the shell user`);
    return `shell.run answered 42 as uid ${lines[1]}`;
  },
});

// ===== 应用 =========================================================================================================

async function ensureApp(ctx, { installed = false } = {}) {
  if (!ctx.shared.app) {
    await ctx.call("service:apps", "apps.remove", { id: appId });
    const sc = await ctx.must("service:apps", "apps.scaffold", { id: appId, name: "E2E 清单", summary: "自动化测试用的清单应用。", role: "测试用清单：记事、划掉。", surfaces: [{ id: "main", title: "主页" }] });
    ctx.shared.app = sc;
    ctx.shared.cleanup.push(async () => { await ctx.call("service:apps", "apps.remove", { id: appId }); });
  }
  if (installed) {
    const list = await ctx.must("service:apps", "apps.list", {});
    const mine = (list.apps ?? []).find((a) => a.id === appId);
    if (!mine?.granted || !mine?.running) await ctx.must("service:apps", "apps.install", { id: appId });
  }
  return ctx.shared.app;
}

defineScenario({
  id: "S119", category: "apps", codes: [], name: "应用：脚手架生成、校验通过", needs: [],
  async run(ctx) {
    const sc = await ensureApp(ctx);
    check((sc.files ?? []).some((f) => /app\.json$/.test(f)) && (sc.files ?? []).some((f) => /server\.mjs$/.test(f)), `the scaffold wrote ${JSON.stringify(sc.files)}`);
    const v = await ctx.must("service:apps", "apps.validate", { id: appId });
    check(v.ok === true, `validate found problems: ${JSON.stringify((v.problems ?? []).filter((p) => p.level === "error")).slice(0, 300)}`);
    return `scaffolded ${(sc.files ?? []).length} files in ${sc.path}; validate ok (${(v.problems ?? []).length} warning(s))`;
  },
});

defineScenario({
  id: "S120", category: "apps", codes: [], name: "应用：agent 要装 → 出审批卡（不提供“以后都可以”），批了才装上", needs: ["llm"],
  async run(ctx) {
    await ensureApp(ctx);
    await ctx.call("service:apps", "apps.revoke", { id: appId });
    const base = await ctx.head();
    await ctx.send(`这是自动化测试：请调用 service:apps 的 apps.install，参数 {"id":"${appId}"}（用 capability_call）。必须真的调用，不要问我。`);
    const got = await ctx.expect(base, (ms) => approvalCards(ms).find((c) => c.word === "apps.install"), "no approval card for apps.install came", { ms: 180_000 });
    check(!got.value.options.includes("always"), "an install card offers 'always'");
    check(!((await ctx.must("service:apps", "apps.list", {})).apps ?? []).find((a) => a.id === appId)?.granted, "the app was installed before the owner approved");
    check((await ctx.owner.answer(got.value.id, "once")).ok, "the answer was refused");
    let app = null;
    for (let i = 0; i < 40 && !app; i++) { await sleep(4000); app = ((await ctx.must("service:apps", "apps.list", {})).apps ?? []).find((a) => a.id === appId && a.granted && a.running); }
    check(app, "approved, but the app was not installed and running within 160 s (the asker did not redeem)");
    return `install card ${got.value.id} (options ${got.value.options.join("/")}) -> once -> ${appId} granted and running`;
  },
});

defineScenario({
  id: "S121", category: "apps", codes: ["S125"], name: "应用：主人装（授权）、停用、启用、收回授权", needs: [],
  async run(ctx) {
    await ensureApp(ctx);
    const state = async () => ((await ctx.must("service:apps", "apps.list", {})).apps ?? []).find((a) => a.id === appId) ?? {};
    await ctx.call("service:apps", "apps.revoke", { id: appId });
    check(!(await state()).granted, "revoke left it granted");
    await ctx.must("service:apps", "apps.install", { id: appId });
    let s = await state(); check(s.granted && s.running, `after install: granted=${s.granted} running=${s.running}`);
    await ctx.must("service:apps", "apps.disable", { id: appId });
    s = await state(); check(!s.running && s.granted, `after disable: granted=${s.granted} running=${s.running}`);
    await ctx.must("service:apps", "apps.enable", { id: appId });
    s = await state(); check(s.running, "after enable it is not running");
    await ctx.must("service:apps", "apps.revoke", { id: appId });
    s = await state(); check(!s.granted && !s.running, `after revoke: granted=${s.granted} running=${s.running}`);
    return "install -> running; disable -> stopped, grants kept; enable -> running; revoke -> not granted, not running";
  },
});

defineScenario({
  id: "S122", category: "apps", codes: ["设备39"], name: "应用：页面（surface）和图标", needs: [],
  async run(ctx) {
    await ensureApp(ctx, { installed: true });
    const d = await ctx.must("service:apps", "apps.describe", { id: appId });
    const surface = d.surfaces?.[0]?.id;
    check(surface, "the app lists no surface");
    const page = await ctx.must("service:apps", "apps.surface", { id: appId, surface });
    check(/<html|<!doctype|<body|<div/i.test(page.html ?? "") && /^text\/html/.test(page.mime ?? ""), `the page is '${page.mime}' with ${String(page.html).length} bytes`);
    const icon = await ctx.must("service:apps", "apps.icon", { id: appId });
    check(/^image\//.test(icon.mime ?? "") && icon.data, "the icon is empty or not an image");
    return `surface '${surface}' served ${page.html.length} bytes of HTML; icon ${icon.mime}`;
  },
});

defineScenario({
  id: "S123", category: "apps", codes: [], name: "应用：调应用自己的工具（加一条、读出来）", needs: [],
  async run(ctx) {
    await ensureApp(ctx, { installed: true });
    const dir = await ctx.must("service:directory", "describe", { member: `app:${appId}` });
    const words = dir.words ?? [];
    const add = words.find((w) => /\.add$/.test(w.word ?? w.name ?? ""));
    const list = words.find((w) => /\.list$/.test(w.word ?? w.name ?? ""));
    check(add && list, `the app's words are ${words.map((w) => w.word ?? w.name).join(",")}`);
    const m = ctx.marker("item");
    await ctx.must(`app:${appId}`, add.word ?? add.name, bodyFromSchema(add.input_schema, m));
    const got = await ctx.must(`app:${appId}`, list.word ?? list.name, {});
    check(JSON.stringify(got).includes(m), "the item that was added is not in the list");
    return `${add.word ?? add.name} then ${list.word ?? list.name}: the new item is there`;
  },
});

defineScenario({
  id: "S124", category: "apps", codes: ["设备37"], name: "应用：内置 health 在、能描述；已授权时读工具可调", needs: [],
  async run(ctx) {
    const list = await ctx.must("service:apps", "apps.list", {});
    const health = (list.apps ?? []).find((a) => a.id === "health");
    check(health, `no built-in 'health' app (apps: ${(list.apps ?? []).map((a) => a.id).join(",")})`);
    const d = await ctx.must("service:apps", "apps.describe", { id: "health" });
    check((d.tools ?? []).length > 0, "health lists no tools");
    if (!health.granted || !health.running) return `health is there (${d.tools.length} tools) but not installed/running, so no tool was called`;
    const dir = await ctx.must("service:directory", "describe", { member: "app:health" });
    const readOnly = (dir.words ?? []).find((w) => w.effect === "read" && !(w.input_schema?.required ?? []).length);
    check(readOnly, "health has no read tool without required arguments to try");
    const r = await ctx.call("app:health", readOnly.word ?? readOnly.name, {});
    check(r.ok || ["unavailable", "failed"].includes(r.code), `health ${readOnly.word ?? readOnly.name} -> ${r.code}: ${r.message}`);
    return `health running; ${readOnly.word ?? readOnly.name} -> ${r.ok ? "ok" : `${r.code} (health data not available on this phone)`}`;
  },
});

// ===== 感知和 pulse ================================================================================================

defineScenario({
  id: "S097", category: "senses", codes: ["S100", "S102", "S103"], name: "感知：屏幕开关事件进感知档案，不进账本；感知器官在运行", needs: ["phone"],
  async run(ctx) {
    const t0 = (await ctx.hubNow()).now - 1000, base = await ctx.head();
    await ctx.adb.key("KEYCODE_SLEEP"); await sleep(3500);
    await ctx.wake();
    let rows = [];
    for (let i = 0; i < 10 && !rows.length; i++) { await sleep(2000); rows = (await ctx.must("service:senses", "query", { kind: "screen", from: t0, limit: 20 })).rows ?? []; }
    check(rows.length, "the screen off/on did not reach the sense archive within 20 s");
    const ms = await ctx.since(base);
    check(!ms.some((m) => /^sense\./.test(m.word)), "sense events were written to the ledger");
    const organ = ((await ctx.must("service:apps", "apps.list", {})).apps ?? []).find((a) => a.id === "sense-rules");
    check(organ?.running, `the sense-rules organ is ${organ ? "not running" : "missing"}`);
    return `${rows.length} screen row(s) archived; none in the ledger; sense-rules running (geofence/ride/stale wakes need mock locations: see the hub scenario tests)`;
  },
});

defineScenario({
  id: "S066", category: "senses", codes: ["S067"], name: "pulse：手动触发一次，后台线醒一轮", needs: ["llm"],
  async run(ctx) {
    const p = await ctx.must("service:pulse", "pulse.get", {});
    if (!p.active) skip(`the pulse is not active (${p.reason ?? "no widget"}); put an 'Ash 卡片' widget on the home screen`);
    if (!p.enabled) { await ctx.must("service:pulse", "pulse.switch", { enabled: true }); ctx.defer(() => ctx.call("service:pulse", "pulse.switch", { enabled: false })); }
    const base = await ctx.head();
    const fired = await ctx.must("service:pulse", "pulse.fire", {});
    check(fired.fired === true, `pulse.fire did not fire (${fired.reason})`);
    const turn = await ctx.expect(base, (ms) => [...turnsIn(ms).values()].find((t) => t.agent === MAIN && t.lane === "back"), "no background turn started after the pulse", { ms: 150_000 });
    return `pulse fired; the main agent ran a background turn (${turn.value.id})`;
  },
});

defineScenario({
  id: "S061", category: "senses", codes: ["S062", "S063"], name: "每日复盘：把复盘时刻设到两分钟后，后台线被叫醒", needs: ["llm"],
  async run(ctx) {
    const { now, timeZone } = await ctx.hubNow();
    const hhmm = hhmmIn(now + 2 * 60_000, timeZone);
    const base = await ctx.head();
    await ctx.setSetting("semantic.review_time", hhmm);
    const got = await ctx.wait(base, (ms) => [...turnsIn(ms).values()].find((t) => t.agent === MAIN && t.lane === "back"), { ms: 240_000, every: 5000 });
    if (!got) skip(`no background turn at ${hhmm}: today's review probably already went out (one wake a day), or its diary is marked done`);
    return `review time set to ${hhmm}; the main agent woke on its background lane (${got.value.id})`;
  },
});

// ===== 设置 =========================================================================================================

defineScenario({
  id: "S164", category: "settings", codes: ["S165", "R5"], name: "暂停 / 继续：暂停期间不开新一轮，继续后恢复", needs: ["llm"],
  async run(ctx) {
    check((await ctx.status())?.paused === false, "the hub is already paused; resume it first");
    ctx.defer(() => ctx.call("service:admin", "resume", { confirmed: true }));
    await ctx.must("service:admin", "pause", { by: "e2e" });
    check((await ctx.status())?.paused === true, "status does not show paused");
    const base = await ctx.head();
    const held = await ctx.send("暂停期间的一条消息，请回复一个字。");
    await ctx.settle(25_000);
    const ms = await ctx.since(base);
    check(!turnsGiven(ms, held.id).length && !agentSays(ms).length, "the agent worked while paused");
    await ctx.must("service:admin", "resume", { confirmed: true });
    check((await ctx.status())?.paused === false, "status still shows paused after resume");
    const r = await ctx.owner.say("恢复后，请回复一个字。", { timeoutS: 150 });
    check(r.replies.length >= 1, "after resume the agent did not answer");
    return "paused -> no turn, no reply for 25 s; resumed -> the agent answered again";
  },
});

defineScenario({
  id: "S159", category: "settings", codes: ["S160"], name: "密钥：存进保险箱，列表只见“已配置”，账本里没有明文，删除后消失", needs: [],
  async run(ctx) {
    const ref = "ASH_E2E_TEST_KEY", secret = `sk-e2e-${ctx.marker("secret")}`;
    ctx.defer(() => ctx.call("service:vault", "delete", { ref }));
    const set = await ctx.owner.setKey(ref, secret);
    check(set.ok, `set-key failed: ${set.message}`);
    const listed = await ctx.must("service:vault", "list", {});
    const entry = (listed.entries ?? []).find((e) => e.ref === ref);
    check(entry?.configured === true, "the key is not listed as configured");
    check(!JSON.stringify(listed).includes(secret), "the vault list shows the secret");
    const hits = await ctx.must("service:history", "query", { text: secret, limit: 5 });
    // This very search is in the ledger too (an owner request to service:history), so it does not count.
    const leaked = (hits.messages ?? []).filter((m) => m.to !== "service:history");
    check(leaked.length === 0, `the secret is in the ledger (${leaked.map((m) => `${m.word} #${m.seq}`).join(", ")})`);
    await ctx.must("service:vault", "delete", { ref });
    const after = (await ctx.must("service:vault", "list", {})).entries ?? [];
    check(!after.find((e) => e.ref === ref && e.configured), "the key is still configured after delete");
    return "set -> listed as configured (no value); not in the ledger; delete -> gone";
  },
});

defineScenario({
  id: "S163", category: "settings", codes: ["R16", "S167"], name: "DSH 插件：列出、关掉再打开一个社区插件", needs: ["llm"],
  async run(ctx) {
    const list = await ctx.must("service:admin", "plugins.list", {});
    const plugins = Array.isArray(list.plugins) ? list.plugins : [];
    const candidate = plugins.find((p) => typeof p?.id === "string" && typeof p?.enabled === "boolean" && !/^(acp|ash[-_]|dsh-ash)/.test(p.id));
    if (!candidate) skip(`no community plug-in is installed (plugins: ${plugins.map((p) => p?.id).join(",") || "none"}); install one with DSH's plug-in manager first`);
    const flip = async (enabled) => ctx.must("service:admin", "plugins.op", { op: "plugin", id: candidate.id, enabled });
    const now = async () => ((await ctx.must("service:admin", "plugins.list", {})).plugins ?? []).find((p) => p.id === candidate.id)?.enabled;
    ctx.defer(() => flip(candidate.enabled));
    await flip(!candidate.enabled);
    check((await now()) === !candidate.enabled, "the plug-in did not switch");
    await flip(candidate.enabled);
    check((await now()) === candidate.enabled, "the plug-in did not switch back");
    return `${candidate.id}: ${candidate.enabled} -> ${!candidate.enabled} -> ${candidate.enabled}`;
  },
});

defineScenario({
  id: "S157", category: "settings", codes: ["S158", "S162"], name: "模型切换：切到另一个模型，重启 DSH 和中枢后仍保持，换回", disruptive: true, needs: ["llm"],
  async run(ctx) {
    const read = async () => modelOf((await ctx.must("service:agents", "configure", { agent: MAIN })).config);
    const before = await read();
    check(before, "cannot read the current model back from the agent");
    const [prov0, model0] = before;
    let target;
    if (ctx.opts.altModel) { const [p, ...m] = ctx.opts.altModel.split("/"); target = [p, m.join("/")]; }
    else target = [prov0 ?? "deepseek-official", model0 === "deepseek-v4-pro" ? "deepseek-flash" : "deepseek-v4-pro"];
    ctx.defer(async () => { await ctx.call("service:admin", "model.set", { provider: prov0 ?? target[0], model: model0 }); });
    await ctx.must("service:admin", "model.set", { provider: target[0], model: target[1] });
    check((await read())?.[1] === target[1], `after model.set the agent reports ${JSON.stringify(await read())}`);
    await ctx.must("service:agents", "restart", { agent: MAIN });
    await sleep(5000);
    let after = null;
    for (let i = 0; i < 30 && !after; i++) { const r = await ctx.call("service:agents", "configure", { agent: MAIN }); after = r.ok ? modelOf(r.data?.config) : null; if (!after) await sleep(4000); }
    check(after?.[1] === target[1], `after restarting the agent the model is ${JSON.stringify(after)}, not ${target[1]}`);
    const r = await ctx.owner.say("只回复一个字：好", { timeoutS: 150 });
    check(r.replies.length >= 1, "the agent did not answer on the new model");
    let hub = "skipped (no way to kill the hub from adb)";
    if ((await ctx.hubPids()).length) {
      try {
        await ctx.killHub(); await ctx.hubBack();
        let again = null;
        for (let i = 0; i < 30 && !again; i++) { const x = await ctx.call("service:agents", "configure", { agent: MAIN }); again = x.ok ? modelOf(x.data?.config) : null; if (!again) await sleep(4000); }
        check(again?.[1] === target[1], `after the hub restarted the model is ${JSON.stringify(again)}, not ${target[1]}`);
        hub = "kept after a hub restart too";
      } catch (e) { if (e instanceof Outcome && e.status === "SKIP") hub = "hub restart skipped"; else throw e; }
    }
    return `${model0} -> ${target[1]}; kept after the agent restarted and it answered; ${hub}; switched back at the end`;
  },
});

defineScenario({
  id: "R20", category: "settings", codes: ["S166"], name: "设置跨重启：安静时段和暂停状态杀中枢后仍在", disruptive: true, needs: ["kill"],
  async run(ctx) {
    check((await ctx.status())?.paused === false, "the hub is already paused; resume it first");
    ctx.defer(() => ctx.call("service:admin", "resume", { confirmed: true }));
    await ctx.setSetting("delivery.quiet_hours", "00:00-23:59");
    await ctx.must("service:admin", "pause", { by: "e2e-restart" });
    await ctx.killHub();
    await ctx.hubBack();
    const settings = (await ctx.must("service:admin", "settings.get", { keys: ["delivery.quiet_hours"] })).settings ?? {};
    check(settings["delivery.quiet_hours"] === "00:00-23:59", `quiet hours after the restart: ${JSON.stringify(settings)}`);
    check((await ctx.status())?.paused === true, "the pause did not survive the restart");
    await ctx.must("service:admin", "resume", { confirmed: true });
    return "quiet hours 00:00-23:59 and the pause both survived a hub kill; restored";
  },
});

// ===== 恢复 =========================================================================================================

defineScenario({
  id: "S170", category: "recovery", codes: ["S171", "R4"], name: "恢复：一轮进行中杀中枢，重启后这条消息不重放，agent 被告知上一轮中断", disruptive: true, needs: ["llm", "kill"],
  async run(ctx) {
    const base = await ctx.head();
    const a = await ctx.send(longJob("S170"));
    const turn = await ctx.startedTurnOf(base, a.id, { ms: 60_000 });
    check(turn, "the message never started a turn");
    await sleep(3000);
    const mark = (await ctx.head());
    await ctx.killHub();
    await ctx.hubBack();
    const note = await ctx.wait(mark, (ms) => [...turnsIn(ms).values()].find((t) => t.agent === MAIN && t.lane === "back" && t.startedSeq > mark), { ms: 180_000, every: 5000 });
    const ms = await ctx.since(base);
    const given = [...turnsIn(ms).values()].filter((t) => t.ids.includes(a.id));
    check(given.length === 1, `the message was given to ${given.length} turns (it must be exactly one: not replayed)`);
    check(note, "after the restart the agent was not woken to be told the last turn was cut off");
    return `message ${a.id} stayed in its one turn (${given[0].id}, now ${given[0].outcome ?? "unfinished"}); the agent was woken on its background lane (${note.value.id})`;
  },
});

defineScenario({
  id: "S168", category: "recovery", codes: [], name: "恢复：DSH 进程被杀后自动拉起，下一句话能答", disruptive: true, needs: ["llm", "kill"],
  async run(ctx) {
    const pids = await ctx.dshPids();
    if (!pids.length) skip("cannot find DSH's process (looked for '--profile acp' in ps)");
    const gone = await ctx.kill(pids);
    if (!gone.length) skip(`could not kill DSH (pid ${pids.join(",")}); ${fill(REMEDY.kill, ctx)}`);
    let fresh = [];
    for (let i = 0; i < 40 && !fresh.length; i++) { await sleep(4000); fresh = (await ctx.dshPids()).filter((p) => !pids.includes(p)); }
    check(fresh.length, "DSH was not started again within 160 s");
    const r = await ctx.owner.say("DSH 刚被重启过，请回复一个字。", { timeoutS: 180 });
    check(r.replies.length >= 1, "the new DSH did not answer");
    return `DSH pid ${pids.join(",")} killed -> new pid ${fresh.join(",")}; the next message was answered`;
  },
});

defineScenario({
  id: "S005", category: "recovery", codes: ["S006", "S007", "S008", "S009"], name: "对话失败重试：DSH 在回答中途被杀，出失败提示和 [重试]，点了能做完", disruptive: true, needs: ["llm", "kill"],
  async run(ctx) {
    if (!(await ctx.dshPids()).length) skip("cannot find DSH's process (looked for '--profile acp' in ps)");
    // The kill has to land while the owner's turn is still running: a fast model can finish a short essay within
    // seconds, and then the kill only hits a background turn (which never shows a card). Ask for a long text, kill as
    // soon as the turn has started, and try again when the turn had already ended by then.
    let base, a;
    for (let attempt = 1; ; attempt++) {
      base = await ctx.head();
      a = await ctx.send(`（S005-${attempt}）请不用任何工具，认真写一篇 2000 字的短文《一个人的春天》，分十段，每段都写细。`);
      check(await ctx.startedTurnOf(base, a.id, { ms: 60_000, every: 300 }), "the message never started a turn");
      await sleep(800);
      const gone = await ctx.kill(await ctx.dshPids());
      if (!gone.length) skip(`could not kill DSH; ${fill(REMEDY.kill, ctx)}`);
      const ended = await ctx.wait(base, (ms) => turnsGiven(ms, a.id).find((t) => t.outcome), { ms: 60_000, every: 1000 });
      if (ended && ended.value.outcome !== "completed") break;
      if (attempt >= 3) fail(`the turn kept finishing before DSH was killed (${ended ? ended.value.outcome : "no end"}); the model is too fast for this test`);
      for (let i = 0; i < 60 && !(await ctx.dshPids()).length; i++) await sleep(1000);   // DSH is brought back on its own
    }
    const got = await ctx.expect(base, (ms) => retryCard(ms), "no failure card with a retry option came", { ms: 240_000, every: 4000 });
    const turn = turnsGiven(ctx.lastLedger, a.id)[0];
    check((await ctx.owner.answer(got.value.id, got.value.retry)).ok, "the retry pick was refused");
    const pick = (await ctx.expect(base, (ms) => pickOf(ms, got.value.id), "the retry is not in the ledger")).value;
    // The retry runs the failed turn's own messages again: the new turn carries the original message's id.
    const after = (t) => t.id !== turn?.id && t.startedSeq > pick.seq && (t.ids.includes(a.id) || t.ids.includes(pick.id));
    const next = (await ctx.wait(base, (ms) => [...turnsIn(ms).values()].find((t) => after(t) && t.outcome), { ms: 240_000, every: 3000 }))?.value;
    check(next?.outcome === "completed", `the retried turn ended ${next?.outcome ?? "never"}`);
    return `turn ${turn?.id ?? "?"} (${turn?.outcome ?? "?"}) -> failure card ${got.value.id} -> retry -> turn ${next.id} completed`;
  },
});

// ===== 眼睛看的 =====================================================================================================

defineScenario({
  id: "S114", category: "island", codes: ["S115", "S116", "S117", "S118"], name: "任务岛：任务进行中截屏（MANUAL），再从中枢停掉这一轮（自动）", manual: true, needs: ["phone", "llm"],
  async run(ctx) {
    await ctx.wake(); await ctx.home();
    const base = await ctx.head();
    const a = await ctx.send(longJob("S114"));
    const turn = await ctx.startedTurnOf(base, a.id, { ms: 60_000 });
    check(turn, "the message never started a turn");
    await sleep(5000);
    const shot = await ctx.shot("running");
    await ctx.adb.shell("cmd statusbar expand-notifications"); await sleep(1200);
    const shade = await ctx.shot("shade");
    await ctx.adb.shell("cmd statusbar collapse");
    const stop = await ctx.call("service:reflex", "task.stop", { turn: turn.id });
    check(stop.ok, `task.stop -> ${stop.code}: ${stop.message}`);
    const ended = await ctx.expect(base, (ms) => { const t = turnsIn(ms).get(turn.id); return t?.outcome ? t : null; }, "the stopped turn did not end", { ms: 30_000, every: 1500 });
    throw manual(`turn ${turn.id} stopped from the hub (${ended.value.outcome}); look at ${shot ?? "S114-running.png"} and ${shade ?? "S114-shade.png"}: does the island / capsule show the task (title, steps, stop button) and disappear after the stop?`);
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Part 5. Command line.
// ---------------------------------------------------------------------------------------------------------------------

const USAGE = `scenarios.mjs: real-phone scenarios for Ash, run from the machine that has adb.

  node scenarios.mjs --serial <adb serial> --link-file link.json [--only R19,S085] [--shots ./shots]

  --serial S           adb serial (env ANDROID_SERIAL); optional when one device is attached
  --link-file PATH     where to keep the hub link ({port, token}); fetched from the phone with run-as and refreshed whenever the hub restarts (default ./link.json)
  --only LIST          comma list: scenario ids, old codes (R19, S085), categories (approval, phone...) or "all"
  --skip LIST          the same, to leave out
  --safe               leave out the scenarios that kill a process (hub, DSH); naming one with --only still runs it
  --list               print the scenarios and exit
  --shots DIR          screenshots, named after the scenario (default ./shots)
  --report FILE        also write the results as JSON
  --owner PATH         owner.mjs (default: the one next to this file)
  --adb PATH           adb binary (default: adb, or the Android SDK's platform-tools)
  --package NAME       the hand app (default ai.ash.agent)      --kernel-package NAME   the kernel host (default ai.ash.kernel)
  --state DIR          owner.mjs identity directory (default ~/.ash-owner-e2e)
  --manual-wait S      MANUAL scenarios that need a tap wait this long for it (default 45; 0 = do not wait)
  --alt-model P/M      the model S157 switches to (default: the other of deepseek-flash / deepseek-v4-pro)
  --timeout-scale X    multiply every wait (slow phone or network), default 1
  --stress-rounds N    turns of S174 (default 6)        --mem-limit-mb N   S174's limit for the kernel app's PSS (default 1500)

Output: PASS|FAIL|SKIP|MANUAL <id> <name> -- <detail>. SKIP says what to switch on. Exit 0 when nothing FAILed, 1 otherwise, 2 when it could not start.
`;

const VALUE_FLAGS = { serial: "serial", "link-file": "linkFile", only: "only", skip: "skip", shots: "shots", report: "report", owner: "owner", adb: "adb", package: "pkg",
  "kernel-package": "kpkg", state: "state", "manual-wait": "manualWait", "alt-model": "altModel", "timeout-scale": "timeoutScale", "stress-rounds": "stressRounds", "mem-limit-mb": "memLimitMb" };
const BOOL_FLAGS = { safe: "safe", list: "list", help: "help" };

/** Arguments -> options (throws a plain Error on a bad one). */
export function parseArgs(argv, env = process.env) {
  const o = { serial: env.ANDROID_SERIAL, linkFile: "link.json", only: "", skip: "", shots: "shots", report: undefined, owner: join(HERE, "owner.mjs"), adb: undefined,
    pkg: "ai.ash.agent", kpkg: "ai.ash.kernel", state: join(homedir(), ".ash-owner-e2e"), manualWait: 45, altModel: undefined, timeoutScale: 1, stressRounds: 6, memLimitMb: 1500,
    safe: false, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL_FLAGS[name]) { o[BOOL_FLAGS[name]] = true; continue; }
    if (!VALUE_FLAGS[name]) throw new Error(`unknown option --${name}`);
    const v = inline ?? argv[++i];
    if (v === undefined) throw new Error(`--${name} needs a value`);
    o[VALUE_FLAGS[name]] = v;
  }
  for (const k of ["manualWait", "timeoutScale", "stressRounds", "memLimitMb"]) {
    o[k] = Number(o[k]);
    if (!Number.isFinite(o[k]) || o[k] < 0) throw new Error(`--${Object.keys(VALUE_FLAGS).find((n) => VALUE_FLAGS[n] === k)} must be a number`);
  }
  if (o.timeoutScale === 0) throw new Error("--timeout-scale must be above 0");
  return o;
}

const tokens = (list) => String(list ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The scenarios to run, in order (the ones that kill a process last), and the tokens that matched nothing. */
export function selectScenarios(all, { only = "", skip: skipList = "", safe = false } = {}) {
  const want = tokens(only), drop = tokens(skipList);
  const unknown = [...want, ...drop].filter((t) => t.toLowerCase() !== "all" && !all.some((s) => matchesToken(s, t)));
  let chosen = want.length ? all.filter((s) => want.some((t) => matchesToken(s, t))) : all.filter((s) => !(safe && s.disruptive));
  chosen = chosen.filter((s) => !drop.some((t) => matchesToken(s, t)));
  // The ones that kill a process go last, so a hub that is slow to come back does not spoil the quiet ones.
  chosen = [...chosen.filter((s) => !s.disruptive), ...chosen.filter((s) => s.disruptive)];
  return { chosen, unknown };
}

export function describeCatalog(all) {
  return all.map((s) => `${s.id.padEnd(6)} ${s.manual ? "MANUAL" : "auto  "} ${s.category.padEnd(12)} ${s.disruptive ? "kills " : "      "}${s.name}  [${s.codes.join(",")}]${s.needs.length ? `  needs: ${s.needs.join(",")}` : ""}`).join("\n");
}

async function findAdb(preferred) {
  const candidates = preferred ? [preferred] : ["adb", join(homedir(), "Library/Android/sdk/platform-tools/adb"), join(process.env.ANDROID_HOME ?? "", "platform-tools/adb"), join(process.env.ANDROID_SDK_ROOT ?? "", "platform-tools/adb")];
  for (const c of candidates) {
    if (c !== "adb" && !existsSync(c)) continue;
    if ((await run(c, ["version"], { timeoutMs: 15_000 })).code === 0) return c;
  }
  return null;
}

/** Runs one scenario to an Outcome. Never throws. */
export async function runOne(ctx, s) {
  ctx.scenario = s;
  let result;
  try {
    if (!(await ctx.ensureHub())) throw new Outcome("SKIP", "the hub does not answer (killed by an earlier scenario and not back yet?)");
    for (const n of s.needs) await ctx.need(n);
    const limit = s.timeoutMs ? s.timeoutMs : ctx.scale(20 * 60_000);
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Outcome("FAIL", `the scenario did not finish in ${Math.round(limit / 60000)} min`)), limit); });
    const out = await Promise.race([s.run(ctx), timeout]).finally(() => clearTimeout(timer));
    result = out instanceof Outcome ? out : new Outcome("PASS", String(out ?? ""));
  } catch (e) {
    result = e instanceof Outcome ? e : new Outcome("FAIL", `script error: ${String(e?.stack ?? e).split("\n").slice(0, 2).join(" ")}`);
  }
  if (result.status === "FAIL") await ctx.shot("fail").catch(() => {});
  if (result.status === "MANUAL" && !ctx.shots.length) await ctx.shot().catch(() => {});
  const errs = await ctx.cleanup();
  const notes = [...ctx.notes, ...(errs.length ? [`cleanup problem: ${errs.join("; ")}`] : [])];
  return { id: s.id, name: s.name, status: result.status, detail: [result.detail, ...notes].filter(Boolean).join(" | "), shots: ctx.shots };
}

export async function main(argv, env = process.env) {
  let opts;
  try { opts = parseArgs(argv, env); } catch (e) { process.stderr.write(`scenarios.mjs: ${e.message}\n\n${USAGE}`); return 64; }
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.list) { process.stdout.write(`${describeCatalog(SCENARIOS)}\n`); return 0; }
  const { chosen, unknown } = selectScenarios(SCENARIOS, opts);
  for (const t of unknown) process.stderr.write(`note: "${t}" matches no scenario (--list shows them)\n`);
  if (!chosen.length) { process.stderr.write("nothing to run\n"); return 64; }
  if (!existsSync(opts.owner)) { process.stderr.write(`owner.mjs not found at ${opts.owner} (--owner)\n`); return 2; }

  const bin = await findAdb(opts.adb);
  if (!bin) { process.stderr.write("adb not found: put it in PATH or give --adb (macOS: ~/Library/Android/sdk/platform-tools/adb)\n"); return 2; }
  const adb = new Adb({ bin, serial: opts.serial });
  const state = await adb.state();
  if (state !== "device") { process.stderr.write(`adb: the device is '${state || "not found"}' (give --serial; run 'adb devices')\n`); return 2; }
  if ((await adb.shell(`pm path ${opts.pkg}`)).out.trim() === "") { process.stderr.write(`${opts.pkg} is not installed on the phone (--package)\n`); return 2; }
  mkdirSync(resolve(opts.shots), { recursive: true });
  mkdirSync(opts.state, { recursive: true, mode: 0o700 });
  const owner = new OwnerCli({ ownerPath: resolve(opts.owner), linkFile: resolve(opts.linkFile), stateDir: resolve(opts.state), adb, pkg: opts.pkg });
  try { await owner.refreshLink(); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }

  const shared = { cleanup: [] };
  const results = [];
  const probe = new Ctx({ adb, owner, opts, shared });
  const st = await probe.status();
  if (!st) { process.stderr.write("the hub does not answer on the link (is the app connected? open it and wait)\n"); return 2; }
  const dev = await probe.call("service:devices", "list");
  const phone = dev.ok ? (dev.data?.devices ?? []).find((d) => d.kind === "phone" && d.online) : null;
  console.log(`INFO scenarios.mjs ${VERSION} | hub ${st.version ?? "?"} up ${Math.round((st.uptime_ms ?? 0) / 60000)} min | phone ${phone ? `${phone.device} (${phone.name}, tier ${phone.tier ?? "?"})` : "NOT ONLINE"} | ${chosen.length} scenario(s)`);
  await probe.wake().catch(() => {});

  for (const s of chosen) {
    process.stderr.write(`... ${s.id} ${s.name}\n`);
    const r = await runOne(new Ctx({ adb, owner, opts, shared }), s);
    results.push(r);
    console.log(reportLine(r.status, r.id, r.name, r.detail));
  }
  for (const fn of shared.cleanup.splice(0).reverse()) { try { await fn(); } catch (e) { process.stderr.write(`cleanup: ${e.message}\n`); } }

  const count = (k) => results.filter((r) => r.status === k).length;
  console.log(`SUMMARY ${count("PASS")} pass, ${count("FAIL")} fail, ${count("SKIP")} skip, ${count("MANUAL")} manual (of ${results.length})`);
  if (opts.report) writeFileSync(resolve(opts.report), `${JSON.stringify({ at: new Date().toISOString(), serial: opts.serial ?? null, hub: st.version ?? null, results }, null, 2)}\n`);
  return count("FAIL") ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`scenarios.mjs: ${e?.stack ?? e}\n`); process.exit(2); });
}
