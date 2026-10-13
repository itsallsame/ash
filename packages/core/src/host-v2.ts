import {randomBytes,randomUUID} from 'node:crypto';
import {deviceIdForKey,verifySignature} from 'ash-gateway/src/protocol';
import type { CallResult } from "../../sdk/src/api";
import type { HostManifestV2 } from "../../sdk/src/host";
import { hostPresentationErrors, type HostPresentationV2 } from "../../sdk/src/host";
import { DeviceMember } from "./members/device";
import { isWordEffect } from "../../sdk/src/words";
import type { Signer } from "./gateway/link";
import type { DeviceCapability } from "./world/router";
import type { WorldMembers } from "./world/member";
import type { TaskStatusFrame } from "./task-status";
import type { WidgetState } from "./members/widgets";

export interface HostConnection { url: string; token: string }
/** Public coordinates only. Ownership is registered privately by the actual host instance. */
export interface HostSignerProof { readonly id:string;readonly publicKey:string;readonly generation:string }
const SIGNER_PROOF_MS=30000,SIGNER_RENEW_MS=15000;


/** Host I/O never passes through the retired v1 event writer. */
export class HostDeviceLink {
  private refresh: ReturnType<typeof setInterval> | null = null;
  private member: DeviceMember | null = null;
  private refreshEpoch = 0;
  private closed = false;
  readonly #config:Readonly<HostConnection>;
  readonly #instance=randomUUID();readonly #lifetime=new AbortController();
  #signer:Signer|undefined;#signerInitialization:Promise<Signer>|undefined;#signerEpoch=0;#proofExpires=0;#proofRefresh:Promise<void>|undefined;#proofTimer:ReturnType<typeof setTimeout>|undefined;
  readonly #proofs=new WeakMap<object,{signer:Signer;epoch:number}>();readonly #actual=new Set<Promise<unknown>>();#requests=0;
  private constructor(config: HostConnection, private currentManifest: HostManifestV2) {this.#config=Object.freeze({...config});}

  get manifest(): HostManifestV2 { return structuredClone(this.currentManifest); }

  private static validatedManifest(raw: unknown): HostManifestV2 {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("invalid host manifest");
    const manifest = raw as HostManifestV2;
    if (typeof manifest.name !== "string" || !manifest.name.trim() || !Array.isArray(manifest.capabilities)) throw new TypeError("invalid host manifest");
    for (const capability of manifest.capabilities) {
      if (!capability || typeof capability.name !== "string" || !capability.name.trim() || typeof capability.description !== "string" || !capability.description.trim() ||
        typeof capability.label !== "string" || !capability.label.trim() || !["none", "outward", "structure"].includes(capability.risk) ||
        !capability.input_schema || typeof capability.input_schema !== "object" || Array.isArray(capability.input_schema) ||
        (capability.effect !== undefined && !isWordEffect(capability.effect))) throw new TypeError("host capability lacks required v2 metadata");
    }
    return structuredClone(manifest);
  }

  static async probe(config: HostConnection): Promise<HostDeviceLink> {
    const fixed=Object.freeze({...config});
    const raw = await HostDeviceLink.request(fixed, "GET", "/manifest");
    return new HostDeviceLink(fixed, HostDeviceLink.validatedManifest(raw));
  }

  private static async request(config: HostConnection, method: string, path: string, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
    const encoded=body===undefined?undefined:JSON.stringify(body);if(encoded!==undefined&&Buffer.byteLength(encoded)>32*1024*1024)throw Error("host request too large");
    const result = await fetch(new URL(path, config.url), { method,redirect:"error",
      headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: encoded, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if (!result.ok) {await result.body?.cancel();throw new Error(`host ${path} failed (${result.status})`);}
    const maximum=path==="/key"||path==="/sign"?4096:path==="/manifest"?1024*1024:32*1024*1024;
    const reader=result.body?.getReader();if(!reader)throw Error("host response unavailable");const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>maximum)throw Error("host response too large");chunks.push(item.value);}return JSON.parse(Buffer.concat(chunks,size).toString("utf8"));}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  }
  private request(method:string,path:string,body?:unknown,timeoutMs?:number,signal?:AbortSignal):Promise<unknown>{const work=this.requestRaw(method,path,body,timeoutMs,signal);this.#actual.add(work);void work.finally(()=>this.#actual.delete(work)).catch(()=>{});return work;}
  private async requestRaw(method: string, path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    if(this.closed||this.#requests>=32)throw Error("device host unavailable");this.#requests++;
    try{const result=await HostDeviceLink.request(this.#config,method,path,body,timeoutMs,signal?AbortSignal.any([signal,this.#lifetime.signal]):this.#lifetime.signal);if(this.closed)throw Error("device host unavailable");return result;}catch(error){if(this.closed||!signal?.aborted||path==="/key"||path==="/sign")this.invalidateSignerProof();throw error;}finally{this.#requests--;}
  }

  device(): DeviceMember {
    if (this.closed) throw new Error("device host is closed");
    if (this.member) return this.member;
    const capabilities: DeviceCapability[] = this.currentManifest.capabilities.map((item) => ({ name: item.name, description: item.description, input_schema: item.input_schema, risk: item.risk, ...(item.effect ? { effect: item.effect } : {}), label: item.label }));
    const member = new DeviceMember("device:phone", this.currentManifest.name, capabilities, async (message, context) => {
      try {
        const result = await this.request("POST", "/call", { capability: message.word, args: message.body, caller: message.from, turn: message.turn }, 180_000, context.signal) as CallResult;
        if (!result || typeof result.ok !== "boolean") throw new Error("invalid host result");
        return result.ok ? { ok: true, result: { content: result.content, ...(result.data === undefined ? {} : { data: result.data }) } }
          : { ok: false, error: { code: "failed", message: result.error ?? "device call failed" } };
      } catch {
        if (!this.closed && this.member === member) member.setOnline(false);
        return { ok: false, error: { code: "offline", message: "device host unavailable" } };
      }
    });
    this.member = member;
    return member;
  }

  /** Invalid/partial updates leave the last snapshot describable but offline. */
  async refreshManifest(members: WorldMembers): Promise<void> {
    if (this.closed) return;
    const epoch = ++this.refreshEpoch;
    try {
      const next = HostDeviceLink.validatedManifest(await this.request("GET", "/manifest"));
      if (this.closed || epoch !== this.refreshEpoch) return;
      if (JSON.stringify(next) === JSON.stringify(this.currentManifest)) { this.member?.setOnline(true); return; }
      const old = this.member;
      const previousManifest = this.currentManifest;
      try {
        this.currentManifest = next;
        this.member = null;
        members.replaceDevice(this.device());
      } catch (error) {
        this.currentManifest = previousManifest;
        this.member = old;
        old?.setOnline(false);
        throw error;
      }
    } catch { this.invalidateSignerProof();if (!this.closed && epoch === this.refreshEpoch) this.member?.setOnline(false); }
  }

  startHealthChecks(members: WorldMembers): void {
    if (this.closed || this.refresh) return;
    this.refresh = setInterval(() => void this.refreshManifest(members), 60_000);
  }
  /** Narrow host controls used only by the local peripheral decision member. */
  async decisionCall(word: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("device host is closed");
    const paths: Record<string, string> = { "surface.get": "/decision/surface", "screen.get": "/decision/screen",
      "screen.return": "/decision/return", "virtual.close": "/decision/virtual-close" };
    if (!paths[word]) throw new Error("unknown decision host word");
    // Leave transport margin outside Android's bounded settling/main-thread acknowledgment.
    return this.request("POST", paths[word], body, word === "virtual.close" ? 9500 : word === "surface.get" ? 1500 : 2500, signal);
  }
  /** Confirm the Android host has replaced or cancelled its one core wake alarm. */
  async scheduleAlarm(at: number | null): Promise<void> {
    if (this.closed || (at !== null && (!Number.isSafeInteger(at) || at < 0))) throw new TypeError("invalid host alarm time");
    const result = await this.request("POST", "/alarm", { at }) as { ok?: unknown };
    if (!result || result.ok !== true) throw new Error("host alarm acknowledgement unavailable");
  }
  /** Acknowledged host presentation. A lost acknowledgement is not proof of non-delivery. */
  async present(presentation: HostPresentationV2): Promise<void> {
    if (this.closed || hostPresentationErrors(presentation).length) throw new TypeError("invalid host presentation");
    const result = await this.request("POST", "/present", presentation) as { ok?: unknown };
    if (!result || result.ok !== true) throw new Error("host presentation acknowledgement unavailable");
  }
  async taskStatus(frame: TaskStatusFrame): Promise<void> {
    if (!this.closed) await this.request("POST", "/task/status", frame, 1500);
  }
  /** The full home-screen widget state; the phone answers with the Ash widgets placed on its home screen and which cards it could draw
   * (with a preview image of the cards asked for, and previews: true when it can draw them). */
  async widgets(state: WidgetState): Promise<{ widgets?: unknown; rendered?: unknown; previews?: unknown }> {
    if (this.closed) return {};
    return (await this.request("POST", "/widgets", state, 3000)) as { widgets?: unknown; rendered?: unknown; previews?: unknown };
  }
  /** Whether the task island is on the phone's screen right now. */
  async islandShown(): Promise<boolean> {
    if (this.closed) return false;
    const result = await this.request("POST", "/island", {}, 1000) as { showing?: unknown };
    return result?.showing === true;
  }
  /** Alert the owner again, strongly, with a reply already shown quietly: its task has finished. */
  async alertPresentation(id: string): Promise<void> {
    if (this.closed || !id) throw new TypeError("invalid presentation id");
    const result = await this.request("POST", "/present/alert", { id }) as { ok?: unknown };
    if (!result || result.ok !== true) throw new Error("host alert acknowledgement unavailable");
  }
  async hidePresentation(id: string): Promise<void> {
    if (this.closed || !id) throw new TypeError("invalid presentation id");
    const result = await this.request("POST", "/present/hide", { id }) as { ok?: unknown };
    if (!result || result.ok !== true) throw new Error("host hide acknowledgement unavailable");
  }
  private invalidateSignerProof():void {this.#signerEpoch++;this.#proofExpires=0;if(this.#proofTimer)clearTimeout(this.#proofTimer);this.#proofTimer=undefined;}
  private observeExpiry():void {if(this.#proofExpires&&Date.now()>=this.#proofExpires)this.invalidateSignerProof();}
  private signerOrigin():void {const url=new URL(this.#config.url);if(url.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=="/"||!url.port||!this.#config.token||this.closed)throw Error("native signer origin unavailable");}
  private async signerKey(signal?:AbortSignal):Promise<{id:string;publicKey:string}>{const value=await this.request("GET","/key",undefined,5000,signal) as {id?:unknown;publicKey?:unknown};if(typeof value?.id!=="string"||typeof value?.publicKey!=="string"||value.publicKey.length>2048||await deviceIdForKey(value.publicKey)!==value.id)throw Error("native signer key unavailable");return{id:value.id,publicKey:value.publicKey};}
  private async rawSignature(data:Uint8Array,key:{id:string;publicKey:string},signal?:AbortSignal):Promise<string>{const value=await this.request("POST","/sign",{data:Buffer.from(data).toString("base64url")},5000,signal) as {sig?:unknown};if(typeof value?.sig!=="string"||value.sig.length>2048||!await verifySignature(key.publicKey,value.sig,new Uint8Array(data)))throw Error("native signer signature unavailable");return value.sig;}
  /** Single bounded renewal. A healthy continuous renewal preserves generation; every observed failure/gap revokes old proofs. */
  refreshSignerProof():Promise<void>{this.observeExpiry();if(this.#proofRefresh)return this.#proofRefresh;const epoch=this.#signerEpoch;const task=(async()=>{try{this.signerOrigin();const signer=this.#signer;if(!signer)throw Error("native signer unavailable");const signal=AbortSignal.timeout(5000),key=await this.signerKey(signal);if(key.id!==signer.id||key.publicKey!==signer.publicKey)throw Error("native signer key changed");await this.rawSignature(randomBytes(32),key,signal);const after=await this.signerKey(signal);this.observeExpiry();if(signal.aborted||this.closed||epoch!==this.#signerEpoch||after.id!==signer.id||after.publicKey!==signer.publicKey)throw Error("native signer lifecycle changed");this.#proofExpires=Date.now()+SIGNER_PROOF_MS;if(this.#proofTimer)clearTimeout(this.#proofTimer);this.#proofTimer=setTimeout(()=>{this.#proofTimer=undefined;void this.refreshSignerProof().catch(()=>{});},SIGNER_RENEW_MS);this.#proofTimer.unref();}catch{this.invalidateSignerProof();throw Error("native signer proof unavailable");}})();this.#proofRefresh=task;void task.finally(()=>{if(this.#proofRefresh===task)this.#proofRefresh=undefined;}).catch(()=>{});return task;}
  private async ensureSignerProof():Promise<void>{this.observeExpiry();if(!this.#proofExpires||this.#proofExpires-Date.now()<=SIGNER_RENEW_MS)await this.refreshSignerProof();if(this.closed||!this.#proofExpires||Date.now()>=this.#proofExpires)throw Error("native signer proof unavailable");}
  signer():Promise<Signer>{if(this.#signerInitialization)return this.#signerInitialization;const task=this.loadSigner();this.#signerInitialization=task;void task.finally(()=>{if(this.#signerInitialization===task)this.#signerInitialization=undefined;}).catch(()=>{});return task;}
  private async loadSigner(): Promise<Signer> {
    this.signerOrigin();if(this.#signer){await this.ensureSignerProof();return this.#signer;}const epoch=this.#signerEpoch;let key;try{key=await this.signerKey();if(this.closed||epoch!==this.#signerEpoch)throw 0;}catch{this.invalidateSignerProof();throw Error("native signer unavailable");}
    const signer:Signer=Object.freeze({id:key.id,publicKey:key.publicKey,sign:async(data:Uint8Array)=>{try{if(this.#signer!==signer||!(data instanceof Uint8Array)||data.byteLength>1024*1024)throw 0;const input=new Uint8Array(data);await this.ensureSignerProof();const current=this.#signerEpoch,signal=AbortSignal.timeout(5000),signature=await this.rawSignature(input,signer,signal);const after=await this.signerKey(signal);this.observeExpiry();if(signal.aborted||this.closed||current!==this.#signerEpoch||after.id!==signer.id||after.publicKey!==signer.publicKey)throw 0;return signature;}catch{this.invalidateSignerProof();throw Error("native signer unavailable");}}});this.#signer=signer;await this.refreshSignerProof();return signer;
  }
  async captureSignerProof(signer:Signer):Promise<HostSignerProof>{if(signer!==this.#signer)throw Error("native signer identity unavailable");await this.ensureSignerProof();const proof=Object.freeze({id:signer.id,publicKey:signer.publicKey,generation:`${this.#instance}:${this.#signerEpoch}`});this.#proofs.set(proof,{signer,epoch:this.#signerEpoch});this.currentSignerProof(proof);return proof;}
  currentSignerProof(proof:HostSignerProof):undefined {this.observeExpiry();const issued=this.#proofs.get(proof);if(this.closed||!issued||issued.signer!==this.#signer||issued.epoch!==this.#signerEpoch||!this.#proofExpires||Date.now()>=this.#proofExpires||proof.id!==this.#signer.id||proof.publicKey!==this.#signer.publicKey)throw Error("native signer proof unavailable");return undefined;}
  async whenClosed():Promise<void>{if(!this.closed)throw Error("device host is not closed");while(this.#actual.size)await Promise.allSettled([...this.#actual]);await Promise.allSettled([this.#proofRefresh,this.#signerInitialization]);}
  close(): void {if(this.closed)return;this.closed = true;this.#lifetime.abort();this.invalidateSignerProof();this.refreshEpoch++; if (this.refresh) clearInterval(this.refresh); this.refresh = null; this.member?.setOnline(false);}
}
