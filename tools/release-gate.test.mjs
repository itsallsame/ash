import assert from "node:assert/strict";
import test from "node:test";
import { cpuBetween, judge, parseArgs, parseGfx, parseSnapshot, parseStat, rendererPids } from "./release-gate.mjs";

const stat = (pid, name, utime, stime) => `${pid} (${name}) S 1 1 1 0 -1 4194560 100 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 100 1000 1000`;
const snap = (up, app, thread) => `U ${up}\nP 10 ${stat(10, "ai.ash.agent", app, 0)}\nT 10 ${stat(10, "ai.ash.agent", 1, 0)}\nT 10 ${stat(11, "ash-link", thread, 0)}\n`;

test("a process name with spaces and brackets does not shift the fields", () => {
  assert.deepEqual(parseStat(stat(7, "Binder:7_1 (x)", 30, 12)), { id: 7, name: "Binder:7_1 (x)", ticks: 42 });
  assert.equal(parseStat("garbage"), null);
});

test("CPU is ticks over the time between two snapshots; the busiest threads are named", () => {
  const before = parseSnapshot(snap(100, 1000, 100));
  const after = parseSnapshot(snap(110, 1550, 600));
  const cpu = cpuBetween(before, after)["10"];
  assert.equal(cpu.cpu_pct, 55);
  assert.deepEqual(cpu.threads[0], { name: "ash-link", cpu_pct: 50 });
  assert.deepEqual(cpuBetween(before, before), {}, "no time passed, nothing to say");
});

test("gfxinfo is read for frames and the 95th percentile", () => {
  assert.deepEqual(parseGfx("Total frames rendered: 1234\n95th percentile: 17ms\n"), { frames: 1234, p95_ms: 17 });
  assert.deepEqual(parseGfx(""), { frames: null, p95_ms: null });
  assert.deepEqual(parseGfx("Total frames rendered: 0\n95th percentile: 4950ms\n"), { frames: 0, p95_ms: null }, "an empty Android histogram is not a 4950ms frame");
});

test("a metric over its budget fails, one nobody could measure fails too, a phase that was not run is not judged", () => {
  const budgets = { _: "x", fg_idle: { app_cpu_pct: 8, health_breaches: 0 }, daily: { frame_p95_ms: 32 } };
  const rows = judge(budgets, { fg_idle: { app_cpu_pct: 110, health_breaches: null } });
  assert.deepEqual(rows.map((r) => [r.metric, r.pass]), [["app_cpu_pct", false], ["health_breaches", false]]);
  assert.ok(judge(budgets, { fg_idle: { app_cpu_pct: 3, health_breaches: 0 } }).every((r) => r.pass));
});

test("arguments: phases are checked, the scale must be above zero", () => {
  assert.deepEqual(parseArgs(["--phases", "fg_idle,daily", "--scale", "0.1", "--input-xy", "540,2100"]).phases, ["fg_idle", "daily"]);
  assert.throws(() => parseArgs(["--phases", "nap"]));
  assert.throws(() => parseArgs(["--scale", "0"]));
});

// A browser on the test phone may have its own renderer with the same process name.
test("renderer CPU belongs to the app's bound services, not every web view", () => {
  const dump = `  * ServiceRecord{a u0 ai.ash.agent/org.chromium.content.app.SandboxedProcessService0:0}
    app=ProcessRecord{b 101:com.google.android.webview:sandboxed_process0/u0i1}
    isolatedProc=ProcessRecord{b 101:com.google.android.webview:sandboxed_process0/u0i1}
  * ServiceRecord{c u0 other.browser/org.chromium.content.app.SandboxedProcessService0:0}
    app=ProcessRecord{d 202:com.google.android.webview:sandboxed_process0/u0i2}
  * ServiceRecord{e u0 ai.ash.agent/ai.ash.link.HandService}
    app=ProcessRecord{f 303:ai.ash.agent/u0a1}`;
  assert.deepEqual(rendererPids(dump), [101]);
  assert.deepEqual(rendererPids(""), []);
});

test("daily cannot silently omit typing", () => {
  assert.throws(() => parseArgs([]), /--input-xy/);
  assert.throws(() => parseArgs(["--input-xy", "bad,2100"]), /--input-xy/);
  assert.deepEqual(parseArgs(["--phases", "fg_idle"]).phases, ["fg_idle"]);
});
