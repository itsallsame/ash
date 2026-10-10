import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HandleContext, Message } from "../../../../sdk/src/message";
import { lintWords } from "../../../../sdk/src/word";
import { createLocalBody, bodyWords, mainBodyKind, type LocalBody } from "../../../src/edges/body/local";
import type { ProotConfig } from "../../../src/edges/body/proot";

const caller = { member: "agent:cloud", via: "agent" as const, local: false };
let seq = 0;
const ask = (body: LocalBody, word: string, args: Record<string, unknown>, signal = new AbortController().signal) =>
  body.handle({ seq: ++seq, id: `m${seq}`, ts: 1, from: caller.member, to: "body:main", kind: "request", word, body: args } as Message, { signal, caller, raw: args } satisfies HandleContext) as Promise<{ data: Record<string, any>; content: any[] }>;

interface Fixture { dir: string; rootfs: string; streams: { bytes: Uint8Array; mime: string }[]; body: LocalBody; ran: { command: string; cwd: string }[] }

/** A fake container root on the host: just a directory tree. Commands run on the host in the matching host directory. */
async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-"));
  const rootfs = join(dir, "main", "ubuntu");
  await mkdir(join(rootfs, "etc"), { recursive: true });
  await mkdir(join(rootfs, "usr", "bin"), { recursive: true });
  await writeFile(join(rootfs, "etc", "os-release"), 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n');
  await writeFile(join(rootfs, "usr", "bin", "apt-get"), "");
  const proot: ProotConfig = { root: join(dir, "main"), rootfs, bin: "/nonexistent/proot", loader: "", lib: "" };
  const streams: Fixture["streams"] = [];
  const ran: Fixture["ran"] = [];
  const body = createLocalBody({
    isolation: { kind: "proot", proot }, streams: (bytes, meta) => { streams.push({ bytes, mime: meta.mime }); return `st_${streams.length}`; },
    exec: (command, place) => { ran.push({ command, cwd: place.cwd }); return spawn("sh", ["-c", command], { cwd: place.hostCwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }); },
  });
  return { dir, rootfs, streams, body, ran };
}
const withFixture = (name: string, fn: (f: Fixture) => Promise<void>) => test(name, async () => {
  const f = await fixture();
  try { await fn(f); } finally { await f.body.close(); await rm(f.dir, { recursive: true, force: true }); }
});

withFixture("body:main is a body member whose words are the ten standard ones and pass the word lint", async ({ body }) => {
  assert.equal(body.id, "body:main");
  assert.equal(body.kind, "body");
  const words = body.words();
  assert.deepEqual(words.map((w) => w.word).sort(), ["body.info", "workspace.bash", "workspace.edit", "workspace.find", "workspace.grep", "workspace.ls", "workspace.poll", "workspace.read", "workspace.signal", "workspace.write"]);
  assert.ok(words.every((w) => w.member === "body:main" && w.kind === "request"));
  assert.deepEqual(lintWords(words), []);
  assert.deepEqual(bodyWords("body:abc").map((w) => w.member), Array(10).fill("body:abc"));
  const byWord = Object.fromEntries(words.map((w) => [w.word, w]));
  assert.equal(byWord["workspace.write"]!.per_call_risk, true);
  assert.equal(byWord["workspace.bash"]!.effect, "execute");
});

withFixture("SPEC-09 §7.1: the nine workspace actions and body.info work in the container's file system", async ({ body, rootfs, streams, ran }) => {
  // write, read, ls, edit, find, grep
  const wrote = await ask(body, "workspace.write", { path: "proj/hello.txt", content: "hello\nworld\n" });
  assert.equal(wrote.data.path, "/root/work/proj/hello.txt");
  assert.equal(await readFile(join(rootfs, "root", "work", "proj", "hello.txt"), "utf8"), "hello\nworld\n");
  assert.equal((await ask(body, "workspace.read", { path: "proj/hello.txt" })).data.text, "hello\nworld\n".trimEnd());
  assert.deepEqual((await ask(body, "workspace.ls", { path: "proj" })).data.entries.map((e: any) => e.name), ["hello.txt"]);
  await ask(body, "workspace.edit", { path: "proj/hello.txt", edits: [{ oldText: "world", newText: "there" }] });
  assert.equal((await ask(body, "workspace.read", { path: "/root/work/proj/hello.txt" })).data.text, "hello\nthere");
  assert.deepEqual((await ask(body, "workspace.find", { pattern: "**/*.txt" })).data.paths, ["/root/work/proj/hello.txt"]);
  assert.deepEqual((await ask(body, "workspace.grep", { pattern: "there" })).data.matches, [{ path: "/root/work/proj/hello.txt", line: 2, text: "there", context: false }]);
  // an image comes back through a stream, byte for byte
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1000, 0xfe)]);
  await writeFile(join(rootfs, "root", "work", "pic.png"), png);
  const image = await ask(body, "workspace.read", { path: "pic.png" });
  assert.deepEqual(image.content.at(-1), { type: "resource", stream: "st_1", mime: "image/png", size: png.length });
  assert.deepEqual(Buffer.from(streams[0]!.bytes), png);
  // bash starts in the work directory as the container names it, and sees what the file calls wrote
  const out = await ask(body, "workspace.bash", { command: "cat proj/hello.txt; echo done" });
  assert.equal(out.data.output, "hello\nthere\ndone\n");
  assert.equal(out.data.exit_code, 0);
  assert.deepEqual(ran, [{ command: "cat proj/hello.txt; echo done", cwd: "/root/work" }]);
  // a long command: poll, signal
  const long = await ask(body, "workspace.bash", { command: "echo start; sleep 30", yield_ms: 0 });
  assert.equal(long.data.running, true);
  const polled = await ask(body, "workspace.poll", { process: long.data.process, yield_ms: 30000 });
  assert.equal(polled.data.output, "start\n");
  assert.equal((await ask(body, "workspace.signal", { process: long.data.process, signal: "TERM" })).data.signalled, true);
  const ended = await ask(body, "workspace.poll", { process: long.data.process, yield_ms: 30000 });
  assert.equal(ended.data.running, false);
  assert.equal(typeof long.data.path, "string");
  assert.match(long.data.path, /^\/var\/tmp\/ash-workspace\/.*\.txt$/);
  assert.match(await readFile(join(rootfs, long.data.path), "utf8"), /^start\n/);
  // body.info: own, a full Linux
  const info = (await ask(body, "body.info", {})).data;
  assert.equal(info.ownership, "own");
  assert.equal(info.full_linux, true);
  assert.equal(info.system, "Ubuntu 24.04 LTS");
  assert.equal(info.package_manager, "apt");
  assert.equal(info.workdir, "/root/work");
});

withFixture("paths cannot leave the container: absolute links inside it resolve inside it, .. stops at its root", async ({ body, rootfs, dir }) => {
  await writeFile(join(dir, "host-secret"), "host");
  await writeFile(join(rootfs, "etc", "hostname"), "box\n");
  await mkdir(join(rootfs, "root", "work"), { recursive: true });
  await symlink(join(dir, "host-secret"), join(rootfs, "root", "work", "peek"));
  await assert.rejects(ask(body, "workspace.read", { path: "peek" }), (e: any) => e.code === "not_found");
  assert.equal((await ask(body, "workspace.read", { path: "../../../../../../etc/hostname" })).data.text, "box");
});

withFixture("SPEC-09 §7.5: a caller with no body of its own builds a file, runs a script and reads the result through body:main", async ({ body }) => {
  await ask(body, "workspace.write", { path: "job/run.sh", content: "echo computed $((6*7)) > out.txt\n" });
  const ran = await ask(body, "workspace.bash", { command: "sh run.sh", workdir: "job" });
  assert.equal(ran.data.exit_code, 0);
  assert.equal((await ask(body, "workspace.read", { path: "job/out.txt" })).data.text, "computed 42");
});

withFixture("assess: a write inside /root/work is none, anywhere else in the container the declared risk", async ({ body }) => {
  assert.equal(await body.assess({ word: "workspace.write", body: { path: "note.md", content: "x" } }), "none");
  assert.equal(await body.assess({ word: "workspace.edit", body: { path: "/etc/hosts", edits: [{ oldText: "a", newText: "b" }] } }), "structure");
  assert.equal(await body.assess({ word: "workspace.write", body: { path: "../../etc/x", content: "x" } }), "structure");
  assert.equal(await body.assess({ word: "workspace.bash", body: { command: "ls" } }), "structure");
});

test("a container that is not installed yet: calls say unavailable; nothing is created", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-"));
  try {
    const body = createLocalBody({ isolation: { kind: "proot", proot: { root: join(dir, "main"), rootfs: join(dir, "main", "ubuntu"), bin: "x", loader: "x", lib: "x" } } });
    await assert.rejects(ask(body, "workspace.ls", {}), (e: any) => e.code === "unavailable");
    assert.equal(await body.assess({ word: "workspace.write", body: { path: "a", content: "" } }), null);
    await body.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

withFixture("a cancelled request aborts the call", async ({ body }) => {
  const abort = new AbortController();
  const pending = ask(body, "workspace.bash", { command: "sleep 30", yield_ms: 30000 }, abort.signal);
  abort.abort();
  await assert.rejects(pending, (e: any) => e.code === "cancelled");
});

test("isolation native (development machine, fake host): body:main is a directory and the machine's own shell", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-"));
  const workspace = join(dir, "ws");                       // not there yet: the body makes it
  const streams: Uint8Array[] = [];
  const body = createLocalBody({ isolation: { kind: "native", native: { workspace, dsh_bin: "dsh", dsh_home: join(dir, "dsh") } }, streams: (bytes) => { streams.push(bytes); return "st_1"; } });
  try {
    assert.equal(body.id, "body:main");
    assert.equal(body.words().length, 10);
    assert.equal(mainBodyKind({ kind: "native", native: { workspace, dsh_bin: "", dsh_home: "" } }), "native");
    await ask(body, "workspace.write", { path: "a/run.sh", content: "echo native $((1+1)) > out.txt\n" });
    assert.equal((await ask(body, "workspace.bash", { command: "sh run.sh && pwd", workdir: "a" })).data.exit_code, 0);
    const read = await ask(body, "workspace.read", { path: "a/out.txt" });
    assert.equal(read.data.text, "native 2");
    assert.equal(read.data.path, join(await realpath(workspace), "a", "out.txt"));
    await writeFile(join(workspace, "blob.bin"), Buffer.from([0, 1, 2]));
    assert.equal((await ask(body, "workspace.read", { path: "blob.bin" })).data.stream, "st_1");
    assert.equal((await ask(body, "body.info", {})).data.ownership, "own");
    await assert.rejects(ask(body, "workspace.read", { path: "../escape" }), (e: any) => e.code === "forbidden");
    assert.equal(await body.assess({ word: "workspace.write", body: { path: "n.txt", content: "" } }), "none");
  } finally { await body.close(); await rm(dir, { recursive: true, force: true }); }
});

test("isolation container is not supported yet: unavailable", async () => {
  const body = createLocalBody({ isolation: { kind: "container", container: { engine: "docker", image: "x" } } });
  await assert.rejects(ask(body, "body.info", {}), (e: any) => e.code === "unavailable");
  assert.equal(mainBodyKind({ kind: "container", container: { engine: "docker", image: "x" } }), "container");
  await body.close();
});

test("spawn and appLauncher follow the isolation: native runs the host's runtime in the workspace, proot goes through the container, another kind cannot", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "body-spawn-"));
  try {
    const native = createLocalBody({ isolation: { kind: "native", native: { workspace: join(dir, "ws"), dsh_bin: process.execPath, dsh_home: join(dir, "dsh") } } });
    const child = native.spawn(["dsh", "-e", "process.stdout.write(process.cwd() + '|' + process.env.DSH_HOME + '|' + process.env.EXTRA)"], { cwd: "agents/main", env: { EXTRA: "x" } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    await new Promise((resolve) => child.on("close", resolve));
    assert.equal(out, `${await realpath(join(dir, "ws", "agents", "main"))}|${join(dir, "dsh")}|x`);
    // Only `dsh` means the host's runtime: another program runs as written, without the runtime's home.
    const plain = native.spawn([process.execPath, "-e", "process.stdout.write(String(process.env.DSH_HOME) + '|' + process.env.EXTRA)"], { env: { EXTRA: "y" } });
    let plainOut = "";
    plain.stdout.on("data", (chunk) => { plainOut += chunk; });
    await new Promise((resolve) => plain.on("close", resolve));
    assert.equal(plainOut, `${process.env.DSH_HOME}|y`);
    const launcher = native.appLauncher()!;
    assert.equal(launcher.root, join(dir, "ws", "apps"));
    const run = launcher.spawn({ server: { command: "node", args: ["server.mjs"], env: { A: "1" } } } as never, join(launcher.root, "notes"), { ASH_X: "y" });
    assert.deepEqual([run.command, run.args, run.cwd, run.env.A, run.env.ASH_X], ["node", ["server.mjs"], join(launcher.root, "notes"), "1", "y"]);

    const proot: ProotConfig = { root: join(dir, "main"), rootfs: join(dir, "main", "ubuntu"), bin: "/nonexistent/proot", loader: "", lib: "" };
    const contained = createLocalBody({ isolation: { kind: "proot", proot } }).appLauncher()!;
    assert.equal(contained.root, join(proot.rootfs, "root", "apps"));
    assert.equal(contained.agentRoot, "/root/apps");
    const inside = contained.spawn({ server: { command: "node", args: ["server.mjs"] } } as never, join(contained.root, "notes"), { ASH_X: "y" });
    assert.equal(inside.command, "/nonexistent/proot");
    assert.ok(inside.args.join(" ").includes("-w /root/apps/notes") && inside.args.includes("ASH_X=y") && inside.args.at(-2) === "node");

    const other = createLocalBody({ isolation: { kind: "container", container: { engine: "docker", image: "x" } } });
    assert.equal(other.appLauncher(), null);
    assert.throws(() => other.spawn(["x"]), (error: any) => error.code === "unavailable");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
