import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceKey } from "ash-gateway/client/client";
import { deviceIdForKey } from "ash-gateway/src/protocol";
import { b64u, fromB64u } from "ash-gateway/src/protocol";
import { OwnerLink } from "../src/gateway/link";
import { EdgeRouter, startEdgeServer, type EdgeCaller, type EdgeRequest, type EdgeResponse } from "../src/server";
import { Ledger } from "../src/world/ledger";
import { WorldRouter } from "../src/world/router";
import { WorldMembers } from "../src/world/member";
import { readCapabilities } from "../../device/src/collaboration/capabilities";
import { SCREEN_TOKEN_HEADER } from "../../sdk/src/api";

const readOwnerId = await deviceIdForKey((await DeviceKey.generate()).publicKey);
const work = { node_id: "desktop", endpoint_id: "desktop", kind: "conversation", native_id: "thread-1" };
const input = { version: 1, device_id: "device:desktop", endpoint_id: "desktop", authorization_generation: 1, authorization_revision: "a".repeat(64), action: "list_work" };
const page = () => ({ items: [{ work, title: "Native title", cwd: "/approved", updated_at: 100, runtime_state: "unknown" }], next_cursor: null, observed_at: new Date().toISOString(), completeness: "source_page", source: "codex.saved_history", runtime_state: "unknown" });
const req = (body: unknown = input, headers: Record<string, string> = {}): EdgeRequest => ({ method: "POST", url: new URL("http://ash/api/collaboration/read"), headers, body: Buffer.from(JSON.stringify(body)) });
const json = (r: EdgeResponse) => JSON.parse("body" in r ? String(r.body) : "{}");
/** Real OwnerLink tunnel framing, device DTO and fixed capabilities; only the connection is fake. */
class FakeGatewayLink extends OwnerLink {
  devices = [{ id: "desktop", name: "Mac", online: true, revoked: false, permissions: ["expose_capability"] }, { id: "browser", name: "Browser", online: true, revoked: false, permissions: ["web_ui"] }];
  generation = 1;
  revision = "a".repeat(64);
  node = "desktop";
  authState = "ready";
  result: any = { ok: true, content: [], data: page() };
  afterCall?: () => void;
  hold = false;
  aborts = 0;
  replyStatuses: number[] = [];
  browserAuthorizationDelayMs = 0;
  calls: any[] = [];
  private requests = new Map<string, { path: string; chunks: Buffer[] }>();
  connect() { this.connected = true; this.conn = { close: () => {}, request: async () => ({ devices: structuredClone(this.devices) }) } as any; }
  changeConnection() { this.connect(); }
  override async isBrowserAuthorized(id: string) {
    if (this.browserAuthorizationDelayMs) await new Promise(r => setTimeout(r, this.browserAuthorizationDelayMs));
    return super.isBrowserAuthorized(id);
  }
  receive(frame: Record<string, unknown>) { this.onFrame(frame); }
  manifest() {
    return { name: "Mac", capabilities: readCapabilities({ state: "ready", endpoint_id: "desktop", authorization_generation: this.generation, authorization_revision: this.revision, allowedCwds: ["/approved"], version: 2, owner_id: readOwnerId, fingerprint: "fake" }),
      collaboration: { version: 1, node_id: this.node, endpoint_id: "desktop", adapter: "desktop/codex", authorization_state: this.authState, authorization_generation: this.generation, authorization_revision: this.revision, runtime_availability: "unknown", scope_kind: "exact_cwd", source: "codex.saved_history", runtime_state: "unknown", control: "unsupported" } };
  }
  protected override send(f: Record<string, unknown>) {
    if (f.op === "http.head") this.replyStatuses.push(Number(f.status));
    const sid = String(f.sid);
    if (f.op === "http.abort") { this.aborts++; this.requests.delete(sid); return; }
    if (f.op === "http.req") this.requests.set(sid, { path: String(f.path), chunks: [] });
    if (f.op === "http.reqbody") this.requests.get(sid)?.chunks.push(Buffer.from(fromB64u(String(f.data))));
    if (f.op !== "http.reqend") return;
    const request = this.requests.get(sid); if (!request) return; this.requests.delete(sid);
    if (request.path === "/ash/call") { this.calls.push(JSON.parse(Buffer.concat(request.chunks).toString())); if (this.hold) return; this.afterCall?.(); }
    const response = request.path === "/ash/manifest" ? this.manifest() : this.result;
    queueMicrotask(() => {
      this.receive({ t: "tun", op: "http.head", sid, from: "desktop", status: 200 });
      const bytes = Buffer.from(JSON.stringify(response));
      for (let i = 0; i < bytes.length; i += 64 * 1024) this.receive({ t: "tun", op: "http.body", sid, from: "desktop", data: b64u(bytes.subarray(i, i + 64 * 1024)) });
      this.receive({ t: "tun", op: "http.end", sid, from: "desktop" });
    });
  }
}
async function fixture(timeout = 1000) {
  let now = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "ash-core-read-")), ledger = await Ledger.open(join(dir, "ledger.db"));
  const world = new WorldRouter(ledger, async () => true), members = new WorldMembers(world);
  const edge = new EdgeRouter(ledger, world, members, { api: { secret: "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 7), collaborationTimeoutMs: timeout, clock: () => now });
  const link = new FakeGatewayLink("http://localhost", { id: "owner", publicKey: "public", sign: async () => "signature" }, edge, () => {}); link.connect();
  const owner = edge.localCaller({ authorization: "Bearer secret" })!;
  return { edge, link, ledger, owner, expire: () => { now += 24 * 60 * 60 * 1000; }, close: () => { link.stop(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test("fixed read DTOs, discovery and repeated polls bypass the ledger", async () => {
  const f = await fixture(); try {
    const before = f.ledger.rawPage({ before: Number.MAX_SAFE_INTEGER, limit: 100 }).length;
    const discovery = await f.edge.handle({ ...req(), method: "GET", url: new URL("http://ash/api/collaboration/endpoints"), body: null }, f.owner);
    assert.equal(discovery.status, 200); assert.equal(json(discovery).targets[0].runtime_availability, "unknown");
    for (let i = 0; i < 5; i++) {
      const result = await f.edge.handle(req(), f.owner); assert.equal(result.status, 200); assert.equal(result.headers?.["cache-control"], "no-store");
      assert.equal(json(result).page.items[0].title, "Native title"); assert.ok(json(result).auth_scope);
    }
    assert.equal(f.ledger.rawPage({ before: Number.MAX_SAFE_INTEGER, limit: 100 }).length, before);
    assert.equal(f.link.calls[0].capability, "collaboration.work.list"); assert.equal(f.link.calls[0].caller, "person:owner");
    assert.deepEqual(f.link.calls[0].args, { version: 1, endpoint_id: "desktop", authorization_revision: "a".repeat(64) });
    const preview = "Native prompt preview\nsecond line\twith a tab";
    f.link.result.data = { ...page(), items: [{ ...page().items[0], title: preview }] };
    const multiline = await f.edge.handle(req(), f.owner);
    assert.equal(multiline.status, 200); assert.equal(json(multiline).page.items[0].title, preview);
  } finally { f.close(); }
});
test("owner identity, exact envelope, work reference and generation are mandatory", async () => {
  const f = await fixture(); try {
    assert.equal((await f.edge.handle(req(), null)).status, 401);
    for (const transport of ["agent", "service", "device", "phone"] as const) assert.equal((await f.edge.handle(req(), { ...f.owner, transport })).status, 403);
    assert.equal((await f.edge.handle(req(), { ...f.owner, member: "agent:fake" })).status, 403);
    for (const key of ["caller", "principal", "capability", "method", "path", "config", "scope", "authorization"]) assert.equal((await f.edge.handle(req({ ...input, [key]: "injected" }), f.owner)).status, 400);
    assert.equal((await f.edge.handle(req({ ...input, endpoint_id: "wrong" }), f.owner)).status, 403);
    assert.equal((await f.edge.handle(req({ ...input, authorization_generation: 2 }), f.owner)).status, 403);
    assert.equal((await f.edge.handle(req({ ...input, action: "read_work", work: { ...work, node_id: "wrong" } }), f.owner)).status, 403);
    assert.equal((await f.edge.handle(req({ ...input, page: { limit: 101 } }), f.owner)).status, 400);
    assert.equal((await f.edge.handle({ ...req(), method: "PUT" }, f.owner)).status, 422);
    assert.equal((await f.edge.handle({ ...req(), body: Buffer.alloc(65537) }, f.owner)).status, 413);
  } finally { f.close(); }
});
test("paired expose permission, native manifest binding and in-flight changes fail closed", async () => {
  for (const mutation of [
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.devices[0].revoked = true; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.devices[0].permissions = []; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.devices[0].online = false; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.generation++; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.revision = "b".repeat(64); },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.node = "wrong"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.changeConnection(); },
  ]) {
    const f = await fixture(); try {
      f.link.afterCall = () => mutation(f);
      const r = await f.edge.handle(req(), f.owner); assert.notEqual(r.status, 200); assert.equal(json(r).page, undefined);
    } finally { f.close(); }
  }
  const f = await fixture(); try { f.link.authState = "scope_required"; assert.equal((await f.edge.handle(req(), f.owner)).status, 403); } finally { f.close(); }
});
test("remote browser must retain a current paired screen; local credential revocation is rechecked", async () => {
  const f = await fixture(); try {
    const remote: EdgeCaller = { ...f.owner, local: false, remote: true, transport: "web_ui", transportPrincipal: "gateway:browser", pairedDeviceId: "browser" };
    const current = async () => f.link.isBrowserAuthorized("browser");
    assert.equal((await f.edge.handle({ ...req(), transportCurrent: current }, remote)).status, 403);
    const screen = f.edge.screens.register(remote, "scope"), headers = { [SCREEN_TOKEN_HEADER.toLowerCase()]: screen.token };
    assert.equal((await f.edge.handle({ ...req(input, headers), transportCurrent: current }, remote)).status, 200);
    f.link.afterCall = () => { f.link.devices[1].revoked = true; };
    assert.equal((await f.edge.handle({ ...req(input, headers), transportCurrent: current }, remote)).status, 403);
    f.link.afterCall = () => { delete f.edge.tokens.api.secret; };
    assert.equal((await f.edge.handle(req(), f.owner)).status, 403);
  } finally { f.close(); }
});
test("source injection, wrong page scope and oversized bodies cannot escape; source errors are sanitized", async () => {
  const f = await fixture(); try {
    for (const data of [{ ...page(), reasoning: "secret" }, { ...page(), source: "unknown" }, { ...page(), items: [{ ...page().items[0], work: { ...work, endpoint_id: "wrong" } }] }]) {
      f.link.result = { ok: true, content: [], data }; assert.notEqual((await f.edge.handle(req(), f.owner)).status, 200);
    }
    f.link.result = { ok: true, content: [], data: { ...page(), items: [{ ...page().items[0], title: "x".repeat(1024 * 1024) }] } };
    assert.equal((await f.edge.handle(req(), f.owner)).status, 413);
    f.link.result = { ok: false, content: [], error: "TOKEN=private /private/path", data: { code: "offline" } };
    const r = await f.edge.handle(req(), f.owner); assert.equal(r.status, 503); assert.doesNotMatch(String("body" in r && r.body), /TOKEN|private/);
  } finally { f.close(); }
});
test("caller cancellation and deadline settle hung reads and emit device abort", async () => {
  for (const cancel of [true, false]) {
    const f = await fixture(35); try {
      f.link.hold = true; const controller = new AbortController();
      const pending = f.edge.handle({ ...req(), signal: controller.signal }, f.owner);
      if (cancel) setTimeout(() => controller.abort(), 10);
      const r = await pending; assert.equal(r.status, cancel ? 499 : 504); assert.ok(f.link.aborts > 0);
    } finally { f.close(); }
  }
});
test("screen expiry before or during a read rejects the body", async () => {
  for (const during of [false, true]) {
    const f = await fixture(); try {
      const screen = f.edge.screens.register(f.owner, "scope");
      if (during) f.link.afterCall = f.expire; else f.expire();
      const result = await f.edge.handle(req(input, { [SCREEN_TOKEN_HEADER.toLowerCase()]: screen.token }), f.owner);
      assert.equal(result.status, 403); assert.equal(json(result).page, undefined);
    } finally { f.close(); }
  }
});
test("final deferred transport check revalidates screen expiry and credential revocation after awaiting", async () => {
  for (const revokeCredential of [false, true]) {
    const f = await fixture(); try {
      const screen = f.edge.screens.register(f.owner, "scope");
      let release!: () => void, entered!: () => void, checks = 0;
      const waiting = new Promise<void>(r => { entered = r; });
      const deferred = new Promise<void>(r => { release = r; });
      const result = f.edge.handle({ ...req(input, { [SCREEN_TOKEN_HEADER.toLowerCase()]: screen.token }), transportCurrent: async () => {
        if (++checks === 2) { entered(); await deferred; }
        return true;
      } }, f.owner);
      await waiting;
      if (revokeCredential) delete f.edge.tokens.api.secret; else f.expire();
      release();
      const response = await result;
      assert.equal(response.status, 403); assert.equal(json(response).page, undefined);
    } finally { f.close(); }
  }
});
test("gateway browser authorization and edge share a single total deadline", async () => {
  const f = await fixture(35); try {
    const remote: EdgeCaller = { ...f.owner, local: false, remote: true, transport: "web_ui", transportPrincipal: "gateway:browser", pairedDeviceId: "browser" };
    const screen = f.edge.screens.register(remote, "scope"); f.link.enable();
    f.link.browserAuthorizationDelayMs = 100;
    const started = Date.now();
    f.link.receive({ t: "tun", op: "http.req", sid: "bounded-browser-read", from: "browser", method: "POST", path: "/api/collaboration/read", headers: [[SCREEN_TOKEN_HEADER, screen.token]] });
    f.link.receive({ t: "tun", op: "http.reqbody", sid: "bounded-browser-read", data: b64u(Buffer.from(JSON.stringify(input))) });
    f.link.receive({ t: "tun", op: "http.reqend", sid: "bounded-browser-read" });
    for (let i = 0; i < 60 && !f.link.replyStatuses.length; i++) await new Promise(r => setTimeout(r, 2));
    assert.deepEqual(f.link.replyStatuses, [504]); assert.ok(Date.now() - started < 80);
    await new Promise(r => setTimeout(r, 110));
    assert.equal(f.link.calls.length, 0, "late authorization cannot start a device read");
    assert.deepEqual(f.link.replyStatuses, [504], "the deadline sends only one timeout response");
  } finally { f.close(); }
});
test("read_work permits only visible scoped messages and reference-only materials", async () => {
  const f = await fixture(); try {
    const message = { work, turn_id: "turn", source_message_id: "message", source_client_message_id: "client", role: "assistant", text: "visible", phase: "final_answer", material_refs: [{ source_part_index: 1, kind: "image", source_type: "localImage", availability: "reference_only" }] };
    const p = { ...page(), items: [{ turn_id: "turn", history_status: "completed", status_source: "codex.saved_history", messages: [message] }] };
    const body = { ...input, action: "read_work", work };
    f.link.result = { ok: true, content: [], data: p };
    const success = await f.edge.handle(req(body), f.owner); assert.equal(success.status, 200); assert.deepEqual(json(success).page.items[0].messages[0], message);
    for (const mutation of [
      { ...message, work: { ...work, native_id: "other-thread" } },
      { ...message, role: "system" }, { ...message, reasoning: "private" },
      { ...message, material_refs: [{ ...message.material_refs[0], url: "file:///secret" }] },
      { ...message, material_refs: [{ ...message.material_refs[0], availability: "downloaded" }] },
    ]) {
      f.link.result.data = { ...p, items: [{ ...p.items[0], messages: [mutation] }] };
      assert.notEqual((await f.edge.handle(req(body), f.owner)).status, 200);
    }
  } finally { f.close(); }
});
test("gateway inbound abort cancels the active read rather than returning a late page", async () => {
  const f = await fixture(); try {
    const remote: EdgeCaller = { ...f.owner, local: false, remote: true, transport: "web_ui", transportPrincipal: "gateway:browser", pairedDeviceId: "browser" };
    const screen = f.edge.screens.register(remote, "scope"); f.link.enable(); f.link.hold = true;
    f.link.receive({ t: "tun", op: "http.req", sid: "browser-read", from: "browser", method: "POST", path: "/api/collaboration/read", headers: [[SCREEN_TOKEN_HEADER, screen.token]] });
    f.link.receive({ t: "tun", op: "http.reqbody", sid: "browser-read", data: b64u(Buffer.from(JSON.stringify(input))) });
    f.link.receive({ t: "tun", op: "http.reqend", sid: "browser-read" });
    for (let i = 0; i < 50 && !f.link.calls.length; i++) await new Promise(r => setTimeout(r, 2));
    assert.equal(f.link.calls.length, 1);
    f.link.receive({ t: "tun", op: "http.abort", sid: "browser-read" });
    for (let i = 0; i < 20 && !f.link.aborts; i++) await new Promise(r => setTimeout(r, 2));
    assert.ok(f.link.aborts > 0); assert.equal(f.link.replyStatuses.length, 0);
  } finally { f.close(); }
});
test("collaboration capabilities are kept out of the ordinary world/member route", async () => {
  const f = await fixture(); try {
    await f.link.refreshDevices();
    const devices = f.edge.members.describe("owner").members.filter(member => member.id === "device:desktop");
    assert.equal(JSON.stringify(devices).includes("collaboration.work"), false);
    assert.equal(JSON.stringify(f.link.state()).includes("collaboration.work"), false);
  } finally { f.close(); }
});
test("HTTP disconnect propagates cancellation to the device read", async () => {
  const f = await fixture(); const server = await startEdgeServer(f.edge, "127.0.0.1", 0); try {
    f.link.hold = true; const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${(server.address() as any).port}/api/collaboration/read`, { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify(input), signal: controller.signal }).catch(() => null);
    while (!f.link.calls.length) await new Promise(r => setTimeout(r, 5));
    controller.abort(); await pending;
    for (let i = 0; i < 20 && !f.link.aborts; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(f.link.aborts > 0);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.close(); }
});
