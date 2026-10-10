/**
 * Python is part of the promise of a working Linux box (the rules tell the agent it can just use it), but the image does
 * not carry it: the first time the main body opens, it is installed in the background, once per image.
 */
import type { ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProotConfig } from "./proot";

export const PROVISION_SCRIPT = "command -v python3 >/dev/null && exit 0; " +
  "apt-get -o DPkg::Lock::Timeout=300 update -q && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q python3 python3-pip python3-venv";

export const PROVISION_LOG = "container-provision.log";

/** True when the image has `apt-get` and no `python3`. */
export const needsProvision = (proot: ProotConfig): boolean =>
  existsSync(join(proot.rootfs, "usr", "bin", "apt-get")) && !existsSync(join(proot.rootfs, "usr", "bin", "python3"));

/**
 * Starts the installation unless one is running or the image already has python3. Never throws and never waits: output
 * and the way it ended go to `<stateDir>/container-provision.log`; a failure is only a line there.
 * `run` starts a command in the container with piped output. Returns the child that was started, or null.
 */
export function startProvision(
  proot: ProotConfig, stateDir: string, run: (argv: string[]) => ChildProcess, running: { current: boolean },
): ChildProcess | null {
  if (running.current || !needsProvision(proot)) return null;
  running.current = true;
  const logFile = join(stateDir, PROVISION_LOG);
  let log: ReturnType<typeof createWriteStream> | null = null;
  const note = (text: string): void => { try { log?.write(`${text}\n`); } catch { /* the log is a courtesy */ } };
  const finish = (text: string): void => {
    if (!running.current) return;
    running.current = false;
    note(text);
    try { log?.end(); } catch { /* ignore */ }
  };
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    log = createWriteStream(logFile, { flags: "a" });
    log.on("error", () => { log = null; });
    note(`[${new Date().toISOString()}] installing python3`);
    const child = run(["/bin/sh", "-c", PROVISION_SCRIPT]);
    child.stdout?.on("data", (chunk) => note(String(chunk).trimEnd()));
    child.stderr?.on("data", (chunk) => note(String(chunk).trimEnd()));
    child.on("error", (error) => finish(`failed to start: ${error.message}`));
    child.on("close", (code, signal) => finish(code === 0 ? "done" : `failed: exit ${code ?? signal}`));
    return child;
  } catch (error) {
    finish(`failed to start: ${(error as Error).message}`);
    return null;
  }
}
