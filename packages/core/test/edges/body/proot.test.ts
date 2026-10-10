import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTAINER_PATH, prootCommand, prootMounts, runInProot, type ProotConfig } from "../../../src/edges/body/proot";

async function container(): Promise<{ dir: string; config: ProotConfig }> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "proot-"));
  const root = join(dir, "main");
  await mkdir(join(root, "ubuntu"), { recursive: true });
  await mkdir(join(dir, "sdcard"));
  return { dir, config: { root, rootfs: join(root, "ubuntu"), bin: join(root, "proot", "bin", "proot"), loader: join(root, "proot", "libexec", "loader"), lib: join(root, "proot", "lib"),
    storage_binds: [`${join(dir, "sdcard")}:/sdcard`, "/does/not/exist:/gone"] } };
}

test("prootCommand: the container root, the work directory, a clean environment, and the host side's proot variables", async () => {
  const { dir, config } = await container();
  try {
    const run = prootCommand(config, ["/bin/echo", "hi"], { env: { FOO: "bar", PATH: "/custom" } });
    assert.equal(run.command, config.bin);
    assert.deepEqual(run.args.slice(0, 5), ["--kill-on-exit", "--link2symlink", "-0", "-r", config.rootfs]);
    assert.equal(run.args[run.args.indexOf("-w") + 1], "/root/work");
    const afterEnv = run.args.slice(run.args.indexOf("/usr/bin/env"));
    assert.deepEqual(afterEnv.slice(0, 2), ["/usr/bin/env", "-i"]);
    assert.deepEqual(afterEnv.slice(-2), ["/bin/echo", "hi"]);
    const vars = afterEnv.slice(2, -2);
    assert.ok(vars.includes("FOO=bar") && vars.includes("PATH=/custom") && vars.includes("HOME=/root") && vars.includes("TMPDIR=/tmp"));
    assert.equal(vars.filter((v) => v.startsWith("PATH=")).length, 1);
    assert.equal(prootCommand(config, ["x"]).args.includes(`PATH=${CONTAINER_PATH}`), true);
    // only storage binds whose host side exists are bound; /tmp is not redirected
    const binds = run.args.flatMap((arg, i) => (run.args[i - 1] === "-b" ? [arg] : []));
    assert.deepEqual(binds, ["/dev", "/proc", "/sys", `${join(dir, "sdcard")}:/sdcard`]);
    assert.deepEqual(prootMounts(config), [{ guest: "/sdcard", host: join(dir, "sdcard") }]);
    assert.deepEqual(run.env, { LD_LIBRARY_PATH: config.lib, PROOT_LOADER: config.loader, PROOT_TMP_DIR: join(config.root, "tmp"), PATH: process.env.PATH });
    assert.equal(prootCommand(config, ["x"], { workdir: "/opt" }).args[prootCommand(config, ["x"], { workdir: "/opt" }).args.indexOf("-w") + 1], "/opt");
    assert.throws(() => prootCommand(config, []), /empty/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runInProot: starts the proot binary with that command line and returns the child", async () => {
  const { dir, config } = await container();
  try {
    await mkdir(join(config.root, "proot", "bin"), { recursive: true });
    await writeFile(config.bin, '#!/bin/sh\nprintf "%s\\n" "$LD_LIBRARY_PATH" "$PROOT_TMP_DIR"\nfor a in "$@"; do printf "[%s]" "$a"; done\n');
    await chmod(config.bin, 0o755);
    const child = runInProot(config, ["/bin/true"], { workdir: "/root/work/x" });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    const [lib, tmp, args] = out.split("\n");
    assert.equal(lib, config.lib);
    assert.equal(tmp, join(config.root, "tmp"));
    assert.match(args!, /^\[--kill-on-exit\]\[--link2symlink\]\[-0\]\[-r\]\[.*\/ubuntu\]/);
    assert.match(args!, /\[-w\]\[\/root\/work\/x\]\[\/usr\/bin\/env\]\[-i\].*\[\/bin\/true\]$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
