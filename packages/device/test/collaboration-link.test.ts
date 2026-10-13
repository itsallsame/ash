import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { b64u, deviceIdForKey } from "ash-gateway/src/protocol";
import { ClientLink, type TunnelResponse, type LocalCapabilities } from "../src/link";
import type { TrustedCallContext } from "../src/collaboration/authorization";

class FakeLink extends ClientLink {
  readonly responses: { sid: string; response: TunnelResponse }[] = [];
  frame(frame: Record<string, unknown>) { this.onFrame(frame); }
  connectFake() { this.conn = { ws: { readyState: WebSocket.OPEN }, close: () => {} } as any; }
  disconnect() { this.onDisconnected(); }
  protected override reply(sid: string, response: TunnelResponse) { this.responses.push({ sid, response }); }
  async request(sid: string, capability: string, from?: string, caller = "person:owner") {
    const before = this.responses.length;
    this.frame({ t: "tun", op: "http.req", sid, method: "POST", path: "/ash/call", from });
    this.frame({ t: "tun", op: "http.reqbody", sid, data: b64u(Buffer.from(JSON.stringify({ capability, caller, args: { version: 1, endpoint_id: "device", from: "spoof" } }))) });
    this.frame({ t: "tun", op: "http.reqend", sid });
    for (let i = 0; i < 100 && this.responses.length === before; i++) await new Promise(resolve => setTimeout(resolve, 2));
    return this.responses.at(-1)!.response;
  }
}
test("gateway from must match pinned owner; body caller never authorizes collaboration, legacy remains compatible", async () => {
  const state = mkdtempSync(join(tmpdir(), "ash-link-read-")), ownerKey = b64u(Buffer.from("synthetic-owner-key")), ownerId = await deviceIdForKey(ownerKey);
  writeFileSync(join(state, "paired.json"), JSON.stringify({ owner_key: ownerKey }));
  let calls = 0, trusted: TrustedCallContext | undefined, disconnected = 0;
  const local: LocalCapabilities = { manifest: async () => ({ name: "fake", kind: "laptop", capabilities: [] }), call: async (_name, _args, _caller, _signal, context) => { calls++; trusted = context; return { ok: true, content: [] }; }, collaborationDisconnected: () => { disconnected++; } };
  const link = new FakeLink("https://unused.invalid", { id: "device", publicKey: "unused", sign: async () => "unused" }, local, () => {});
  try {
    await link.pair(state, undefined, "fake"); link.connectFake();
    assert.equal((await link.request("missing", "collaboration.work.list")).status, 403);
    assert.equal((await link.request("wrong", "collaboration.work.list", "another-owner")).status, 403);
    assert.equal(calls, 0);
    assert.equal((await link.request("correct", "collaboration.work.list", ownerId, "agent:reader")).status, 200);
    assert.equal(calls, 1); assert.equal(trusted?.transportOwnerId, ownerId); assert.equal(trusted?.isCurrent(), true);
    link.disconnect(); assert.equal(trusted?.isCurrent(), false);
    assert.equal((await link.request("legacy", "workspace.list")).status, 200); assert.equal(trusted, undefined);
    writeFileSync(join(state, "paired.json"), JSON.stringify({ owner_key: ownerKey, revoked: true }));
    assert.equal((await link.request("revoked", "collaboration.work.list", ownerId)).status, 403);
    assert.equal(calls, 2); assert.ok(disconnected > 0);
  } finally { link.stop(); rmSync(state, { recursive: true, force: true }); }
});

test("pair file change invalidates an in-flight transport context and suppresses its successful result", async () => {
  const state = mkdtempSync(join(tmpdir(), "ash-link-revoke-")), ownerKey = b64u(Buffer.from("synthetic-owner-key")), ownerId = await deviceIdForKey(ownerKey);
  writeFileSync(join(state, "paired.json"), JSON.stringify({ owner_key: ownerKey }));
  let release!: () => void, trusted: TrustedCallContext | undefined;
  const link = new FakeLink("https://unused.invalid", { id: "device", publicKey: "unused", sign: async () => "unused" }, { manifest: async () => ({ name: "fake", kind: "laptop", capabilities: [] }), call: async (_name, _args, _caller, _signal, context) => { trusted = context; await new Promise<void>(resolve => { release = resolve; }); return { ok: true, content: [], data: "private history" }; } }, () => {});
  try {
    await link.pair(state, undefined, "fake"); link.connectFake();
    const pending = link.request("reading", "collaboration.work.read", ownerId);
    while (!release) await new Promise(resolve => setTimeout(resolve, 2));
    writeFileSync(join(state, "paired.json"), JSON.stringify({ owner_key: ownerKey, revoked: true }));
    assert.equal(trusted?.isCurrent(), false); release();
    const response = await pending;
    assert.equal(response.status, 200); assert.ok("body" in response); assert.equal(JSON.parse(String(response.body)).ok, false); assert.doesNotMatch(String(response.body), /private history/);
  } finally { link.stop(); rmSync(state, { recursive: true, force: true }); }
});
