import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkCapabilitySpec, type CallFrame } from "../../sdk/src/link";
import { isExtensionName, standardAction } from "../../sdk/src/namespaces";
import { WordError } from "../../sdk/src/message";
import type { CallOutcome } from "../../link/src/hand";
import { Browser, EGO_CAPABILITY } from "../src/browser";
import { createHand, UPDATE_CAPABILITY, UPDATER } from "../src/hand";
import { createWorkspace, expandHome, workspaceCapabilities } from "../src/workspace";

const open: { close(): Promise<void> }[] = [];
after(async () => { await Promise.all(open.map((w) => w.close())); });
const dir = () => mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-hand-"));
const frame = (capability: string, args: Record<string, unknown> = {}, member = "agent:main"): CallFrame =>
  ({ t: "call", ch: "device", id: "c1", capability, args, caller: { member, label: "x" }, deadline: Date.now() + 60_000 });
const ctx = (signal = new AbortController().signal) => ({ signal, progress() {} });
const failed = (outcome: CallOutcome) => (outcome.ok ? null : outcome.error);

async function hand(over: { update?: ((v: string, h: string) => Promise<unknown>) | null; ego?: Browser | null; busy?: () => boolean } = {}) {
  const base = await dir();
  const workdir = join(base, "work"), stateDir = join(base, "state");
  await mkdir(workdir);
  const sent: { mime: string; size: number }[] = [];
  const workspace = createWorkspace({ workdir, stateDir, stream: (data, mime) => { sent.push({ mime, size: data.length }); return `st_${sent.length}`; } });
  open.push(workspace);
  return { base, workdir, sent, workspace, hand: createHand({ workspace, ...over }) };
}

test("workspace.* and body.info are the standard actions word for word, with the risk and per-call flag the standard gives", () => {
  const caps = workspaceCapabilities();
  assert.deepEqual(caps.map((c) => c.name), ["workspace.ls", "workspace.read", "workspace.find", "workspace.grep", "workspace.write", "workspace.edit", "workspace.bash", "workspace.poll", "workspace.signal", "body.info"]);
  for (const cap of caps) {
    const standard = standardAction(cap.name)!;
    assert.equal(checkCapabilitySpec(cap), null, cap.name);
    assert.deepEqual([cap.input_schema, cap.result_schema, cap.effect, cap.risk, cap.label], [standard.input_schema, standard.result_schema, standard.effect, standard.risk, standard.label], cap.name);
    assert.equal(cap.per_call_risk, standard.per_call_risk ? true : undefined, cap.name);
  }
});

test("the manifest adds what this copy has: ego-browser's script and the update, nothing else without the extension", async () => {
  const bare = await hand();
  assert.equal(bare.hand.manifest().length, 10);
  const full = await hand({ ego: new Browser(bare.base, "ego"), update: async () => ({}) });
  const names = full.hand.manifest().map((c) => c.name);
  assert.deepEqual(names.slice(10), [EGO_CAPABILITY.name, UPDATE_CAPABILITY.name]);
  for (const cap of full.hand.manifest()) {
    assert.equal(checkCapabilitySpec(cap), null, cap.name);
    assert.ok(standardAction(cap.name) || isExtensionName(cap.name), `${cap.name} is standard or x.`);
  }
  assert.deepEqual(UPDATE_CAPABILITY.callers, ["kernel"]);
  assert.deepEqual([UPDATE_CAPABILITY.effect, UPDATE_CAPABILITY.risk], ["execute", "structure"]);
});

test("a call returns the workspace's content and data; a refusal keeps its code, message and hint", async () => {
  const h = await hand();
  await writeFile(join(h.workdir, "a.txt"), "one\ntwo\n");
  const read = await h.hand.handlers.call(frame("workspace.read", { path: "a.txt" }), ctx());
  assert.ok(read.ok);
  assert.equal((read.data as any).text, "one\ntwo");
  assert.deepEqual(read.content, [{ type: "text", text: "one\ntwo" }]);
  assert.deepEqual(failed(await h.hand.handlers.call(frame("workspace.read", { path: "missing" }), ctx()))?.code, "not_found");
  assert.deepEqual(failed(await h.hand.handlers.call(frame("workspace.read", { nope: 1 }), ctx()))?.code, "bad_request");
  assert.deepEqual(failed(await h.hand.handlers.call(frame("workspace.fly"), ctx()))?.code, "not_found");
  assert.deepEqual(failed(await h.hand.handlers.call(frame("screen.tap"), ctx()))?.code, "not_found");
  assert.equal(failed(await h.hand.handlers.call(frame("browser.open", { url: "https://x.test" }), ctx()))?.code, "unavailable");
  assert.equal(failed(await h.hand.handlers.call(frame(EGO_CAPABILITY.name, { task: "t", script: "" }), ctx()))?.code, "unavailable");
});

test("a binary file is sent as a stream and the result refers to it", async () => {
  const h = await hand();
  await writeFile(join(h.workdir, "p.png"), Buffer.from([1, 2, 3, 4]));
  const read = await h.hand.handlers.call(frame("workspace.read", { path: "p.png" }), ctx());
  assert.ok(read.ok);
  assert.deepEqual(h.sent, [{ mime: "image/png", size: 4 }]);
  assert.deepEqual(read.content.find((c) => c.type === "resource"), { type: "resource", stream: "st_1", mime: "image/png", size: 4 });
});

test("cancelling a call ends it as cancelled", async () => {
  const h = await hand();
  const control = new AbortController();
  const running = h.hand.handlers.call(frame("workspace.bash", { command: "sleep 30", yield_ms: 30000 }), ctx(control.signal));
  setTimeout(() => control.abort(), 50);
  assert.equal(failed(await running)?.code, "cancelled");
});

test("assess answers for the body's per-call words; for anything else the declared risk stands", async () => {
  const h = await hand({ update: async () => ({}) });
  assert.equal((await h.hand.handlers.assess("workspace.write", { path: "x.txt", content: "" })).risk, "none");
  assert.equal((await h.hand.handlers.assess("workspace.write", { path: join(h.base, "elsewhere.txt"), content: "" })).risk, "structure");
  assert.equal((await h.hand.handlers.assess("workspace.bash", { command: "true" })).risk, "structure");
  assert.equal((await h.hand.handlers.assess("workspace.ls", {})).risk, "none");
  assert.equal((await h.hand.handlers.assess("x.ash.update", {})).risk, "structure");
  assert.equal((await h.hand.handlers.assess("nothing.here", {})).risk, "structure");
  // a work directory that holds the home folder lends nothing for free
  const wide = createWorkspace({ workdir: join(homedir(), ".."), stateDir: h.base, stream: () => "s" });
  open.push(wide);
  assert.equal(await wide.assess("workspace.write", { path: "x.txt", content: "" }), "structure");
  const state = createWorkspace({ workdir: h.base, stateDir: join(h.base, "work"), stream: () => "s" });
  open.push(state);
  assert.equal(await state.assess("workspace.write", { path: "x.txt", content: "" }), "structure", "a work directory that holds the program's own state");
});

test("~ means the home folder in a path or a work directory", () => {
  assert.deepEqual(expandHome({ path: "~/a", workdir: "~", command: "~/x" }, "/h"), { path: "/h/a", workdir: "/h", command: "~/x" });
  assert.deepEqual(expandHome({ path: "~other" }, "/h"), { path: "~other" });
});

test("the update: only the hub's device service, with a good version and checksum, and not while something runs", async () => {
  const installs: string[][] = [];
  let busy = false;
  const h = await hand({ update: async (v, s) => { installs.push([v, s]); return { version: v }; }, busy: () => busy });
  const hash = "a".repeat(64);
  assert.equal(failed(await h.hand.handlers.call(frame("x.ash.update", { version: "0.2.1", sha256: hash }), ctx()))?.code, "forbidden");
  assert.equal(failed(await h.hand.handlers.call(frame("x.ash.update", { version: "0.2.1", sha256: hash }, "agent:main"), ctx()))?.code, "forbidden");
  assert.equal(failed(await h.hand.handlers.call(frame("x.ash.update", { version: "latest", sha256: hash }, UPDATER), ctx()))?.code, "bad_request");
  assert.equal(failed(await h.hand.handlers.call(frame("x.ash.update", { version: "0.2.1", sha256: "abc" }, UPDATER), ctx()))?.code, "bad_request");
  busy = true;
  assert.equal(failed(await h.hand.handlers.call(frame("x.ash.update", { version: "0.2.1", sha256: hash }, UPDATER), ctx()))?.code, "conflict");
  busy = false;
  const done = await h.hand.handlers.call(frame("x.ash.update", { version: "0.2.1", sha256: hash }, UPDATER), ctx());
  assert.ok(done.ok);
  assert.deepEqual(installs, [["0.2.1", hash]]);
  // a copy that was not installed by the service installer has no update
  const plain = await hand();
  assert.equal(failed(await plain.hand.handlers.call(frame("x.ash.update", { version: "0.2.1", sha256: hash }, UPDATER), ctx()))?.code, "unavailable");
});

test("an unexpected failure is reported as failed with credentials hidden; a WordError keeps its own code", async () => {
  const h = await hand({ update: async () => { throw new Error("download failed token=hidden-value"); } });
  const error = failed(await h.hand.handlers.call(frame("x.ash.update", { version: "0.2.1", sha256: "b".repeat(64) }, UPDATER), ctx()))!;
  assert.equal(error.code, "failed");
  assert.doesNotMatch(error.message, /hidden-value/);
  assert.ok(new WordError("conflict", "x") instanceof Error);
});
