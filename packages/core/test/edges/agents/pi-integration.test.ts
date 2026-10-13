import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createPiDriver } from "../../../src/edges/agents/pi";
import { fixture, waitFor } from "./helpers";

// The hub's agents module with the real pi driver (registered as the fixture's default runtime) over a stand-in for `pi --mode rpc`.
const FAKE = new URL("./fake-pi-rpc.mjs", import.meta.url).pathname;
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

test("the agents module over the pi driver: nothing runs until a message comes; the answer reaches the owner; a process that dies fails that turn only (retry card), the agent stays up and answers the next message; the key reaches pi through its environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-int-"));
  dirs.push(dir);
  const logFile = join(dir, "pi.log");
  const written: Record<string, string> = {};
  const procs: ReturnType<typeof spawn>[] = [];
  const f = fixture({ secrets: { DEEPSEEK_API_KEY: "sk-fake-pi-key" }, drivers: { dsh: (report) => createPiDriver({
    report, writeFile: async (path, content) => { written[path] = content; }, argv: ["pi", "--mode", "rpc"],
    spawn: (argv, o) => { const p = spawn(process.execPath, [FAKE, ...argv.slice(1)], { env: { ...process.env, FAKE_LOG: logFile, ...(o?.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"], detached: true }); procs.push(p); return p; },
    probe: async () => false, hotMs: 200,
  }) } });
  await f.start();
  await waitFor(() => f.agents.manager.stateOf("agent:main") === "idle");
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) as Record<string, any>[];
  try {
    assert.match(written["/root/work/AGENTS.md"]!, /soul v1/);
    assert.equal(log().filter((l) => l.start).length, 0, "no process while nothing is going on");
    assert.equal(Object.keys(f.agents.manager.runs.get("agent:main")!.spec.sessions).length, 2, "the manager stored a handle per lane");

    await f.call("agent:main", "say", { text: "hello there" });
    await waitFor(() => f.router.says().length === 1);
    assert.equal(f.router.says()[0]!.text, "echo[deepseek/deepseek-flash]: hello there");
    assert.equal(f.router.events("turn.ended").length, 1);
    assert.equal(log().find((l) => l.start)!.env.KEY, "set", "the key the owner saved reached pi");

    await f.call("agent:main", "say", { text: "CRASH now" });
    await waitFor(() => f.router.to("person:owner", "show").length === 1, "the retry card");
    assert.deepEqual(f.router.events("turn.ended").map((e) => (e.msg.body as { outcome: string }).outcome), ["completed", "error"]);
    assert.equal(f.agents.manager.stateOf("agent:main"), "idle", "the agent is up: only the turn failed");
    assert.ok(f.registry.members.has("agent:main"));

    await f.call("agent:main", "say", { text: "still there?" });
    await waitFor(() => f.router.says().some((s) => s.text === "echo[deepseek/deepseek-flash]: still there?"));
    assert.ok(!JSON.stringify([f.router.sent, f.logs]).includes("sk-fake-pi-key"));
  } finally {
    await f.agents.stopAll();
    for (const p of procs) { try { process.kill(-p.pid!, "SIGKILL"); } catch { p.kill("SIGKILL"); } }
  }
});
