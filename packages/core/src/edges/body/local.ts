/**
 * The main body, member `body:main` (SPEC-09 §1, HUB-MODULES §2.6): the file system and shell of the proot Ubuntu the
 * kernel carries. Files are read and written on the host side of the Ubuntu root with `packages/workspace`; commands run
 * inside the container through proot.
 */
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MAIN_BODY_ID } from "../../../../sdk/src/ids";
import type { HandleContext, Message, WordResult } from "../../../../sdk/src/message";
import { standardContracts } from "../../../../sdk/src/namespaces";
import type { Member, Risk, WordContract } from "../../../../sdk/src/word";
import { Workspace, WorkspaceError, type Executor, type StreamPublisher } from "../../../../workspace/src";
import { PROOT_WORKDIR, prootMounts, runInProot, type ProotConfig } from "./proot";

export interface LocalBodyOptions {
  /** The container (host.json `isolation.proot`). */
  proot: ProotConfig;
  /** Ash's home inside the container. Default `/root/work`. */
  workdir?: string;
  /** How a binary or large file travels to the caller (SPEC-03 §3.4). */
  streams?: StreamPublisher;
  /** Extra environment for commands inside the container. */
  env?: Record<string, string>;
  /** Runs a command instead of proot: for tests on a machine without proot, and for a host that runs the body some other way. */
  exec?: Executor;
}

export interface LocalBody extends Member {
  /** The risk of one call (SPEC-01 §6.3): a write inside the work directory is none. For the gate's `assess`. */
  assess(msg: Pick<Message, "word" | "body">): Promise<Risk | null>;
  /** Stops commands still running (kernel shutdown). */
  close(): Promise<void>;
}

/** The words of any body: the standard `workspace.*` and `body.info`, addressed to this member. */
export const bodyWords = (id: string): WordContract[] =>
  standardContracts().filter((contract) => contract.member === "body:*").map((contract) => ({ ...contract, member: id }));

export function createLocalBody(o: LocalBodyOptions): LocalBody {
  const workdir = o.workdir ?? PROOT_WORKDIR;
  const exec: Executor = o.exec ?? ((command, place) => runInProot(o.proot, ["/bin/bash", "-c", command], { workdir: place.cwd, env: o.env, detached: true }));
  let workspace: Workspace | null = null;
  // The container may not be installed yet when the kernel starts; the body appears when its files do.
  const open = (): Workspace => {
    if (workspace) return workspace;
    if (!existsSync(o.proot.rootfs)) throw new WorkspaceError("unavailable", "The main body is not installed yet");
    mkdirSync(join(o.proot.rootfs, workdir), { recursive: true });
    return workspace = new Workspace({
      root: o.proot.rootfs, chroot: true, workdir, ownership: "own", exec, streams: o.streams, mounts: prootMounts(o.proot),
      // Command output is kept in the container's own /var/tmp, where a file call can read it too.
      spillDir: join(o.proot.rootfs, "var", "tmp", "ash-workspace"),
    });
  };
  return {
    id: MAIN_BODY_ID,
    kind: "body",
    name: "main body",
    words: () => bodyWords(MAIN_BODY_ID),
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
      return open().call(msg.word, (msg.body ?? {}) as Record<string, unknown>, { signal: ctx.signal });
    },
    async assess(msg) {
      try { return await open().assess(msg.word, (msg.body ?? {}) as Record<string, unknown>); } catch { return null; }
    },
    async close() { await workspace?.close(); },
  };
}
