import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, fromB64u } from "ash-gateway/src/protocol";
import { OwnerLink } from "../src/gateway/link";
import { EdgeRouter, fenceCollaborationResponse, startEdgeServer, type EdgeCaller, type EdgeRequest, type EdgeResponse } from "../src/server";
import { Ledger } from "../src/world/ledger";
import { WorldRouter } from "../src/world/router";
import { WorldMembers } from "../src/world/member";
import { readCapabilities } from "../../device/src/collaboration/capabilities";
import { CREATE_CAPABILITIES } from "../src/collaboration/create-service";
import { SCREEN_TOKEN_HEADER } from "../../sdk/src/api";
const revision = "a".repeat(64);
const target = { node_id: "desktop", endpoint_id: "desktop", project_id: "project-1", cwd: "/workspace/project" };
const work = { node_id: "desktop", endpoint_id: "desktop", kind: "conversation" as const, native_id: "thread-1" };
const query = { version: 1, device_id: "device:desktop", authorization_revision: revision, target, operation_id: "operation-1" };
const apply = { version: 1, device_id: "device:desktop", expected_connector_epoch: "current-epoch", request: { version: 1, request_id: "request-1", operation_id: "operation-1", authorization_revision: revision, target, title: "Explicit title", input: { text: "Explicit owner submission" }, expires_at: 1000 } };
const projectsInput = { version: 1, device_id: "device:desktop", node_id: "desktop", endpoint_id: "desktop", authorization_revision: revision, cwd: target.cwd };
const limitations = { native_readiness: "unknown", cancel: false, automatic_replay: false, execution_completion: "unknown" };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function phase(stage: "create" | "name" | "first_input", status: "accepted" | "not_started" | "unknown" | "rejected" = "accepted") {
    const idle = status === "not_started";
    return { status, attempt_id: idle ? null : `attempt-${stage}`, connector_epoch: idle ? null : "old-epoch", native_interface_version: idle ? null : "native-v1", started_at: idle ? null : 10, observed_at: 20,
        receipt: status !== "accepted" ? null : { stage, accepted_by: "native", work, ...(stage === "first_input" ? { native_turn_id: "turn-1", native_message_id: "item-1", correlation: "stable_message_id" } : {}) },
        error_code: status === "unknown" ? "result_unknown" : status === "rejected" ? "offline" : null };
}
function fact() {
    return { version: 1, request_id: "request-1", operation_id: "operation-1", authorization_revision: revision, target, expires_at: 1000, status: "recorded", create: phase("create"), name: phase("name"), first_input: phase("first_input"), work, native_client_message_id: "client-1", reconciliation: null, error_code: null, observed_at: 30 };
}
function projects() {
    return { target: { node_id: "desktop", endpoint_id: "desktop", cwd: target.cwd }, authorization_revision: revision, connector_epoch: "current-epoch", native_interface_version: "native-v1", projects: [{ project_id: target.project_id, cwd: target.cwd }], complete: true };
}
const input = query;
const req = (body: unknown = input, headers: Record<string, string> = {}, operation = "query"): EdgeRequest => ({ method: "POST", url: new URL(`http://ash/api/collaboration/create/${operation}`), headers, body: bytes(body) });
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
    private requests = new Map<string, {
        path: string;
        chunks: Buffer[];
    }>();
    connect() { this.connected = true; this.conn = { close: () => { }, request: async () => ({ devices: structuredClone(this.devices) }) } as any; }
    changeConnection() { this.connect(); }
    override async isBrowserAuthorized(id: string) {
        if (this.browserAuthorizationDelayMs)
            await new Promise(r => setTimeout(r, this.browserAuthorizationDelayMs));
        return super.isBrowserAuthorized(id);
    }
    receive(frame: Record<string, unknown>) { this.onFrame(frame); }
    manifest() {
        return { protocol: "ash-dev/1", capabilities: Object.entries(CREATE_CAPABILITIES).map(([operation, name]) => ({ name, description: "fixed create", input_schema: { type: "object" }, risk: operation === "apply" ? "outward" : "none" })),
            collaboration_create: { version: 1, endpoint_id: this.node, grant_state: this.authState, authorization_revision: this.authState === "ready" ? this.revision : null, actions: this.authState === "ready" ? ["projects", "apply", "query", "reconcile"] : [], scope: this.authState === "ready" ? { kind: "exact_cwd", cwd: target.cwd } : null, limitations } };
    }
    protected override send(f: Record<string, unknown>) {
        if (f.op === "http.head")
            this.replyStatuses.push(Number(f.status));
        const sid = String(f.sid);
        if (f.op === "http.abort") {
            this.aborts++;
            this.requests.delete(sid);
            return;
        }
        if (f.op === "http.req")
            this.requests.set(sid, { path: String(f.path), chunks: [] });
        if (f.op === "http.reqbody")
            this.requests.get(sid)?.chunks.push(Buffer.from(fromB64u(String(f.data))));
        if (f.op !== "http.reqend")
            return;
        const request = this.requests.get(sid);
        if (!request)
            return;
        this.requests.delete(sid);
        if (request.path === "/ash/call") {
            this.calls.push(JSON.parse(Buffer.concat(request.chunks).toString()));
            if (this.hold)
                return;
            this.afterCall?.();
        }
        const response = request.path === "/ash/manifest" ? this.manifest() : this.result;
        if (request.path === "/ash/manifest")
            this.afterManifest?.(++this.manifestRequests);
        queueMicrotask(() => {
            this.receive({ t: "tun", op: "http.head", sid, from: "desktop", status: 200 });
            const bytes = Buffer.from(JSON.stringify(response));
            for (let i = 0; i < bytes.length; i += 64 * 1024)
                this.receive({ t: "tun", op: "http.body", sid, from: "desktop", data: b64u(bytes.subarray(i, i + 64 * 1024)) });
            this.receive({ t: "tun", op: "http.end", sid, from: "desktop" });
        });
    }
}
async function fixture(timeout = 1000) {
    let now = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "ash-core-create-routing-")), ledger = await Ledger.open(join(dir, "ledger.db"));
    const world = new WorldRouter(ledger, async () => true), members = new WorldMembers(world);
    const edge = new EdgeRouter(ledger, world, members, { api: { secret: "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 7), collaborationTimeoutMs: timeout, clock: () => now });
    const link = new FakeGatewayLink("http://localhost", { id: "owner", publicKey: "public", sign: async () => "signature" }, edge, () => { });
    link.connect();
    const owner = edge.localCaller({ authorization: "Bearer secret" })!;
    return { edge, link, ledger, owner, expire: () => { now += 24 * 60 * 60 * 1000; }, close: () => { link.stop(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test("four real Core create routes use exact owner capabilities with no ledger body copy", async () => {
    const f = await fixture();
    try {
        f.edge.world.send = async () => { throw new Error("must bypass ledger routing"); };
        const count = f.ledger.rawPage({ before: Number.MAX_SAFE_INTEGER, limit: 100 }).length;
        for (const operation of ["projects", "apply", "query", "reconcile"] as const) {
            f.link.result.data = operation === "projects" ? projects() : { fact: fact() };
            const r = await f.edge.handle(req(operation === "projects" ? projectsInput : operation === "apply" ? apply : query, {}, operation), f.owner);
            assert.equal(r.status, 200);
            assert.equal(r.headers?.["cache-control"], "no-store");
            assert.ok(json(r).auth_scope);
            assert.equal(f.link.calls.at(-1).capability, CREATE_CAPABILITIES[operation]);
            assert.equal(f.link.calls.at(-1).caller, "person:owner");
            assert.equal(Object.hasOwn(f.link.calls.at(-1).args, "device_id"), false);
        }
        assert.equal(f.ledger.rawPage({ before: Number.MAX_SAFE_INTEGER, limit: 100 }).length, count);
    }
    finally {
        f.close();
    }
});
test("create targets discover independently without read grants or native calls", async () => {
    const f = await fixture();
    try {
        const request = { ...req(), method: "GET", url: new URL("http://ash/api/collaboration/create/endpoints"), body: null };
        const result = await f.edge.handle(request, f.owner);
        assert.equal(result.status, 200);
        assert.equal(json(result).create_targets[0].scope.cwd, target.cwd);
        assert.equal(json(result).targets, undefined);
        assert.equal(f.link.calls.length, 0);
        f.link.authState = "grant_required";
        const absent = await f.edge.handle(request, f.owner);
        assert.equal(absent.status, 200);
        assert.equal(json(absent).create_targets[0].grant_state, "grant_required");
        assert.equal((await f.edge.handle({ ...request, url: new URL(`${request.url}?native=start`) }, f.owner)).status, 400);
    }
    finally {
        f.close();
    }
});
test("create owner identity, exact target grant and fixed route validation reject before calls", async () => {
    const f = await fixture();
    try {
        assert.equal((await f.edge.handle(req(), null)).status, 401);
        for (const transport of ["agent", "service", "device", "phone"] as const)
            assert.equal((await f.edge.handle(req(), { ...f.owner, transport })).status, 403);
        for (const operation of ["thread/start", "send", ""])
            assert.equal((await f.edge.handle(req(input, {}, operation), f.owner)).status, 422);
        assert.equal((await f.edge.handle(req({ ...query, model: "injected" }), f.owner)).status, 400);
        assert.equal((await f.edge.handle(req({ ...query, target: { ...target, cwd: "/other" } }), f.owner)).status, 403);
        assert.equal((await f.edge.handle({ ...req(), body: Buffer.alloc(65537) }, f.owner)).status, 413);
        assert.equal(f.link.calls.length, 0);
    }
    finally {
        f.close();
    }
});
test("fresh pairing, expose, cwd grant and connection changes fence create successes and errors", async () => {
    for (const error of [false, true])
        for (const mutate of [
            (f: any) => { f.link.devices[0].revoked = true; }, (f: any) => { f.link.devices[0].permissions = []; }, (f: any) => { f.link.revision = "b".repeat(64); }, (f: any) => { f.link.changeConnection(); }, (f: any) => { delete f.edge.tokens.api.secret; }, (f: any) => { f.link.node = "wrong"; }
        ]) {
            const f = await fixture();
            try {
                if (error)
                    f.link.result = { ok: false, content: [], error: "private native failure", data: { code: "offline" } };
                f.link.afterCall = () => mutate(f);
                const r = await f.edge.handle(req(), f.owner);
                assert.notEqual(r.status, 200);
                assert.equal(json(r).fact, undefined);
                assert.doesNotMatch(String("body" in r && r.body), /private native/);
                assert.equal(f.link.calls.length, 1);
            }
            finally {
                f.close();
            }
        }
});
test("final awaited owner check precedes fresh manifest fence", async () => {
    const f = await fixture();
    try {
        let checks = 0;
        const r = await f.edge.handle({ ...req(), transportCurrent: async () => { if (++checks === 2)
                f.link.revision = "b".repeat(64); return true; } }, f.owner);
        assert.equal(r.status, 403);
        assert.equal(json(r).fact, undefined);
        assert.equal(f.link.calls.length, 1);
    }
    finally {
        f.close();
    }
});
test("actual gateway return gate survives wrapper await and locally known revoke ABA", async () => {
    for (const change of ["connection", "pairing", "token"]) {
        const f = await fixture();
        try {
            const transport = (f.edge as any).collaborationCreate;
            f.edge.attachCollaborationCreate({ collaborationCreate: async (operation, input, signal, gate) => { const result = await transport.collaborationCreate(operation, input, signal, gate); if (change === "connection")
                    f.link.changeConnection();
                else if (change === "pairing")
                    (f.link as any).authorityGeneration++;
                else
                    delete f.edge.tokens.api.secret; return result; } });
            const r = await f.edge.handle(req(), f.owner);
            assert.notEqual(r.status, 200);
            assert.equal(json(r).fact, undefined);
            assert.equal(f.link.calls.length, 1);
        }
        finally {
            f.close();
        }
    }
});
test("remote create screen requires async authorization and synchronous transport fence", async () => {
    const f = await fixture();
    try {
        const remote: EdgeCaller = { ...f.owner, local: false, remote: true, transport: "web_ui", transportPrincipal: "gateway:browser", pairedDeviceId: "browser" };
        const screen = f.edge.screens.register(remote, "scope"), headers = { [SCREEN_TOKEN_HEADER.toLowerCase()]: screen.token };
        const request = { ...req(input, headers), transportCurrent: async () => f.link.isBrowserAuthorized("browser") };
        assert.equal((await f.edge.handle(request, remote)).status, 403);
        const fenced = { ...request, transportFence: () => !f.link.devices[1].revoked };
        assert.equal((await f.edge.handle(fenced, remote)).status, 200);
        f.link.afterCall = () => { f.link.devices[1].revoked = true; };
        const r = await f.edge.handle(fenced, remote);
        assert.equal(r.status, 403);
        assert.equal(json(r).fact, undefined);
    }
    finally {
        f.close();
    }
});
test("create discovery fences owner and manifest changes and errors", async () => {
    for (const change of ["grant", "pairing", "token"]) {
        const f = await fixture();
        try {
            f.link.afterManifest = count => { if (count === 1) {
                if (change === "grant")
                    f.link.revision = "b".repeat(64);
                else if (change === "pairing")
                    f.link.devices[0].revoked = true;
                else
                    delete f.edge.tokens.api.secret;
            } };
            const r = await f.edge.handle({ ...req(), method: "GET", url: new URL("http://ash/api/collaboration/create/endpoints"), body: null }, f.owner);
            assert.equal(r.status, 403);
            assert.equal(json(r).create_targets, undefined);
            assert.equal(f.link.calls.length, 0);
        }
        finally {
            f.close();
        }
    }
});
test("create deadline and cancellation bound actual gateway native exchange", async () => {
    for (const cancel of [false, true]) {
        const f = await fixture(35);
        try {
            f.link.hold = true;
            const controller = new AbortController();
            const pending = f.edge.handle({ ...req(), signal: controller.signal }, f.owner);
            if (cancel)
                setTimeout(() => controller.abort(), 10);
            assert.equal((await pending).status, cancel ? 499 : 504);
            assert.ok(f.link.aborts > 0);
            assert.equal(f.link.calls.length, 1);
        }
        finally {
            f.close();
        }
    }
});
test("real HTTP edge and remote gateway screen serve fixed create routes", async () => {
    const f = await fixture(), server = await startEdgeServer(f.edge, "127.0.0.1", 0);
    try {
        f.link.result.data = projects();
        const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/collaboration/create/projects`, {
            method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify(projectsInput),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal((await response.json() as any).projects[0].project_id, target.project_id);
        f.link.result.data = { fact: fact() };
        f.link.enable();
        const remote: EdgeCaller = { ...f.owner, local: false, remote: true, transport: "web_ui", transportPrincipal: "gateway:browser", pairedDeviceId: "browser" };
        const screen = f.edge.screens.register(remote, "scope");
        f.link.receive({ t: "tun", op: "http.req", sid: "remote-create", from: "browser", method: "POST", path: "/api/collaboration/create/apply", headers: [[SCREEN_TOKEN_HEADER, screen.token]] });
        f.link.receive({ t: "tun", op: "http.reqbody", sid: "remote-create", from: "browser", data: b64u(bytes(apply)) });
        f.link.receive({ t: "tun", op: "http.reqend", sid: "remote-create", from: "browser" });
        for (let attempt = 0; attempt < 100 && !f.link.replyStatuses.length; attempt++)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepEqual(f.link.replyStatuses, [200]);
        assert.equal(f.link.calls.at(-1).capability, CREATE_CAPABILITIES.apply);
    }
    finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        f.close();
    }
});
test("HTTP and tunnel final serialization fence keeps discovery and facts private", async () => {
    for (const discovery of [false, true])
        for (const change of ["token", "connection", "pairing"]) {
            const f = await fixture();
            try {
                const request = discovery ? { ...req(), method: "GET", url: new URL("http://ash/api/collaboration/create/endpoints"), body: null } : req();
                const response = await f.edge.handle(request, f.owner);
                assert.equal(response.status, 200);
                await Promise.resolve();
                if (change === "token")
                    delete f.edge.tokens.api.secret;
                else if (change === "connection")
                    f.link.changeConnection();
                else
                    (f.link as any).authorityGeneration++;
                const fenced = fenceCollaborationResponse(response);
                assert.notEqual(fenced.status, 200);
                assert.equal(json(fenced).fact, undefined);
                assert.equal(json(fenced).create_targets, undefined);
            }
            finally {
                f.close();
            }
        }
});


test("create discovery rejects every falsy gateway failure without successful empty targets", async () => {
  for (const reason of [undefined, null, false, 0]) {
    const f = await fixture();
    try {
      (f.link as any).conn.request = async () => { throw reason; };
      const response = await f.edge.handle({ ...req(), method: "GET", url: new URL("http://ash/api/collaboration/create/endpoints"), body: null }, f.owner);
      assert.equal(response.status, 503);
      assert.equal(json(response).ok, false);
      assert.equal(json(response).error.code, "offline");
      assert.equal(json(response).create_targets, undefined);
      assert.equal(f.link.calls.length, 0);
    } finally { f.close(); }
  }
});

test("create presence notification immediately fences facts and targets while fresh pairing waits", async () => {
  for (const discovery of [false, true]) for (const restore of [false, true]) {
    const f = await fixture();
    try {
      const request = discovery ? { ...req(), method: "GET", url: new URL("http://ash/api/collaboration/create/endpoints"), body: null } : req();
      const response = await f.edge.handle(request, f.owner);
      assert.equal(response.status, 200);
      let refreshes = 0;
      (f.link as any).conn.request = async () => { refreshes++; return new Promise(() => {}); };
      f.link.receive({ t: "gw", op: "device.presence", device_id: "desktop", online: false });
      if (restore) f.link.receive({ t: "gw", op: "device.presence", device_id: "desktop", online: true });
      const fenced = fenceCollaborationResponse(response);
      assert.equal(fenced.status, 403);
      assert.equal(json(fenced).fact, undefined);
      assert.equal(json(fenced).create_targets, undefined);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(refreshes > 0);
      assert.equal(fenceCollaborationResponse(response).status, 403);
      assert.equal(f.link.calls.length, discovery ? 0 : 1);
    } finally { f.close(); }
  }
});
