#!/usr/bin/env node
// The release gate: runs a build on the test phone the way an owner leaves it and uses it, and judges behaviour against
// tools/release-budgets.json. Four phases: the app in front and left alone (fg_idle), in the background (bg_idle), with the
// screen off (screen_off), and a short scripted use (daily). Per phase it reads, from the phone, the CPU of the app, the web
// view renderers and the kernel (/proc, with the busiest threads), frames drawn (gfxinfo) and memory (meminfo); from the hub,
// `service:health` (rates and the budget breaches it wrote). Exit 0 when every budget is kept.
//
//   node tools/release-gate.mjs --serial <adb serial> --link-file link.json [--phases fg_idle,daily] [--scale 0.1] [--input-xy 540,2100]
//
// --scale shortens the waits (0.1 = a dry run of a minute and a half); a scaled run says so and always exits 1: it is not a gate.
// The debug build of the app is needed (the link is read with run-as), see tools/e2e/README.md. Report: build/release-gate/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Adb, OwnerCli, parsePs, totalPssKb } from "./e2e/scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLK_TCK = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- judging: pure functions over what the phone printed ----

/** `/proc/<pid>/stat` (or a task's): the name between the brackets may hold spaces and brackets, so split after the last one. */
export function parseStat(line) {
  const text = String(line ?? "");
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(" ");
  const utime = Number(rest[11]), stime = Number(rest[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? { id: Number(text.slice(0, open)), name: text.slice(open + 1, close), ticks: utime + stime } : null;
}

/** The snapshot script's output: `U <uptime>`, `P <pid> <stat>`, `T <pid> <task stat>` lines -> `{up, procs: {pid: {name, ticks, threads: {tid: {name, ticks}}}}}`. */
export function parseSnapshot(text) {
  const snap = { up: null, procs: {} };
  for (const line of String(text ?? "").split("\n")) {
    const [kind, a, ...rest] = line.trim().split(" ");
    if (kind === "U") snap.up = Number(a);
    else if (kind === "P" || kind === "T") {
      const stat = parseStat(rest.join(" "));
      if (!stat) continue;
      const proc = (snap.procs[a] ??= { name: "", ticks: 0, threads: {} });
      if (kind === "P") Object.assign(proc, { name: stat.name, ticks: stat.ticks });
      else proc.threads[stat.id] = { name: stat.name, ticks: stat.ticks };
    }
  }
  return snap;
}

/** CPU percent of one core for each pid over the time between two snapshots, and the busiest threads by name. */
export function cpuBetween(before, after) {
  const seconds = (after.up ?? 0) - (before.up ?? 0);
  const out = {};
  if (!(seconds > 0)) return out;
  for (const [pid, now] of Object.entries(after.procs)) {
    const was = before.procs[pid];
    if (!was) continue;
    const byName = {};
    for (const [tid, t] of Object.entries(now.threads)) byName[t.name] = (byName[t.name] ?? 0) + Math.max(0, t.ticks - (was.threads[tid]?.ticks ?? t.ticks));
    out[pid] = {
      name: now.name, cpu_pct: round((Math.max(0, now.ticks - was.ticks) / CLK_TCK / seconds) * 100),
      threads: Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, ticks]) => ({ name, cpu_pct: round((ticks / CLK_TCK / seconds) * 100) })),
    };
  }
  return out;
}

/** From `dumpsys gfxinfo <pkg>`: frames drawn and the 95th percentile frame time (ms). */
export function parseGfx(dump) {
  const text = String(dump ?? "");
  const frames = /Total frames rendered:\s*(\d+)/.exec(text);
  const p95 = /95th percentile:\s*(\d+)ms/.exec(text);
  return { frames: frames ? Number(frames[1]) : null, p95_ms: p95 ? Number(p95[1]) : null };
}

/** Every budgeted metric against its value: `[{phase, metric, value, budget, pass}]`. A metric nobody could measure fails: it cannot be shown to be kept. */
export function judge(budgets, metrics) {
  const rows = [];
  for (const [phase, limits] of Object.entries(budgets)) {
    if (phase.startsWith("_") || !metrics[phase]) continue;
    for (const [metric, budget] of Object.entries(limits)) {
      const value = metrics[phase][metric] ?? null;
      rows.push({ phase, metric, value, budget, pass: value !== null && value <= budget });
    }
  }
  return rows;
}
const round = (n) => Math.round(n * 10) / 10;

// ---- the phone ----

const PHASES = { fg_idle: 600, bg_idle: 300, screen_off: 300, daily: 180 };
const PACKAGE = "ai.ash.agent", KERNEL = "ai.ash.kernel";

class Phone {
  constructor(adb, owner, inputXy) { this.adb = adb; this.owner = owner; this.inputXy = inputXy; }
  async pids() {
    const pid = async (pkg) => Number((await this.adb.shell(`pidof ${pkg}`)).out.trim().split(/\s+/)[0]) || null;
    const ps = (await this.adb.shell("ps -A -o PID,ARGS")).out;
    return { app: await pid(PACKAGE), host: await pid(KERNEL), core: parsePs(ps, /runtime\/bin\/node/)[0]?.pid ?? null, renderers: parsePs(ps, /sandboxed_process/).map((p) => p.pid) };
  }
  async snapshot(pids) {
    const list = [pids.app, pids.host, pids.core, ...pids.renderers].filter(Boolean).join(" ");
    const script = `echo "U $(cut -d' ' -f1 /proc/uptime)"; for p in ${list}; do echo "P $p $(cat /proc/$p/stat 2>/dev/null)"; for f in /proc/$p/task/*/stat; do echo "T $p $(cat $f 2>/dev/null)"; done; done`;
    return parseSnapshot((await this.adb.shell(script)).out);
  }
  launch() { return this.adb.shell(`monkey -p ${PACKAGE} -c android.intent.category.LAUNCHER 1`).then(() => sleep(2500)); }
  async act(phase) {
    const { adb } = this;
    if (phase === "fg_idle") { await adb.shell("input keyevent 224"); await adb.shell("wm dismiss-keyguard"); await this.launch(); }
    else if (phase === "bg_idle") await adb.key(3);
    else if (phase === "screen_off") await adb.key(223);
  }
  /** The scripted use of `daily`: open, type, scroll the history, leave and come back, ask the hub. */
  async daily() {
    const { adb, owner } = this;
    await this.launch();
    if (this.inputXy) { await adb.tap(...this.inputXy); for (const chunk of ["hello", "ash", "gate", "test"]) { await adb.shell(`input text ${chunk}`); await sleep(500); } await adb.key(67); }
    for (let i = 0; i < 6; i++) { await adb.shell("input swipe 540 700 540 1700 200"); await sleep(600); }
    await adb.key(3); await sleep(3000); await this.launch();
    await owner.call("service:history", "query", { limit: 20 });
  }
}

export async function runGate(opts, log = (m) => process.stderr.write(`${m}\n`)) {
  const budgets = JSON.parse(readFileSync(opts.budgets, "utf8"));
  const adb = new Adb({ bin: opts.adb, serial: opts.serial });
  if ((await adb.state()) !== "device") throw new Error("adb: no device (give --serial)");
  const owner = new OwnerCli({ ownerPath: resolve(opts.owner), linkFile: resolve(opts.linkFile), stateDir: resolve(opts.state), adb, pkg: PACKAGE, name: "release-gate" });
  mkdirSync(opts.state, { recursive: true, mode: 0o700 });
  await owner.refreshLink();
  const phone = new Phone(adb, owner, opts.inputXy);
  const metrics = {}, detail = {};
  for (const phase of opts.phases) {
    const seconds = Math.round(PHASES[phase] * opts.scale);
    log(`... ${phase} (${seconds} s)`);
    await phone.act(phase);
    const pids = await phone.pids();
    const health0 = (await owner.call("service:health", "status", {})).data;
    const started = Date.now();
    await adb.shell(`dumpsys gfxinfo ${PACKAGE} reset`);
    const before = await phone.snapshot(pids);
    const gfx0 = parseGfx((await adb.shell(`dumpsys gfxinfo ${PACKAGE}`)).out);
    if (phase === "daily") await phone.daily();
    await sleep(Math.max(0, seconds * 1000 - (Date.now() - started)));
    const after = await phone.snapshot(pids);
    const gfx = parseGfx((await adb.shell(`dumpsys gfxinfo ${PACKAGE}`)).out);
    const cpu = cpuBetween(before, after);
    const elapsed = (after.up ?? 0) - (before.up ?? 0);
    const sum = (ids) => round(ids.reduce((n, id) => n + (cpu[id]?.cpu_pct ?? 0), 0));
    const health = (await owner.call("service:health", "status", { window_s: Math.min(3600, Math.max(60, seconds)) })).data;
    const events = (await owner.call("service:health", "recent", { since: started, limit: 100 })).data?.events ?? [];
    const breaches = events.filter((e) => e.type === "breach");
    metrics[phase] = {
      app_cpu_pct: pids.app && cpu[pids.app] ? cpu[pids.app].cpu_pct : null,
      render_cpu_pct: pids.renderers.length ? sum(pids.renderers) : null,
      kernel_cpu_pct: pids.core && cpu[pids.core] ? cpu[pids.core].cpu_pct : null,
      host_cpu_pct: pids.host && cpu[pids.host] ? cpu[pids.host].cpu_pct : null,
      frames_per_s: gfx.frames !== null && gfx0.frames !== null && elapsed > 0 ? round((gfx.frames - gfx0.frames) / elapsed) : null,
      frame_p95_ms: gfx.p95_ms,
      ledger_rows_per_min: health ? health.rates.ledger_rows_per_min : null,
      health_breaches: health ? breaches.length : null,
      kernel_restarts: health && health0 ? (health.uptime_s + 5 < health0.uptime_s + elapsed - 5 ? 1 : 0) : null,
    };
    detail[phase] = {
      seconds, threads: Object.fromEntries(Object.entries({ app: pids.app, kernel: pids.core }).filter(([, p]) => p).map(([k, p]) => [k, cpu[p]?.threads ?? []])),
      pss_kb: { app: totalPssKb((await adb.shell(`dumpsys meminfo ${PACKAGE}`)).out), kernel: totalPssKb((await adb.shell(`dumpsys meminfo ${KERNEL}`)).out) },
      top_words: health?.top ?? [], breaches,
    };
  }
  await adb.key(224);
  const rows = judge(budgets, metrics);
  return { at: new Date().toISOString(), serial: opts.serial ?? null, scale: opts.scale, hub: (await owner.call("service:admin", "status", {})).data?.version ?? null, pass: rows.length > 0 && rows.every((r) => r.pass), rows, metrics, detail };
}

export function parseArgs(argv, env = process.env) {
  const o = { serial: env.ANDROID_SERIAL, linkFile: "link.json", adb: "adb", owner: join(HERE, "e2e/owner.mjs"), budgets: join(HERE, "release-budgets.json"), state: join(homedir(), ".ash-owner-gate"),
    out: "build/release-gate", phases: Object.keys(PHASES), scale: 1, inputXy: null };
  const names = { serial: "serial", "link-file": "linkFile", adb: "adb", owner: "owner", budgets: "budgets", state: "state", out: "out", phases: "phases", scale: "scale", "input-xy": "inputXy" };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]?.replace(/^--/, "")];
    if (!argv[i].startsWith("--") || !key || argv[i + 1] === undefined) throw new Error(`cannot use ${argv[i]}`);
    o[key] = argv[++i];
  }
  o.scale = Number(o.scale);
  if (!(o.scale > 0)) throw new Error("--scale must be above 0");
  if (typeof o.phases === "string") o.phases = o.phases.split(",");
  if (o.phases.some((p) => !PHASES[p])) throw new Error(`phases are ${Object.keys(PHASES).join(", ")}`);
  if (typeof o.inputXy === "string") o.inputXy = o.inputXy.split(",").map(Number);
  return o;
}

export async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { process.stderr.write(`release-gate: ${e.message}\n`); return 64; }
  const report = await runGate(opts);
  for (const r of report.rows) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.phase} ${r.metric} ${r.value ?? "no data"} (budget ${r.budget})`);
  mkdirSync(resolve(opts.out), { recursive: true });
  const file = join(resolve(opts.out), `${report.hub ?? "unknown"}-${report.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.pass ? "PASS" : "FAIL"} release gate${report.scale === 1 ? "" : ` (scaled ${report.scale}: not a gate)`} -> ${file}`);
  return report.pass && report.scale === 1 ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`release-gate: ${e.message}\n`); process.exit(2); });
