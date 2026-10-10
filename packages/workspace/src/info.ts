import { access, readFile, statfs } from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem, type } from "node:os";
import { delimiter, join } from "node:path";
import type { Jail } from "./jail";

const PACKAGE_MANAGERS = ["apt-get", "dnf", "yum", "apk", "pacman", "zypper", "brew", "winget", "choco"];

const exists = (path: string) => access(path).then(() => true, () => false);

async function packageManager(jail: Jail): Promise<string | null> {
  const dirs = jail.chroot
    ? ["usr/local/bin", "usr/bin", "bin", "usr/sbin", "sbin"].map((dir) => join(jail.root, dir))
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of PACKAGE_MANAGERS) for (const dir of dirs) if (await exists(join(dir, name))) return name === "apt-get" ? "apt" : name;
  return null;
}

async function systemName(jail: Jail): Promise<string> {
  if (jail.chroot) {
    const text = await readFile(join(jail.root, "etc", "os-release"), "utf8").catch(() => "");
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(text)?.[1];
    if (pretty) return pretty;
  }
  return `${type()} ${release()}`;
}

/** The structured result of `body.info`. */
export async function describeBody(jail: Jail, workdir: string, ownership: "own" | "borrowed"): Promise<Record<string, unknown>> {
  const disk = await statfs(jail.root).then((s) => ({ total: s.blocks * s.bsize, free: s.bavail * s.bsize }), () => ({}));
  const cpu = cpus();
  const fullLinux = jail.chroot
    ? await exists(join(jail.root, "etc", "os-release")) && await exists(join(jail.root, "usr", "bin"))
    : platform() === "linux";
  return {
    system: await systemName(jail),
    arch: arch(),
    full_linux: fullLinux,
    package_manager: await packageManager(jail),
    workdir,
    resources: { cpu: { count: cpu.length, model: cpu[0]?.model ?? null }, memory: { total: totalmem(), free: freemem() }, disk },
    ownership,
  };
}
