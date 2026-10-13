import type { CollaborationRequest, MaterialReply, ResultEnvelope } from '../../../device/src/collaboration/material-types';
import { MaterialProtocolError } from '../../../device/src/collaboration/material-types';
import { parseCollaborationRequest, parseMaterialReply, parseResultEnvelope, sameMaterialWork, materialPayloadHash } from '../../../device/src/collaboration/material-protocol';
import type { Ledger } from '../world/ledger';
import type { WorldRouter } from '../world/router';
import type { WorkRef } from '../../../device/src/collaboration/types';
import type { MaterialLedgerBinding, MaterialLedgerFacade, MaterialLedgerLocator, MaterialLedgerSnapshot } from './material-ledger-facade';

export type MaterialLedgerAction = 'accept' | 'lookup' | 'read' | 'answer' | 'wait' | 'dispatch' | 'complete';
declare const permitBrand: unique symbol;
/** Issued only by a protected authority. Runtime registration occurs after before resolves. */
export interface MaterialAdmissionPermit { readonly [permitBrand]: true }
export interface MaterialAdmissionInput {
  action: MaterialLedgerAction;
  binding: MaterialLedgerBinding;
  request: CollaborationRequest | null;
  reply: MaterialReply | null;
  stableKey: string | null;
  locator: MaterialLedgerLocator | null;
  result?: ResultEnvelope;
}
export interface MaterialAdmissionAuthority {
  before(input: Readonly<MaterialAdmissionInput>): Promise<MaterialAdmissionPermit>;
  /** Pre-admission fence, including before() failures and awaits. */
  currentInput(input: Readonly<MaterialAdmissionInput>): undefined;
  current(permit: MaterialAdmissionPermit): undefined;
  release(permit: MaterialAdmissionPermit): undefined;
}
interface Registration { input: MaterialAdmissionInput; current(): undefined; active: boolean }
const registrations = new WeakMap<object, Registration>();
const used = new WeakSet<object>();
function frozen<T>(value: T): T {
  const result = structuredClone(value);
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(result); return result;
}
/** Internal Ledger boundary: strings/brands/cloned objects never constitute an admission permit. */
export function currentMaterialAdmission(permit: MaterialAdmissionPermit, action: MaterialLedgerAction, binding: MaterialLedgerBinding,
  request: CollaborationRequest | null = null, stableKey: string | null = null, reply: MaterialReply | null = null): undefined {
  const entry = registrations.get(permit);
  if (!entry?.active || entry.input.action !== action || JSON.stringify(entry.input.binding) !== JSON.stringify(binding) ||
    (stableKey !== null && entry.input.stableKey !== stableKey) ||
    (request !== null && (!entry.input.request || materialPayloadHash(entry.input.request) !== materialPayloadHash(request))) ||
    (reply !== null && (!entry.input.reply || materialPayloadHash(entry.input.reply) !== materialPayloadHash(reply)))) throw new MaterialProtocolError('permission_denied');
  entry.current(); return undefined;
}
export interface MaterialTaskDispatchLease {
  /** Revalidates exact capability, node/endpoint, generation, grant and execution budget synchronously. */
  current(): undefined;
  readonly idempotentRecovery: boolean;
  /** Exact production work proved by the capability registry, or no work-producing capability. */
  readonly production_work: WorkRef | null;
  /** The canonical ledger ID must be the target's durable idempotency key. */
  execute(ledgerRequestId: string, request: Readonly<CollaborationRequest>): Promise<ResultEnvelope>;
  release(): undefined;
}
export interface MaterialTaskDispatchAdapter {
  authorize(request: Readonly<CollaborationRequest>, binding: Readonly<MaterialLedgerBinding>): Promise<MaterialTaskDispatchLease>;
  /** Reauthentication through the protected registry; persisted strings cannot mint a fresh actor. */
  recoverBinding(owner: string, member: string, requestId: string): Promise<MaterialLedgerBinding>;
}
export interface MaterialDurableLedgerOptions {
  ledger: Ledger; authority: MaterialAdmissionAuthority; now?: () => number;
  taskDispatch?: MaterialTaskDispatchAdapter; router?: WorldRouter;
  max_unfinished_tasks?: number;
  dispatch_observation_timeout_ms?: number;
}
export function currentMaterialTaskResult(permit: MaterialAdmissionPermit,result: ResultEnvelope): undefined {
  const entry = registrations.get(permit);
  if(!entry?.active || entry.input.action !== 'complete' || JSON.stringify(entry.input.result) !== JSON.stringify(result)) throw new MaterialProtocolError('permission_denied');
  entry.current(); return undefined;
}
/** No default authority and no local-agent fallback. All durable bodies live in Ledger.messages. */
export class MaterialDurableLedgerFacade implements MaterialLedgerFacade {
  private readonly now: () => number;
  private readonly dispatches = new Map<string,Promise<unknown>>();
  private readonly admissionPayloads=new Map<string,string>();
  private readonly unfinishedTasks=new Set<Promise<unknown>>();
  private readonly maximum: number;
  private readonly observationTimeout: number;
  private readonly observationClosers = new Set<() => void>();
  private closed=false;
  private detachRecovery?: () => void;
  constructor(private readonly options: MaterialDurableLedgerOptions) {
    if (!options.authority || typeof options.authority.before !== 'function' || typeof options.authority.currentInput !== 'function' || typeof options.authority.current !== 'function' || typeof options.authority.release !== 'function') throw new MaterialProtocolError('permission_denied');
    this.now = options.now ?? Date.now;
    this.maximum=options.max_unfinished_tasks ?? 8;this.observationTimeout=options.dispatch_observation_timeout_ms ?? 20000;
    if(!Number.isSafeInteger(this.maximum)||this.maximum<1||this.maximum>32||!Number.isSafeInteger(this.observationTimeout)||this.observationTimeout<1||this.observationTimeout>20000)throw new MaterialProtocolError('invalid');
    if(options.router && options.taskDispatch) this.detachRecovery=options.router.setMaterialRecoveryHandler(tracked => {
      const identity = options.ledger.externalMaterialRecoveryIdentity(tracked.message.id);
      if(!identity || tracked.message.body.kind !== 'agent_task') return Promise.resolve();
      return this.startDispatch(identity.locator.ledger_request_id,async()=>{
        const binding=await options.taskDispatch!.recoverBinding(identity.owner,identity.member,tracked.message.id);
        await this.dispatchOnce(identity.locator,binding);
      }).then(()=>undefined);
    },{maxUnfinishedTasks:this.maximum,observationTimeoutMs:this.observationTimeout});
  }
  private async authorized<T>(input: MaterialAdmissionInput, run: (permit: MaterialAdmissionPermit) => T | Promise<T>): Promise<T> {
    if(this.closed && input.action!=='complete')throw new MaterialProtocolError('offline');
    input = frozen(input);
    const inputFence = () => {
      if(this.options.authority.currentInput(input) !== undefined) throw new MaterialProtocolError('permission_denied');
    };
    inputFence();
    let permit: MaterialAdmissionPermit | undefined;
    try { permit = await this.options.authority.before(input); inputFence(); }
    catch(error) {
      try { inputFence(); } finally { if(permit) this.options.authority.release(permit); }
      throw error;
    }
    if (!permit || typeof permit !== 'object' || used.has(permit)) throw new MaterialProtocolError('permission_denied');
    used.add(permit);
    const entry: Registration = {input,active:true,current: () => {
      if(this.closed && input.action!=='complete')throw new MaterialProtocolError('offline');
      inputFence();
      if(this.options.authority.current(permit) !== undefined) throw new MaterialProtocolError('permission_denied');
      if (this.now() >= input.binding.context.expires_at) throw new MaterialProtocolError('expired');
      return undefined;
    }};
    registrations.set(permit,entry);
    try { entry.current(); return await run(permit); }
    finally { try { entry.current(); } finally { entry.active = false; if(this.options.authority.release(permit) !== undefined) throw new MaterialProtocolError('permission_denied'); } }
  }
  async accept(request: CollaborationRequest, binding: MaterialLedgerBinding, stableKey: string): Promise<MaterialLedgerLocator> {
    request = frozen(parseCollaborationRequest(request)); binding = frozen(binding);
    const commit=()=>this.authorized({action:'accept',binding,request,reply:null,stableKey,locator:null}, async permit => {
      if(request.kind !== 'agent_task') return this.options.ledger.admitExternalMaterial(request,binding,stableKey,permit,this.now());
      if(!this.options.taskDispatch) throw new MaterialProtocolError('unsupported');
      const lease = await this.options.taskDispatch.authorize(request,binding);
      try {
        if(lease.current() !== undefined) throw new MaterialProtocolError('permission_denied');
        return this.options.ledger.admitExternalMaterial(request,binding,stableKey,permit,this.now());
      } finally { try { if(lease.current() !== undefined) throw new MaterialProtocolError('permission_denied'); } finally { if(lease.release() !== undefined) throw new MaterialProtocolError('permission_denied'); } }
    });
    if(request.kind !== 'agent_task')return commit();
    const admissionKey=`accept:${binding.owner_principal_id}:${stableKey}`;
    const payload=materialPayloadHash(request);
    const previousPayload=this.admissionPayloads.get(admissionKey);
    if(previousPayload && previousPayload!==payload)return this.authorized({action:'accept',binding,request,reply:null,stableKey,locator:null},()=>{throw new MaterialProtocolError('conflict');});
    const work=this.startDispatch(admissionKey,async()=>{
      const locator=await commit();
      // Admission and recovery share the same actual unfinished execution, before any second authorize/execute.
      const current=this.dispatches.get(admissionKey)!;
      const canonical=this.dispatches.get(locator.ledger_request_id);
      if(canonical && canonical!==current)await canonical;
      else {this.dispatches.set(locator.ledger_request_id,current);await this.dispatchOnce(locator,binding);}
      return locator;
    });
    if(this.dispatches.get(admissionKey)===work)this.admissionPayloads.set(admissionKey,payload);
    return this.authorized({action:'accept',binding,request,reply:null,stableKey,locator:null},()=>this.observeDispatch(work));
  }
  async lookup(binding: MaterialLedgerBinding, stableKey: string): Promise<MaterialLedgerLocator | null> {
    binding = frozen(binding);
    const located = await this.authorized({action:'lookup',binding,request:null,reply:null,stableKey,locator:null}, permit => this.options.ledger.findExternalMaterialOperation(binding,stableKey,permit));
    if (!located) return null;
    // Metadata lookup is never authority to return a canonical request.
    const snapshot = await this.read(located,binding);
    return snapshot ? located : null;
  }
  async read(locator: MaterialLedgerLocator, binding: MaterialLedgerBinding): Promise<MaterialLedgerSnapshot | null> {
    locator = frozen(locator); binding = frozen(binding);
    const request = await this.authorized({action:'read',binding,request:null,reply:null,stableKey:null,locator},permit => this.options.ledger.externalMaterialCanonical(locator,binding,permit,'read'));
    if (!request) return null;
    return this.authorized({action:'read',binding,request,reply:null,stableKey:null,locator},permit => this.options.ledger.readExternalMaterial(locator,binding,permit,this.now(),'read'));
  }
  async answer(reply: MaterialReply, binding: MaterialLedgerBinding, stableKey: string): Promise<MaterialLedgerLocator> {
    reply = frozen(parseMaterialReply(reply)); binding = frozen(binding);
    const locator = await this.authorized({action:'lookup',binding,request:null,reply,stableKey:null,locator:null},permit => this.options.ledger.findExternalMaterialRequest(binding,reply.request_id,permit));
    if (!locator) throw new MaterialProtocolError('not_found');
    const request = await this.authorized({action:'read',binding,request:null,reply:null,stableKey:null,locator},permit => this.options.ledger.externalMaterialCanonical(locator,binding,permit,'read'));
    if (!request) throw new MaterialProtocolError('not_found');
    return this.authorized({action:'answer',binding,request,reply,stableKey,locator},permit => this.options.ledger.answerExternalMaterial(reply,binding,stableKey,permit,this.now()));
  }
  /** End observers and intake only. Actual unfinished work retains its slot and original fences. */
  close(): void {
    if(this.closed)return;this.closed=true;this.detachRecovery?.();this.detachRecovery=undefined;
    for(const close of this.observationClosers)close();
  }
  private startDispatch<T>(id: string,run:()=>Promise<T>): Promise<T> {
    const prior=this.dispatches.get(id);if(prior)return prior as Promise<T>;
    if(this.closed || this.unfinishedTasks.size>=this.maximum){
      const rejected=Promise.reject<T>(new MaterialProtocolError(this.closed?'offline':'too_large'));
      void rejected.catch(()=>{});return rejected;
    }
    const work=Promise.resolve().then(run);this.dispatches.set(id,work);this.unfinishedTasks.add(work);
    const release=()=>{this.unfinishedTasks.delete(work);for(const [key,value] of this.dispatches)if(value===work){this.dispatches.delete(key);this.admissionPayloads.delete(key);}};
    void work.then(release,release);return work;
  }
  private observeDispatch<T>(work: Promise<T>): Promise<T> {
    if(this.closed){void work.catch(()=>{});return Promise.reject(new MaterialProtocolError('offline'));}
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(error:unknown,value?:T)=>{if(done)return;done=true;clearTimeout(timer);this.observationClosers.delete(close);error?reject(error):resolve(value!);};
      const close=()=>finish(new MaterialProtocolError('offline'));
      const timer=setTimeout(()=>finish(new MaterialProtocolError('timeout')),this.observationTimeout);
      this.observationClosers.add(close);void work.then(value=>this.closed?close():finish(null,value),error=>finish(error));
    });
  }
  private async dispatchOnce(locator: MaterialLedgerLocator,binding: MaterialLedgerBinding): Promise<void> {
    const snapshot = await this.read(locator,binding);
    if(!snapshot || snapshot.request.kind !== 'agent_task' || snapshot.fact.result) return;
    const adapter = this.options.taskDispatch; if(!adapter) return;
    const request = frozen(snapshot.request); binding = frozen(binding);
    const lease = await adapter.authorize(request,binding);
    try {
      if(lease.current() !== undefined) throw new MaterialProtocolError('permission_denied');
      const phase = await this.authorized({action:'dispatch',binding,request,reply:null,stableKey:null,locator},permit => {
        if(lease.current() !== undefined) throw new MaterialProtocolError('permission_denied'); return this.options.ledger.startExternalMaterialDispatch(locator,binding,permit,this.now());
      });
      if(phase === 'settled' || phase === 'dispatching' && !lease.idempotentRecovery) return;
      if(lease.current() !== undefined) throw new MaterialProtocolError('permission_denied');
      // Only a response from this exact protected dispatch lease can become a task result.
      const result = parseResultEnvelope(await lease.execute(locator.ledger_request_id,request));
      if ((result.target_work === null) !== (lease.production_work === null) || result.target_work && lease.production_work && !sameMaterialWork(result.target_work,lease.production_work)) throw new MaterialProtocolError('permission_denied');
      if(lease.current() !== undefined) throw new MaterialProtocolError('permission_denied');
      await this.authorized({action:'complete',binding,request,reply:null,stableKey:null,locator,result},permit => {
        if(lease.current() !== undefined) throw new MaterialProtocolError('permission_denied'); this.options.ledger.completeExternalMaterialTask(locator,binding,result,permit,this.now());
      });
    } finally { try { if(lease.current() !== undefined) throw new MaterialProtocolError('permission_denied'); } finally { if(lease.release() !== undefined) throw new MaterialProtocolError('permission_denied'); } }
  }
  async wait(locator: MaterialLedgerLocator, binding: MaterialLedgerBinding, deadline: number, signal: AbortSignal): Promise<void> {
    locator = frozen(locator); binding = frozen(binding);
    if (!Number.isSafeInteger(deadline) || deadline > this.now()+20000) throw new MaterialProtocolError('invalid');
    const snapshot = await this.read(locator,binding);
    if (!snapshot) throw new MaterialProtocolError('not_found');
    await this.authorized({action:'wait',binding,request:snapshot.request,reply:null,stableKey:null,locator},async permit => {
      while (!signal.aborted && this.now() < deadline) {
        const fact = this.options.ledger.readExternalMaterial(locator,binding,permit,this.now(),'wait');
        if (!fact || !['running','registered'].includes(fact.fact.state)) return;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort',done); resolve(); };
          const timer = setTimeout(done,Math.min(25,Math.max(0,deadline-this.now())));
          signal.addEventListener('abort',done,{once:true}); if (signal.aborted) done();
        });
      }
      currentMaterialAdmission(permit,'wait',binding,snapshot.request);
    });
  }
}
