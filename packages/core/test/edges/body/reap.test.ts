import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpClient } from "../../../src/edges/agents/dsh/acp";
import { reapContainer } from "../../../src/edges/body/proot";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return check(); };

test("reapContainer ends what runs from the container's directory and nothing else", { skip: process.platform !== "linux" }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "reap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "container", "main");
  mkdirSync(join(root, "bin"), { recursive: true });
  const inside = join(root, "bin", "sleep");
  copyFileSync("/bin/sleep", inside);
  chmodSync(inside, 0o755);
  const left = spawn(inside, ["30"], { stdio: "ignore" });
  const other = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  t.after(() => { left.kill("SIGKILL"); other.kill("SIGKILL"); });
  await until(() => alive(left.pid!) && alive(other.pid!));
  assert.equal(reapContainer({ root }), 1);
  assert.ok(await until(() => left.exitCode !== null || left.signalCode !== null), "the leftover ended");
  assert.ok(alive(other.pid!), "a process outside the container is left alone");
});

test("stopping an agent started in its own group ends what it started too", { skip: process.platform === "win32" }, async () => {
  // sh stands in for proot: it starts a grandchild and does not pass a signal on to it.
  const child = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], { stdio: ["pipe", "pipe", "pipe"], detached: true });
  const grandchild = await new Promise<number>((resolve) => child.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  assert.ok(alive(grandchild));
  new AcpClient(child).close();
  assert.ok(await until(() => !alive(grandchild)), "the grandchild ended with its group");
  assert.ok(await until(() => child.exitCode !== null || child.signalCode !== null), "the agent ended");
});
