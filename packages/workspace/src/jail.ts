import { lstat, readlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, sep } from "node:path";
import { WorkspaceError } from "./errors";

const MAX_LINKS = 40;

/** Cuts a path into its parts, dropping empty ones and `.`. */
const parts = (path: string): string[] => path.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");

/** True when `path` is `root` or lies under it (both absolute and already resolved). */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

/**
 * Keeps every path under one root directory, links followed.
 *
 * Two ways to show paths:
 * - `chroot: false` (a real machine): paths are the machine's own paths; one that lands outside the root is refused.
 * - `chroot: true` (a root file system that is not the machine's own, e.g. a container's): the root is "/", an absolute
 *   path and an absolute link target both start from it, and `..` stops at it. Paths shown to the caller are root-based.
 *
 * Links are resolved one step at a time (the target may not exist yet: a file about to be written).
 */
export class Jail {
  readonly root: string;
  private readonly mounts: { guest: string[]; host: string }[];
  /**
   * `mounts` (chroot only): host directories that appear inside the root at another place, like a container's bind
   * mounts. `guest` is the root-based path, `host` the directory on this machine.
   */
  constructor(root: string, readonly chroot: boolean, mounts: { guest: string; host: string }[] = []) {
    this.root = realpathSync(root);
    this.mounts = chroot ? mounts.map((m) => ({ guest: parts(m.guest), host: m.host })).sort((x, y) => y.guest.length - x.guest.length) : [];
  }

  /** The machine path of the root-based path made of `stack` (the root of a chroot, or `base`). */
  private hostOf(base: string, stack: string[]): string {
    for (const mount of this.mounts) {
      if (mount.guest.length <= stack.length && mount.guest.every((part, i) => stack[i] === part)) return join(mount.host, ...stack.slice(mount.guest.length));
    }
    return join(base, ...stack);
  }

  /** The directory a shown path starts from when it is absolute. */
  private base(shown: string): string {
    return this.chroot ? this.root : parse(shown).root || "/";
  }

  /** The host path a shown path means. `cwd` is the shown directory a relative path starts from. */
  async resolve(input: string, cwd: string): Promise<string> {
    const shown = isAbsolute(input) || (this.chroot && /^[\\/]/.test(input)) ? input : join(cwd, input);
    const base = this.base(shown);
    let pending = parts(this.chroot ? shown : relative(parse(shown).root, shown));
    const stack: string[] = [];
    let links = 0;
    while (pending.length > 0) {
      const part = pending.shift()!;
      if (part === "..") { stack.pop(); continue; }
      const at = this.hostOf(base, [...stack, part]);
      let info;
      try { info = await lstat(at); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") { stack.push(part); continue; }
        throw error;
      }
      if (!info.isSymbolicLink()) { stack.push(part); continue; }
      if (++links > MAX_LINKS) throw new WorkspaceError("bad_request", "Too many levels of symbolic links");
      const target = await readlink(at);
      if (/^[\\/]/.test(target) || isAbsolute(target)) {
        // In a host path an absolute target starts from the machine's root; in a chroot, from the jail's root.
        stack.length = 0;
        pending = this.chroot ? [...parts(target), ...pending] : [...parts(relative(parse(target).root, target)), ...pending];
      } else {
        pending = [...parts(target), ...pending];
      }
    }
    const host = this.hostOf(base, stack);
    if (!this.chroot && !isWithin(this.root, host)) throw new WorkspaceError("forbidden", "The path is outside the work root");
    return host;
  }

  /** The path to show for a host path; null when it cannot be shown (outside the root of a chroot). */
  show(host: string): string | null {
    if (!this.chroot) return host;
    for (const mount of this.mounts) {
      if (isWithin(mount.host, host)) return "/" + [...mount.guest, ...relative(mount.host, host).split(sep).filter(Boolean)].join("/");
    }
    if (!isWithin(this.root, host)) return null;
    return "/" + relative(this.root, host).split(sep).filter(Boolean).join("/");
  }

  /** The shown form of the root itself. */
  get shownRoot(): string { return this.chroot ? "/" : this.root; }
}
