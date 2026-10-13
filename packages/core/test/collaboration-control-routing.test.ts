import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceKey } from "ash-gateway/client/client";
import { deviceIdForKey } from "ash-gateway/src/protocol";
import { b64u, fromB64u } from "ash-gateway/src/protocol";
import { OwnerLink } from "../src/gateway/link";
import { EdgeRouter, fenceCollaborationResponse, startEdgeServer, type EdgeCaller, type EdgeRequest, type EdgeResponse } from "../src/server";
import { Ledger } from "../src/world/ledger";
import { WorldRouter } from "../src/world/router";
import { WorldMembers } from "../src/world/member";
import { readCapabilities } from "../../device/src/collaboration/capabilities";
import { CONTROL_CAPABILITIES } from "../src/collaboration/control-service";
import { SCREEN_TOKEN_HEADER } from "../../sdk/src/api";

const readOwnerId = await deviceIdForKey((await DeviceKey.generate()).publicKey);
const work = { node_id: "desktop", endpoint_id: "desktop", kind: "conversation", native_id: "thread-1" };
const revision = "a".repeat(64);
const input = { version: 1, device_id: "device:desktop", endpoint_id: "desktop", authorization_revision: revision, work, action: "send_input", operation_id: "operation-1" };
const limitations = { atomic_idle_start: false, cancel: false, queue: false, runtime_state: "unknown", subscription_state: "unknown" };
const fact = () => ({ request_id: "request-1", operation_id: "operation-1", work, action: "send_input", expires_at: 1000, delivery_status: "accepted", attempt_id: "attempt-1", connector_epoch: "old-native-epoch", native_client_message_id: "client-1", native_interface_version: "native-version", expected_turn_id: null, receipt: { accepted_by: "native", native_turn_id: "turn-1", correlation: "uncertain" }, reconciliation: null, error_code: null, observed_at: 2000 });
const state = () => ({ target: { endpoint_id: "desktop", work }, authorization_revision: revision, connector_epoch: "native-1", native_interface_version: "native-version", snapshot: { work, connector_epoch: "native-1", source: "codex.live", identity_provenance: "none", observed_at: null, revision: 0, state: "unknown" }, allowed_actions: ["send_input", "steer"], limitations });
const req = (body: unknown = input, headers: Record<string, string> = {}, operation = "query"): EdgeRequest => ({ method: "POST", url: new URL(`http://ash/api/collaboration/control/${operation}`), headers, body: Buffer.from(JSON.stringify(body)) });
const json = (r: EdgeResponse) => JSON.parse("body" in r ? String(r.body) : "{}");
/** Real OwnerLink tunnel framing, device DTO and fixed capabilities; only the connection is fake. */
class FakeGatewayLink extends OwnerLink {
  devices = [{ id: "desktop", name: "Mac", online: true, revoked: false, permissions: ["expose_capability"] }, { id: "browser", name: "Browser", online: true, revoked: false, permissions: ["web_ui"] }];
  generation = 1;
  revision = "a".repeat(64);
  node = "desktop";
  authState = "ready";
  result: any = { ok: true, content: [], data: { fact: fact() } };
  afterCall?: () => void;
  afterManifest?: (count: number) => void;
  manifestRequests = 0;
  includeRead = false;
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
    return { name: "Mac", protocol: "ash-dev/1", capabilities: [...(this.includeRead ? readCapabilities({ state: "ready", endpoint_id: "desktop", authorization_generation: 1, authorization_revision: "c".repeat(64), allowedCwds: ["/approved"], version: 2, owner_id: readOwnerId, fingerprint: "fake" }) : []), ...Object.entries(CONTROL_CAPABILITIES).map(([operation, name]) => ({ name, description: "fixed control", input_schema: { type: "object" }, risk: operation === "apply" ? "outward" : "none" }))],
      ...(this.includeRead ? { collaboration: { version: 1, node_id: "desktop", endpoint_id: "desktop", adapter: "desktop/codex", authorization_state: "ready", authorization_generation: 1, authorization_revision: "c".repeat(64), runtime_availability: "unknown", scope_kind: "exact_cwd", source: "codex.saved_history", runtime_state: "unknown", control: "unsupported" } } : {}),
      collaboration_control: { version: 1, endpoint_id: this.node, grant_state: this.authState, authorization_revision: this.authState === "ready" ? this.revision : null, actions: this.authState === "ready" ? ["send_input", "steer"] : [], limitations } };
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
    if (request.path === "/ash/manifest") this.afterManifest?.(++this.manifestRequests);
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
  const dir = mkdtempSync(join(tmpdir(), "ash-core-control-routing-")), ledger = await Ledger.open(join(dir, "ledger.db"));
  const world = new WorldRouter(ledger, async () => true), members = new WorldMembers(world);
  const edge = new EdgeRouter(ledger, world, members, { api: { secret: "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 7), collaborationTimeoutMs: timeout, clock: () => now });
  const link = new FakeGatewayLink("http://localhost", { id: "owner", publicKey: "public", sign: async () => "signature" }, edge, () => {}); link.connect();
  const owner = edge.localCaller({ authorization: "Bearer secret" })!;
  return { edge, link, ledger, owner, expire: () => { now += 24 * 60 * 60 * 1000; }, close: () => { link.stop(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("four fixed Core control POST routes bypass world routing and ledger", async () => {
  const f = await fixture(); try {
    f.edge.world.send = async () => { throw new Error("control must never route world words"); };
    const before = f.ledger.rawPage({ before: Number.MAX_SAFE_INTEGER, limit: 100 }).length;
    for (const operation of ["state", "apply", "query", "reconcile"] as const) {
      const body = operation === "state" ? { ...input, operation_id: undefined } : operation === "apply" ? { ...input, action: undefined, operation_id: undefined, expected_connector_epoch: "native-1", request: { request_id: "request-1", operation_id: "operation-1", work, action: "send_input", input: { text: "owner submit" }, expires_at: 1000 } } : input;
      f.link.result.data = operation === "state" ? state() : { fact: fact() };
      const r = await f.edge.handle(req(body, {}, operation), f.owner);
      assert.equal(r.status, 200); assert.equal(r.headers?.["cache-control"], "no-store"); assert.ok(json(r).auth_scope);
      assert.equal(f.link.calls.at(-1).capability, CONTROL_CAPABILITIES[operation]); assert.equal(f.link.calls.at(-1).caller, "person:owner"); assert.equal(Object.hasOwn(f.link.calls.at(-1).args, "device_id"), false);
    }
    assert.equal(f.ledger.rawPage({ before: Number.MAX_SAFE_INTEGER, limit: 100 }).length, before);
  } finally { f.close(); }
});
test("control routes enforce owner identity, exact body and route whitelist", async () => {
  const f = await fixture(); try {
    assert.equal((await f.edge.handle(req(), null)).status, 401);
    for (const transport of ["agent", "service", "device", "phone"] as const) assert.equal((await f.edge.handle(req(), { ...f.owner, transport })).status, 403);
    for (const operation of ["native/start", "", "send"]) assert.equal((await f.edge.handle(req(input, {}, operation), f.owner)).status, 422);
    assert.equal((await f.edge.handle({ ...req(), method: "GET" }, f.owner)).status, 422);
    assert.equal((await f.edge.handle(req({ ...input, caller: "person:owner" }), f.owner)).status, 400);
    assert.equal((await f.edge.handle(req({ ...input, expected_connector_epoch: "old" }), f.owner)).status, 400);
    assert.equal((await f.edge.handle(req({ ...input, authorization_revision: "b".repeat(64) }), f.owner)).status, 403);
    assert.equal((await f.edge.handle({ ...req(), body: Buffer.alloc(65537) }, f.owner)).status, 413);
    assert.equal(f.link.calls.length, 0);
  } finally { f.close(); }
});
test("fresh pairing, grant, manifest and owner connection fence native responses", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.devices[0].revoked = true; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.devices[0].permissions = []; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.devices[0].online = false; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.revision = "b".repeat(64); },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.node = "other"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.link.changeConnection(); },
  ]) {
    const f = await fixture(); try { f.link.afterCall = () => mutate(f); const r = await f.edge.handle(req(), f.owner); assert.notEqual(r.status, 200); assert.equal(json(r).fact, undefined); } finally { f.close(); }
  }
});
test("remote screen and local owner token are checked again before releasing facts or errors", async () => {
  const f = await fixture(); try {
    const remote: EdgeCaller = { ...f.owner, local: false, remote: true, transport: "web_ui", transportPrincipal: "gateway:browser", pairedDeviceId: "browser" };
    const current = async () => f.link.isBrowserAuthorized("browser");
    assert.equal((await f.edge.handle({ ...req(), transportCurrent: current, transportFence: () => !f.link.devices[1].revoked && f.link.devices[1].permissions.includes("web_ui") }, remote)).status, 403);
    const screen = f.edge.screens.register(remote, "scope"), headers = { [SCREEN_TOKEN_HEADER.toLowerCase()]: screen.token };
    assert.equal((await f.edge.handle({ ...req(input, headers), transportCurrent: current, transportFence: () => !f.link.devices[1].revoked && f.link.devices[1].permissions.includes("web_ui") }, remote)).status, 200);
    f.link.afterCall = () => { f.link.devices[1].revoked = true; };
    assert.equal((await f.edge.handle({ ...req(input, headers), transportCurrent: current, transportFence: () => !f.link.devices[1].revoked && f.link.devices[1].permissions.includes("web_ui") }, remote)).status, 403);
    f.link.afterCall = f.expire;
    const localScreen = f.edge.screens.register(f.owner, "scope");
    assert.equal((await f.edge.handle(req(input, { [SCREEN_TOKEN_HEADER.toLowerCase()]: localScreen.token }), f.owner)).status, 403);
    f.link.afterCall = () => { delete f.edge.tokens.api.secret; };
    f.link.result = { ok: false, content: [], error: "native private path", data: { code: "offline" } };
    const r = await f.edge.handle(req(), f.owner); assert.equal(r.status, 403); assert.equal(json(r).error.code, "permission_denied"); assert.doesNotMatch(String("body" in r && r.body), /private/);
  } finally { f.close(); }
});
test("control deadline and cancellation abort hung fixed device calls", async () => {
  for (const cancel of [true, false]) {
    const f = await fixture(35); try {
      f.link.hold = true; const controller = new AbortController(); const pending = f.edge.handle({ ...req(), signal: controller.signal }, f.owner);
      if (cancel) setTimeout(() => controller.abort(), 10);
      assert.equal((await pending).status, cancel ? 499 : 504); assert.ok(f.link.aborts > 0);
    } finally { f.close(); }
  }
});
test("model DeviceMember discovery excludes all collaboration capabilities", async () => {
  const f = await fixture(); try {
    await f.link.refreshDevices();
    assert.doesNotMatch(JSON.stringify(f.edge.members.describe("owner")), /collaboration\.control/);
  } finally { f.close(); }
});

test("final awaited transport check revalidates screen and token after waiting", async () => {
  for (const revokeToken of [false, true]) {
    const f = await fixture(); try {
      const screen = f.edge.screens.register(f.owner, "scope");
      let entered!: () => void, release!: () => void, checks = 0;
      const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      const pending = f.edge.handle({ ...req(input, { [SCREEN_TOKEN_HEADER.toLowerCase()]: screen.token }), transportCurrent: async () => {
        if (++checks === 2) { entered(); await held; } return true;
      } }, f.owner);
      await waiting; if (revokeToken) delete f.edge.tokens.api.secret; else f.expire(); release();
      const result = await pending; assert.equal(result.status, 403); assert.equal(json(result).fact, undefined);
    } finally { f.close(); }
  }
});
test("gateway browser authorization and fixed control share one deadline", async () => {
  const f = await fixture(35); try {
    f.link.enable(); f.link.browserAuthorizationDelayMs = 60;
    f.link.receive({ t: "tun", op: "http.req", sid: "remote-control", from: "browser", method: "POST", path: "/api/collaboration/control/query", headers: [] });
    f.link.receive({ t: "tun", op: "http.reqend", sid: "remote-control", from: "browser" });
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(f.link.replyStatuses, [504]); assert.equal(f.link.calls.length, 0);
  } finally { f.close(); }
});
test("HTTP disconnect cancels the active fixed control device call", async () => {
  const f = await fixture(), server = await startEdgeServer(f.edge, "127.0.0.1", 0); try {
    f.link.hold = true; const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${(server.address() as any).port}/api/collaboration/control/query`, { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify(input), signal: controller.signal }).catch(() => null);
    while (!f.link.calls.length) await new Promise(r => setTimeout(r, 5));
    controller.abort(); await pending;
    await new Promise(r => setTimeout(r, 20)); assert.ok(f.link.aborts > 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});

test("independent control manifest discovery preserves read targets and bypasses writes", async () => {
  const f = await fixture(); try {
    f.edge.world.send = async () => { throw new Error("discovery must not send world words"); };
    const request = { ...req(), method: "GET", url: new URL("http://ash/api/collaboration/control/endpoints"), body: null };
    const before = f.ledger.rawPage({ before: Number.MAX_SAFE_INTEGER, limit: 100 }).length;
    assert.equal((await f.edge.handle({ ...request, method: "POST" }, f.owner)).status, 422);
    assert.equal((await f.edge.handle({ ...request, url: new URL(`${request.url}?native=start`) }, f.owner)).status, 400);
    assert.equal((await f.edge.handle({ ...request, body: Buffer.from("{}") }, f.owner)).status, 400);
    let r = await f.edge.handle(request, f.owner);
    assert.equal(r.status, 200); assert.equal(json(r).control_targets[0].authorization_revision, revision);
    f.link.includeRead = true;
    const read = await f.edge.handle({ ...request, url: new URL("http://ash/api/collaboration/endpoints") }, f.owner);
    assert.equal(read.status, 200); assert.equal(json(read).targets[0].authorization_revision, "c".repeat(64)); assert.equal(json(read).control_targets, undefined);
    r = await f.edge.handle(request, f.owner); assert.equal(r.status, 200); assert.equal(json(r).control_targets[0].authorization_revision, revision);
    f.link.includeRead = false; f.link.authState = "grant_required";
    r = await f.edge.handle(request, f.owner);
    assert.equal(r.status, 200); assert.equal(json(r).control_targets[0].grant_state, "grant_required"); assert.equal(json(r).control_targets[0].authorization_revision, null); assert.deepEqual(json(r).control_targets[0].actions, []);
    assert.equal(f.link.calls.length, 0); assert.equal(f.ledger.rawPage({ before: Number.MAX_SAFE_INTEGER, limit: 100 }).length, before);
  } finally { f.close(); }
});
test("late discovery grant or pairing changes reject the entire target response", async () => {
  for (const revoked of [false, true]) {
    const f = await fixture(); try {
      f.link.afterManifest = count => { if (count === 1) { if (revoked) f.link.devices[0].revoked = true; else f.link.revision = "b".repeat(64); } };
      const r = await f.edge.handle({ ...req(), method: "GET", url: new URL("http://ash/api/collaboration/control/endpoints"), body: null }, f.owner);
      assert.equal(r.status, 403); assert.equal(json(r).control_targets, undefined); assert.equal(f.link.calls.length, 0);
    } finally { f.close(); }
  }
});

test("control discovery errors do not hide independent read endpoints", async () => {
  const f = await fixture(); try {
    f.link.includeRead = true;
    // A legacy read manifest without the separate control block yields no control targets.
    const manifest = f.link.manifest.bind(f.link);
    f.link.manifest = () => ({ ...manifest(), collaboration_control: undefined }) as any;
    const request = { ...req(), method: "GET", url: new URL("http://ash/api/collaboration/control/endpoints"), body: null };
    const control = await f.edge.handle(request, f.owner); assert.equal(control.status, 200); assert.deepEqual(json(control).control_targets, []);
    const read = await f.edge.handle({ ...request, url: new URL("http://ash/api/collaboration/endpoints") }, f.owner);
    assert.equal(read.status, 200); assert.equal(json(read).targets[0].authorization_revision, "c".repeat(64));
    f.edge.attachCollaborationControlDiscovery(async () => { throw new Error("private native fault"); });
    assert.equal((await f.edge.handle(request, f.owner)).status, 503);
    assert.equal((await f.edge.handle({ ...request, url: new URL("http://ash/api/collaboration/endpoints") }, f.owner)).status, 200);
  } finally { f.close(); }
});
test("control discovery rechecks owner proof before exposing errors", async () => {
  const f = await fixture(); try {
    f.edge.attachCollaborationControlDiscovery(async () => { delete f.edge.tokens.api.secret; throw new Error("private native fault"); });
    const result = await f.edge.handle({ ...req(), method: "GET", url: new URL("http://ash/api/collaboration/control/endpoints"), body: null }, f.owner);
    assert.equal(result.status, 403); assert.equal(json(result).error.code, "permission_denied");
  } finally { f.close(); }
});


test("control final owner await precedes device grant and pairing reinspection", async () => {
  for (const error of [false, true]) for (const pairing of [false, true]) {
    const f = await fixture();
    try {
      if (error) f.link.result = { ok: false, content: [], error: "private native fault", data: { code: "offline" } };
      let checks = 0;
      const result = await f.edge.handle({ ...req(), transportCurrent: async () => {
        if (++checks === 2) { if (pairing) f.link.devices[0].revoked = true; else f.link.revision = "b".repeat(64); }
        return true;
      } }, f.owner);
      assert.equal(result.status, 403);
      assert.equal(json(result).fact, undefined);
      assert.equal(f.link.calls.length, 1);
    } finally { f.close(); }
  }
});

test("control return gate keeps actual gateway connection and local authority fenced across wrapper await", async () => {
  for (const change of ["connection", "pairing", "token"]) {
    const f = await fixture();
    try {
      const transport = (f.edge as any).collaborationControl;
      f.edge.attachCollaborationControl({ collaborationControl: async (operation, input, signal, gate) => {
        const result = await transport.collaborationControl(operation, input, signal, gate);
        if (change === "connection") f.link.changeConnection();
        else if (change === "pairing") (f.link as any).authorityGeneration++;
        else delete f.edge.tokens.api.secret;
        return result;
      } });
      const result = await f.edge.handle(req(), f.owner);
      assert.notEqual(result.status, 200);
      assert.equal(json(result).fact, undefined);
      assert.equal(f.link.calls.length, 1);
    } finally { f.close(); }
  }
});


test("control discovery rejects every falsy gateway failure without successful empty targets", async () => {
  for (const reason of [undefined, null, false, 0]) {
    const f = await fixture();
    try {
      (f.link as any).conn.request = async () => { throw reason; };
      const response = await f.edge.handle({ ...req(), method: "GET", url: new URL("http://ash/api/collaboration/control/endpoints"), body: null }, f.owner);
      assert.equal(response.status, 503);
      assert.equal(json(response).ok, false);
      assert.equal(json(response).error.code, "offline");
      assert.equal(json(response).control_targets, undefined);
      assert.equal(f.link.calls.length, 0);
    } finally { f.close(); }
  }
});

test("control presence notification immediately fences facts and targets while fresh pairing waits", async () => {
  for (const discovery of [false, true]) for (const restore of [false, true]) {
    const f = await fixture();
    try {
      const request = discovery ? { ...req(), method: "GET", url: new URL("http://ash/api/collaboration/control/endpoints"), body: null } : req();
      const response = await f.edge.handle(request, f.owner);
      assert.equal(response.status, 200);
      let refreshes = 0;
      (f.link as any).conn.request = async () => { refreshes++; return new Promise(() => {}); };
      f.link.receive({ t: "gw", op: "device.presence", device_id: "desktop", online: false });
      if (restore) f.link.receive({ t: "gw", op: "device.presence", device_id: "desktop", online: true });
      const fenced = fenceCollaborationResponse(response);
      assert.equal(fenced.status, 403);
      assert.equal(json(fenced).fact, undefined);
      assert.equal(json(fenced).control_targets, undefined);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(refreshes > 0);
      assert.equal(fenceCollaborationResponse(response).status, 403);
      assert.equal(f.link.calls.length, discovery ? 0 : 1);
    } finally { f.close(); }
  }
});
