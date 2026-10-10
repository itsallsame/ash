/**
 * Runs a command inside the main body's proot Ubuntu. The one place that knows how proot is started: the main body
 * (shell commands) and the DSH driver (the agent process) both start things through it.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostProotIsolation } from "../../../../sdk/src/host";

/** The proot part of the host's launch description (`isolation.proot`, SPEC-07 §2.1). */
export type ProotConfig = HostProotIsolation["proot"];

/** Where commands start in the container: Ash's home. */
export const PROOT_WORKDIR = "/root/work";
/** The search path inside the container; `/opt/node/bin` is the Node the image carries. */
export const CONTAINER_PATH = "/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface ProotOptions {
  /** The directory the command starts in, as the container sees it. Default `/root/work`. */
  workdir?: string;
  /** The whole environment of the command inside (nothing else is passed in); these are added to the defaults below. */
  env?: Record<string, string>;
}

/** What the command inside gets unless `env` says otherwise. */
const DEFAULT_ENV: Record<string, string> = { HOME: "/root", PATH: CONTAINER_PATH, TMPDIR: "/tmp", TERM: "dumb", LANG: "C.UTF-8" };

export interface ProotCommand { command: string; args: string[]; env: Record<string, string> }

/**
 * The command line that runs `argv` in the container (no process is started).
 * Inside, `/tmp` is the image's own `/tmp` (so a file written to /tmp by a file call is the one a command sees);
 * proot's own scratch directory is `<root>/tmp` on the host.
 */
export function prootCommand(proot: ProotConfig, argv: string[], opts: ProotOptions = {}): ProotCommand {
  if (argv.length === 0) throw new Error("prootCommand: argv is empty");
  const inside = Object.entries({ ...DEFAULT_ENV, ...(opts.env ?? {}) }).map(([key, value]) => `${key}=${value}`);
  const binds = (proot.storage_binds ?? []).flatMap((bind) => {
    const host = bind.slice(0, bind.indexOf(":"));
    return bind.includes(":") && host && existsSync(host) ? ["-b", bind] : [];
  });
  return {
    command: proot.bin,
    args: ["--kill-on-exit", "--link2symlink", "-0", "-r", proot.rootfs, "-b", "/dev", "-b", "/proc", "-b", "/sys", ...binds,
      "-w", opts.workdir ?? PROOT_WORKDIR, "/usr/bin/env", "-i", ...inside, ...argv],
    env: { LD_LIBRARY_PATH: proot.lib, PROOT_LOADER: proot.loader, PROOT_TMP_DIR: join(proot.root, "tmp"), PATH: process.env.PATH ?? "/system/bin" },
  };
}

export interface ProotSpawnOptions extends ProotOptions {
  /** Start it in its own process group, so one signal reaches everything it starts. Default false. */
  detached?: boolean;
  /** Default: stdin ignored, stdout and stderr piped. */
  stdio?: StdioOptions;
}

/** Starts `argv` in the container and returns the child. */
export function runInProot(proot: ProotConfig, argv: string[], opts: ProotSpawnOptions = {}): ChildProcess {
  const run = prootCommand(proot, argv, opts);
  mkdirSync(run.env.PROOT_TMP_DIR!, { recursive: true });
  return spawn(run.command, run.args, { env: run.env, detached: opts.detached ?? false, stdio: opts.stdio ?? ["ignore", "pipe", "pipe"] });
}

/** The container's mounts that have a counterpart on the host side: `storage_binds` entries `host:guest` whose host side exists. */
export function prootMounts(proot: ProotConfig): { guest: string; host: string }[] {
  return (proot.storage_binds ?? []).flatMap((bind) => {
    const at = bind.indexOf(":");
    const host = bind.slice(0, at), guest = bind.slice(at + 1);
    return at > 0 && guest.startsWith("/") && existsSync(host) ? [{ guest, host }] : [];
  });
}
