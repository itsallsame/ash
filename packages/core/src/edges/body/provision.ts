/**
 * Python is part of the promise of a working Linux box (the rules tell the agent it can just use it), but the image does
 * not carry it: once the main agent is up, it is installed in the background, once per run of the hub.
 */
import type { ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProotConfig } from "./proot";

/** `dpkg --configure -a` first: a package left half-installed by an interrupted run would make the install fail. */
export const PROVISION_SCRIPT = "dpkg --configure -a; command -v python3 >/dev/null && exit 0; " +
  "apt-get -o DPkg::Lock::Timeout=300 update -q && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q python3 python3-pip python3-venv";

export const PROVISION_LOG = "container-provision.log";

/** True when the image has `apt-get` and no `python3`. */
export const needsProvision = (proot: ProotConfig): boolean =>
  existsSync(join(proot.rootfs, "usr", "bin", "apt-get")) && !existsSync(join(proot.rootfs, "usr", "bin", "python3"));

/** Where the installation is: not started, running, or started in this run (finished or failed; not repeated). */
export interface ProvisionState { phase: "idle" | "running" | "tried" }

/**
 * Starts the installation unless one was started in this run or the image already has python3. Never throws and never waits: output
 * and the way it ended go to `<stateDir>/container-provision.log`; a failure is only a line there.
 * `run` starts a command in the container with piped output. Returns the child that was started, or null.
 */
export function startProvision(
  proot: ProotConfig, stateDir: string, run: (argv: string[]) => ChildProcess, state: ProvisionState,
): ChildProcess | null {
  if (state.phase !== "idle" || !needsProvision(proot)) return null;
  state.phase = "running";
  const logFile = join(stateDir, PROVISION_LOG);
  let log: ReturnType<typeof createWriteStream> | null = null;
  const note = (text: string): void => { try { log?.write(`${text}\n`); } catch { /* the log is a courtesy */ } };
  const finish = (text: string): void => {
    if (state.phase !== "running") return;
    state.phase = "tried";
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
