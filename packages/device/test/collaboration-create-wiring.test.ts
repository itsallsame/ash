import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, deviceIdForKey } from "ash-gateway/src/protocol";
import { ClientLink, type TunnelResponse } from "../src/link";
import { createDeviceCollaboration, startDevice } from "../src/main";
import { controlAuthorizationSnapshot } from "../src/collaboration/control-authorization";
import { controlRuntimePath } from "../src/collaboration/control-runtime";
import { CREATE_CAPABILITIES } from "../src/collaboration/create-protocol";
import { FakeCreateSocket } from "./fixtures/codex-create-socket";

class Tunnel extends ClientLink {
  responses = new Map<string, TunnelResponse>();
  frame(f: Record<string, unknown>) { this.onFrame(f); }
  connectFake() { this.conn = { ws: { readyState: WebSocket.OPEN }, close: () => {} } as any; }
  disconnect() { this.conn = null; this.onDisconnected(); }
  protected override reply(sid: string, response: TunnelResponse) { this.responses.set(sid, response); }
  async request(sid: string, from?: string, capability?: string, args: unknown = {}, caller = "person:owner") {
    this.frame({ t: "tun", op: "http.req", method: capability ? "POST" : "GET", path: capability ? "/ash/call" : "/ash/manifest", sid, from });
    if (capability) this.frame({ t: "tun", op: "http.reqbody", sid, data: b64u(Buffer.from(JSON.stringify({ capability, args, caller }))) });
    this.frame({ t: "tun", op: "http.reqend", sid });
    for (let i = 0; i < 500 && !this.responses.has(sid); i++) await new Promise(r => setTimeout(r, 2));
    const response = this.responses.get(sid); assert.ok(response && "body" in response); return { status: response.status, body: JSON.parse(String(response.body)) };
  }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ash-create-wiring-")), key = b64u(Buffer.from("create-owner-fixture")), owner = await deviceIdForKey(key), node = "device";
  writeFileSync(join(dir, "paired.json"), JSON.stringify({ owner_key: key }));
  const config = { version: 1, endpoint_id: node, socket: "/fake.sock", executable: "/fake/codex", supportedVersions: ["1.2.3"] };
  const grant = { version: 1, endpoint_id: node, owner_id: owner, authorization_generation: 1, allowed_actions: ["create_work"], scope: { kind: "exact_cwd", cwd: "/project" } };
  writeFileSync(controlRuntimePath(dir), JSON.stringify(config)); writeFileSync(join(dir, "collaboration-control.json"), JSON.stringify(grant));
  const sockets: FakeCreateSocket[] = []; let watchClosed = 0;
  const testing = { listener: () => ({ ...config, pid: 123, version: "1.2.3", identity: "one" }), connectSocket: async () => { const s = new FakeCreateSocket(); sockets.push(s); return s; }, watch: () => () => { watchClosed++; } };
  const collaboration = createDeviceCollaboration(dir, node, { createTesting: testing, controlTesting: { watch: testing.watch }, createDeadlineMs: 1000 });
  const link = new Tunnel("https://unused.invalid", { id: node, publicKey: "unused", sign: async () => "unused" }, {
    manifest: async context => ({ name: "fake", kind: "laptop", ...collaboration.manifest(context) }), call: (name, args, _caller, signal, context) => collaboration.call(name, args, signal, context), collaborationDisconnected: collaboration.invalidate,
  }, () => {});
  await link.pair(dir, undefined, "fake"); link.connectFake();
  const revision = controlAuthorizationSnapshot(grant, node).authorization_revision!;
  const target = { node_id: node, endpoint_id: node, project_id: "project", cwd: "/project" };
  const projects = { version: 1, node_id: node, endpoint_id: node, authorization_revision: revision, cwd: "/project" };
  const query = { version: 1, target, authorization_revision: revision, operation_id: "operation" };
  const request = { version: 1, target, authorization_revision: revision, request_id: "request", operation_id: "operation", title: "Title", input: { text: "private-body" }, expires_at: Date.now() + 10000 };
  return { dir, owner, node, grant, testing, sockets, collaboration, link, projects, query, request, get watchClosed() { return watchClosed; }, close: async () => { link.stop(); await collaboration.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; i < 8; i++) { const r = await f.link.request(`ready-${i}`, f.owner); if (r.body.collaboration_create?.grant_state === "ready") return r; }
  assert.fail("Pairing watcher did not settle");
}
const writes = (f: Awaited<ReturnType<typeof fixture>>) => f.sockets.flatMap(s => s.calls).filter(c => ["thread/start", "thread/name/set", "turn/start"].includes(c.method));
test("GET manifest requires current transport owner for create scope and preserves apply outward risk", async () => {
  const f = await fixture();
  try {
    for (const from of [undefined, "wrong-owner"]) {
      const r = await f.link.request(`missing-${from}`, from); assert.equal(r.status, 200); assert.equal(r.body.collaboration_create.grant_state, "grant_required"); assert.equal(r.body.collaboration_create.scope, null); assert.equal(r.body.capabilities.filter((c: any) => c.name.startsWith("collaboration.create.")).length, 0);
    }
    const r = await ready(f); assert.deepEqual(r.body.collaboration_create.scope, { kind: "exact_cwd", cwd: "/project" });
    const create = r.body.capabilities.filter((c: any) => c.name.startsWith("collaboration.create.")); assert.equal(create.length, 4); assert.equal(create.find((c: any) => c.name === CREATE_CAPABILITIES.apply).risk, "outward"); assert.equal(f.sockets.length, 0);
  } finally { await f.close(); }
});
test("actual link entry fixed dispatch creates once, queries/reconciles read-only and rejects model/native passthrough", async () => {
  const f = await fixture();
  try {
    await ready(f);
    for (const capability of [CREATE_CAPABILITIES.projects, CREATE_CAPABILITIES.apply, CREATE_CAPABILITIES.query, CREATE_CAPABILITIES.reconcile]) {
      assert.equal((await f.link.request(`agent-${capability}`, f.owner, capability, f.projects, "agent:model")).status, 403);
      assert.equal((await f.link.request(`wrong-${capability}`, "wrong", capability, f.projects)).status, 403);
    }
    assert.equal((await f.link.request("large", f.owner, CREATE_CAPABILITIES.apply, { text: "s".repeat(65536) })).status, 413);
    assert.equal((await f.link.request("override", f.owner, "collaboration.create.thread/start", f.projects)).body.ok, false); assert.equal(f.sockets.length, 0);
    const projects = await f.link.request("projects", f.owner, CREATE_CAPABILITIES.projects, f.projects); assert.equal(projects.body.ok, true);
    const body = { version: 1, request: f.request, expected_connector_epoch: projects.body.data.connector_epoch };
    const applied = await f.link.request("apply", f.owner, CREATE_CAPABILITIES.apply, body); assert.equal(applied.body.ok, true); assert.equal(applied.body.data.fact.first_input.status, "accepted");
    assert.deepEqual(writes(f).map(c => c.method), ["thread/start", "thread/name/set", "turn/start"]);
    assert.doesNotMatch(JSON.stringify(applied), /private-body|principal_id|payload_hash/);
    const query = await f.link.request("query", f.owner, CREATE_CAPABILITIES.query, f.query); assert.equal(query.body.data.fact.work.native_id, "thread");
    const reconcile = await f.link.request("reconcile", f.owner, CREATE_CAPABILITIES.reconcile, f.query); assert.equal(reconcile.body.ok, true); assert.equal(writes(f).length, 3);
    const repeated = await f.link.request("repeated", f.owner, CREATE_CAPABILITIES.apply, body); assert.equal(repeated.body.data.fact.work.native_id, "thread"); assert.equal(writes(f).length, 3);
  } finally { await f.close(); }
});
test("manifest awaits and oversized create responses receive final freshness/bounds checks", async () => {
  const f = await fixture(); let release!: () => void;
  const link = new Tunnel("https://unused.invalid", { id: "device", publicKey: "unused", sign: async () => "unused" }, {
    manifest: async context => { const result = f.collaboration.manifest(context); await new Promise<void>(r => { release = r; }); return { name: "fake", kind: "laptop", ...result }; },
    call: async () => ({ ok: true, content: [], data: "private".repeat(200000) }),
  }, () => {});
  try {
    await link.pair(f.dir, undefined, "fake"); link.connectFake();
    const pending = link.request("manifest", f.owner); while (!release) await new Promise(r => setTimeout(r, 1));
    link.disconnect(); release(); const response = await pending; assert.equal(response.status, 403); assert.doesNotMatch(JSON.stringify(response), /cwd|project/);
    link.connectFake(); const large = await link.request("large", f.owner, CREATE_CAPABILITIES.query, f.query); assert.equal(large.body.data.code, "too_large"); assert.doesNotMatch(JSON.stringify(large), /private/);
  } finally { link.stop(); await f.close(); }
});
test("startDevice starts without matching create grant and closes all create/control watchers", async () => {
  const f = await fixture(); await f.collaboration.close(); f.link.stop();
  let stopped = 0, local: any, pairedLink: Tunnel | undefined, device: Awaited<ReturnType<typeof startDevice>> | undefined;
  // startDevice generates only a disposable fixture signer and does no real install/network/native work.
  try {
    device = await startDevice({ gateway: "https://unused.invalid", name: "fake", stateDir: f.dir, workdir: join(f.dir, "workspace") }, undefined, {
      detect: async () => [], createTesting: f.testing, controlTesting: { watch: f.testing.watch },
      testing: { detectBrowser: async () => undefined, kimiFactory: () => ({ url: "fake", online: false, busy: false, start: async () => {}, close: async () => { stopped++; }, call: async () => ({ ok: false, content: [] }) }),
        linkFactory: (...args) => { local = args[2]; class Running extends Tunnel { override async run() { this.connectFake(); } } pairedLink = new Running(...args); return pairedLink; } },
    });
    await device.run;
    // Grant uses fixture device ID rather than generated signer: startup remains valid with no matching create grant.
    const manifest = await local.manifest(); assert.equal(manifest.collaboration_create.grant_state, "invalid_configuration");
    await device.close(); await device.close(); assert.equal(stopped, 1); assert.ok(f.watchClosed >= 4); assert.equal(f.sockets.length, 0);
  } finally { await device?.close(); pairedLink?.stop(); await f.close(); }
});
