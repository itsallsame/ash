import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { observeAuthorizationWrites, replaceFixtureAuthorization } from "./fixtures/authorization-events";
import { DeviceKey } from "ash-gateway/client/client";
import { b64u, deviceIdForKey } from "ash-gateway/src/protocol";
import { acquireDescriptorStateLock } from "../src/collaboration/descriptor-lock";
import { loadReadAuthorization, parseReadAuthorization, readAuthorizationRevision, readAuthorizationSnapshot } from "../src/collaboration/authorization";
import { loadCurrentPairing } from "../src/collaboration/pairing";
import { AUTHORIZATION_LOCK_FILE, LocalStateTransaction } from "../src/collaboration/local-state-transaction";
import type { ReadPage, WorkSummary } from "../src/collaboration/types";
import { CollaborationReadService, type ReadServiceOptions } from "../src/collaboration/read-service";
import { COLLABORATION_LIST } from "../src/collaboration/capabilities";
import { ConnectionSetupService } from "../src/setup/service";
import { SetupError } from "../src/setup/scope-settings";
import { deviceCli } from "../src/cli";
import { ClientLink, fileSigner, type LocalCapabilities, type TunnelResponse } from "../src/link";

const keyA = await DeviceKey.generate(), keyB = await DeviceKey.generate();
const ownerA = await deviceIdForKey(keyA.publicKey), ownerB = await deviceIdForKey(keyB.publicKey);
const page = () => ({ items: [], next_cursor: null, observed_at: new Date().toISOString(), completeness: "source_page" as const, source: "codex.saved_history" as const, runtime_state: "unknown" as const });
const grant = (owner_id = ownerA, endpoint_id = "node") => parseReadAuthorization({ version: 3, source_id: "fixture-source", binding_revision: "a".repeat(64), owner_id, endpoint_id, authorization_generation: 1, allowedCwds: ["/private/project"] }, endpoint_id);
const ctx = (transportOwnerId: string) => ({ transportOwnerId, isCurrent: () => true });
const code = (result: { data?: unknown }) => (result.data as { code: string }).code;
const envelope = (service: CollaborationReadService, endpoint_id = "node") => ({ version: 1, endpoint_id, authorization_revision: service.manifest().collaboration.authorization_revision });
function makeService(options: ReadServiceOptions) {
  const {factory,...rest}=options;
  return new CollaborationReadService({...rest,testing:{factory,source:{capture:()=>({source_id:"fixture-source",source_revision:"a".repeat(64),version:"fixture"}),current:()=>undefined,drained:async()=>{},release:()=>undefined}}});
}
function fixture(t: { after(fn: () => void): void }) {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "ash-read-owner-")));
  const pair = (key = keyA.publicKey, revoked = false) => writeFileSync(join(state, "paired.json"), JSON.stringify({ owner_key: key, ...(revoked ? { revoked } : {}) }));
  pair();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  return { state, pair, read: join(state, "collaboration-read.json") };
}
function setup(stateDir: string, endpointId = "node") {
  return new ConnectionSetupService({ stateDir, endpointId, testing:{allowBooleanVerification:true},verification: { diagnostics: async () => ({}), verifyScope: async () => true },
    runtime: { reserveChange: async () => ({ assertCurrent: () => undefined, release: () => undefined }) } });
}
const neverStart = (async () => { throw new Error("must not start device"); }) as Parameters<typeof deviceCli>[0];

test("fresh B context cannot read A grant; owner participates in authorization revision", async t => {
  const f = fixture(t); writeFileSync(f.read, JSON.stringify(grant()));
  assert.notEqual(readAuthorizationRevision(grant(ownerA)), readAuthorizationRevision(grant(ownerB)));
  f.pair(keyB.publicKey);
  const snapshot = loadReadAuthorization(f.state, "node");
  assert.equal(snapshot.state, "invalid_configuration"); assert.deepEqual(snapshot.allowedCwds, []);
  let factories = 0;
  const service = makeService({ stateDir: f.state, nodeId: "node", factory: () => { factories++; throw new Error("must not initialize"); } });
  try {
    assert.deepEqual(service.manifest().capabilities, []);
    assert.equal(code(await service.call(COLLABORATION_LIST, envelope(service), undefined, ctx(ownerB))), "permission_denied");
    assert.equal(factories, 0);
  } finally { await service.close(); }
});
test("injected snapshot cannot authorize another owner or replace the actual disk grant", async t => {
  const f = fixture(t); writeFileSync(f.read, JSON.stringify(grant())); f.pair(keyB.publicKey);
  let factories = 0;
  const fake = readAuthorizationSnapshot(grant(ownerB), "node", ownerB);
  const service = makeService({ stateDir: f.state, nodeId: "node", authorization: () => fake, factory: () => { factories++; throw new Error("must not initialize"); } });
  try {
    assert.equal(code(await service.call(COLLABORATION_LIST, envelope(service), undefined, ctx(ownerB))), "permission_denied"); assert.equal(factories, 0);
  } finally { await service.close(); }
});
test("owner swap during native await suppresses result, closes reader, and fresh B still denies", async t => {
  const f = fixture(t); writeFileSync(f.read, JSON.stringify(grant()));
  let release!: (value: ReadPage<WorkSummary>) => void, factories = 0, closed = 0;
  const service = makeService({ stateDir: f.state, nodeId: "node", factory: () => {
    factories++; return { listWork: () => new Promise(resolve => { release = resolve; }), readWork: async () => page(), close: async () => { closed++; } };
  } });
  try {
    const pending = service.call(COLLABORATION_LIST, envelope(service), undefined, ctx(ownerA));
    f.pair(keyB.publicKey); release({ ...page(), items: [{ work: { node_id: "node", endpoint_id: "node", kind: "conversation", native_id: "private-A-work" }, title: "private-A-history", cwd: "/private/project", updated_at: null, runtime_state: "unknown" }] });
    const result = await pending;
    assert.equal(code(result), "permission_denied"); assert.doesNotMatch(JSON.stringify(result), /private-A/);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 1);
    assert.equal(code(await service.call(COLLABORATION_LIST, envelope(service), undefined, ctx(ownerB))), "permission_denied"); assert.equal(factories, 1);
  } finally { await service.close(); }
});
test("legacy v1 stays unchanged through status/read and requires explicit owner-bound reselect", async t => {
  const f = fixture(t), signer = await fileSigner(f.state), config = join(f.state, "device.json");
  writeFileSync(config, JSON.stringify({ stateDir: f.state, workdir: "/private/secret-workdir" }));
  const legacy = JSON.stringify({ version: 1, endpoint_id: signer.id, authorization_generation: 9, allowedCwds: ["/private/legacy"] });
  writeFileSync(f.read, legacy);
  const service = makeService({ stateDir: f.state, nodeId: signer.id, factory: () => { throw new Error("must not initialize"); } });
  const outputs: string[] = [], log = console.log; console.log = (...args) => { outputs.push(args.join(" ")); };
  try {
    await deviceCli(neverStart, ["status", "--config", config]);
    assert.equal(code(await service.call(COLLABORATION_LIST, envelope(service, signer.id), undefined, ctx(ownerA))), "permission_denied");
    assert.equal(readFileSync(f.read, "utf8"), legacy);
    assert.doesNotMatch(outputs.join(""), /private|legacy|owner_key|workdir/);
    await deviceCli(neverStart, ["read-scope", "--config", config, "--allow-cwd", "/chosen"]);
    const current = loadReadAuthorization(f.state, signer.id); assert.equal(current.version, 2); assert.equal(current.owner_id, ownerA); assert.deepEqual(current.allowedCwds, ["/chosen"]);
  } finally { console.log = log; await service.close(); }
});
test("hardlinks/symlinks/FIFO/oversized pairing or scope fail before native reads", async t => {
  for (const target of ["paired.json", "collaboration-read.json"] as const) for (const mode of ["hardlink", "symlink", "fifo", "oversized"] as const) {
    const f = fixture(t); writeFileSync(f.read, JSON.stringify(grant()));
    const path = join(f.state, target), outside = join(f.state, "other-file"), previous = readFileSync(path);
    if (mode === "hardlink") linkSync(path, outside);
    if (mode === "symlink") { writeFileSync(outside, previous); unlinkSync(path); symlinkSync(outside, path); }
    if (mode === "fifo") { unlinkSync(path); execFileSync("mkfifo", [path]); }
    if (mode === "oversized") writeFileSync(path, "x".repeat(target === "paired.json" ? 16385 : 1024 * 1024 + 1));
    const before = Date.now();
    assert.equal(loadReadAuthorization(f.state, "node").state, "invalid_configuration", `${target}/${mode}`);
    assert.deepEqual(loadReadAuthorization(f.state, "node").allowedCwds, []);
    if (target === "paired.json") assert.equal(loadCurrentPairing(path), null);
    let factories = 0;
    const service = makeService({ stateDir: f.state, nodeId: "node", factory: () => { factories++; throw new Error("must not initialize"); } });
    try { assert.equal(code(await service.call(COLLABORATION_LIST, envelope(service), undefined, ctx(ownerA))), "permission_denied"); assert.equal(factories, 0); } finally { await service.close(); }
    const settings = setup(f.state);
    try { await assert.rejects(settings.status(), e => e instanceof SetupError && e.code === "storage"); } finally { settings.close(); }
    assert.ok(Date.now() - before < 2000, "special file must not block");
  }
});
test("CLI and setup contend on the same crash-safe OS lock without changing grants", async t => {
  const f = fixture(t), signer = await fileSigner(f.state), config = join(f.state, "device.json");
  writeFileSync(config, JSON.stringify({ stateDir: f.state }));
  writeFileSync(join(f.state, AUTHORIZATION_LOCK_FILE), "", { mode: 0o600 });
  const db = acquireDescriptorStateLock(f.state), settings = setup(f.state, signer.id);
  const before = (await settings.status()).precondition!;
  try {
    await assert.rejects(deviceCli(neverStart, ["read-scope", "--config", config, "--allow-cwd", "/cli"]), /Read scope: busy/);
    await assert.rejects(settings.applyScope({ kind: "read", allowedCwds: ["/settings"] }, before), e => e instanceof SetupError && e.code === "busy");
    assert.equal(loadReadAuthorization(f.state, signer.id).state, "scope_required");
  } finally { db.release(); settings.close(); }
});
test("process death while holding the authorization lock releases it without PID cleanup", async t => {
  const f = fixture(t), helper = fileURLToPath(new URL("../src/collaboration/local-state-transaction.ts", import.meta.url));
  const source = `import { LocalStateTransaction } from ${JSON.stringify(helper)}; const tx = new LocalStateTransaction(process.argv[1]); tx.write('collaboration-read.json', 'not committed', tx.capture(), () => { process.exit(23); });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, f.state], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr += String(bytes); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
  assert.equal(exit, 23, stderr);
  const settings = setup(f.state);
  try {
    const before = await settings.status();
    await settings.applyScope({ kind: "read", allowedCwds: ["/after-crash"] }, before.precondition!);
    assert.deepEqual(loadReadAuthorization(f.state, "node").allowedCwds, ["/after-crash"]);
    assert.equal(statSync(join(f.state, AUTHORIZATION_LOCK_FILE)).mode & 0o777, 0o600);
  } finally { settings.close(); }
});

class Tunnel extends ClientLink {
  responses = new Map<string, TunnelResponse>();
  frame(frame: Record<string, unknown>) { this.onFrame(frame); }
  connectFake() { this.conn = { ws: { readyState: WebSocket.OPEN }, close: () => {} } as never; }
  bindAttempt() { this.onAttempt(); }
  revoke() { return this.onRevoked(); }
  stubPair(request: () => ReturnType<typeof this.gateway.requestPairing>, approval: () => ReturnType<typeof this.gateway.waitForApproval>) { this.gateway.requestPairing = request; this.gateway.waitForApproval = approval; }
  protected override reply(sid: string, response: TunnelResponse) { this.responses.set(sid, response); }
  async request(sid: string, from: string, args: Record<string, unknown>) {
    this.frame({ t: "tun", op: "http.req", sid, method: "POST", path: "/ash/call", from });
    this.frame({ t: "tun", op: "http.reqbody", sid, data: b64u(Buffer.from(JSON.stringify({ capability: COLLABORATION_LIST, caller: "person:owner", args }))) });
    this.frame({ t: "tun", op: "http.reqend", sid });
    for (let n = 0; n < 300 && !this.responses.has(sid); n++) await new Promise(resolve => setTimeout(resolve, 2));
    const result = this.responses.get(sid); assert.ok(result && "body" in result); return JSON.parse(String(result.body));
  }
}
const fakeLocal: LocalCapabilities = { manifest: async () => ({ name: "fake", kind: "laptop", capabilities: [] }), call: async () => ({ ok: true, content: [] }) };
test("pairing preparation fences replacement and pairing ABA during gateway awaits", async t => {
  for (const restore of [false, true]) {
    const f = fixture(t), transaction = new LocalStateTransaction(f.state);
    const link = new Tunnel("https://unused.invalid", keyA, fakeLocal, () => {});
    let approve!: (value: { permissions: []; grant_version: number }) => void;
    link.stubPair(async () => ({ request_id: "fake", client_id: keyA.id, owner_key: keyB.publicKey, owner_fingerprint: "fake" }), () => new Promise(resolve => { approve = resolve; }));
    try {
      const pending = link.pair(f.state, "fake-code", "fake");
      while (!approve) await new Promise(resolve => setImmediate(resolve));
      transaction.write("paired.json", JSON.stringify({ owner_key: keyB.publicKey }), transaction.capture());
      if (restore) transaction.write("paired.json", JSON.stringify({ owner_key: keyA.publicKey }), transaction.capture());
      approve({ permissions: [], grant_version: 1 });
      await assert.rejects(pending, /stale/);
      assert.equal(loadCurrentPairing(join(f.state, "paired.json"))!.ownerId, restore ? ownerA : ownerB);
    } finally { link.stop(); transaction.close(); }
  }
});
test("late revoke is bound to original connection and cannot revoke a replacement pairing", async t => {
  const f = fixture(t), link = new Tunnel("https://unused.invalid", keyA, fakeLocal, () => {});
  try {
    await link.pair(f.state, undefined, "fake"); link.connectFake(); link.bindAttempt();
    f.pair(keyB.publicKey);
    assert.equal(link.revoke(), false);
    const current = loadCurrentPairing(join(f.state, "paired.json"))!; assert.equal(current.ownerId, ownerB); assert.equal(current.revoked, false);
  } finally { link.stop(); }
});
test("real ClientLink trusted context reaches real read service; owner replacement stays closed", async t => {
  const f = fixture(t); writeFileSync(f.read, JSON.stringify(grant(ownerA, keyA.id)));
  let factories = 0;
  const service = makeService({ stateDir: f.state, nodeId: keyA.id, factory: () => { factories++; return { listWork: async () => page(), readWork: async () => page(), close: async () => {} }; } });
  const local: LocalCapabilities = { manifest: async () => ({ name: "fake", kind: "laptop", ...service.manifest() }), call: (name, args, _caller, signal, context) => service.call(name, args, signal, context), collaborationDisconnected: () => service.invalidate() };
  const link = new Tunnel("https://unused.invalid", keyA, local, () => {});
  try {
    await link.pair(f.state, undefined, "fake"); link.connectFake();
    await observeAuthorizationWrites(f.state, ["paired.json", "collaboration-read.json"], () => { replaceFixtureAuthorization(f.state, "paired.json", JSON.stringify({ owner_key: keyA.publicKey })); replaceFixtureAuthorization(f.state, "collaboration-read.json", JSON.stringify(grant(ownerA, keyA.id))); });
    assert.equal((await link.request("A-read", ownerA, envelope(service, keyA.id))).ok, true); assert.equal(factories, 1);
    f.pair(keyB.publicKey);
    assert.equal((await link.request("B-read", ownerB, envelope(service, keyA.id))).ok, false); assert.equal(factories, 1);
  } finally { link.stop(); await service.close(); }
});
test("real watcher invalidates observed ABA even when an injected additional epoch is constant", async t => {
  const f = fixture(t), settings = new ConnectionSetupService({ stateDir: f.state, endpointId: "node", observationEpoch: () => "constant",
    testing:{allowBooleanVerification:true},verification: { diagnostics: async () => ({}), verifyScope: async () => true }, runtime: { reserveChange: async () => ({ assertCurrent: () => undefined, release: () => undefined }) } });
  try {
    await observeAuthorizationWrites(f.state, ["paired.json"], () => replaceFixtureAuthorization(f.state, "paired.json", JSON.stringify({ owner_key: keyA.publicKey })));
    const before = await settings.status(), original = readFileSync(join(f.state, "paired.json"), "utf8");
    await observeAuthorizationWrites(f.state, ["paired.json"], () => { replaceFixtureAuthorization(f.state, "paired.json", JSON.stringify({ owner_key: keyB.publicKey })); replaceFixtureAuthorization(f.state, "paired.json", original); });
    const after = await settings.status();
    assert.equal(after.precondition!.ownerId, before.precondition!.ownerId);
    assert.notEqual(after.precondition!.epoch, before.precondition!.epoch);
    await assert.rejects(settings.applyScope({ kind: "read", allowedCwds: ["/selected"] }, before.precondition!), e => e instanceof SetupError && e.code === "stale");
  } finally { settings.close(); }
});
test("current transport revoke atomically persists only its paired owner", async t => {
  const f = fixture(t), link = new Tunnel("https://unused.invalid", keyA, fakeLocal, () => {});
  try {
    await link.pair(f.state, undefined, "fake"); link.connectFake();
    assert.equal(link.revoke(), true);
    const revoked = loadCurrentPairing(join(f.state, "paired.json"))!;
    assert.equal(revoked.ownerId, ownerA); assert.equal(revoked.revoked, true);
    assert.equal(statSync(join(f.state, "paired.json")).mode & 0o777, 0o600);
  } finally { link.stop(); }
});
test("parent descriptor retains native flock after helper exit and another Node process is busy", async t => {
  const f = fixture(t), helper = fileURLToPath(new URL("../src/collaboration/descriptor-lock.ts", import.meta.url));
  const lock = acquireDescriptorStateLock(f.state);
  try {
    const source = `import {acquireDescriptorStateLock} from ${JSON.stringify(helper)}; try { acquireDescriptorStateLock(process.argv[1]).release(); process.exit(9); } catch(e) { process.exit(e.code === 'busy' ? 0 : 10); }`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, f.state], { stdio: "ignore" });
    const exit = await new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
    assert.equal(exit, 0, "separate Node process must not acquire while parent's verified fd is retained");
  } finally { lock.release(); }
  acquireDescriptorStateLock(f.state).release();
});
