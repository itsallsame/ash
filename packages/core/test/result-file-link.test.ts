import {createHash} from "node:crypto";
import {ResultFileService} from "../src/collaboration/result-file-service";
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
  listRequests=0; manifestRequests=0;
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
  connect() { this.connected = true; this.conn = { close: () => {}, request: async () => { this.listRequests++; return { devices: structuredClone(this.devices) }; } } as any; }
  changeConnection() { this.connect(); }
  override async isBrowserAuthorized(id: string) {
    if (this.browserAuthorizationDelayMs) await new Promise(r => setTimeout(r, this.browserAuthorizationDelayMs));
    return super.isBrowserAuthorized(id);
  }
  receive(frame: Record<string, unknown>) { this.onFrame(frame); }
  manifest() {
    this.manifestRequests++; return { name: "Mac", capabilities: [...['collaboration.result.prepare','collaboration.result.read_chunk'].map(name=>({name,risk:'none'})),...readCapabilities({ state: "ready", endpoint_id: "desktop", authorization_generation: this.generation, authorization_revision: this.revision, allowedCwds: ["/approved"], version: 2, owner_id: readOwnerId, fingerprint: "fake" })],
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
    const response = request.path === "/ash/manifest" ? this.manifest() : typeof this.result === "function" ? this.result(this.calls[this.calls.length-1]) : this.result;
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
test('result export uses fixed signed device tunnel and fences capability, pairing and authorization mutation',async()=>{
 const f=await fixture();try{f.link.result={ok:true,content:[],data:{version:1,state:'approval_required',pending_id:'pending',display_name:'result.txt',media_type:'text/plain',byte_length:8}};
 const args={version:1,endpoint_id:'desktop',authorization_revision:'a'.repeat(64),work,turn_id:'turn',source_message_id:'message',exact_href:'./result.txt'};
 const inputValue={...input,action:'read_work' as const,work:work as any} as any;
 const result:any=await f.link.resultCall(inputValue,'collaboration.result.prepare',args,new AbortController().signal);assert.equal(result.state,'approval_required');assert.deepEqual(f.link.calls[0],{capability:'collaboration.result.prepare',caller:'person:owner',args});
 f.link.afterCall=()=>{f.link.revision='b'.repeat(64);};await assert.rejects(f.link.resultCall(inputValue,'collaboration.result.prepare',args,new AbortController().signal),/permission_denied/);
 f.link.afterCall=undefined;f.link.revision='a'.repeat(64);f.link.devices[0].revoked=true;await assert.rejects(f.link.resultCall(inputValue,'collaboration.result.prepare',args,new AbortController().signal),/permission_denied/);
 }finally{f.close();}
});
test('4MiB snapshot uses one operation lease: 103 calls, two fresh manifests and three pairing reads',async()=>{
 const f=await fixture();try{const bytes=Buffer.alloc(4194304,0x5a),sha=createHash('sha256').update(bytes).digest('hex');
 f.link.result=(call:any)=>({ok:true,content:[],data:call.capability.endsWith('prepare')?{version:1,state:'ready',export_id:'export',asset:{kind:'asset',asset_id:'asset',version:1,sha256:sha,byte_length:bytes.length,display_name:'fixture.txt',media_type:'text/plain',provenance:[],expires_at:Date.now()+900000},expires_at:Date.now()+900000}:{version:1,export_id:'export',asset_id:'asset',asset_version:1,sha256:sha,byte_length:bytes.length,chunk_index:call.args.chunk_index,data_base64:bytes.subarray(call.args.chunk_index*40960,(call.args.chunk_index+1)*40960).toString('base64')}});
 const service=new ResultFileService(f.link),signal=new AbortController().signal,selection={...input,action:'read_work',work,turn_id:'turn',source_message_id:'message',exact_href:'./fixture.txt'} as any,prepared:any=await service.prepare('screen',selection,signal,()=>{});
 f.link.calls=[];f.link.listRequests=0;f.link.manifestRequests=0;const began=Date.now(),snapshot=await service.snapshot('screen',prepared.save_id,1,sha,signal,()=>{});
 assert.equal(Buffer.from(snapshot.bytes_base64,'base64').length,bytes.length);assert.equal(f.link.calls.length,103);assert.equal(f.link.manifestRequests,2);assert.equal(f.link.listRequests,3);assert.ok(Date.now()-began<30000);
 // The final fresh manifest remains mandatory even when every chunk is verified.
 f.link.afterCall=()=>{if(f.link.calls.length===206)f.link.revision='b'.repeat(64);};await assert.rejects(service.snapshot('screen',prepared.save_id,1,sha,signal,()=>{}),/permission_denied/);
 }finally{f.close();}
});
