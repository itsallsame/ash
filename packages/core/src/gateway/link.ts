import {MATERIAL_PROVIDER_REQUEST_TYPE,MATERIAL_PROVIDER_RESPONSE_TYPE} from '../../../device/src/collaboration/material-provider-protocol';
import { bounded, Link, STEP_MS, type Signer } from "../../../device/src/link";
import { RemoteAgents } from "../../../device/src/agents/remote";
export { ClientLink, fileSigner, type LocalCapabilities, type Signer } from "../../../device/src/link";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Connection, GatewayError } from "ash-gateway/client/client";
import { b64u, fromB64u, LIMITS, type Permission, PERMISSIONS, randomToken, shortFingerprint } from "ash-gateway/src/protocol";
import type { CallResult } from "../../../sdk/src/api";
import { isWordEffect } from "../../../sdk/src/words";
import { DeviceMember } from "../members/device";
import { fenceCollaborationResponse, type EdgeCaller, type EdgeResponse, type EdgeRouter } from "../server";
import type { DeviceCapability } from "../world/router";
import { boundedControl, CONTROL_ERROR_STATUS, CONTROL_INPUT_BYTES, CONTROL_OUTPUT_BYTES, CoreControlError, FixedControlTransport, controlFailure, normalizeControlTarget, type ControlReturnGate, type ControlTarget, type CoreControlSession } from "../collaboration/control-service";
import { boundedCreate, CREATE_ERROR_STATUS, CREATE_INPUT_BYTES, CREATE_OUTPUT_BYTES, CoreCreateError, FixedCreateTransport, createFailure, normalizeCreateTarget, type CreateReturnGate, type CreateTarget, type CoreCreateSession } from "../collaboration/create-service";
import type {ResultFileTransport} from "../collaboration/result-file-service";
import { boundedRead, CoreReadError, normalizeReadTarget, READ_CAPABILITIES, READ_ERROR_STATUS, READ_INPUT_BYTES, READ_OUTPUT_BYTES, validateReadPage, type ReadInput, type ReadTarget } from "../collaboration/read-service";

import {GatewayClient} from 'ash-gateway/client/client';
import {deviceIdForKey} from 'ash-gateway/src/protocol';
import {MaterialProtocolError} from '../../../device/src/collaboration/material-types';
import {MATERIAL_REQUEST_TYPE,MATERIAL_RESPONSE_TYPE,relayFrame,relayRecord,type MaterialRelayTransport} from '../../../device/src/collaboration/material-client';
import {MATERIAL_IDENTITY_TYPE,MaterialLinkWork} from '../../../device/src/collaboration/material-link-bindings';
import {freezeMaterial,type MaterialPeerProofProvider} from '../collaboration/material-registry';
import type {CoreMaterialRuntime} from '../collaboration/material-runtime';
import type {CoreMaterialLinkBindings} from '../collaboration/material-link-bindings';
/** A paired device's own name, safe to show inside owner-facing labels. */
function deviceLabel(name: unknown): string {
  return String(name ?? "").replace(/[\p{C}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 40) || "另一台设备";
}

/**
 * Capabilities a paired device lends. Only a read-only claim (risk none) is honoured; any other claim, or
 * none at all, is structure risk. The owner writes every label, naming the device and the capability.
 */
export function borrowedCapabilities(raw: unknown[], deviceName: unknown): DeviceCapability[] {
  const device = deviceLabel(deviceName);
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid remote capability");
    const cap = value as DeviceCapability;
    if (typeof cap.name !== "string" || !cap.name.trim() || typeof cap.description !== "string" || !cap.input_schema || typeof cap.input_schema !== "object")
      throw new TypeError("invalid remote capability");
    const name = cap.name.replace(/[\p{C}\s]+/gu, " ").trim().slice(0, 80);
    // A lent effect is believed only when it is not a read: another device can never make a call look harmless.
    const effect = cap.risk === "none" ? "read" as const : isWordEffect(cap.effect) && cap.effect !== "read" ? cap.effect : "write" as const;
    return { ...cap, risk: cap.risk === "none" ? "none" as const : "structure" as const, effect, label: `在${device}上用 ${name}` };
  });
}

interface Inbound { method: string; path: string; headers: [string, string][]; body: Uint8Array[]; from?: string }
interface Outbound { device: string; status: number; chunks: Uint8Array[]; maxBytes: number; end: (error?: string) => void }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Why the gateway cannot be used, in a fixed vocabulary the owner's screen explains. Only `unreachable` is retried;
 * the others need the owner (a new claim secret, a reset gateway, a newer gateway).
 */
export type GatewayProblem = "claimed_by_other" | "bad_secret" | "missing_secret" | "unsupported" | "unreachable";
class GatewayRefused extends Error { constructor(readonly problem: GatewayProblem, message: string) { super(message); } }
export function gatewayProblem(error: unknown): GatewayProblem {
  if (error instanceof GatewayRefused) return error.problem;
  if (error instanceof GatewayError) {
    if (error.code === "bad_mac") return "bad_secret";
    if (error.code === "already_claimed") return "claimed_by_other";
  }
  if (error instanceof Error && /unsupported gateway protocol/i.test(error.message)) return "unsupported";
  return "unreachable";
}

export interface PendingPairing { request_id: string; client_id: string; name: string; pubkey: string; fingerprint: string; at: number }

/** The owner tunnel forwards only authenticated web_ui devices to the v2 edge. */
export class OwnerLink extends Link {
  private material?:{runtime:CoreMaterialRuntime;bindings:CoreMaterialLinkBindings;work:MaterialLinkWork};
  private readonly materialKeys=new Map<string,{key:string;version:number}>();private readonly materialPeers=new Map<string,Promise<void>>();
  attachMaterial(runtime:CoreMaterialRuntime,bindings:CoreMaterialLinkBindings,work:MaterialLinkWork):void{if(this.material)throw new Error('material already attached');this.material={runtime,bindings,work};}
  private invalidateMaterial():void{const material=this.material;if(!material)return;for(const id of this.materialPeers.keys())material.runtime.detachPeer(id);this.materialPeers.clear();material.runtime.invalidate();}
  materialPeerProofs():MaterialPeerProofProvider{return {currentEpoch:()=>`${this.epoch}:${this.authorityGeneration}`,capture:async id=>{const peer=await this.materialPeer(id);return {node_id:peer.peer_id,public_key:peer.public_key,pairing_id:peer.pairing_id,generation:peer.generation,current:():undefined=>{this.materialTransport(id).current(peer);return undefined;}};}};}
  private async materialPeer(id:string){const conn=this.conn,epoch=this.epoch;if(!conn||!this.connected||this.stopped)throw new MaterialProtocolError('offline');const list=await conn.request({op:'device.list'});if(this.conn!==conn||epoch!==this.epoch||!this.connected||this.stopped)throw new MaterialProtocolError('offline');if(!Array.isArray(list.devices))throw new MaterialProtocolError('offline');this.observePairing(list.devices);const item=(list.devices as any[]).find(d=>d.id===id&&!d.revoked&&d.online),key=this.materialKeys.get(id);if(!item||!key||key.version!==item.grant_version)throw new MaterialProtocolError('unsupported');return freezeMaterial({local_id:this.signer.id,peer_id:id,public_key:key.key,pairing_id:`material:${this.signer.id}:${id}`,generation:`${epoch}:${this.authorityGeneration}`});}
  materialTransport(id:string):MaterialRelayTransport{return {capture:()=>this.materialPeer(id),current:peer=>{this.material?.work.current();const key=this.materialKeys.get(id);if(this.stopped||!this.conn||!this.connected||peer.local_id!==this.signer.id||peer.peer_id!==id||peer.generation!==`${this.epoch}:${this.authorityGeneration}`||peer.public_key!==key?.key||key.version!==JSON.parse(this.observedPairing.get(id)??'[]')[3])throw new MaterialProtocolError('permission_denied');return undefined;},send:envelope=>{this.material?.work.current();if(!this.conn||this.stopped||!this.connected||envelope.from!==this.signer.id||envelope.to!==id)throw new MaterialProtocolError('offline');this.conn.send(envelope);return undefined;}};}
  private async materialIdentity(frame:Record<string,unknown>):Promise<void>{const conn=this.conn,epoch=this.epoch,generation=this.authorityGeneration;if(!conn||!this.connected||this.stopped)throw new MaterialProtocolError('offline');const current=()=>{this.material?.work.current();if(this.conn!==conn||this.epoch!==epoch||this.authorityGeneration!==generation||!this.connected||this.stopped)throw new MaterialProtocolError('permission_denied');};const envelope=relayFrame(frame,MATERIAL_IDENTITY_TYPE,Date.now()),body=relayRecord(JSON.parse(envelope.payload),['version','public_key']);if(envelope.to!==this.signer.id||body.version!==1||typeof body.public_key!=='string'||body.public_key.length>4096)throw new MaterialProtocolError('invalid');const list=await conn.request({op:'device.list'});current();if(!Array.isArray(list.devices))throw new MaterialProtocolError('offline');const item=(list.devices as any[]).find(d=>d.id===envelope.from&&!d.revoked&&d.online);if(!item)throw new MaterialProtocolError('permission_denied');if(await deviceIdForKey(body.public_key)!==envelope.from)throw new MaterialProtocolError('permission_denied');current();if(!await GatewayClient.verifyEnvelope(envelope,body.public_key))throw new MaterialProtocolError('permission_denied');current();relayFrame(envelope,MATERIAL_IDENTITY_TYPE,Date.now());this.observePairing(list.devices);const nextGeneration=this.authorityGeneration;if(!this.materialKeys.has(envelope.from)&&this.materialKeys.size>=4096)throw new MaterialProtocolError('too_large');this.materialKeys.set(envelope.from,{key:body.public_key,version:item.grant_version});if(envelope.reply_to===null){const response=await this.gateway.envelope(MATERIAL_IDENTITY_TYPE,envelope.from,{version:1,public_key:this.signer.publicKey},{ttlMs:Math.max(1,envelope.expires_at-Date.now()-1),replyTo:envelope.message_id});this.material?.work.current();if(this.conn!==conn||this.epoch!==epoch||this.authorityGeneration!==nextGeneration||this.stopped)throw new MaterialProtocolError('permission_denied');conn.send(response);}}
  /** Fixed internal source bridge locates a currently authenticated paired peer before material registration. */
  async materialInputPeer(id:string){const material=this.material;if(!material)throw new MaterialProtocolError('unsupported');await material.work.run(async()=>{let pending=this.materialPeers.get(id);if(!pending){pending=material.runtime.peer({peer_id:id,gateway:this.gateway,transport:this.materialTransport(id),bindings:material.bindings}).then(()=>undefined);this.materialPeers.set(id,pending);pending.catch(()=>{if(this.materialPeers.get(id)===pending)this.materialPeers.delete(id);});}await pending;});return material.runtime.inputForPeer(id);}
  private async materialFrame(frame:Record<string,unknown>):Promise<void>{const material=this.material;if(!material)return;const id=typeof frame.from==='string'?frame.from:'';if(!id)throw new MaterialProtocolError('invalid');let peer=this.materialPeers.get(id);if(!peer){peer=material.runtime.peer({peer_id:id,gateway:this.gateway,transport:this.materialTransport(id),bindings:material.bindings}).then(()=>undefined);this.materialPeers.set(id,peer);peer.catch(()=>{if(this.materialPeers.get(id)===peer)this.materialPeers.delete(id);});}await peer;await material.runtime.acceptFrame(id,frame);}
  private readonly incoming = new Map<string, Inbound>();
  private readonly readCalls = new Map<string, AbortController>();
  private readonly outbound = new Map<string, Outbound>();
  private readonly remoteDevices = new Map<string, { member: DeviceMember; manifest: string; details: { protocol?: string; version?: string; agents?: unknown[]; workdir?: string } }>();
  private deviceName: (id: string, fallback: string) => string = (_id, fallback) => fallback;
  private agentsAllowed: (id: string) => boolean = () => false;
  setDeviceManagement(name: (id: string, fallback: string) => string, agentsAllowed: (id: string) => boolean): void {
    this.deviceName = name; this.agentsAllowed = agentsAllowed;
  }
  private readonly agentChannels = new Map<string, { peer: RemoteAgents; connection?: Connection; stream?: import("ash-gateway/client/client").DeviceStream }>();
  /** Every paired, unrevoked device as the gateway lists it (browsers included), for listing and revoking. */
  private paired: { id: string; name: string; permissions: string[]; online: boolean }[] = [];
  private readonly streams = new Map<string, { end: () => void; from: string }>();
  private serving = false;
  private ready = false;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncTail: Promise<void> = Promise.resolve();
  private epoch = 0;
  // Only observed gateway pairing state and locally initiated changes are synchronous knowledge.
  private authorityGeneration = 0;
  private readonly observedPairing = new Map<string, string>();
  private observePairing(devices: unknown[]): void {
    const next = new Map<string, string>();
    for (const raw of devices) {
      if (!raw || typeof raw !== "object" || !("id" in raw) || typeof raw.id !== "string") continue;
      const device = raw as { id: string; revoked?: boolean; permissions?: unknown; online?: boolean };
      next.set(device.id, JSON.stringify([Boolean(device.revoked), device.permissions, Boolean(device.online),(device as any).grant_version]));
    }
    for (const [id, value] of this.observedPairing) if (next.get(id) !== value) {this.authorityGeneration++;this.invalidateMaterial();}
    this.observedPairing.clear(); for (const [id, value] of next) this.observedPairing.set(id, value);
  }
  readonly pending = new Map<string, PendingPairing>();
  /** Set while claiming fails; a refusal other than `unreachable` stops the link until the owner changes the gateway. */
  problem: GatewayProblem | null = null;
  private readonly halted = new AbortController();
  constructor(url: string, signer: Signer, private readonly edge: EdgeRouter, log: (...args: unknown[]) => void) { super(url, signer, log); edge.attachCollaboration(this); edge.attachResultFiles(this); edge.attachCollaborationControl(new FixedControlTransport(signal => this.controlSession(signal))); edge.attachCollaborationControlDiscovery((signal, gate) => this.collaborationControlEndpoints(signal, gate)); edge.attachCollaborationCreate(new FixedCreateTransport(signal => this.createSession(signal))); edge.attachCollaborationCreateDiscovery((signal, gate) => this.collaborationCreateEndpoints(signal, gate)); }
  enable(): void { this.serving = true; }

  /**
   * Claim the gateway when needed, then stay connected. Never throws: ash runs without the gateway, an unreachable one is
   * tried again with backoff, and a refusal is kept in `problem` for the owner to see.
   */
  async start(secretFile: string, name: string): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      try { await this.claimIfNeeded(secretFile, name); this.problem = null; this.lastError = ""; break; }
      catch (error) {
        this.problem = gatewayProblem(error); this.lastError = error instanceof Error ? error.message : String(error);
        this.log("gateway unavailable", this.problem, this.lastError);
        if (this.problem !== "unreachable") return;
        try { await pause(delay * (0.5 + Math.random() / 2), undefined, { signal: this.halted.signal }); } catch { return; }
        delay = Math.min(delay * 2, 60_000);
      }
    }
    if (!this.stopped) await this.run().catch((error) => this.log("gateway link stopped", error));
  }

  /** Bounded: true once devices and grants are current, false as soon as the gateway is known to be unavailable. */
  async waitConnected(timeoutMs = 30_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (!this.ready && !this.problem && !this.lastError && !this.stopped && Date.now() < until) await sleep(50);
    return this.ready;
  }

  async claimIfNeeded(secretFile: string, name: string): Promise<void> {
    const health = await bounded(this.gateway.health(), STEP_MS, "gateway health");
    if (health.protocol !== undefined && health.protocol !== "ash-gw/1") throw new GatewayRefused("unsupported", "Unsupported gateway protocol");
    if (health.claimed === true) {
      if (health.owner_id !== this.signer.id) throw new GatewayRefused("claimed_by_other", "gateway is claimed by a different owner device");
      return;
    }
    if (health.claimed !== false) throw new Error("gateway claim status unavailable");
    if (!existsSync(secretFile)) throw new GatewayRefused("missing_secret", "gateway is unclaimed and no bootstrap secret is saved");
    const result = await this.gateway.claim(readFileSync(secretFile, "utf8").trim(), name);
    unlinkSync(secretFile);
    this.log("gateway claimed", result.owner_id);
  }

  protected async onConnected(conn: Connection): Promise<void> {
    const epoch = ++this.epoch;
    const pending = await conn.request({ op: "pair.pending" }).catch(() => null);
    if (epoch !== this.epoch || this.conn !== conn) return;
    for (const item of (pending?.requests as Record<string, string>[] | undefined) ?? []) await this.addPending(item);
    await this.refreshDevices();
    if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
    this.ready = true;
    // An owner process can restart while paired devices keep their connections.
    // Reuse the signed identity exchange; only its verified reply supplies a key.
    if(this.material)void this.material.work.run(async()=>{
      const generation=this.authorityGeneration;
      for(const device of this.paired.filter(d=>d.online&&d.permissions.includes('expose_capability'))){
        if(this.conn!==conn||this.epoch!==epoch||this.authorityGeneration!==generation||this.stopped||!this.connected)return;
        const envelope=await this.gateway.envelope(MATERIAL_IDENTITY_TYPE,device.id,{version:1,public_key:this.signer.publicKey},{ttlMs:29999});
        this.material?.work.current();
        if(this.conn!==conn||this.epoch!==epoch||this.authorityGeneration!==generation||this.stopped||!this.connected)return;
        conn.send(envelope);
      }
    }).catch(error=>this.log('material identity unavailable',error));
    this.syncTimer = setInterval(() => void this.refreshDevices().catch(() => {}), 30_000);
  }
  protected onDisconnected(): void {
    this.epoch++;this.invalidateMaterial();
    this.ready = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    for (const stream of this.streams.values()) stream.end();
    this.streams.clear(); this.incoming.clear();
    for (const call of this.readCalls.values()) call.abort();
    this.readCalls.clear();
    for (const pending of this.outbound.values()) pending.end("device_offline");
    this.outbound.clear();
    for (const entry of this.remoteDevices.values()) entry.member.setOnline(false);
  }
  /** Internal entry point: AgentSystem must check local_agents permission before calling this. */
  openAgentChannel(member: string, handlers: ConstructorParameters<typeof RemoteAgents>[0]): RemoteAgents {
    const id = member.replace(/^device:/, "");
    const device = this.paired.find(d => d.id === id);
    if (!device?.online || !device.permissions.includes("expose_capability") || !this.agentsAllowed(`device:${id}`)) throw new Error("device offline or local agents not authorized");
    const existing = this.agentChannels.get(id); if (existing) return existing.peer;
    const entry = { peer: new RemoteAgents({ ...handlers, manifestChanged: () => { handlers.manifestChanged?.(); void this.refreshDevices().catch(() => {}); } }) };
    this.agentChannels.set(id, entry); this.connectAgentChannel(id); return entry.peer;
  }
  closeAgentChannel(member: string): void {
    const id = member.replace(/^device:/, "");
    this.agentChannels.get(id)?.peer.close(); this.agentChannels.delete(id);
  }
  private connectAgentChannel(id: string): void {
    const entry = this.agentChannels.get(id), conn = this.conn;
    if (!entry || !conn || entry.stream) return;
    const stream = conn.openStream(id);
    entry.connection = conn; entry.stream = stream;
    stream.onClose(() => { if (entry.stream === stream) entry.stream = undefined; });
    entry.peer.attach(stream);
  }
  override stop(): void {
    this.material?.work.stop();this.invalidateMaterial();
    for (const call of this.readCalls.values()) call.abort();
    for (const entry of this.agentChannels.values()) entry.peer.close();
    this.agentChannels.clear(); this.halted.abort(); super.stop();
  }
  /** Told once per pairing request this link has not seen before, live or found pending on connecting. */
  onPairingRequest: ((item: PendingPairing) => void) | null = null;
  private async addPending(raw: Record<string, string>): Promise<void> {
    const item: PendingPairing = { request_id: raw.request_id, client_id: raw.client_id, name: raw.name, pubkey: raw.pubkey, fingerprint: await shortFingerprint(raw.pubkey), at: Date.now() };
    const fresh = !this.pending.has(item.request_id);
    this.pending.set(item.request_id, item);
    if (fresh) try { this.onPairingRequest?.(item); } catch (error) { this.log("pairing notice failed", error); }
  }
  protected onFrame(frame: Record<string, unknown>): void {
    if(frame.type===MATERIAL_IDENTITY_TYPE||frame.type===MATERIAL_REQUEST_TYPE||frame.type===MATERIAL_RESPONSE_TYPE||frame.type===MATERIAL_PROVIDER_REQUEST_TYPE||frame.type===MATERIAL_PROVIDER_RESPONSE_TYPE){const material=this.material;if(material){const captured=freezeMaterial(frame);void material.work.run(()=>frame.type===MATERIAL_IDENTITY_TYPE?this.materialIdentity(captured):this.materialFrame(captured)).catch(error=>this.log('material relay unavailable',error));}return;}
    if (frame.t === "tun" && typeof frame.sid === "string" && this.outbound.has(frame.sid)) { this.onOutbound(frame); return; }
    if (frame.t === "gw") {
      if (frame.op === "pair.request") void this.addPending(frame as Record<string, string>);
      if (frame.op === "device.presence") {
        // This authenticated notification can accompany permission changes. Invalidate
        // captured sessions immediately; neither online nor offline proves a fresh grant.
        this.authorityGeneration++;this.invalidateMaterial();
        void this.revalidateStreams(); void this.refreshDevices().catch(() => {});
      }
      return;
    }
    if (frame.t !== "tun" || typeof frame.sid !== "string") return;
    const sid = frame.sid;
    if (frame.op === "http.req") this.incoming.set(sid, { method: String(frame.method), path: String(frame.path), headers: (frame.headers as [string, string][]) ?? [], body: [], from: typeof frame.from === "string" ? frame.from : undefined });
    else if (frame.op === "http.reqbody") {
      const inbound = this.incoming.get(sid);
      if (inbound) {
        inbound.body.push(fromB64u(String(frame.data)));
        if (inbound.path.startsWith("/api/collaboration/") && inbound.body.reduce((n, chunk) => n + chunk.length, 0) > (inbound.path.startsWith("/api/collaboration/create/") ? CREATE_INPUT_BYTES : inbound.path.startsWith("/api/collaboration/control/") ? CONTROL_INPUT_BYTES : READ_INPUT_BYTES)) {
          this.incoming.delete(sid); this.reply(sid, { status: 413, headers: { "cache-control": "no-store" }, body: JSON.stringify({ ok: false, error: { code: "too_large", message: `Collaboration ${inbound.path.startsWith("/api/collaboration/create/") ? "create" : inbound.path.startsWith("/api/collaboration/control/") ? "control" : "read"} too_large` } }) });
        }
      }
    }
    else if (frame.op === "http.reqend") {
      const inbound = this.incoming.get(sid); this.incoming.delete(sid);
      if (inbound) {
        const controller = new AbortController(); this.readCalls.set(sid, controller);
        void this.serve(sid, inbound, controller.signal).catch(() => { if (!controller.signal.aborted) this.send({ t: "tun", op: "http.error", sid, message: "tunnel failed" }); }).finally(() => this.readCalls.delete(sid));
      }
    } else if (frame.op === "http.abort") { this.incoming.delete(sid); this.readCalls.get(sid)?.abort(); this.streams.get(sid)?.end(); this.streams.delete(sid); }
  }

  private onOutbound(frame: Record<string, unknown>): void {
    const item = this.outbound.get(String(frame.sid))!;
    if (frame.from !== item.device) return;
    if (frame.op === "http.head") item.status = Number(frame.status);
    else if (frame.op === "http.body") {
      item.chunks.push(fromB64u(String(frame.data)));
      if (item.chunks.reduce((n, b) => n + b.byteLength, 0) > item.maxBytes) {
        this.send({ t: "tun", op: "http.abort", sid: frame.sid, to: item.device }); item.end("too_large");
      }
    }
    else if (frame.op === "http.end") item.end();
    else if (frame.op === "http.error") item.end(String(frame.message ?? "tunnel error"));
  }

  /** One authenticated gateway exchange with an exposed, paired client. */
  private requestDevice(to: string, method: string, path: string, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal, maxBytes = 8 * 1024 * 1024): Promise<{ status: number; body: Buffer }> {
    if (!this.conn || !this.connected || signal?.aborted) return Promise.reject(new Error("device offline or call cancelled"));
    const sid = randomToken(12);
    return new Promise((resolve, reject) => {
      let settled = false;
      const item: Outbound = { device: to, status: 0, chunks: [], maxBytes, end: (error) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.outbound.delete(sid);
        if (error) reject(new Error(error));
        else resolve({ status: item.status, body: Buffer.concat(item.chunks) });
      } };
      const cancel = (reason: string) => { this.send({ t: "tun", op: "http.abort", sid, to }); item.end(reason); };
      const timer = setTimeout(() => cancel("device timeout"), timeoutMs);
      const abort = () => cancel("cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      this.outbound.set(sid, item);
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      this.send({ t: "tun", op: "http.req", sid, to, method, path, headers: data ? [["content-type", "application/json"]] : [] });
      if (data) for (let offset = 0; offset < data.length; offset += LIMITS.tunnelChunkBytes)
        this.send({ t: "tun", op: "http.reqbody", sid, to, data: b64u(new Uint8Array(data.subarray(offset, offset + LIMITS.tunnelChunkBytes))) });
      this.send({ t: "tun", op: "http.reqend", sid, to });
    });
  }

  /** Every presence/grant change queues a fresh list; no update is discarded behind an older sync. */
  refreshDevices(): Promise<void> {
    const epoch = this.epoch;
    const task = this.syncTail.catch(() => {}).then(() => this.syncDevicesOnce(epoch));
    this.syncTail = task;
    return task;
  }

  private async syncDevicesOnce(epoch: number): Promise<void> {
    const conn = this.conn;
    if (!conn || epoch !== this.epoch || !this.connected) return;
    const result = await conn.request({ op: "device.list" });
    if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
    const list = result.devices as { id: string; name: string; permissions: string[]; revoked: boolean; online: boolean }[];
    if (!Array.isArray(list)) throw new Error("gateway device list unavailable");
    this.observePairing(list);
    this.paired = list.filter((item) => typeof item.id === "string" && /^[A-Za-z0-9_-]+$/.test(item.id) && !item.revoked)
      .map((item) => ({ id: item.id, name: this.deviceName(`device:${item.id}`, String(item.name ?? item.id)), permissions: Array.isArray(item.permissions) ? item.permissions.map(String) : [], online: Boolean(item.online) }));
    for (const id of this.agentChannels.keys()) {
      const item = this.paired.find(device => device.id === id);
      if (!item?.permissions.includes("expose_capability")) this.closeAgentChannel(id);
      else if (item.online) this.connectAgentChannel(id);
    }
    const seen = new Set<string>();
    for (const item of list) {
      if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
      if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.id)) continue;
      const memberId = `device:${item.id}`;
      item.name = this.deviceName(memberId, String(item.name ?? item.id));
      if (item.revoked || !item.permissions?.includes("expose_capability")) {
        this.edge.members.removeDevice(memberId);
        this.remoteDevices.delete(item.id);
        continue;
      }
      seen.add(item.id);
      const previous = this.remoteDevices.get(item.id);
      if (!item.online) { previous?.member.setOnline(false); continue; }
      try {
        const response = await this.requestDevice(item.id, "GET", "/ash/manifest", undefined, 20_000);
        if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
        if (response.status !== 200) throw new Error("remote manifest unavailable");
        const raw = JSON.parse(response.body.toString("utf8")) as { name?: unknown; capabilities?: unknown; protocol?: string; version?: string; agents?: unknown[]; workdir?: string };
        if (!raw || !Array.isArray(raw.capabilities) || typeof raw.name !== "string" || !raw.name.trim()) throw new TypeError("invalid remote manifest");
        if (raw.protocol && raw.protocol !== "ash-dev/1") throw new Error("Device protocol needs updating");
        // Desktop history is an owner-screen observation, never a borrowed agent tool or ledger word.
        const capabilities = borrowedCapabilities(raw.capabilities.filter(cap => !(cap && typeof cap === "object" && "name" in cap && typeof cap.name === "string" && cap.name.startsWith("collaboration."))), item.name);
        const details = { protocol: raw.protocol, version: raw.version, agents: raw.agents, workdir: raw.workdir };
        const manifest = JSON.stringify({ name: item.name, capabilities, details });
        if (previous?.manifest === manifest) { previous.member.setOnline(true); continue; }
        const member = new DeviceMember(memberId, item.name, capabilities, async (message, context) => {
          try {
            const called = await this.requestDevice(item.id, "POST", "/ash/call", { capability: message.word, args: message.body, caller: message.from }, 150_000, context.signal);
            if (called.status !== 200) throw new Error("remote device returned an HTTP error");
            const answer = JSON.parse(called.body.toString("utf8")) as CallResult;
            if (!answer || typeof answer.ok !== "boolean") throw new Error("invalid remote result");
            return answer.ok ? { ok: true, result: { content: answer.content, ...(answer.data === undefined ? {} : { data: answer.data }) } }
              : { ok: false, error: { code: "failed", message: answer.error ?? "remote call failed", detail: { content: answer.content, data: answer.data } } };
          } catch (e) {
            const message = e instanceof Error ? e.message : "remote device unavailable";
            return { ok: false, error: { code: /offline/.test(message) ? "offline" : /timeout/.test(message) ? "timeout" : /cancelled/.test(message) ? "cancelled" : "failed", message } };
          }
        });
        this.edge.members.replaceDevice(member);
        this.remoteDevices.set(item.id, { member, manifest, details });
      } catch { if (epoch === this.epoch && this.conn === conn && this.connected) previous?.member.setOnline(false); }
    }
    if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
    for (const id of this.remoteDevices.keys()) if (!seen.has(id)) {
      this.edge.members.removeDevice(`device:${id}`);
      this.remoteDevices.delete(id);
    }
  }

  private async revalidateStreams(): Promise<void> {
    for (const stream of this.streams.values()) {
      try { if (!await this.isBrowserAuthorized(stream.from)) stream.end(); }
      catch { stream.end(); }
    }
  }

  async isBrowserAuthorized(id: string): Promise<boolean> {
    const conn = this.conn, epoch = this.epoch;
    if (!conn) return false;
    const list = await bounded(conn.request({ op: "device.list" }), 5000, "browser authorization");
    if (conn !== this.conn || epoch !== this.epoch || !this.connected) return false;
    const devices = list.devices as { id: string; revoked?: boolean; permissions: string[] }[];
    if (Array.isArray(devices)) this.observePairing(devices);
    return Array.isArray(devices) && devices.some((device) => device.id === id && !device.revoked && device.permissions?.includes("web_ui"));
  }
  private async serve(sid: string, inbound: Inbound, signal?: AbortSignal): Promise<void> {
    const collaboration = inbound.path.startsWith("/api/collaboration/");
    const create = inbound.path.startsWith("/api/collaboration/create/");
    const control = inbound.path.startsWith("/api/collaboration/control/");
    const failure = (code: string): EdgeResponse => ({ status: (create ? CREATE_ERROR_STATUS as Record<string, number> : control ? CONTROL_ERROR_STATUS as Record<string, number> : READ_ERROR_STATUS)[code] ?? 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify({ ok: false, error: { code, message: `Collaboration ${create ? "create" : control ? "control" : "read"} ${code}` } }) });
    let dispatchFence: (() => boolean) | undefined;
    const dispatch = async (activeSignal?: AbortSignal, deadline?: number): Promise<EdgeResponse> => {
      if (!this.serving) return collaboration ? failure("offline") : { status: 503, body: JSON.stringify({ error: "offline", message: "owner edge starting" }) };
      const connection = this.conn, epoch = this.epoch;
      const authorized = Boolean(inbound.from && await this.isBrowserAuthorized(inbound.from));
      if (activeSignal?.aborted) throw new CoreReadError("cancelled");
      if (connection !== this.conn || epoch !== this.epoch) throw new CoreReadError("offline");
      if (!authorized) return collaboration ? failure("permission_denied") : { status: 403, body: JSON.stringify({ error: "forbidden", message: "web UI permission required" }) };
      const authorityGeneration = this.authorityGeneration;
      dispatchFence = () => this.conn === connection && this.epoch === epoch && this.connected && !this.stopped && this.authorityGeneration === authorityGeneration;
      const headers: Record<string, string> = {};
      for (const [name, value] of inbound.headers) headers[name.toLowerCase()] = value;
      const caller: EdgeCaller = { member: "person:owner", transportPrincipal: `gateway:${inbound.from}`, pairedDeviceId: inbound.from, local: false, remote: true, ownerProxy: true, transport: "web_ui" };
      return this.edge.handle({ method: inbound.method, url: new URL(inbound.path, "http://ash"), headers, body: inbound.body.length ? Buffer.concat(inbound.body) : null, signal: activeSignal, collaborationDeadline: deadline,
        transportFence: () => this.conn === connection && this.epoch === epoch && this.connected && !this.stopped && this.authorityGeneration === authorityGeneration,
        transportCurrent: async () => this.conn === connection && this.epoch === epoch && this.connected && await this.isBrowserAuthorized(inbound.from!) && this.conn === connection && this.epoch === epoch }, caller);
    };
    let result: EdgeResponse;
    try {
      if (collaboration) {
        const budget = this.edge.collaborationReadTimeoutMs(), deadline = Date.now() + budget;
        result = await (create ? boundedCreate : control ? boundedControl : boundedRead)(signal, budget, activeSignal => dispatch(activeSignal, deadline));
      } else result = await dispatch(signal);
    } catch (error) {
      if (!collaboration) throw error;
      result = failure(create ? error instanceof CoreReadError ? error.code : createFailure(error).code : control ? error instanceof CoreReadError ? error.code : controlFailure(error).code : error instanceof CoreReadError ? error.code : "offline");
    }
    if (signal?.aborted) return;
    if (collaboration && dispatchFence && !dispatchFence()) result = failure("permission_denied");
    result = fenceCollaborationResponse(result);
    this.reply(sid, result, (end) => { this.streams.set(sid, { end, from: inbound.from! }); return () => this.streams.delete(sid); });
  }
  private requireConnection(): Connection { if (!this.conn) throw new Error("gateway offline"); return this.conn; }

  /** Independent manifest discovery; read grants do not gate control targets. */
  private async collaborationControlEndpoints(signal: AbortSignal, gate: ControlReturnGate): Promise<ControlTarget[]> {
    const session = this.controlSession(signal), conn = this.conn;
    gate.bindDeviceFence(session.current);
    gate.current();
    session.current(); const response = await conn!.request({ op: "device.list" }); session.current();
    if (!Array.isArray(response.devices) || response.devices.length > 256) throw new CoreControlError("invalid");
    const selected = response.devices.filter((device: any) => device && typeof device.id === "string" && /^[A-Za-z0-9_-]+$/.test(device.id) && !device.revoked && device.online && Array.isArray(device.permissions) && device.permissions.includes("expose_capability"));
    if (selected.length > 32) throw new CoreControlError("too_large");
    const targets: ControlTarget[] = [];
    for (const device of selected) {
      const inspected = await session.inspect(device.id, signal); session.current();
      const target = normalizeControlTarget(inspected.id, inspected.name ?? inspected.id, inspected.manifest);
      if (target) targets.push(target);
    }
    await gate.authorize(); gate.current();
    // Return no stale grant if discovery crossed a manifest/pairing change.
    for (const target of targets) {
      const inspected = await session.inspect(target.device_id.slice(7), signal); session.current();
      const after = normalizeControlTarget(inspected.id, inspected.name ?? inspected.id, inspected.manifest);
      if (JSON.stringify(after) !== JSON.stringify(target)) throw new CoreControlError("permission_denied");
    }
    session.current(); const final = await conn!.request({ op: "device.list" }); session.current();
    if (!Array.isArray(final.devices) || final.devices.length > 256) throw new CoreControlError("invalid");
    const finalDevices = final.devices;
    if (targets.some(target => !finalDevices.some((device: any) => device && `device:${device.id}` === target.device_id && !device.revoked && device.online && Array.isArray(device.permissions) && device.permissions.includes("expose_capability")))) throw new CoreControlError("permission_denied");
    this.observePairing(finalDevices); gate.current(); session.current();
    return targets;
  }

  /** Control is a fixed owner transport, independent of borrowed model capabilities. */
  private controlSession(signal: AbortSignal): CoreControlSession {
    const conn = this.conn, epoch = this.epoch, authorityGeneration = this.authorityGeneration;
    const current = () => {
      if (signal.aborted) throw new CoreControlError("cancelled");
      if (this.authorityGeneration !== authorityGeneration) throw new CoreControlError("permission_denied");
      if (!conn || this.conn !== conn || epoch !== this.epoch || !this.connected || this.stopped) throw new CoreControlError("offline");
    };
    const paired = async (id: string) => {
      current(); const list = await conn!.request({ op: "device.list" }); current();
      if (!Array.isArray(list.devices) || list.devices.length > 256) throw new CoreControlError("invalid");
      this.observePairing(list.devices); current();
      const device = list.devices.find((d: any) => d && d.id === id);
      if (!device || device.revoked || !Array.isArray(device.permissions) || !device.permissions.includes("expose_capability")) throw new CoreControlError("permission_denied");
      if (!device.online) throw new CoreControlError("offline");
      return device;
    };
    current();
    return {
      current,
      inspect: async id => {
        const device = await paired(id);
        current();
        const response = await this.requestDevice(id, "GET", "/ash/manifest", undefined, 30_000, signal, CONTROL_INPUT_BYTES);
        current();
        if (response.status !== 200) throw new CoreControlError("offline");
        let manifest: unknown; try { manifest = JSON.parse(response.body.toString("utf8")); } catch { throw new CoreControlError("invalid"); }
        // The manifest await must not mask a pairing revocation.
        const final = await paired(id); current();
        return { id, name: String(final.name ?? device.name ?? id), online: true, revoked: false, permissions: final.permissions, manifest };
      },
      exchange: async (id, call) => {
        current();
        const response = await this.requestDevice(id, "POST", "/ash/call", call, 30_000, signal, CONTROL_OUTPUT_BYTES);
        current(); return response;
      },
    };
  }

  /** Independent manifest discovery; read grants do not gate create targets. */
  private async collaborationCreateEndpoints(signal: AbortSignal, gate: CreateReturnGate): Promise<CreateTarget[]> {
    const session = this.createSession(signal), conn = this.conn;
    gate.bindDeviceFence(session.current);
    gate.current();
    session.current(); const response = await conn!.request({ op: "device.list" }); session.current();
    if (!Array.isArray(response.devices) || response.devices.length > 256) throw new CoreCreateError("invalid");
    const selected = response.devices.filter((device: any) => device && typeof device.id === "string" && /^[A-Za-z0-9_-]+$/.test(device.id) && !device.revoked && device.online && Array.isArray(device.permissions) && device.permissions.includes("expose_capability"));
    if (selected.length > 32) throw new CoreCreateError("too_large");
    const targets: CreateTarget[] = [];
    for (const device of selected) {
      const inspected = await session.inspect(device.id, signal); session.current();
      const target = normalizeCreateTarget(inspected.id, inspected.name ?? inspected.id, inspected.manifest);
      if (target) targets.push(target);
    }
    await gate.authorize(); gate.current();
    // Return no stale grant if discovery crossed a manifest/pairing change.
    for (const target of targets) {
      const inspected = await session.inspect(target.device_id.slice(7), signal); session.current();
      const after = normalizeCreateTarget(inspected.id, inspected.name ?? inspected.id, inspected.manifest);
      if (JSON.stringify(after) !== JSON.stringify(target)) throw new CoreCreateError("permission_denied");
    }
    session.current(); const final = await conn!.request({ op: "device.list" }); session.current();
    if (!Array.isArray(final.devices) || final.devices.length > 256) throw new CoreCreateError("invalid");
    const finalDevices = final.devices;
    if (targets.some(target => !finalDevices.some((device: any) => device && `device:${device.id}` === target.device_id && !device.revoked && device.online && Array.isArray(device.permissions) && device.permissions.includes("expose_capability")))) throw new CoreCreateError("permission_denied");
    this.observePairing(finalDevices); gate.current(); session.current();
    return targets;
  }

  /** Create is a fixed owner transport, independent of borrowed model capabilities. */
  private createSession(signal: AbortSignal): CoreCreateSession {
    const conn = this.conn, epoch = this.epoch, authorityGeneration = this.authorityGeneration;
    const current = () => {
      if (signal.aborted) throw new CoreCreateError("cancelled");
      if (this.authorityGeneration !== authorityGeneration) throw new CoreCreateError("permission_denied");
      if (!conn || this.conn !== conn || epoch !== this.epoch || !this.connected || this.stopped) throw new CoreCreateError("offline");
    };
    const paired = async (id: string) => {
      current(); const list = await conn!.request({ op: "device.list" }); current();
      if (!Array.isArray(list.devices) || list.devices.length > 256) throw new CoreCreateError("invalid");
      this.observePairing(list.devices); current();
      const device = list.devices.find((d: any) => d && d.id === id);
      if (!device || device.revoked || !Array.isArray(device.permissions) || !device.permissions.includes("expose_capability")) throw new CoreCreateError("permission_denied");
      if (!device.online) throw new CoreCreateError("offline");
      return device;
    };
    current();
    return {
      current,
      inspect: async id => {
        const device = await paired(id);
        current();
        const response = await this.requestDevice(id, "GET", "/ash/manifest", undefined, 30_000, signal, CREATE_INPUT_BYTES);
        current();
        if (response.status !== 200) throw new CoreCreateError("offline");
        let manifest: unknown; try { manifest = JSON.parse(response.body.toString("utf8")); } catch { throw new CoreCreateError("invalid"); }
        // The manifest await must not mask a pairing revocation.
        const final = await paired(id); current();
        return { id, name: String(final.name ?? device.name ?? id), online: true, revoked: false, permissions: final.permissions, manifest };
      },
      exchange: async (id, call) => {
        current();
        const response = await this.requestDevice(id, "POST", "/ash/call", call, 30_000, signal, CREATE_OUTPUT_BYTES);
        current(); return response;
      },
    };
  }

  /** Fresh transport facts, never cached capability/online claims, authorize these reads. */
  private collaborationSession(signal: AbortSignal) {
    const conn = this.conn, epoch = this.epoch;
    const manifests = new Map<string, string>();
    const current = () => {
      if (signal.aborted) throw new CoreReadError("cancelled");
      if (!conn || this.conn !== conn || epoch !== this.epoch || !this.connected || this.stopped) throw new CoreReadError("offline");
    };
    current();
    const devices = async () => {
      current(); const response = await conn!.request({ op: "device.list" }); current();
      if (!Array.isArray(response.devices) || response.devices.length > 256) throw new CoreReadError("invalid");
      return response.devices as { id: string; name?: string; online?: boolean; revoked?: boolean; permissions?: string[] }[];
    };
    const target = async (id: string): Promise<ReadTarget> => {
      const list = await devices(), device = list.find(d => d.id === id && !d.revoked);
      if (!device?.permissions?.includes("expose_capability")) throw new CoreReadError("permission_denied");
      if (!device.online) throw new CoreReadError("offline");
      current();
      const response = await this.requestDevice(id, "GET", "/ash/manifest", undefined, 30_000, signal, READ_INPUT_BYTES);
      current();
      if (response.status !== 200) throw new CoreReadError("offline");
      let manifest: unknown; try { manifest = JSON.parse(response.body.toString("utf8")); } catch { throw new CoreReadError("invalid"); }
      const target = normalizeReadTarget(id, String(device.name ?? id), manifest);
      if (!target) throw new CoreReadError("unsupported");
      manifests.set(id, JSON.stringify(manifest));
      return target;
    };
    return { current, devices, target, manifests };
  }
  async collaborationEndpoints(signal: AbortSignal): Promise<ReadTarget[]> {
    const session = this.collaborationSession(signal), list = await session.devices();
    const selected = list.filter(d => !d.revoked && d.online && d.permissions?.includes("expose_capability") && /^[A-Za-z0-9_-]+$/.test(d.id));
    if (selected.length > 32) throw new CoreReadError("too_large");
    const targets: ReadTarget[] = [];
    for (const device of selected) {
      try { targets.push(await session.target(device.id)); }
      catch (error) { session.current(); if (!(error instanceof CoreReadError) || error.code !== "unsupported") throw error; }
    }
    // Recheck pairing after manifest discovery, so revoked entries are never returned.
    const final = await session.devices();
    if (targets.some(t => !final.some(d => `device:${d.id}` === t.device_id && !d.revoked && d.online && d.permissions?.includes("expose_capability")))) throw new CoreReadError("permission_denied");
    return targets;
  }
  async collaborationRead(input: ReadInput, signal: AbortSignal) {
    try {
      const session = this.collaborationSession(signal), id = input.device_id.slice(7), target = await session.target(id);
      const manifest = session.manifests.get(id);
      if (target.endpoint_id !== input.endpoint_id || target.authorization_generation !== input.authorization_generation || target.authorization_revision !== input.authorization_revision || target.authorization_state !== "ready" || !target.actions.includes(input.action)) throw new CoreReadError("permission_denied");
      const response = await this.requestDevice(id, "POST", "/ash/call", { capability: READ_CAPABILITIES[input.action], caller: "person:owner", args: { version: 1, endpoint_id: target.endpoint_id, authorization_revision: target.authorization_revision, ...(input.page ? { page: input.page } : {}), ...(input.work ? { work: input.work } : {}) } }, 30_000, signal, READ_OUTPUT_BYTES);
      session.current();
      if (response.status !== 200) throw new CoreReadError("offline");
      let answer: any; try { answer = JSON.parse(response.body.toString("utf8")); } catch { throw new CoreReadError("invalid"); }
      if (!answer || typeof answer.ok !== "boolean" || !Array.isArray(answer.content) || answer.content.length !== 0) throw new CoreReadError("invalid");
      if (!answer.ok) {
        const code = answer.data?.code;
        throw new CoreReadError(["permission_denied", "unsupported", "not_found", "invalid", "offline", "timeout", "cancelled", "too_large"].includes(code) ? code : "offline");
      }
      const page = validateReadPage(answer.data, input);
      const after = await session.target(id);
      if (JSON.stringify(after) !== JSON.stringify(target) || session.manifests.get(id) !== manifest) throw new CoreReadError("permission_denied");
      const final = await session.devices();
      if (!final.some(d => d.id === id && !d.revoked && d.online && d.permissions?.includes("expose_capability"))) throw new CoreReadError("permission_denied");
      return { target, page };
    } catch (error) {
      if (error instanceof CoreReadError) throw error;
      // Transport failures use a fixed local vocabulary; source messages are never echoed.
      const message = error instanceof Error ? error.message : "";
      throw new CoreReadError(message === "too_large" ? "too_large" : message === "cancelled" ? "cancelled" : message === "device timeout" ? "timeout" : "offline");
    }
  }
  /** One snapshot lease captures one connection, never reused by another operation. */
  async beginResultSnapshot(input:ReadInput,signal:AbortSignal){
    const session=this.collaborationSession(signal),generation=this.authorityGeneration,id=input.device_id.slice(7),target=await session.target(id),manifest=session.manifests.get(id);
    const current=()=>{session.current();if(generation!==this.authorityGeneration)throw new CoreReadError('permission_denied');};current();
    if(target.authorization_state!=='ready'||target.authorization_generation!==input.authorization_generation||target.authorization_revision!==input.authorization_revision||target.endpoint_id!==input.endpoint_id)throw new CoreReadError('permission_denied');
    let raw:any;try{raw=JSON.parse(manifest!);}catch{throw new CoreReadError('invalid');}
    if(!raw.capabilities?.some((c:any)=>c.name==='collaboration.result.read_chunk'))throw new CoreReadError('unsupported');
    return {call:async(args:Record<string,unknown>)=>{current();const response=await this.requestDevice(id,'POST','/ash/call',{capability:'collaboration.result.read_chunk',caller:'person:owner',args},30000,signal,65536);current();let answer:any;try{answer=JSON.parse(response.body.toString());}catch{throw new CoreReadError('invalid');}
      if(response.status!==200||answer?.ok!==true||!Array.isArray(answer.content)||answer.content.length)throw new CoreReadError(['permission_denied','expired','not_found','too_large','invalid','conflict'].includes(answer?.data?.code)?answer.data.code:'offline');return answer.data;},
      finish:async()=>{current();const after=await session.target(id);current();if(JSON.stringify(after)!==JSON.stringify(target)||session.manifests.get(id)!==manifest)throw new CoreReadError('permission_denied');const devices=await session.devices();current();if(!devices.some(d=>d.id===id&&!d.revoked&&d.online&&d.permissions?.includes('expose_capability')))throw new CoreReadError('permission_denied');}};
  }
  async resultCall(input: ReadInput, capability: 'collaboration.result.prepare'|'collaboration.result.read_chunk', args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const session=this.collaborationSession(signal), id=input.device_id.slice(7), target=await session.target(id), manifest=session.manifests.get(id);
    if(target.authorization_state!=='ready'||target.authorization_generation!==input.authorization_generation||target.authorization_revision!==input.authorization_revision||target.endpoint_id!==input.endpoint_id)throw new CoreReadError('permission_denied');
    let raw:any;try{raw=JSON.parse(manifest!);}catch{throw new CoreReadError('invalid');}
    if(!raw.capabilities?.some((c:any)=>c.name===capability))throw new CoreReadError('unsupported');
    const response=await this.requestDevice(id,'POST','/ash/call',{capability,caller:'person:owner',args},30000,signal,65536);session.current();
    let answer:any;try{answer=JSON.parse(response.body.toString());}catch{throw new CoreReadError('invalid');}
    if(response.status!==200||answer?.ok!==true||!Array.isArray(answer.content)||answer.content.length)throw new CoreReadError(['permission_denied','expired','not_found','too_large','invalid','conflict'].includes(answer?.data?.code)?answer.data.code:'offline');
    const after=await session.target(id);if(JSON.stringify(after)!==JSON.stringify(target)||session.manifests.get(id)!==manifest)throw new CoreReadError('permission_denied');
    const devices=await session.devices();if(!devices.some(d=>d.id===id&&!d.revoked&&d.online&&d.permissions?.includes('expose_capability')))throw new CoreReadError('permission_denied');
    return answer.data;
  }
  async ticket(): Promise<{ ticket: string; expires_in: number; gateway: string }> { return { ticket: await this.gateway.createPairTicket(this.requireConnection()), expires_in: 300, gateway: this.gateway.origin }; }
  async approve(requestId: string, permissions: Permission[]): Promise<void> {
    const item = this.pending.get(requestId); if (!item) throw new Error("unknown pairing request");
    const list = await this.requireConnection().request({ op: "device.list" });
    const version = Number(list.grant_version) + 1;
    const safe = permissions.filter((permission) => (PERMISSIONS as readonly string[]).includes(permission));
    this.authorityGeneration++;this.invalidateMaterial();
    await this.gateway.approve(this.requireConnection(), item, safe, version);
    this.pending.delete(requestId);
  }
  async reject(requestId: string): Promise<void> { await this.requireConnection().request({ op: "pair.reject", request_id: requestId }); this.pending.delete(requestId); }
  async revoke(member: string): Promise<void> {
    this.authorityGeneration++;this.invalidateMaterial();
    const list = await this.requireConnection().request({ op: "device.list" });
    await this.gateway.revoke(this.requireConnection(), member.replace(/^device:/, ""), Number(list.grant_version) + 1);
  }
  async setWebUi(member: string, allow: boolean): Promise<void> {
    this.authorityGeneration++;this.invalidateMaterial();
    const id = member.replace(/^device:/, ""), conn = this.requireConnection();
    const list = await conn.request({ op: "device.list" });
    const item = (list.devices as { id: string; revoked: boolean; permissions: Permission[] }[]).find(d => d.id === id && !d.revoked);
    if (!item) throw new Error("unknown device");
    const permissions: Permission[] = item.permissions.filter(p => p !== "web_ui" && p !== "chat");
    if (allow) permissions.push("web_ui", "chat");
    await this.gateway.permissions(conn, id, permissions, Number(list.grant_version) + 1);
    await this.revalidateStreams(); await this.refreshDevices();
  }
  /** The owner-facing reason the gateway is not usable now, or undefined while connected. */
  private error(): GatewayProblem | undefined {
    if (this.problem) return this.problem;
    return this.connected || !this.lastError ? undefined : gatewayProblem(new Error(this.lastError));
  }
  state(): Record<string, unknown> { return { connected: this.connected, error: this.error(),
    pending: [...this.pending.values()],
    devices: this.paired.map((item) => ({ id: `device:${item.id}`, name: item.name, online: this.remoteDevices.get(item.id)?.member.online ?? item.online,
      permissions: item.permissions, lends: this.remoteDevices.has(item.id), capabilities: this.remoteDevices.get(item.id)?.member.capabilities().length ?? 0,
      capability_specs: this.remoteDevices.get(item.id)?.member.capabilities().map(c => ({ word: c.name, effect: c.effect, label: c.label })) ?? [],
      ...this.remoteDevices.get(item.id)?.details })) }; }
  async updateDevice(member: string, version: string, sha256: string): Promise<unknown> {
    const id = member.replace(/^device:/, "");
    if (!this.paired.some(item => item.id === id && item.online && item.permissions.includes("expose_capability"))) throw new Error("Device offline or revoked");
    const response = await this.requestDevice(id, "POST", "/ash/update", { version, sha256 }, 180_000);
    const result = JSON.parse(response.body.toString("utf8"));
    if (response.status !== 200 || !result.ok) throw new Error(String(result.error ?? "Device update failed"));
    return result.result;
  }
}
