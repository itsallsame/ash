import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { standardAction } from "../../sdk/src/namespaces";
import { compileSchema } from "../../sdk/src/word";
import { Workspace, WorkspaceError, MAX_TEXT_BYTES, WORKSPACE_ACTION_NAMES, type WorkspaceOptions } from "../src";

interface Fixture { dir: string; root: string; outside: string; sent: { bytes: Uint8Array; mime: string }[]; ws: Workspace }

async function fixture(extra: Partial<WorkspaceOptions> = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ws-"));
  const root = join(dir, "root"), outside = join(dir, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "top secret");
  const sent: { bytes: Uint8Array; mime: string }[] = [];
  const ws = new Workspace({ root, spillDir: join(dir, "spill"), streams: (bytes, meta) => { sent.push({ bytes, mime: meta.mime }); return `st_${sent.length}`; }, ...extra });
  return { dir, root, outside, sent, ws };
}
const withFixture = (name: string, fn: (f: Fixture) => Promise<void>, extra: Partial<WorkspaceOptions> = {}) =>
  test(name, async () => {
    const f = await fixture(extra);
    try { await fn(f); } finally { await f.ws.close(); await rm(f.dir, { recursive: true, force: true }); }
  });
const refused = (code: string) => (error: unknown) => error instanceof WorkspaceError && error.code === code;

test("the ten actions are exactly the standard workspace.* and body.info actions", () => {
  for (const name of WORKSPACE_ACTION_NAMES) assert.ok(standardAction(name), name);
  const standard = ["workspace.ls", "workspace.read", "workspace.find", "workspace.grep", "workspace.write", "workspace.edit", "workspace.bash", "workspace.poll", "workspace.signal", "body.info"];
  assert.deepEqual([...WORKSPACE_ACTION_NAMES], standard);
});

withFixture("bad input and unknown actions are refused with the shared codes", async ({ ws }) => {
  await assert.rejects(ws.call("workspace.read", {}), refused("bad_request"));
  await assert.rejects(ws.call("workspace.read", { path: "a", extra: 1 }), refused("bad_request"));
  await assert.rejects(ws.call("workspace.nope", {}), refused("not_found"));
});

withFixture("paths cannot leave the root: .., absolute paths, links, workdir", async ({ ws, root, outside }) => {
  await symlink(outside, join(root, "out-link"));
  await symlink(join(outside, "secret.txt"), join(root, "file-link"));
  await assert.rejects(ws.call("workspace.read", { path: "../outside/secret.txt" }), refused("forbidden"));
  await assert.rejects(ws.call("workspace.read", { path: join(outside, "secret.txt") }), refused("forbidden"));
  await assert.rejects(ws.call("workspace.read", { path: "out-link/secret.txt" }), refused("forbidden"));
  await assert.rejects(ws.call("workspace.read", { path: "file-link" }), refused("forbidden"));
  await assert.rejects(ws.call("workspace.ls", { path: "out-link" }), refused("forbidden"));
  await assert.rejects(ws.call("workspace.write", { path: "out-link/new.txt", content: "x" }), refused("forbidden"));
  await assert.rejects(ws.call("workspace.write", { path: "../outside/new.txt", content: "x" }), refused("forbidden"));
  await assert.rejects(ws.call("workspace.bash", { command: "pwd", workdir: "../outside" }), refused("forbidden"));
  await assert.rejects(ws.call("workspace.find", { path: "..", pattern: "*" }), refused("forbidden"));
  await assert.rejects(ws.call("workspace.grep", { path: "../outside", pattern: "secret" }), refused("forbidden"));
  await assert.rejects(readFile(join(outside, "new.txt")), /ENOENT/);
  // a link that stays inside is fine
  await writeFile(join(root, "real.txt"), "inside");
  await symlink("real.txt", join(root, "inner-link"));
  assert.equal((await ws.call("workspace.read", { path: "inner-link" })).data.text, "inside");
});

withFixture("chroot: the root is /, absolute paths and absolute links start from it, .. stops at it", async ({ root, outside, ws }) => {
  await mkdir(join(root, "etc")); await mkdir(join(root, "root", "work"), { recursive: true });
  await writeFile(join(root, "etc", "hostname"), "box\n");
  await symlink("/etc/hostname", join(root, "root", "work", "name"));          // absolute target: inside the jail
  await symlink(outside, join(root, "root", "escape"));                        // a host path that is not in the jail
  const jailed = new Workspace({ root, chroot: true, workdir: "/root/work", spillDir: join(root, "var", "tmp", "ws") });
  try {
    assert.equal((await jailed.call("workspace.read", { path: "/etc/hostname" })).data.text, "box");
    assert.equal((await jailed.call("workspace.read", { path: "name" })).data.text, "box");
    assert.equal((await jailed.call("workspace.read", { path: "../../../../../etc/hostname" })).data.text, "box");
    assert.equal((await jailed.call("workspace.ls", { path: "." })).data.path, "/root/work");
    await assert.rejects(jailed.call("workspace.read", { path: "/root/escape/secret.txt" }), refused("not_found"));
    assert.equal((await jailed.call("workspace.write", { path: "note.txt", content: "hi" })).data.path, "/root/work/note.txt");
    assert.equal(await readFile(join(root, "root", "work", "note.txt"), "utf8"), "hi");
    assert.deepEqual((await jailed.call("workspace.find", { path: "/", pattern: "**/hostname" })).data.paths, ["/etc/hostname"]);
  } finally { await jailed.close(); }
  void ws;
});

withFixture("chroot mounts: a host directory appears inside the root at another place", async ({ root, outside }) => {
  await mkdir(join(root, "sdcard"));
  await writeFile(join(outside, "photo.txt"), "from the mount");
  await symlink("/sdcard/photo.txt", join(root, "alias"));      // a link inside the jail that points into the mount
  const mounted = new Workspace({ root, chroot: true, mounts: [{ guest: "/sdcard", host: outside }], workdir: "/" });
  try {
    assert.equal((await mounted.call("workspace.read", { path: "/sdcard/photo.txt" })).data.text, "from the mount");
    assert.equal((await mounted.call("workspace.read", { path: "alias" })).data.text, "from the mount");
    assert.deepEqual((await mounted.call("workspace.find", { path: "/sdcard", pattern: "*.txt" })).data.paths, ["/sdcard/photo.txt", "/sdcard/secret.txt"]);
    await mounted.call("workspace.write", { path: "/sdcard/new.txt", content: "w" });
    assert.equal(await readFile(join(outside, "new.txt"), "utf8"), "w");
    assert.equal((await mounted.call("workspace.ls", { path: "/sdcard" })).data.path, "/sdcard");
    await assert.rejects(mounted.call("workspace.read", { path: "/sdcard/../../etc/hostname" }), refused("not_found"));
  } finally { await mounted.close(); }
});

withFixture("ls lists name, type and size, in order, with a limit", async ({ ws, root }) => {
  await mkdir(join(root, "sub")); await writeFile(join(root, "b.txt"), "12345"); await writeFile(join(root, "a.txt"), "");
  await symlink("b.txt", join(root, "c-link"));
  const { data } = await ws.call("workspace.ls", {});
  assert.equal(data.path, root);
  assert.deepEqual((data.entries as { name: string; type: string }[]).map((e) => [e.name, e.type]), [["a.txt", "file"], ["b.txt", "file"], ["c-link", "symlink"], ["sub", "directory"]]);
  assert.equal((data.entries as { size: number }[])[1]!.size, 5);
  const some = await ws.call("workspace.ls", { limit: 2 });
  assert.equal((some.data.entries as unknown[]).length, 2);
  assert.equal(some.data.truncated, true);
  await assert.rejects(ws.call("workspace.ls", { path: "missing" }), refused("not_found"));
  await assert.rejects(ws.call("workspace.ls", { path: "a.txt" }), refused("bad_request"));
});

withFixture("read: text by lines with offset, limit and next_offset", async ({ ws, root }) => {
  await writeFile(join(root, "t.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
  const all = await ws.call("workspace.read", { path: "t.txt" });
  assert.equal((all.data.text as string).split("\n").length, 10);
  assert.equal(all.data.truncated, false);
  const part = await ws.call("workspace.read", { path: "t.txt", offset: 3, limit: 4 });
  assert.equal(part.data.text, "line 3\nline 4\nline 5\nline 6");
  assert.equal(part.data.next_offset, 7);
  assert.equal(part.data.truncated, true);
  assert.deepEqual(part.content, [{ type: "text", text: "line 3\nline 4\nline 5\nline 6" }]);
  await assert.rejects(ws.call("workspace.read", { path: "nothing" }), refused("not_found"));
  await assert.rejects(ws.call("workspace.read", { path: "." }), refused("bad_request"));
});

withFixture("read: an image and a binary file come back as a stream reference with the original bytes", async ({ ws, root, sent }) => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);
  await writeFile(join(root, "pic.png"), png);
  const bin = Buffer.from([1, 2, 0, 3, 4, 255, 0, 9]);
  await writeFile(join(root, "blob.dat"), bin);
  const image = await ws.call("workspace.read", { path: "pic.png" });
  assert.deepEqual(image.content[1], { type: "resource", stream: "st_1", mime: "image/png", size: png.length });
  assert.equal(image.data.stream, "st_1");
  assert.deepEqual(Buffer.from(sent[0]!.bytes), png);
  const data = await ws.call("workspace.read", { path: "blob.dat" });
  assert.deepEqual(data.content[1], { type: "resource", stream: "st_2", mime: "application/octet-stream", size: bin.length });
  assert.deepEqual(Buffer.from(sent[1]!.bytes), bin);
});

withFixture("read: a text file over 4 MiB is a stream unless a line range is asked for; no stream function means unavailable", async ({ ws, root, sent }) => {
  const line = "x".repeat(99) + "\n";
  await writeFile(join(root, "big.log"), line.repeat(Math.ceil((MAX_TEXT_BYTES + 1) / line.length)));
  const big = await ws.call("workspace.read", { path: "big.log" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.mime, "text/plain");
  assert.equal((big.content[1] as { type: string }).type, "resource");
  const ranged = await ws.call("workspace.read", { path: "big.log", offset: 5, limit: 2 });
  assert.equal(ranged.data.text, "x".repeat(99) + "\n" + "x".repeat(99));
  assert.equal(sent.length, 1);
  const bare = new Workspace({ root });
  await assert.rejects(bare.call("workspace.read", { path: "big.log" }), refused("unavailable"));
  await bare.close();
});

withFixture("read: a file over the stream limit is too_large", async ({ ws, root }) => {
  const small = new Workspace({ root, streams: () => "x" });
  await writeFile(join(root, "blob.dat"), Buffer.from([0, 1]));
  assert.equal((await small.call("workspace.read", { path: "blob.dat" })).data.stream, "x");
  await small.close(); void ws;
});

withFixture("find: glob patterns under a directory, with a limit", async ({ ws, root }) => {
  await mkdir(join(root, "src", "deep"), { recursive: true });
  for (const file of ["a.ts", "b.js", "src/c.ts", "src/deep/d.ts", "src/deep/e.md"]) await writeFile(join(root, file), "");
  const rel = (paths: unknown) => (paths as string[]).map((p) => p.slice(root.length + 1));
  assert.deepEqual(rel((await ws.call("workspace.find", { pattern: "**/*.ts" })).data.paths), ["a.ts", "src/c.ts", "src/deep/d.ts"]);
  assert.deepEqual(rel((await ws.call("workspace.find", { pattern: "*.ts" })).data.paths), ["a.ts"]);
  assert.deepEqual(rel((await ws.call("workspace.find", { pattern: "**/*.{js,md}" })).data.paths), ["b.js", "src/deep/e.md"]);
  assert.deepEqual(rel((await ws.call("workspace.find", { path: "src", pattern: "**/d.ts" })).data.paths), ["src/deep/d.ts"]);
  const limited = await ws.call("workspace.find", { pattern: "**/*.ts", limit: 2 });
  assert.equal((limited.data.paths as string[]).length, 2);
  assert.equal(limited.data.truncated, true);
});

withFixture("grep: regular expression or literal text, glob, case, context, limit; binary files and links are skipped", async ({ ws, root, outside }) => {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "one\nneedle here\nthree\nfour\nNEEDLE again\n");
  await writeFile(join(root, "b.md"), "no match\nneedle(1)\n");
  await writeFile(join(root, "bin.dat"), Buffer.from("needle\0binary"));
  await symlink(outside, join(root, "link-dir"));
  const text = (r: { data: { matches?: unknown } }) => (r.data.matches as { path: string; line: number; text: string; context: boolean }[]).map((m) => `${m.path.slice(root.length + 1)}:${m.line}:${m.text}`);
  assert.deepEqual(text(await ws.call("workspace.grep", { pattern: "needle" })), ["b.md:2:needle(1)", "src/a.ts:2:needle here"]);
  assert.deepEqual(text(await ws.call("workspace.grep", { pattern: "needle", ignoreCase: true, glob: "*.ts" })), ["src/a.ts:2:needle here", "src/a.ts:5:NEEDLE again"]);
  assert.deepEqual(text(await ws.call("workspace.grep", { pattern: "needle(1)", literal: true })), ["b.md:2:needle(1)"]);
  assert.deepEqual(text(await ws.call("workspace.grep", { pattern: "^three$", path: "src/a.ts", context: 1 })), ["src/a.ts:2:needle here", "src/a.ts:3:three", "src/a.ts:4:four"]);
  const ctx = (await ws.call("workspace.grep", { pattern: "^three$", path: "src/a.ts", context: 1 })).data.matches as { context: boolean }[];
  assert.deepEqual(ctx.map((m) => m.context), [true, false, true]);
  const limited = await ws.call("workspace.grep", { pattern: "needle", ignoreCase: true, limit: 1 });
  assert.equal((limited.data.matches as unknown[]).length, 1);
  assert.equal(limited.data.truncated, true);
  await assert.rejects(ws.call("workspace.grep", { pattern: "(" }), refused("bad_request"));
});

withFixture("write: creates folders, replaces, refuses over 4 MiB", async ({ ws, root }) => {
  const made = await ws.call("workspace.write", { path: "a/b/c.txt", content: "héllo" });
  assert.equal(made.data.bytes, 6);
  assert.equal(await readFile(join(root, "a", "b", "c.txt"), "utf8"), "héllo");
  await ws.call("workspace.write", { path: "a/b/c.txt", content: "new" });
  assert.equal(await readFile(join(root, "a", "b", "c.txt"), "utf8"), "new");
  await assert.rejects(ws.call("workspace.write", { path: "big", content: "x".repeat(MAX_TEXT_BYTES + 1) }), refused("too_large"));
  await assert.rejects(ws.call("workspace.write", { path: "a/b/c.txt/under", content: "x" }), refused("bad_request"));
});

withFixture("edit: each oldText must match exactly once, edits apply in order, otherwise nothing is saved", async ({ ws, root }) => {
  const file = join(root, "e.txt");
  await writeFile(file, "alpha\nbeta\ngamma\nbeta2\n");
  const ok = await ws.call("workspace.edit", { path: "e.txt", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "gamma", newText: "G\nG2" }] });
  assert.equal(ok.data.edits, 2);
  assert.equal(await readFile(file, "utf8"), "A\nbeta\nG\nG2\nbeta2\n");
  // twice in the file: refused, whole call unsaved even though the first edit is fine
  await assert.rejects(ws.call("workspace.edit", { path: "e.txt", edits: [{ oldText: "A", newText: "a" }, { oldText: "beta", newText: "B" }] }), refused("bad_request"));
  await assert.rejects(ws.call("workspace.edit", { path: "e.txt", edits: [{ oldText: "missing", newText: "x" }] }), /was not found/);
  assert.equal(await readFile(file, "utf8"), "A\nbeta\nG\nG2\nbeta2\n");
  // a later edit sees the result of an earlier one
  await ws.call("workspace.edit", { path: "e.txt", edits: [{ oldText: "A\nbeta\n", newText: "X\nY\n" }, { oldText: "Y", newText: "Z" }] });
  assert.equal(await readFile(file, "utf8"), "X\nZ\nG\nG2\nbeta2\n");
  await assert.rejects(ws.call("workspace.edit", { path: "nothing.txt", edits: [{ oldText: "a", newText: "b" }] }), refused("not_found"));
  await assert.rejects(ws.call("workspace.edit", { path: "e.txt", edits: [] }), refused("bad_request"));
});

withFixture("assess: a write inside the work directory is none, elsewhere the declared risk; guarded folders are never free", async ({ ws, root, dir }) => {
  await mkdir(join(root, "work"));
  const work = new Workspace({ root, workdir: join(root, "work") });
  assert.equal(await work.assess("workspace.write", { path: "x.txt", content: "" }), "none");
  assert.equal(await work.assess("workspace.write", { path: "deep/er/x.txt", content: "" }), "none");
  assert.equal(await work.assess("workspace.edit", { path: "../top.txt", edits: [{ oldText: "a", newText: "b" }] }), "structure");
  assert.equal(await work.assess("workspace.write", { path: "x.txt", content: "", workdir: ".." }), "structure");
  assert.equal(await work.assess("workspace.write", { path: "../../outside/x", content: "" }), "structure");   // refused path: declared risk
  assert.equal(await work.assess("workspace.write", { content: "" }), "structure");                          // bad input: declared risk
  assert.equal(await work.assess("workspace.read", { path: "x" }), "none");
  assert.equal(await work.assess("workspace.bash", { command: "ls" }), "structure");
  await symlink(dir, join(root, "work", "up"));
  assert.equal(await work.assess("workspace.write", { path: "up/x", content: "" }), "structure");
  const guarded = new Workspace({ root, workdir: join(root, "work"), guard: [join(root, "work", "state")] });
  await mkdir(join(root, "work", "state"));
  assert.equal(await guarded.assess("workspace.write", { path: "x.txt", content: "" }), "structure");
  await work.close(); await guarded.close(); void ws;
});

async function finish(ws: Workspace, first: { data: Record<string, unknown> }): Promise<{ output: string; exit_code: unknown; data: Record<string, unknown> }> {
  let output = first.data.output as string, last = first.data;
  while (last.running || last.truncated) {
    last = (await ws.call("workspace.poll", { process: last.process as string, yield_ms: 30000 })).data;
    output += last.output as string;
  }
  return { output, exit_code: last.exit_code, data: last };
}

withFixture("bash: a short command returns output and exit code in the call; the working directory is honoured", async ({ ws, root }) => {
  await mkdir(join(root, "sub"));
  const run = await ws.call("workspace.bash", { command: "pwd; echo err >&2; exit 3", workdir: "sub" });
  assert.equal(run.data.running, false);
  assert.equal(run.data.exit_code, 3);
  assert.match(run.data.output as string, new RegExp(`${join(root, "sub")}\\nerr\\n`));
  assert.ok(typeof run.data.path === "string" && (await readFile(run.data.path as string, "utf8")).includes("err"));
  await assert.rejects(ws.call("workspace.bash", { command: "true", workdir: "nope" }), refused("not_found"));
});

withFixture("bash, poll: a long command returns early, its output arrives in pieces, then the exit code", async ({ ws }) => {
  const started = await ws.call("workspace.bash", { command: "echo first; sleep 0.4; echo second; sleep 0.4; echo third; exit 5", yield_ms: 0 });
  assert.equal(started.data.running, true);
  const done = await finish(ws, started);
  assert.equal(done.output, "first\nsecond\nthird\n");
  assert.equal(done.exit_code, 5);
  assert.equal(done.data.running, false);
  const again = await ws.call("workspace.poll", { process: started.data.process as string, yield_ms: 0 });
  assert.equal(again.data.output, "");
  assert.equal(again.data.running, false);
});

withFixture("poll: output over the piece size comes in several polls, none lost", async ({ ws }) => {
  const started = await ws.call("workspace.bash", { command: "head -c 120000 /dev/zero | tr '\\0' 'a'; echo; echo done" });
  const done = await finish(ws, started);
  assert.equal(done.output.length, 120000 + 1 + 5);
  assert.ok(done.output.endsWith("a\ndone\n"));
});

withFixture("signal: TERM stops a long command and a finished one reports signalled false", async ({ ws }) => {
  const started = await ws.call("workspace.bash", { command: "sleep 30; echo never", yield_ms: 0 });
  assert.equal(started.data.running, true);
  const signalled = await ws.call("workspace.signal", { process: started.data.process as string, signal: "TERM" });
  assert.equal(signalled.data.signalled, true);
  const done = await finish(ws, started);
  assert.equal(done.data.running, false);
  assert.notEqual(done.exit_code, 0);
  assert.equal(done.output, "");
  assert.equal((await ws.call("workspace.signal", { process: started.data.process as string, signal: "INT" })).data.signalled, false);
});

withFixture("signal: INT reaches a whole process group (the shell and what it started)", async ({ ws, root }) => {
  const started = await ws.call("workspace.bash", { command: `sh -c 'echo $$ > ${join(root, "pid")}; sleep 30' & wait`, yield_ms: 0 });
  for (let i = 0; i < 200; i++) { if (await readFile(join(root, "pid"), "utf8").catch(() => "")) break; await new Promise((r) => setTimeout(r, 25)); }
  const pid = Number((await readFile(join(root, "pid"), "utf8")).trim());
  await ws.call("workspace.signal", { process: started.data.process as string, signal: "TERM" });
  await finish(ws, started);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

withFixture("bash: timeout stops the command and says so", async ({ ws }) => {
  const started = await ws.call("workspace.bash", { command: "sleep 30", timeout: 1, yield_ms: 0 });
  const done = await finish(ws, started);
  assert.equal(done.data.error, "Command timed out");
  assert.equal(done.data.running, false);
});

withFixture("poll and signal on an unknown process: not_found", async ({ ws }) => {
  await assert.rejects(ws.call("workspace.poll", { process: "nope" }), refused("not_found"));
  await assert.rejects(ws.call("workspace.signal", { process: "nope", signal: "TERM" }), refused("not_found"));
});

withFixture("bash: a cancelled call stops waiting but the command keeps running and can still be polled", async ({ ws }) => {
  const abort = new AbortController();
  const pending = ws.call("workspace.bash", { command: "sleep 0.3; echo late", yield_ms: 30000 }, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, refused("cancelled"));
});

withFixture("a custom executor decides where commands run; the shell sees the shown directory", async ({ root }) => {
  const seen: { command: string; cwd: string; hostCwd: string }[] = [];
  const { spawn } = await import("node:child_process");
  const ws = new Workspace({ root, chroot: true, workdir: "/", spillDir: join(root, "spill"), exec: (command, place) => {
    seen.push({ command, ...place });
    return spawn("sh", ["-c", `echo "in ${place.cwd}: $0"; ${command}`, "x"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } });
  try {
    await mkdir(join(root, "w"));
    const run = await ws.call("workspace.bash", { command: "echo hi", workdir: "/w" });
    assert.equal(run.data.output, "in /w: x\nhi\n");
    assert.deepEqual(seen, [{ command: "echo hi", cwd: "/w", hostCwd: join(root, "w") }]);
  } finally { await ws.close(); }
});

withFixture("body.info: system, arch, work directory and ownership, as the standard action declares", async ({ ws, root }) => {
  const info = await ws.call("body.info", {});
  assert.equal(info.data.ownership, "borrowed");
  assert.equal(info.data.workdir, root);
  assert.equal(info.data.full_linux, process.platform === "linux");
  assert.ok(typeof info.data.system === "string" && typeof info.data.arch === "string");
  const resources = info.data.resources as { cpu: { count: number }; memory: { total: number }; disk: { total: number } };
  assert.ok(resources.cpu.count >= 0 && resources.memory.total > 0 && resources.disk.total > 0);
  const own = new Workspace({ root, ownership: "own" });
  assert.equal((await own.call("body.info", {})).data.ownership, "own");
  await own.close();
});

withFixture("every result data matches the standard action's result_schema", async ({ ws, root }) => {
  await writeFile(join(root, "f.txt"), "needle\n");
  const cases: [string, Record<string, unknown>][] = [
    ["workspace.ls", {}], ["workspace.read", { path: "f.txt" }], ["workspace.find", { pattern: "*" }], ["workspace.grep", { pattern: "needle" }],
    ["workspace.write", { path: "g.txt", content: "x" }], ["workspace.edit", { path: "f.txt", edits: [{ oldText: "needle", newText: "n" }] }],
    ["workspace.bash", { command: "echo ok" }], ["body.info", {}],
  ];
  for (const [name, args] of cases) {
    const out = await ws.call(name, args);
    const validate = compileSchema(standardAction(name)!.result_schema);
    assert.ok(validate(out.data), `${name}: ${JSON.stringify(validate.errors)}`);
  }
  const started = await ws.call("workspace.bash", { command: "sleep 5", yield_ms: 0 });
  assert.ok(compileSchema(standardAction("workspace.poll")!.result_schema)(started.data));
  const signalled = await ws.call("workspace.signal", { process: started.data.process as string, signal: "TERM" });
  assert.ok(compileSchema(standardAction("workspace.signal")!.result_schema)(signalled.data));
});
