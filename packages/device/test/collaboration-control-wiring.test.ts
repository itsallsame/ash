import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { b64u, deviceIdForKey } from "ash-gateway/src/protocol";
import { DeviceKey } from "ash-gateway/client/client";
import { parseControlInput } from "../../core/src/collaboration/control-service";
import { ClientLink, fileSigner, type LocalCapabilities, type TunnelResponse } from "../src/link";
import { createDeviceCollaboration, startDevice } from "../src/main";
import { currentPinnedOwnerId, loadCurrentPairing } from "../src/collaboration/pairing";
import { controlAuthorizationSnapshot } from "../src/collaboration/control-authorization";
import { CONTROL_CAPABILITIES } from "../src/collaboration/control-protocol";
import { controlRuntimePath } from "../src/collaboration/control-runtime";

// Public, disposable fixture keypairs; no account or installed device credentials.
const gatewayKeys = [
  { id: "_IJ55kaFCTFOGZzOOtezli", jwk: { key_ops: ["sign"], ext: true, kty: "EC", x: "J1uW-LUEUAyk1T4BpbliNjCJD-5Zs1v900aPyaYV8lo", y: "0fdv1OCRFt0Fqw6FvWAr4IQObkVFmTkytw5Bz_SYHIM", crv: "P-256", d: "-IILIHz-dX35E7EIfwVcrl-UuPBQetbKwUAI3JtntvQ" } },
  { id: "-Mu8OuWwq82b9P1TpI7YNi", jwk: { key_ops: ["sign"], ext: true, kty: "EC", x: "ZFiuSSAD9wvywdzAl31nvSduqC--O1mV0MUFqeF_7VE", y: "QzqrX9k2N78rNHViidbWkttI0-52V5ywk1DZ3TjpHrA", crv: "P-256", d: "xdN1SZVsf7W0vWqbtU8DOWKpTaC2aPM_AHlhrCGK9z4" } },
];

class Socket extends EventEmitter {
  closed = false;
  constructor(private calls: any[], private mode: { hang: boolean; delayMs?: number; holdRead?: Promise<void>; holdTurn?: Promise<void>; onCall?: (call: any) => void }) { super(); }
  send(data: string) {
    const call = JSON.parse(data); this.calls.push(call); this.mode.onCall?.(call);
    if (!call.id || this.mode.hang && call.method === "turn/start") return;
    const result = call.method === "initialize" ? { userAgent: "codex 1.2.3" } : call.method === "turn/start" ? { turn: { id: "turn" } } : { thread: { id: "thread", cwd: "/project", status: { type: "idle" } } };
    const respond = () => this.emit("message", Buffer.from(JSON.stringify({ id: call.id, result })));
    if (call.method === "thread/read" && this.mode.holdRead) void this.mode.holdRead.then(respond);
    else if (call.method === "turn/start" && this.mode.holdTurn) void this.mode.holdTurn.then(respond);
    else if (this.mode.delayMs) setTimeout(respond, this.mode.delayMs); else queueMicrotask(respond);
  }
  close() { this.closed = true; }
}
class Tunnel extends ClientLink {
  responses = new Map<string, TunnelResponse>();
  frame(frame: Record<string, unknown>) { this.onFrame(frame); }
  connectFake() { this.conn = { ws: { readyState: WebSocket.OPEN }, close: () => {} } as any; }
  disconnect() { this.conn = null; this.onDisconnected(); }
  protected override reply(sid: string, response: TunnelResponse) { this.responses.set(sid, response); }
  async request(sid: string, capability: string, args: unknown, from?: string, caller = "person:owner") {
    this.frame({ t: "tun", op: "http.req", method: "POST", path: "/ash/call", sid, from });
    this.frame({ t: "tun", op: "http.reqbody", sid, data: b64u(Buffer.from(JSON.stringify({ capability, caller, args }))) });
    this.frame({ t: "tun", op: "http.reqend", sid });
    for (let i = 0; i < 300 && !this.responses.has(sid); i++) await new Promise(r => setTimeout(r, 2));
    const response = this.responses.get(sid)!;
    assert.ok(response && "body" in response);
    return { status: response.status, body: JSON.parse(String(response.body)) };
  }
}
async function fixture(deadlineMs = 1000, deviceKey?: typeof gatewayKeys[number], ownerKey?: typeof gatewayKeys[number]) {
  const dir = mkdtempSync(join(tmpdir(), "ash-control-wiring-"));
  if (deviceKey) writeFileSync(join(dir, "device.jwk"), JSON.stringify(deviceKey.jwk));
  const key = ownerKey ? (await DeviceKey.fromJwk(ownerKey.jwk)).publicKey : b64u(Buffer.from("owner-fixture")), owner = await deviceIdForKey(key), node = (await fileSigner(dir)).id;
  writeFileSync(join(dir, "paired.json"), JSON.stringify({ owner_key: key, permissions: ["expose_capability"], grant_version: 1 }));
  const config = { version: 1, endpoint_id: node, socket: "/fake.sock", executable: "/fake/codex", supportedVersions: ["1.2.3"] };
  const grant = { version: 1, endpoint_id: node, owner_id: owner, authorization_generation: 1, allowed_actions: ["send_input"], scope: { kind: "exact_cwd", cwd: "/project" } };
  writeFileSync(controlRuntimePath(dir), JSON.stringify(config)); writeFileSync(join(dir, "collaboration-control.json"), JSON.stringify(grant));
  const calls: any[] = [], sockets: Socket[] = [], mode = { hang: false, delayMs: 0, holdRead: undefined as Promise<void> | undefined, holdTurn: undefined as Promise<void> | undefined, onCall: undefined as ((call: any) => void) | undefined };
  let changed = () => {}, watchError = () => {}, watchClosed = false;
  const controlTesting = {
    listener: () => ({ socket: config.socket, executable: config.executable, pid: 123, version: "1.2.3", identity: "one" }),
    connectSocket: async () => { const socket = new Socket(calls, mode); sockets.push(socket); return socket; },
    watch: (_paths: readonly string[], invalidate: () => void, error: () => void) => { changed = invalidate; watchError = error; return () => { watchClosed = true; }; },
  };
  const collaboration = createDeviceCollaboration(dir, node, { controlDeadlineMs: deadlineMs, controlTesting });
  const link = new Tunnel("https://unused.invalid", { id: node, publicKey: "unused", sign: async () => "unused" }, { manifest: async () => ({ name: "fake", kind: "laptop", ...collaboration.manifest() }), call: (cap, args, _caller, signal, context) => collaboration.call(cap, args, signal, context), collaborationDisconnected: collaboration.invalidate }, () => {});
  await link.pair(dir, undefined, "fake"); link.connectFake();
  const work = { node_id: node, endpoint_id: node, kind: "conversation", native_id: "thread" }, envelope = { version: 1, endpoint_id: node, authorization_revision: controlAuthorizationSnapshot(grant, node).authorization_revision!, work, action: "send_input" };
  return { dir, owner, key, node, controlTesting, calls, sockets, mode, collaboration, link, envelope, work, grant, changed: () => changed(), watchError: () => watchError(), get watchClosed() { return watchClosed; }, close: async () => { link.stop(); await collaboration.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const writes = (calls: any[]) => calls.filter(c => ["turn/start", "turn/steer"].includes(c.method));

async function waitCurrentPair(f: Awaited<ReturnType<typeof fixture>>) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await f.link.request(`ready-${attempt}`, CONTROL_CAPABILITIES.query, { ...f.envelope, operation_id: "00000000-0000-4000-8000-000000000001" }, f.owner);
    if (response.body.ok) { assert.equal(currentPinnedOwnerId(f.dir), f.owner); return; }
    assert.equal(response.body.data.code, "permission_denied");
  }
  assert.fail("Pairing watcher did not admit a current setup query");
}

test("fresh synchronous pairing identity matches gateway async algorithm and strict bounded shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-pair-wiring-")), path = join(dir, "paired.json");
  try {
    for (const bytes of [Buffer.from("owner"), Buffer.alloc(91, 255), Buffer.from([0, 1, 2, 128])]) {
      const key = b64u(bytes); writeFileSync(path, JSON.stringify({ owner_key: key }));
      assert.equal(currentPinnedOwnerId(dir), await deviceIdForKey(key));
    }
    for (const bad of [{ owner_key: 1 }, { owner_key: "YQ", revoked: "false" }, { owner_key: "YQ", extra: true }, { owner_key: "YQ", permissions: "web_ui" }, { owner_key: "YQ", grant_version: 0 }, { owner_key: "YQ=" }, { owner_key: "YQ", revoked: true }]) {
      writeFileSync(path, JSON.stringify(bad)); assert.equal(currentPinnedOwnerId(dir), null);
    }
    writeFileSync(path, " ".repeat(17000)); assert.equal(loadCurrentPairing(path), null);
    rmSync(path); symlinkSync("/missing", path); assert.equal(loadCurrentPairing(path), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real entry and runtime expose independent fixed control manifest with exact risks; no read scope grants control", async () => {
  const f = await fixture();
  try {
    const manifest = f.collaboration.manifest();
    assert.equal(manifest.collaboration.authorization_state, "scope_required");
    assert.equal(manifest.collaboration_control.grant_state, "ready");
    assert.deepEqual(manifest.capabilities.map(c => [c.name, c.risk]), Object.entries(CONTROL_CAPABILITIES).map(([op, name]) => [name, op === "apply" ? "outward" : "none"]));
    writeFileSync(join(f.dir, "collaboration-read.json"), JSON.stringify({ version: 2, owner_id: f.owner, endpoint_id: f.node, authorization_generation: 1, allowedCwds: ["/project"] }));
    rmSync(join(f.dir, "collaboration-control.json")); f.changed();
    assert.equal(f.collaboration.manifest().collaboration.authorization_state, "ready");
    assert.equal(f.collaboration.manifest().collaboration_control.grant_state, "grant_required");
    const denied = await f.link.request("nogrant", CONTROL_CAPABILITIES.state, f.envelope, f.owner);
    assert.equal(denied.body.data.code, "permission_denied"); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("actual Tunnel → production dispatcher → runtime/native state/query/reconcile stay read-only", async () => {
  const f = await fixture();
  try {
    for (const operation of ["query", "reconcile", "state"] as const) {
      const answer = await f.link.request(operation, CONTROL_CAPABILITIES[operation], { ...f.envelope, ...(operation === "state" ? {} : { operation_id: "00000000-0000-4000-8000-000000000001" }) }, f.owner);
      assert.equal(answer.body.ok, true);
      assert.equal(writes(f.calls).length, 0);
      if (operation !== "state") assert.equal(f.calls.filter(c => c.method === "thread/resume").length, 0);
    }
    assert.equal(f.calls.filter(c => c.method === "thread/resume").length, 1);
    assert.deepEqual(f.calls.find(c => c.method === "thread/resume").params, { threadId: "thread", excludeTurns: true });
  } finally { await f.close(); }
  assert.ok(f.sockets.every(s => s.closed)); assert.equal(f.watchClosed, true);
});

test("entry apply preserves actual epoch and durable stable client ID; repeat executes once", async () => {
  const f = await fixture();
  try {
    const state = (await f.link.request("state", CONTROL_CAPABILITIES.state, f.envelope, f.owner)).body.data;
    const { action, ...base } = f.envelope;
    const input = { ...base, expected_connector_epoch: state.connector_epoch, request: { request_id: "request", operation_id: "operation", work: f.work, action, input: { text: "private-text" }, expires_at: Date.now() + 10000 } };
    const first = (await f.link.request("apply", CONTROL_CAPABILITIES.apply, input, f.owner)).body;
    const repeat = (await f.link.request("repeat", CONTROL_CAPABILITIES.apply, input, f.owner)).body;
    assert.equal(first.ok, true); assert.deepEqual(first.data.fact, repeat.data.fact);
    assert.equal(writes(f.calls).length, 1);
    assert.equal(writes(f.calls)[0].params.clientUserMessageId, first.data.fact.native_client_message_id);
    assert.equal(first.data.fact.connector_epoch, state.connector_epoch);
    assert.equal(first.data.fact.native_interface_version, "1.2.3");
    assert.doesNotMatch(JSON.stringify(first), /private-text|principal_id|payload_hash/);
    const queried = await f.link.request("query", CONTROL_CAPABILITIES.query, { ...f.envelope, operation_id: "operation" }, f.owner);
    assert.equal(queried.body.data.fact.operation_id, "operation"); assert.equal(writes(f.calls).length, 1);
  } finally { await f.close(); }
});

test("trusted transport is tied to live connection, fresh pairing and post-await checks", async () => {
  for (const change of ["disconnect", "revoke", "watch-error", "aba"] as const) {
    const f = await fixture();
    try {
      // Initial fs.watchFile stat callbacks can invalidate an early setup request.
      // Establish a current pairing through a successful query before testing revoke.
      await waitCurrentPair(f);
      let admitted = false;
      for (let attempt = 0; attempt < 8 && !admitted; attempt++) {
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        f.mode.holdRead = new Promise<void>(resolve => { release = resolve; });
        f.mode.onCall = call => { if (call.method === "thread/read") enter(); };
        const sid = `state-${attempt}`;
        const pending = f.link.request(sid, CONTROL_CAPABILITIES.state, f.envelope, f.owner);
        const phase = await Promise.race([entered.then(() => ({ kind: "entered" as const })), pending.then(response => ({ kind: "setup_denied" as const, response }))]);
        if (phase.kind === "setup_denied") {
          release(); f.mode.holdRead = undefined;
          assert.equal(phase.response.body.ok, false); assert.equal(phase.response.body.data.code, "permission_denied");
          continue;
        }
        admitted = true;
        assert.ok(f.calls.some(call => call.method === "thread/read"));
        if (change === "disconnect") f.link.disconnect();
        if (change === "revoke") writeFileSync(join(f.dir, "paired.json"), JSON.stringify({ owner_key: f.key, revoked: true }));
        if (change === "watch-error") f.watchError();
        if (change === "aba") { f.changed(); f.changed(); }
        release(); f.mode.holdRead = undefined;
        if (change === "disconnect") { await assert.rejects(pending); assert.equal(f.link.responses.has(sid), false); }
        else { const response = await pending; assert.equal(response.body.ok, false); assert.doesNotMatch(JSON.stringify(response), /"cwd"|"connector_epoch"/); }
      }
      assert.equal(admitted, true); assert.equal(writes(f.calls).length, 0);
    } finally { await f.close(); }
  }
});

test("fixed dispatch, input bounds and error sanitization do not permit native passthrough", async () => {
  const f = await fixture();
  try {
    for (const capability of ["collaboration.control.turn/start", "collaboration.control.cancel", "collaboration.native.invoke"]) {
      const response = await f.link.request(capability, capability, f.envelope, f.owner);
      assert.equal(response.body.ok, false); assert.equal(f.calls.length, 0);
    }
    assert.equal((await f.link.request("agent", CONTROL_CAPABILITIES.state, f.envelope, f.owner, "agent:model")).status, 403);
    assert.equal((await f.link.request("spoof", CONTROL_CAPABILITIES.state, f.envelope, "wrong-owner")).status, 403);
    const large = await f.link.request("large", CONTROL_CAPABILITIES.apply, { secret: "s".repeat(65536) }, f.owner);
    assert.equal(large.status, 413); assert.equal(large.body.data.code, "too_large"); assert.doesNotMatch(JSON.stringify(large), /ssss/);
    f.link.disconnect(); assert.equal((await f.link.request("offline", CONTROL_CAPABILITIES.state, f.envelope, f.owner)).status, 403);
  } finally { await f.close(); }
});

test("busy survives unresolved native past deadline; shutdown releases resources", async () => {
  const f = await fixture(200);
  try {
    const state = (await f.link.request("state", CONTROL_CAPABILITIES.state, f.envelope, f.owner)).body.data;
    f.mode.hang = true; f.mode.delayMs = 5;
    const { action, ...base } = f.envelope;
    const result = await f.link.request("apply", CONTROL_CAPABILITIES.apply, { ...base, expected_connector_epoch: state.connector_epoch, request: { request_id: "request", operation_id: "operation", work: f.work, action, input: { text: "body" }, expires_at: Date.now() + 10000 } }, f.owner);
    assert.equal(result.body.data.code, "result_unknown"); assert.equal(writes(f.calls).length, 1); assert.equal(f.collaboration.busy, true);
    await f.collaboration.close(); assert.ok(f.sockets.every(s => s.closed));
    f.mode.hang = false; f.mode.delayMs = 0;
    const reopened = createDeviceCollaboration(f.dir, f.node, { controlTesting: f.controlTesting });
    const link = new Tunnel("https://unused.invalid", { id: f.node, publicKey: "unused", sign: async () => "unused" }, { manifest: async () => ({ name: "fake", kind: "laptop", ...reopened.manifest() }), call: (cap, args, _caller, signal, context) => reopened.call(cap, args, signal, context), collaborationDisconnected: reopened.invalidate }, () => {});
    try {
      await link.pair(f.dir, undefined, "fake"); link.connectFake();
      const query = await link.request("query-reopened", CONTROL_CAPABILITIES.query, { ...f.envelope, operation_id: "operation" }, f.owner);
      assert.equal(query.body.ok, true); assert.equal(query.body.data.fact.delivery_status, "unknown"); assert.equal(writes(f.calls).length, 1);
    } finally { link.stop(); await reopened.close(); }
  } finally { await f.close(); }
});

test("control manifest preserves outward and oversized or source-error responses never leak bodies", async () => {
  const f = await fixture();
  let mode = "large";
  const link = new Tunnel("https://unused.invalid", { id: "device", publicKey: "unused", sign: async () => "unused" }, {
    manifest: async () => ({ name: "fake", kind: "laptop", ...f.collaboration.manifest() }),
    call: async () => { if (mode === "error") throw new Error("secret-native-error"); return { ok: true, content: [], data: "private-body".repeat(100000) }; },
  }, () => {});
  try {
    await link.pair(f.dir, undefined, "fake"); link.connectFake();
    link.frame({ t: "tun", op: "http.req", method: "GET", path: "/ash/manifest", sid: "manifest" });
    link.frame({ t: "tun", op: "http.reqend", sid: "manifest" });
    for (let i = 0; i < 20 && !link.responses.has("manifest"); i++) await new Promise(r => setTimeout(r, 2));
    const response = link.responses.get("manifest")!; assert.ok("body" in response);
    const manifest = JSON.parse(String(response.body));
    assert.equal(manifest.capabilities.find((c: any) => c.name === CONTROL_CAPABILITIES.apply).risk, "outward");
    assert.equal(response.headers?.["cache-control"], "no-store");
    const large = await link.request("large-response", CONTROL_CAPABILITIES.query, f.envelope, f.owner);
    assert.equal(large.body.data.code, "too_large"); assert.doesNotMatch(JSON.stringify(large), /private-body/);
    mode = "error";
    const error = await link.request("source-error", CONTROL_CAPABILITIES.query, f.envelope, f.owner);
    assert.equal(error.body.data.code, "offline"); assert.doesNotMatch(JSON.stringify(error), /secret-native-error/);
  } finally { link.stop(); await f.close(); }
});

test("HTTP abort suppresses late control response without cancelling or replaying daemon work", async () => {
  const f = await fixture();
  try {
    await waitCurrentPair(f);
    let admitted = false, operationId = "";
    for (let attempt = 0; attempt < 8 && !admitted; attempt++) {
      const stateResponse = await f.link.request(`state-${attempt}`, CONTROL_CAPABILITIES.state, f.envelope, f.owner);
      if (!stateResponse.body.ok) { assert.equal(stateResponse.body.data.code, "permission_denied"); continue; }
      assert.equal(currentPinnedOwnerId(f.dir), f.owner);
      const { action, ...base } = f.envelope, sid = `aborted-${attempt}`;
      operationId = `operation-${attempt}`;
      const body = { ...base, expected_connector_epoch: stateResponse.body.data.connector_epoch, request: { request_id: `request-${attempt}`, operation_id: operationId, work: f.work, action, input: { text: "body" }, expires_at: Date.now() + 10000 } };
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      f.mode.holdTurn = new Promise<void>(resolve => { release = resolve; });
      f.mode.onCall = call => { if (call.method === "turn/start") enter(); };
      const pending = f.link.request(sid, CONTROL_CAPABILITIES.apply, body, f.owner);
      const phase = await Promise.race([entered.then(() => ({ kind: "entered" as const })), pending.then(response => ({ kind: "setup_denied" as const, response }))]);
      if (phase.kind === "setup_denied") {
        release(); f.mode.holdTurn = undefined; f.mode.onCall = undefined;
        assert.equal(phase.response.body.ok, false); assert.ok(["permission_denied", "stale_precondition"].includes(phase.response.body.data.code));
        assert.equal(writes(f.calls).length, 0); continue;
      }
      admitted = true; assert.equal(writes(f.calls).length, 1);
      // Cancel only after the actual native write is admitted, while its reply is held.
      f.link.frame({ t: "tun", op: "http.abort", sid }); release();
      f.mode.holdTurn = undefined; f.mode.onCall = undefined;
      await assert.rejects(pending); assert.equal(f.link.responses.has(sid), false);
    }
    assert.equal(admitted, true); assert.equal(writes(f.calls).length, 1);
    assert.equal(f.calls.some(c => /cancel|interrupt/.test(c.method)), false);
    const query = await f.link.request("query", CONTROL_CAPABILITIES.query, { ...f.envelope, operation_id: operationId }, f.owner);
    assert.equal(query.body.ok, true); assert.equal(query.body.data.fact.delivery_status, "unknown"); assert.equal(writes(f.calls).length, 1);
  } finally { await f.close(); }
});

async function boot(f: Awaited<ReturnType<typeof fixture>>, options: { failPair?: boolean; failInstall?: boolean; failConstruct?: boolean; failClose?: boolean } = {}) {
  f.link.stop(); await f.collaboration.close();
  let link: Tunnel | undefined, local: LocalCapabilities | undefined, kimiClosed = 0, installs = 0;
  const result = startDevice({ gateway: "https://unused.invalid", name: "fake", stateDir: f.dir, workdir: join(f.dir, "workspace"), installRoot: join(f.dir, "install") }, undefined, {
    detect: async () => [], restart: () => {}, controlTesting: f.controlTesting, controlDeadlineMs: 40,
    testing: {
      detectBrowser: async () => undefined,
      kimiFactory: () => ({ url: "fake", online: false, busy: false, start: async () => {}, close: async () => { kimiClosed++; if (options.failClose && kimiClosed === 1) throw new Error("fake close failed"); }, call: async () => ({ ok: false, content: [] }) }),
      install: async () => { installs++; if (options.failInstall) throw new Error("fake install failed"); return {} as any; },
      linkFactory: (...args) => {
        if (options.failConstruct) throw new Error("fake constructor failed");
        local = args[2];
        class RunningTunnel extends Tunnel {
          override async pair(...input: Parameters<ClientLink["pair"]>) { if (options.failPair) throw new Error("fake pair failure"); await super.pair(...input); }
          override async run() { this.connectFake(); }
        }
        link = new RunningTunnel(...args); return link;
      },
    },
  });
  return { result, get link() { return link!; }, get local() { return local!; }, get kimiClosed() { return kimiClosed; }, get installs() { return installs; } };
}

test("real startDevice pair failure and close release control watcher and local resources", async () => {
  for (const failPair of [true, false]) {
    const f = await fixture();
    try {
      const app = await boot(f, { failPair });
      if (failPair) await assert.rejects(app.result, /fake pair failure/);
      else { const device = await app.result; await device.run; await device.close(); await device.close(); }
      assert.equal(f.watchClosed, true); assert.ok(f.sockets.every(s => s.closed)); assert.ok(app.kimiClosed > 0);
    } finally { await f.close(); }
  }
});

test("real startDevice blocks update during unresolved native, invalidates upgrade scope, and recovers failed upgrade", async () => {
  const f = await fixture();
  let device: Awaited<ReturnType<typeof startDevice>> | undefined;
  try {
    const app = await boot(f, { failInstall: true }); device = await app.result; await device.run;
    const state = (await app.link.request("state", CONTROL_CAPABILITIES.state, f.envelope, f.owner)).body.data;
    f.mode.hang = true;
    const { action, ...base } = f.envelope;
    await app.link.request("apply", CONTROL_CAPABILITIES.apply, { ...base, expected_connector_epoch: state.connector_epoch, request: { request_id: "request", operation_id: "operation", work: f.work, action, input: { text: "body" }, expires_at: Date.now() + 10000 } }, f.owner);
    await assert.rejects(app.local.update!("1.2.3", "a".repeat(64)), /active tasks/); assert.equal(app.installs, 0);
    await new Promise(r => setTimeout(r, 80));
    const resumes = f.calls.filter(c => c.method === "thread/resume").length;
    await assert.rejects(app.local.update!("1.2.3", "a".repeat(64)), /fake install failed/); assert.equal(app.installs, 1);
    f.mode.hang = false;
    const fresh = await app.link.request("fresh-state", CONTROL_CAPABILITIES.state, f.envelope, f.owner);
    assert.equal(fresh.body.ok, true); assert.notEqual(fresh.body.data.connector_epoch, state.connector_epoch);
    assert.equal(f.calls.filter(c => c.method === "thread/resume").length, resumes + 1); assert.equal(writes(f.calls).length, 1);
    await device.close(); assert.equal(f.watchClosed, true);
  } finally { await device?.close(); await f.close(); }
});

test("successful upgrade invalidates native scopes and keeps calls disabled until restart", async () => {
  const f = await fixture(); let device: Awaited<ReturnType<typeof startDevice>> | undefined;
  try {
    const app = await boot(f); device = await app.result; await device.run;
    assert.equal((await app.link.request("state", CONTROL_CAPABILITIES.state, f.envelope, f.owner)).body.ok, true);
    await app.local.update!("1.2.3", "a".repeat(64)); assert.equal(app.installs, 1);
    assert.ok(f.sockets.every(s => s.closed));
    const count = f.calls.length;
    const disabled = await app.link.request("updating", CONTROL_CAPABILITIES.state, f.envelope, f.owner);
    assert.equal(disabled.body.ok, false); assert.equal(f.calls.length, count);
    await device.close(); assert.equal(f.watchClosed, true); assert.equal(app.kimiClosed, 1);
  } finally { await device?.close(); await f.close(); }
});

test("startDevice constructor failure closes allocated control and local resources", async () => {
  const f = await fixture();
  try {
    const app = await boot(f, { failConstruct: true });
    await assert.rejects(app.result, /fake constructor failed/);
    assert.equal(f.watchClosed, true); assert.equal(app.kimiClosed, 1);
  } finally { await f.close(); }
});

test("failed close completes other resource cleanup and permits retry", async () => {
  const f = await fixture(); let device: Awaited<ReturnType<typeof startDevice>> | undefined;
  try {
    const app = await boot(f, { failClose: true }); device = await app.result; await device.run;
    assert.equal((await app.link.request("state", CONTROL_CAPABILITIES.state, f.envelope, f.owner)).body.ok, true);
    await assert.rejects(device.close(), /fake close failed/);
    assert.equal(f.watchClosed, true); assert.ok(f.sockets.every(s => s.closed)); assert.equal(app.kimiClosed, 1);
    await device.close(); assert.equal(app.kimiClosed, 2);
  } finally { await device?.close(); await f.close(); }
});

test("gateway key-derived leading underscore and hyphen identities pass Core parse through actual control apply", async () => {
  for (let index = 0; index < gatewayKeys.length; index++) {
    const device = gatewayKeys[index], ownerKey = gatewayKeys[1 - index];
    const f = await fixture(1000, device, ownerKey);
    try {
      assert.equal(f.node, device.id); assert.equal(f.owner, ownerKey.id);
      assert.equal(await deviceIdForKey((await DeviceKey.fromJwk(device.jwk)).publicKey), device.id);
      await waitCurrentPair(f);
      const fromCore = (operation: "state" | "query" | "apply", args: unknown) => {
        const parsed = parseControlInput(operation, Buffer.from(JSON.stringify({ ...(args as object), device_id: `device:${f.node}` })));
        const { device_id, ...envelope } = parsed; assert.equal(device_id, `device:${device.id}`); return envelope;
      };
      const state = await f.link.request("prefixed-state", CONTROL_CAPABILITIES.state, fromCore("state", f.envelope), f.owner);
      assert.equal(state.body.ok, true); assert.equal(writes(f.calls).length, 0);
      const query = await f.link.request("prefixed-query", CONTROL_CAPABILITIES.query, fromCore("query", { ...f.envelope, operation_id: "00000000-0000-4000-8000-000000000001" }), f.owner);
      assert.deepEqual(query.body.data, { fact: null }); assert.equal(writes(f.calls).length, 0);
      const { action, ...base } = f.envelope;
      const apply = fromCore("apply", { ...base, expected_connector_epoch: state.body.data.connector_epoch, request: { request_id: "request", operation_id: "operation", work: f.work, action, input: { text: "prefix binding" }, expires_at: Date.now() + 10000 } });
      const stateSchema = f.collaboration.manifest().capabilities.find(cap => cap.name === CONTROL_CAPABILITIES.state)!.input_schema as any;
      assert.equal(stateSchema.properties.work.properties.node_id.const, device.id);
      assert.throws(() => parseControlInput("apply", Buffer.from(JSON.stringify({ ...apply, device_id: `device:${f.node}`, request: { ...(apply as any).request, request_id: "_request" } }))), /invalid/);
      assert.throws(() => parseControlInput("state", Buffer.from(JSON.stringify({ ...f.envelope, work: { ...f.work, native_id: "_native" }, device_id: `device:${f.node}` }))), /invalid/);
      for (const bad of ["", "/node", ":node", "_".repeat(257), "-node\u0000", "_node space"]) assert.throws(() => parseControlInput("state", Buffer.from(JSON.stringify({ ...f.envelope, endpoint_id: bad, work: { ...f.work, node_id: bad, endpoint_id: bad }, device_id: `device:${bad}` }))), /invalid/);
      const accepted = await f.link.request("prefixed-apply", CONTROL_CAPABILITIES.apply, apply, f.owner);
      assert.equal(accepted.body.ok, true); assert.equal(accepted.body.data.fact.work.node_id, device.id);
      assert.equal(writes(f.calls).length, 1); assert.equal(writes(f.calls)[0].params.clientUserMessageId, accepted.body.data.fact.native_client_message_id);
      const denied = await f.link.request("other-owner", CONTROL_CAPABILITIES.query, fromCore("query", { ...f.envelope, operation_id: "operation" }), device.id);
      assert.equal(denied.status, 403); assert.equal(writes(f.calls).length, 1);
      assert.throws(() => parseControlInput("state", Buffer.from(JSON.stringify({ ...f.envelope, device_id: `device:${ownerKey.id}` }))), /permission_denied/);
    } finally { await f.close(); }
  }
});
