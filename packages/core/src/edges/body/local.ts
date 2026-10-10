/**
 * The main body, member `body:main` (SPEC-09 §1, HUB-MODULES §2.6): the file system and shell the kernel carries.
 * The host's `isolation.kind` picks the implementation (SPEC-07 §2.2):
 * - `proot`: the Ubuntu root is read and written from the host side with `packages/workspace`; commands run inside the
 *   container through proot.
 * - `native`: no container; a directory on this machine and its shell (development machines, the fake host).
 */
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostIsolation } from "../../../../sdk/src/host";
import { MAIN_BODY_ID } from "../../../../sdk/src/ids";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import { standardContracts } from "../../../../sdk/src/namespaces";
import type { Member, Risk, WordContract } from "../../../../sdk/src/word";
import { Workspace, type Executor, type StreamPublisher } from "../../../../workspace/src";
import type { AppJson } from "../../../../sdk/src/app";
import { PROOT_WORKDIR, prootCommand, prootMounts, runInProot } from "./proot";

export interface LocalBodyOptions {
  /** How the host isolates the main body (host.json `isolation`). */
  isolation: HostIsolation;
  /** How a binary or large file travels to the caller (SPEC-03 §3.4). */
  streams?: StreamPublisher;
  /** Extra environment for commands inside the container (proot only). */
  env?: Record<string, string>;
  /** Runs a command instead of the default (proot, or the machine's own shell for native): for tests and unusual hosts. */
  exec?: Executor;
}

/** How the apps module starts an app's server and where the apps live (the shape of its `AppLauncher`). */
export interface BodyAppLauncher {
  /** The folder holding one folder per app, as the hub sees it. */
  root: string;
  /** The same folder as the agent sees it, when that differs. */
  agentRoot?: string;
  spawn(app: AppJson, dir: string, env: Record<string, string>): { command: string; args: string[]; env: Record<string, string>; cwd?: string };
}

export interface LocalBody extends Member {
  /**
   * Starts a program on this body with piped stdio (the agent runtime's process). `cwd` is a path on the body. Where and how
   * it runs depends on the isolation: in the container through proot, or directly on this machine for `native`.
   */
  spawn(argv: string[], opts?: { env?: Record<string, string>; cwd?: string }): ChildProcessWithoutNullStreams;
  /** Where the apps live on this body and how their servers are started; null when this body cannot run them. */
  appLauncher(): BodyAppLauncher | null;
  /** The risk of one call (SPEC-01 §6.3): a write inside the work directory is none. For the gate's `assess`. */
  assess(msg: Pick<Message, "word" | "body">): Promise<Risk | null>;
  /** Stops commands still running (kernel shutdown). */
  close(): Promise<void>;
}

/** The `bodies.kind` of the main body for this isolation. */
export const mainBodyKind = (isolation: HostIsolation): string => (isolation.kind === "proot" ? "proot-ubuntu" : isolation.kind);

/** The words of any body: the standard `workspace.*` and `body.info`, addressed to this member. */
export const bodyWords = (id: string): WordContract[] =>
  standardContracts().filter((contract) => contract.member === "body:*").map((contract) => ({ ...contract, member: id }));

export function createLocalBody(o: LocalBodyOptions): LocalBody {
  let workspace: Workspace | null = null;
  // The container may not be installed yet when the kernel starts; the body appears when its files do.
  const open = (): Workspace => {
    if (workspace) return workspace;
    const isolation = o.isolation;
    if (isolation.kind === "native") {
      mkdirSync(isolation.native.workspace, { recursive: true });
      return workspace = new Workspace({ root: isolation.native.workspace, ownership: "own", exec: o.exec, streams: o.streams });
    }
    if (isolation.kind !== "proot") throw new WordError("unavailable", `The ${isolation.kind} main body is not supported yet`);
    const proot = isolation.proot;
    if (!existsSync(proot.rootfs)) throw new WordError("unavailable", "The main body is not installed yet");
    mkdirSync(join(proot.rootfs, PROOT_WORKDIR), { recursive: true });
    return workspace = new Workspace({
      root: proot.rootfs, chroot: true, workdir: PROOT_WORKDIR, ownership: "own", streams: o.streams, mounts: prootMounts(proot),
      exec: o.exec ?? ((command, place) => runInProot(proot, ["/bin/bash", "-c", command], { workdir: place.cwd, env: o.env, detached: true })),
      // Command output is kept in the container's own /var/tmp, where a file call can read it too.
      spillDir: join(proot.rootfs, "var", "tmp", "ash-workspace"),
    });
  };
  const isolation = o.isolation;
  return {
    id: MAIN_BODY_ID,
    kind: "body",
    name: "main body",
    words: () => bodyWords(MAIN_BODY_ID),
    spawn(argv, opts = {}) {
      if (isolation.kind === "proot") {
        return runInProot(isolation.proot, argv, { ...(opts.cwd ? { workdir: opts.cwd } : {}), ...(opts.env ? { env: opts.env } : {}), stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      }
      if (isolation.kind === "native") {
        // The development form: the runtime named by the host runs straight on this machine, its place under the workspace.
        const cwd = join(isolation.native.workspace, opts.cwd ?? "");
        mkdirSync(cwd, { recursive: true });
        return spawnProcess(isolation.native.dsh_bin, argv.slice(1), { cwd, env: { ...process.env, DSH_HOME: isolation.native.dsh_home, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
      }
      throw new WordError("unavailable", `The ${isolation.kind} main body cannot run a program yet`);
    },
    appLauncher() {
      if (isolation.kind === "native") {
        return {
          root: join(isolation.native.workspace, "apps"),
          spawn: (app, dir, env) => ({
            command: app.server.command, args: app.server.args ?? [], cwd: dir,
            env: { HOME: process.env.HOME ?? "/root", PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8", TERM: "dumb", ...(app.server.env ?? {}), ...env },
          }),
        };
      }
      if (isolation.kind === "proot") {
        const proot = isolation.proot;
        return {
          root: join(proot.rootfs, "root", "apps"), agentRoot: "/root/apps",
          spawn: (app, dir, env) => {
            const run = prootCommand(proot, [app.server.command, ...(app.server.args ?? [])], { workdir: `/root/apps/${dir.split("/").pop()}`, env: { ...(app.server.env ?? {}), ...env } });
            return { command: run.command, args: run.args, env: run.env };
          },
        };
      }
      return null;
    },
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
      return open().call(msg.word, (msg.body ?? {}) as Record<string, unknown>, { signal: ctx.signal });
    },
    async assess(msg) {
      try { return await open().assess(msg.word, (msg.body ?? {}) as Record<string, unknown>); } catch { return null; }
    },
    async close() { await workspace?.close(); },
  };
}
