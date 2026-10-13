import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Connection, DeviceKey, GatewayClient, GatewayError } from "ash-gateway/client/client";
import { b64u, fromB64u, LIMITS, shortFingerprint } from "ash-gateway/src/protocol";
import type { CallResult, CapabilitySpec, DeviceKind } from "../../sdk/src/api";
import type { TrustedCallContext } from "./collaboration/authorization";
import { isCollaborationCapability, controlOperation, createOperation } from "./collaboration/capabilities";
import { loadCurrentPairing, parseCurrentPairing } from "./collaboration/pairing";
import { LocalStateTransaction, type LocalStateObservation } from "./collaboration/local-state-transaction";
import { CONTROL_INPUT_MAX_BYTES, CONTROL_OUTPUT_MAX_BYTES } from "./collaboration/control-protocol";
import {deviceIdForKey} from 'ash-gateway/src/protocol';
import {MaterialProtocolError} from './collaboration/material-types';
import {MaterialClient,MATERIAL_REQUEST_TYPE,MATERIAL_RESPONSE_TYPE,relayFrame,relayRecord,type MaterialRelayTransport} from './collaboration/material-client';
import {MATERIAL_PROVIDER_REQUEST_TYPE,MATERIAL_PROVIDER_RESPONSE_TYPE} from './collaboration/material-provider-protocol';
import {MATERIAL_IDENTITY_TYPE,MaterialLinkWork} from './collaboration/material-link-bindings';
export interface Signer { readonly id: string; readonly publicKey: string; sign(data: Uint8Array): Promise<string> }


export type TunnelResponse = { status: number; headers?: Record<string, string>; body?: string | Buffer } |
  { status: number; headers?: Record<string, string>; stream: (write: (chunk: string) => void, onClose: (fn: () => void) => void, end: () => void) => void };
type EdgeResponse = TunnelResponse;
interface Inbound { method: string; path: string; headers: [string, string][]; body: Uint8Array[]; from?: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Each step of reaching the gateway gets this long; on a slow mobile network a request can otherwise hang for minutes. */
export const STEP_MS = 20_000;
/**
 * [work], or a timeout error after [ms]. What arrives late is handed to [late] (a connection is closed there), so a
 * stalled request never holds up the next attempt.
 */
export function bounded<T>(work: Promise<T>, ms: number, what: string, late?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error(`timeout: ${what} took over ${ms / 1000}s`)); }, ms); });
  work.then((value) => { if (timedOut) late?.(value); }, () => {});
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
export async function fileSigner(stateDir: string): Promise<Signer> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, "device.jwk");
  if (existsSync(file)) return DeviceKey.fromJwk(JSON.parse(readFileSync(file, "utf8")));
  const key = await DeviceKey.generate();
  writeFileSync(file, JSON.stringify(await key.exportJwk()), { mode: 0o600 });
  return key;
}


export interface SetupConnectionProof {readonly kind:'setup-current-connection';}
const setupConnections=new WeakMap<object,()=>undefined>();
export function currentSetupConnectionProof(proof:SetupConnectionProof):undefined{const current=setupConnections.get(proof);if(!current)throw new Error('Setup connection is unavailable');return current();}

export abstract class Link {
  protected conn: Connection | null = null;
  protected readonly gateway: GatewayClient;
  protected stopped = false;
  protected setupConnectionReady = false;
  connected = false;
  lastError = "";
  constructor(url: string, readonly signer: Signer, protected readonly log: (...args: unknown[]) => void) {
    this.gateway = new GatewayClient(url, signer as unknown as DeviceKey);
  }
  protected send(frame: Record<string, unknown>): void {
    if (this.conn?.ws.readyState === WebSocket.OPEN) this.conn.ws.send(JSON.stringify(frame));
  }
  protected abstract onFrame(frame: Record<string, unknown>): void;
  protected async onConnected(_conn: Connection): Promise<void> {}
  protected onDisconnected(): void {}
  protected onAttempt(): void {}
  protected onRevoked(): boolean { return true; }
  async run(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      let beat: ReturnType<typeof setInterval> | undefined;
      try {
        this.setupConnectionReady=false;this.onAttempt();
        const health = await bounded(this.gateway.health(), STEP_MS, "gateway health");
        if (health.protocol !== "ash-gw/1") { this.stopped = true; throw new Error("Unsupported gateway protocol"); }
        const session = await bounded(this.gateway.authenticate(), STEP_MS, "gateway sign-in");
        const conn = await bounded(this.gateway.connect(session), STEP_MS, "gateway connection", (late) => late.close());
        this.conn = conn; this.connected = true; this.lastError = ""; delay = 1000;
        conn.onUnmatched = (frame) => { if (this.conn === conn && conn.ws.readyState === WebSocket.OPEN) this.onFrame(frame); };
        let lastHeard = Date.now();
        let expired!: () => void;
        const silent = new Promise<void>((resolve) => { expired = resolve; });
        conn.ws.addEventListener("message", () => { lastHeard = Date.now(); });
        beat = setInterval(() => {
          if (conn.ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastHeard > 90_000) { conn.ws.close(4000, "silent"); expired(); }
          else conn.ws.send("ping");
        }, 30_000);
        await bounded(this.onConnected(conn), STEP_MS * 3, "gateway first sync");
        if(this.stopped||this.conn!==conn||conn.ws.readyState!==WebSocket.OPEN)throw new Error("Connection ended during first sync");
        this.setupConnectionReady=true;
        const closed = await Promise.race([conn.closed, silent]);
        if (closed && closed.code === 4003 && this.onRevoked()) { this.stopped = true; this.lastError = "Device revoked"; }
      } catch (error) {
        this.conn?.close(); this.lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof GatewayError && /revoked/i.test(error.message) && this.onRevoked()) this.stopped = true;
        this.log("gateway connection failed", this.lastError);
      } finally { if (beat) clearInterval(beat); }
      this.setupConnectionReady=false;this.connected = false; this.conn = null; this.onDisconnected();
      if (this.stopped) break;
      await sleep(delay * (0.5 + Math.random() / 2)); delay = Math.min(delay * 2, 30_000);
    }
  }
  stop(): void { this.setupConnectionReady=false;this.stopped = true; this.conn?.close(); }
  protected reply(sid: string, result: EdgeResponse, onStream?: (end: () => void) => () => void): void {
    const headers = Object.entries(result.headers ?? {}).filter(([name]) => !/^(set-cookie|content-length|content-encoding|transfer-encoding|connection)$/i.test(name));
    this.send({ t: "tun", op: "http.head", sid, status: result.status, headers });
    const data = (value: Uint8Array) => {
      for (let i = 0; i < value.length; i += LIMITS.tunnelChunkBytes) this.send({ t: "tun", op: "http.body", sid, data: b64u(new Uint8Array(value.subarray(i, i + LIMITS.tunnelChunkBytes))) });
    };
    if ("stream" in result) {
      let ended = false; const cleanups: (() => void)[] = [];
      const end = () => { if (ended) return; ended = true; for (const cleanup of cleanups) cleanup(); this.send({ t: "tun", op: "http.end", sid }); };
      const timeout = setTimeout(end, 4 * 60_000);
      cleanups.push(() => clearTimeout(timeout));
      const unregister = onStream?.(end);
      if (unregister) cleanups.push(unregister);
      result.stream((chunk) => { if (!ended) data(Buffer.from(chunk)); }, (cleanup) => cleanups.push(cleanup), end);
      return;
    }
    if (result.body !== undefined) data(typeof result.body === "string" ? Buffer.from(result.body) : result.body);
    this.send({ t: "tun", op: "http.end", sid });
  }
}


export interface LocalCapabilities {
  manifest(context?: TrustedCallContext): Promise<{ protocol?: string; version?: string; name: string; kind: DeviceKind; capabilities: CapabilitySpec[]; agents?: unknown[] }>;
  call(capability: string, args: Record<string, unknown>, caller: string, signal?: AbortSignal, context?: TrustedCallContext): Promise<CallResult>;
  collaborationDisconnected?(): void;
  stream?(stream: import("ash-gateway/client/client").DeviceStream): void;
  update?(version: string, sha256: string): Promise<unknown>;
}

/** Client role retains the existing gateway manifest/call protocol. */
export class ClientLink extends Link {
  readonly materialWork=new MaterialLinkWork();private materialClient?:MaterialClient;private materialReceiver?:{acceptFrame(frame:unknown):Promise<boolean>;invalidate():void;busy:number;connected?():Promise<void>};
  attachMaterialReceiver(receiver:{acceptFrame(frame:unknown):Promise<boolean>;invalidate():void;busy:number;connected?():Promise<void>}):void{if(this.materialReceiver)throw new Error('material receiver already attached');this.materialReceiver=receiver;}
  createMaterialClient():MaterialClient{if(!this.materialClient)this.materialClient=new MaterialClient({gateway:this.gateway,transport:this.materialTransport(),observeUnfinished:this.materialWork.observeUnfinished});return this.materialClient;}
  materialTransport():MaterialRelayTransport{return {capture:async()=>{const state=this.stateTransaction,conn=this.conn,epoch=this.transportEpoch;this.materialWork.current();if(!state||!conn||this.stopped||!this.connected)throw new MaterialProtocolError('offline');const token=state.capture(),raw=token.files['paired.json']?.raw,pair=raw?parseCurrentPairing(raw):null;if(!pair||pair.revoked)throw new MaterialProtocolError('permission_denied');const key=JSON.parse(raw!).owner_key;if(await deviceIdForKey(key)!==pair.ownerId)throw new MaterialProtocolError('permission_denied');state.assertCurrent(token);if(epoch!==this.transportEpoch||this.stateTransaction!==state||this.conn!==conn||this.stopped||!this.connected)throw new MaterialProtocolError('offline');return Object.freeze({local_id:this.signer.id,peer_id:pair.ownerId,public_key:key,pairing_id:`material:${pair.ownerId}:${this.signer.id}`,generation:`${epoch}:${token.epoch}:${token.revision}`});},current:peer=>{const state=this.stateTransaction,conn=this.conn;if(!state||!conn||this.stopped||!this.connected||peer.local_id!==this.signer.id)throw new MaterialProtocolError('permission_denied');const token=state.capture(),raw=token.files['paired.json']?.raw,pair=raw?parseCurrentPairing(raw):null;if(peer.generation!==`${this.transportEpoch}:${token.epoch}:${token.revision}`||!pair||pair.revoked||pair.ownerId!==peer.peer_id||JSON.parse(raw!).owner_key!==peer.public_key)throw new MaterialProtocolError('permission_denied');return undefined;},send:envelope=>{this.materialWork.current();const token=this.stateTransaction?.capture(),raw=token?.files['paired.json']?.raw,pair=raw?parseCurrentPairing(raw):null;if(!this.conn||this.stopped||!this.connected||envelope.from!==this.signer.id||!pair||pair.revoked||envelope.to!==pair.ownerId)throw new MaterialProtocolError('offline');this.conn.send(envelope);return undefined;}};}
  private invalidateMaterial():void{this.materialClient?.invalidate();this.materialReceiver?.invalidate();}
  private async sendMaterialIdentity():Promise<void>{const transport=this.materialTransport(),peer=await transport.capture();transport.current(peer);const envelope=await this.gateway.envelope(MATERIAL_IDENTITY_TYPE,peer.peer_id,{version:1,public_key:this.signer.publicKey},{ttlMs:29999});transport.current(peer);transport.send(envelope);}
  private async materialIdentity(frame:Record<string,unknown>):Promise<void>{const transport=this.materialTransport(),peer=await transport.capture();transport.current(peer);const envelope=relayFrame(frame,MATERIAL_IDENTITY_TYPE,Date.now()),body=relayRecord(JSON.parse(envelope.payload),['version','public_key']);if(envelope.to!==peer.local_id||envelope.from!==peer.peer_id||body.version!==1||body.public_key!==peer.public_key)throw new MaterialProtocolError('permission_denied');if(!await GatewayClient.verifyEnvelope(envelope,peer.public_key))throw new MaterialProtocolError('permission_denied');transport.current(peer);relayFrame(envelope,MATERIAL_IDENTITY_TYPE,Date.now());if(envelope.reply_to===null){const response=await this.gateway.envelope(MATERIAL_IDENTITY_TYPE,peer.peer_id,{version:1,public_key:this.signer.publicKey},{ttlMs:Math.max(1,envelope.expires_at-Date.now()-1),replyTo:envelope.message_id});transport.current(peer);transport.send(response);}}
  /** Read-only private proof issued only after actual gateway authentication and first sync. */
  captureSetupConnection():SetupConnectionProof{const state=this.stateTransaction,conn=this.conn;if(!state||!conn||!this.setupConnectionReady||this.stopped||!this.connected||conn.ws.readyState!==WebSocket.OPEN)throw new Error('Setup connection is unavailable');const original=this.revocationBinding,token=state.capture(),epoch=this.transportEpoch;if(!original||original.files['paired.json']?.identity!==token.files['paired.json']?.identity)throw new Error('Setup pairing is unavailable');const raw=token.files['paired.json']?.raw,pair=raw?parseCurrentPairing(raw):null;if(!pair||pair.revoked)throw new Error('Setup pairing is unavailable');const proof=Object.freeze({kind:'setup-current-connection' as const});setupConnections.set(proof,()=>{const current=state.capture();if(current.files['paired.json']?.identity!==token.files['paired.json']?.identity)throw new Error('Setup pairing is stale');if(this.stateTransaction!==state||this.conn!==conn||this.transportEpoch!==epoch||!this.setupConnectionReady||this.stopped||!this.connected||conn.ws.readyState!==WebSocket.OPEN)throw new Error('Setup connection is stale');return undefined;});currentSetupConnectionProof(proof);return proof;}
  /** Read settings retain the actual paired connection, not an unrelated grant
   * epoch. Source/scope transactions separately retain their exact state receipt. */
  captureReadSetupConnection():SetupConnectionProof{
    const state=this.stateTransaction,conn=this.conn;
    if(!state||!conn||!this.setupConnectionReady||this.stopped||!this.connected||conn.ws.readyState!==WebSocket.OPEN)throw Error('Read setup connection is unavailable');
    const token=state.capture(),identity=token.files['paired.json']?.identity,raw=token.files['paired.json']?.raw,pair=raw?parseCurrentPairing(raw):null;
    if(!identity||!pair||pair.revoked||!this.revocationBinding||this.revocationBinding.files['paired.json']?.identity!==identity)throw Error('Read setup pairing is unavailable');
    const proof=Object.freeze({kind:'setup-current-connection' as const});
    setupConnections.set(proof,()=>{if(this.stateTransaction!==state||this.conn!==conn||!this.setupConnectionReady||this.stopped||!this.connected||conn.ws.readyState!==WebSocket.OPEN||state.capture().files['paired.json']?.identity!==identity)throw Error('Read setup connection is stale');return undefined;});
    currentSetupConnectionProof(proof);return proof;
  }

  get materialBusy():number{return this.materialWork.busy+(this.materialReceiver?.busy??0)+(this.materialClient?.inflight??0);}
  private readonly incoming = new Map<string, Inbound>();
  private readonly calls = new Map<string, AbortController>();
  private pairFile?: string;
  private transportEpoch = 0;
  private stateTransaction?: LocalStateTransaction;
  private revocationBinding?: LocalStateObservation;
  protected override onAttempt(): void {
    this.revocationBinding = this.stateTransaction?.capture();
  }
  protected override async onConnected(conn: Connection): Promise<void> {
    if (!this.stateTransaction || !this.revocationBinding) throw new Error("Pairing is unavailable");
    this.stateTransaction.assertCurrent(this.revocationBinding);
    void this.materialWork.run(()=>this.sendMaterialIdentity()).catch(error=>this.log('material identity unavailable',error));
    if(this.materialReceiver?.connected)void this.materialWork.run(()=>this.materialReceiver!.connected!()).catch(error=>this.log('material receiver unavailable',error));
    conn.onStream(stream => this.local.stream ? this.local.stream(stream) : stream.close(4404, "Device agents unavailable"));
  }
  protected override onDisconnected(): void {
    this.transportEpoch++;this.invalidateMaterial();
    this.local.collaborationDisconnected?.();
    this.incoming.clear();
    for (const call of this.calls.values()) call.abort();
    this.calls.clear();
  }
  protected override onRevoked(): boolean {
    try {
      const binding = this.revocationBinding, transaction = this.stateTransaction;
      const original = binding?.files["paired.json"], pairing = original ? parseCurrentPairing(original.raw) : null;
      if (!binding || !transaction || !pairing || pairing.revoked) return false;
      transaction.write("paired.json", JSON.stringify({ ...JSON.parse(pairing.fingerprint), revoked: true }) + "\n", binding);
      return true;
    } catch { return false; /* A late revoke never writes a replacement owner's pairing. */ }
    finally { this.onDisconnected(); }
  }
  override stop(): void {
    this.materialWork.stop();this.materialClient?.close();super.stop(); this.onDisconnected(); this.stateTransaction?.close();
  }
  constructor(url: string, signer: Signer, private readonly local: LocalCapabilities, log: (...args: unknown[]) => void) { super(url, signer, log); }
  async pair(stateDir: string, code: string | undefined, name: string): Promise<void> {
    this.stateTransaction?.close();
    const transaction = new LocalStateTransaction(stateDir, () => { this.transportEpoch++;this.invalidateMaterial(); this.local.collaborationDisconnected?.(); });
    this.stateTransaction = transaction;
    this.pairFile = join(transaction.stateDir, "paired.json");
    const prepared = transaction.capture(); // Capture before requestPairing/approval/fingerprint awaits.
    this.revocationBinding = prepared;
    this.transportEpoch++;this.invalidateMaterial(); this.local.collaborationDisconnected?.();
    if (!code) {
      const file = prepared.files["paired.json"], pairing = file ? parseCurrentPairing(file.raw) : null;
      if (!file) throw new Error("not paired: use --pair once");
      if (!pairing) throw new Error("Invalid local pairing");
      if (pairing.revoked) throw new Error("Device revoked; explicitly pair again to reconnect");
      return;
    }
    const request = await this.gateway.requestPairing(code, name);
    this.log("pairing requested", await shortFingerprint(this.signer.publicKey), request.owner_fingerprint);
    const grant = await this.gateway.waitForApproval(request.request_id, request.owner_key, 10 * 60_000);
    const raw = JSON.stringify({ ...grant, owner_key: request.owner_key }) + "\n", pairing = parseCurrentPairing(raw);
    if (!pairing || pairing.revoked) throw new Error("Invalid approved pairing");
    if (this.stateTransaction !== transaction || this.stopped) throw new Error("Pairing changed");
    const committed = transaction.write("paired.json", raw, prepared);
    // An existing transport retains its original revoke binding until the next gateway attempt.
    if (!this.conn) this.revocationBinding = committed;
    this.transportEpoch++;this.invalidateMaterial(); this.local.collaborationDisconnected?.();
    this.conn?.close();
  }
  protected onFrame(frame: Record<string, unknown>): void {
    if(frame.type===MATERIAL_IDENTITY_TYPE||frame.type===MATERIAL_REQUEST_TYPE||frame.type===MATERIAL_RESPONSE_TYPE||frame.type===MATERIAL_PROVIDER_REQUEST_TYPE||frame.type===MATERIAL_PROVIDER_RESPONSE_TYPE){const captured=structuredClone(frame);void this.materialWork.run(async()=>{if(frame.type===MATERIAL_IDENTITY_TYPE)return this.materialIdentity(captured);if(this.materialReceiver&&await this.materialReceiver.acceptFrame(captured))return;await this.materialClient?.acceptFrame(captured);}).catch(error=>this.log('material relay unavailable',error));return;}
    if (frame.t !== "tun" || typeof frame.sid !== "string") return;
    const sid = frame.sid;
    if (frame.op === "http.abort") { this.incoming.delete(sid); this.calls.get(sid)?.abort(); return; }
    if (frame.op === "http.req") this.incoming.set(sid, { method: String(frame.method), path: String(frame.path), headers: (frame.headers as [string, string][]) ?? [], body: [], ...(typeof frame.from === "string" ? { from: frame.from } : {}) });
    else if (frame.op === "http.reqbody") {
      const inbound = this.incoming.get(sid);
      if (inbound) {
        inbound.body.push(fromB64u(String(frame.data)));
        if (inbound.body.reduce((n, b) => n + b.byteLength, 0) > 8 * 1024 * 1024) {
          this.incoming.delete(sid); this.reply(sid, { status: 413, body: "Request too large" });
        }
      }
    }
    else if (frame.op === "http.reqend") {
      const inbound = this.incoming.get(sid); this.incoming.delete(sid);
      if (inbound) {
        const controller = new AbortController(); this.calls.set(sid, controller);
        void this.serve(sid, inbound, controller.signal)
          .catch((error) => { if (!controller.signal.aborted) this.send({ t: "tun", op: "http.error", sid, message: error instanceof Error ? error.message : "client failed" }); })
          .finally(() => this.calls.delete(sid));
      }
    }
  }
  private async trustedContext(from?: string): Promise<TrustedCallContext | undefined> {
    if (!from || !this.stateTransaction || this.stopped) return undefined;
    const transaction = this.stateTransaction, conn = this.conn;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return undefined;
    try {
      const bound = transaction.capture(), file = bound.files["paired.json"], pairing = file ? parseCurrentPairing(file.raw) : null;
      // capture may synchronously observe a change and invalidate older transport contexts.
      // Bind this NEW context to the epoch after that observation, never to its predecessor.
      const epoch = this.transportEpoch;
      if (!pairing || pairing.revoked || pairing.ownerId !== from) return undefined;
      const context: TrustedCallContext = Object.freeze({ transportOwnerId: from, isCurrent: () => {
        try {
          if (this.stopped || this.stateTransaction !== transaction || this.conn !== conn || conn.ws.readyState !== WebSocket.OPEN || epoch !== this.transportEpoch) return false;
          transaction.assertCurrent(bound);
          return true;
        } catch { return false; }
      } });
      return context.isCurrent() ? context : undefined;
    } catch { return undefined; }
  }
  private async serve(sid: string, inbound: Inbound, signal: AbortSignal): Promise<void> {
    const path = inbound.path.split("?")[0];
    const json = (status: number, body: unknown): EdgeResponse => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
    if (inbound.method === "POST" && path === "/ash/update") {
      const input = JSON.parse(Buffer.concat(inbound.body).toString("utf8") || "{}");
      if (!this.local.update || typeof input.version !== "string" || !/^v?\d+\.\d+\.\d+$/.test(input.version) || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) return this.reply(sid, json(400, { ok: false, error: "Invalid approved update" }));
      try { return this.reply(sid, json(200, { ok: true, result: await this.local.update(input.version, input.sha256) })); }
      catch (error) { return this.reply(sid, json(409, { ok: false, error: error instanceof Error ? error.message : "Update failed" })); }
    }
    if (inbound.method === "GET" && path === "/ash/manifest") {
      const context = await this.trustedContext(inbound.from);
      const manifest = await this.local.manifest(context);
      if (context && !context.isCurrent()) return this.reply(sid, json(403, { error: "permission_denied" }));
      return this.reply(sid, json(200, { ...manifest, capabilities: manifest.capabilities.map((capability) => ({
        ...capability, risk: (controlOperation(capability.name) || createOperation(capability.name)) ? capability.risk : capability.risk === "none" ? "none" : "structure", label: `Use ${capability.name}`,
      })) }));
    }
    if (inbound.method === "POST" && path === "/ash/call") {
      let input: { capability?: string; args?: Record<string, unknown>; caller?: string };
      try { input = JSON.parse(Buffer.concat(inbound.body).toString("utf8") || "{}"); }
      catch { return this.reply(sid, json(400, { ok: false, content: [], error: "Invalid call", data: { code: "invalid" } })); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return this.reply(sid, json(400, { ok: false, content: [], error: "Invalid call", data: { code: "invalid" } }));
      if (typeof input.caller !== "string" || !/^(agent:[a-z][a-z0-9_-]{0,31}|person:owner)$/.test(input.caller)) return this.reply(sid, json(403, { error: "Invalid caller" }));
      const capability = String(input.capability ?? "");
      const collaboration = isCollaborationCapability(capability), control = controlOperation(capability) || createOperation(capability);
      if (control && input.caller !== "person:owner") return this.reply(sid, json(403, { ok: false, content: [], error: "Owner control is required", data: { code: "permission_denied" } }));
      if (control && inbound.body.reduce((sum, chunk) => sum + chunk.byteLength, 0) > CONTROL_INPUT_MAX_BYTES) return this.reply(sid, json(413, { ok: false, content: [], error: "Collaboration control: too_large", data: { code: "too_large" } }));
      const context = collaboration ? await this.trustedContext(inbound.from) : undefined;
      if (collaboration && !context) return this.reply(sid, json(403, { ok: false, content: [], error: "Trusted paired transport is required", data: { code: "permission_denied" } }));
      if (signal.aborted) return;
      let answer: CallResult;
      try { answer = await this.local.call(capability, input.args ?? {}, input.caller, signal, context); }
      catch (error) { if (!collaboration) throw error; answer = { ok: false, content: [], error: "Collaboration source unavailable", data: { code: "offline" } }; }
      if (control && Buffer.byteLength(JSON.stringify(answer)) > CONTROL_OUTPUT_MAX_BYTES) answer = { ok: false, content: [], error: "Collaboration control: too_large", data: { code: "too_large" } };
      if (!signal.aborted) this.reply(sid, json(200, collaboration && !context!.isCurrent() ? { ok: false, content: [], error: "Collaboration authorization changed", data: { code: "permission_denied" } } : answer));
      return;
    }
    this.reply(sid, json(404, { error: "not_found" }));
  }
}
