import { createHash } from 'node:crypto';
import {
  MaterialProtocolError, MATERIAL_LIMITS,
  type MaterialAuthorization, type MaterialAuthorizationScope, type MaterialEndpointRef,
  type MaterialInputs, type MaterialOperation, type MaterialRequestService, type MaterialTrustedContext,
  type MaterialResultFact, type MaterialReply, type AssetReceipt,
} from '../../../device/src/collaboration/material-types';
import {
  parseMaterialEnvelope, materialPayloadHash, sameMaterialEndpoint, assertMaterialReplyBinding,
  assertMaterialFactBinding, toMaterialResultDto, parseAssetReceipt,
} from '../../../device/src/collaboration/material-protocol';
import type { MaterialLedgerBinding, MaterialLedgerFacade, MaterialLedgerLocator, MaterialLedgerSnapshot } from './material-ledger-facade';
import { MaterialRequestStore, type StoredMaterialRequest } from './material-request-store';

export interface MaterialRequestServiceOptions {
  store: MaterialRequestStore;
  ledger: MaterialLedgerFacade;
  authorization: MaterialAuthorization;
  /** Synchronous freshness fence for the trusted transport binding, including before() awaits. */
  currentContext(context: Readonly<MaterialTrustedContext>): undefined;
  /** Stable, limited member mapping from authenticated identity. No local native agent impersonation. */
  resolveExternalMember(context: Readonly<MaterialTrustedContext>, ownerPrincipal: string): Promise<string>;
  discover?: (target: MaterialInputs['discover']['target'], context: Readonly<MaterialTrustedContext>) => Promise<readonly string[]>;
  /** Trusted ID lookup under request scope; exact transfer scope re-read supplies committed-byte proof. */
  readReceipt?: (receiptId: string, context: Readonly<MaterialTrustedContext>, scope: MaterialAuthorizationScope) => Promise<AssetReceipt | null>;
  now?: () => number;
  operation_timeout_ms?: number;
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(copy); return copy;
}
interface AssetFence { lease: MaterialTrustedContext; scope: MaterialAuthorizationScope; }
interface Invocation {
  assetFences: AssetFence[];
  lease: MaterialTrustedContext;
  scope: MaterialAuthorizationScope;
  io<T>(work: () => Promise<T>): Promise<T>;
  current(): void;
}
export class CoreMaterialRequestService implements MaterialRequestService {
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly options: MaterialRequestServiceOptions) {
    this.now = options.now ?? Date.now;
    this.timeout = options.operation_timeout_ms ?? 25000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60000) throw new MaterialProtocolError('invalid');
  }
  invoke<K extends MaterialOperation>(operation: K, input: MaterialInputs[K], context: MaterialTrustedContext): Promise<K extends 'discover' ? { version: 1; target: MaterialInputs['discover']['target']; capabilities: readonly string[] } : MaterialResultFact> {
    return this.invokeWithSignal(operation,input,context) as Promise<K extends 'discover' ? { version: 1; target: MaterialInputs['discover']['target']; capabilities: readonly string[] } : MaterialResultFact>;
  }
  /** Disconnect aborts observation only. Durable accepted work is never cancelled. */
  invokeWithSignal<K extends MaterialOperation>(operation: K, input: MaterialInputs[K], context: MaterialTrustedContext, signal?: AbortSignal): Promise<{version:1;target:MaterialInputs['discover']['target'];capabilities:readonly string[]} | MaterialResultFact> {
    return this.invokeObserved(operation,input,context,signal,[]);
  }
  private async invokeObserved<K extends MaterialOperation>(operation: K,input: MaterialInputs[K],context: MaterialTrustedContext,signal: AbortSignal | undefined,assetFences: AssetFence[]): Promise<{version:1;target:MaterialInputs['discover']['target'];capabilities:readonly string[]} | MaterialResultFact> {
    // Use the common whitelist parser even for in-process trusted callers.
    const supplied = immutable(context);
    const operationDeadline = this.now() + this.timeout;
    this.options.currentContext(supplied);
    const parsed = parseMaterialEnvelope(operation,input);
    let row: StoredMaterialRequest | null = null;
    if (operation !== 'submit' && operation !== 'discover') {
      const id = (parsed as MaterialInputs['get_result']).request_id;
      row = operation === 'reply' ? this.options.store.forTarget(id,supplied.source_binding) : this.options.store.get(supplied.principal_id,id);
    }
    const scope = immutable(this.scope(operation,parsed,row,supplied));
    let lease: MaterialTrustedContext;
    try { lease = immutable(await this.bounded(() => this.options.authorization.before(supplied,scope),operationDeadline,signal)); }
    finally { this.options.currentContext(supplied); }
    if (lease.principal_id !== supplied.principal_id || lease.pairing_id !== supplied.pairing_id || lease.grant_revision !== supplied.grant_revision || lease.authorization_epoch !== supplied.authorization_epoch || !sameMaterialEndpoint(lease.source_binding,supplied.source_binding)) throw new MaterialProtocolError('permission_denied');
    const deadline = Math.min(operationDeadline,lease.expires_at);
    const current = () => {
      this.options.currentContext(supplied); this.options.authorization.current(lease,scope);
      this.currentAssets(assetFences);
      if (row) this.active(row);
      if (signal?.aborted) throw new MaterialProtocolError('offline');
      if (this.now() >= lease.expires_at) throw new MaterialProtocolError('expired');
      if (this.now() >= deadline) throw new MaterialProtocolError('timeout');
    };
    const call: Invocation = { lease,scope,current,assetFences, io: async <T>(work: () => Promise<T>): Promise<T> => {
      current();
      let result: T | undefined, failure: unknown, failed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort!: () => void;
      const bounded = new Promise<never>((_,reject) => {
        timer = setTimeout(() => reject(new MaterialProtocolError('timeout')),Math.max(0,deadline-this.now()));
        abort = () => reject(new MaterialProtocolError('offline'));
        signal?.addEventListener('abort',abort,{once:true});
      });
      try { result = await Promise.race([work(),bounded]); } catch (error) { failed = true; failure = error; }
      finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort',abort); }
      try { await this.bounded(() => this.options.authorization.after(lease,scope),deadline); } finally { current(); }
      if (failed) throw failure;
      return result!;
    }};
    let result: {version:1;target:MaterialInputs['discover']['target'];capabilities:readonly string[]} | MaterialResultFact | undefined;
    let failure: unknown, failed = false;
    try {
      current();
      if (operation === 'discover') {
        const value = parsed as MaterialInputs['discover'];
        if (!this.options.discover) throw new MaterialProtocolError('unsupported');
        result = {version:1,target:value.target,capabilities:await call.io(() => this.options.discover!(value.target,lease))};
      } else if (operation === 'submit') {
        const request = parsed as MaterialInputs['submit'];
        if (!sameMaterialEndpoint(request.source,lease.source_binding)) throw new MaterialProtocolError('permission_denied');
        if (this.now() >= request.expires_at) throw new MaterialProtocolError('expired');
        result = await this.lock(`submit:${lease.principal_id}:${request.client_id}`,call,async () => {
          const claim = this.options.store.claim(request,lease.principal_id,materialPayloadHash(request),lease.grant_revision,lease.authorization_epoch,lease.expires_at);
          row = claim.row;
          const binding = await this.binding(call,claim.row);
          let locator = claim.row.locator;
          if (!locator) {
            locator = claim.fresh ? await call.io(() => this.options.ledger.accept(request,binding,claim.row.stable_key)) : await call.io(() => this.options.ledger.lookup(binding,claim.row.stable_key));
            if (locator) { current(); this.options.store.map(claim.row,locator); }
          }
          return this.read(call,claim.row,binding,locator);
        });
      } else {
        if (!row) throw new MaterialProtocolError('not_found');
        this.active(row);
        if (operation !== 'reply' && (!sameMaterialEndpoint(lease.source_binding,row.source) || !sameMaterialEndpoint(row.source,row.return_to))) throw new MaterialProtocolError('permission_denied');
        const binding = await this.binding(call,row);
        let locator = row.locator;
        if (!locator) {
          locator = await call.io(() => this.options.ledger.lookup(binding,row!.stable_key));
          if (locator) this.options.store.map(row,locator);
        }
        if (operation === 'reply') result = await this.reply(call,row,binding,locator,parsed as MaterialReply);
        else {
          result = await this.read(call,row,binding,locator);
          if (operation === 'await_result' && result.state === 'running' && locator) {
            const wait = Math.min((parsed as MaterialInputs['await_result']).wait_ms,MATERIAL_LIMITS.await_ms,row.expires_at-this.now(),Math.max(0,deadline-this.now()-1));
            if (wait > 0) {
              const controller = new AbortController();
              const abort = () => controller.abort(); signal?.addEventListener('abort',abort,{once:true});
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await call.io(() => Promise.race([
                  this.options.ledger.wait(locator!,binding,this.now()+wait,controller.signal),
                  new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); },wait); }),
                ]));
              } finally { controller.abort(); if (timer) clearTimeout(timer); signal?.removeEventListener('abort',abort); }
              result = await this.read(call,row,binding,locator);
            }
          }
          if (operation === 'ack_result') {
            const version = (parsed as MaterialInputs['ack_result']).result_version;
            if (!result.result || result.result.result_version !== version) throw new MaterialProtocolError('conflict');
            current(); this.options.store.acknowledge(row,version);
            result = { ...result,claimed_result_version:version };
          }
        }
      }
    } catch (error) { failed = true; failure = error; }
    // Fence all observable success and failure outcomes with the same immutable invocation lease.
    try { await this.bounded(() => this.options.authorization.after(lease,scope),deadline); } finally { current(); }
    if (failed) throw failure instanceof MaterialProtocolError ? failure : new MaterialProtocolError('offline');
    return result!;
  }
  private async bounded<T>(work: () => Promise<T>,deadline: number,signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const interrupted = new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new MaterialProtocolError('timeout')),Math.max(0,deadline-this.now()));
      abort = () => reject(new MaterialProtocolError('offline'));
      signal?.addEventListener('abort',abort,{once:true});
    });
    try {
      if (signal?.aborted) throw new MaterialProtocolError('offline');
      if (this.now() >= deadline) throw new MaterialProtocolError('timeout');
      return await Promise.race([work(),interrupted]);
    } catch(error) { throw error instanceof MaterialProtocolError ? error : new MaterialProtocolError('offline'); }
    finally { if(timer) clearTimeout(timer); signal?.removeEventListener('abort',abort); }
  }
  private scope(operation: MaterialOperation, parsed: MaterialInputs[MaterialOperation], row: StoredMaterialRequest | null, context: MaterialTrustedContext): MaterialAuthorizationScope {
    if (operation === 'discover') return {kind:'discovery',action:'discover',target:(parsed as MaterialInputs['discover']).target};
    if (operation === 'submit') {
      const r = parsed as MaterialInputs['submit'];
      return {kind:'request',action:operation,request_id:r.request_id,source:r.source,return_to:r.return_to,target:r.target_work ? {kind:'work',work:r.target_work} : {kind:'node',node_id:r.target.node_id,endpoint_id:r.target.endpoint_id},transfer:null};
    }
    return {kind:'request',action:operation,request_id:(parsed as MaterialInputs['get_result']).request_id,source:row?.source ?? context.source_binding,return_to:row?.return_to ?? context.source_binding,target:row?.target ?? context.source_binding,transfer:null};
  }
  private active(row: StoredMaterialRequest): void {
    if (row.tombstone || this.now() >= row.expires_at) { this.options.store.expire(row); throw new MaterialProtocolError('expired'); }
  }
  private async binding(call: Invocation, row: StoredMaterialRequest): Promise<MaterialLedgerBinding> {
    this.active(row);
    const member = await call.io(() => this.options.resolveExternalMember(call.lease,row.principal_id));
    if (!member || member.startsWith('agent:') || member.length > 256) throw new MaterialProtocolError('permission_denied');
    return immutable({context:call.lease,owner_principal_id:row.principal_id,external_member_id:member});
  }
  private async snapshot(call: Invocation, row: StoredMaterialRequest, binding: MaterialLedgerBinding, locator: MaterialLedgerLocator): Promise<MaterialLedgerSnapshot | null> {
    this.active(row);
    const snapshot = await call.io(() => this.options.ledger.read(locator,binding));
    this.active(row);
    if (!snapshot) return null;
    if (materialPayloadHash(snapshot.request) !== row.payload_sha256 || !sameMaterialEndpoint(snapshot.request.source,row.source) || !sameMaterialEndpoint(snapshot.request.return_to,row.return_to)) throw new MaterialProtocolError('conflict');
    const fact = toMaterialResultDto(snapshot.fact);
    if (locator.pending_id !== (fact.question?.pending_id ?? null) || locator.question_version !== (fact.question?.question_version ?? null)) throw new MaterialProtocolError('conflict');
    let question = this.options.store.get(row.principal_id,row.request_id)!.question;
    if (fact.question) {
      call.current(); question = this.options.store.bindQuestion(row,fact.question);
      if (question.expires_at > call.lease.expires_at) throw new MaterialProtocolError('permission_denied');
    }
    assertMaterialFactBinding(fact,snapshot.request,question);
    if (snapshot.request.kind === 'human_material' && fact.state === 'registered') throw new MaterialProtocolError('result_unknown');
    if (snapshot.request.kind === 'agent_task' && !locator.job_id) throw new MaterialProtocolError('result_unknown');
    return {request:snapshot.request,fact};
  }
  private async read(call: Invocation,row: StoredMaterialRequest,binding: MaterialLedgerBinding,locator: MaterialLedgerLocator | null): Promise<MaterialResultFact> {
    this.active(row);
    const snapshot = locator ? await this.snapshot(call,row,binding,locator) : null;
    if (!snapshot) {
      const latest = this.options.store.get(row.principal_id,row.request_id)!;
      if (latest.result_version) throw new MaterialProtocolError('result_unknown');
      call.current(); this.options.store.observe(row,'unknown',0,null);
      return {version:1,request_id:row.request_id,state:'unknown',result:null,question:null,claimed_result_version:null,receipts:[],business_state:'unverified',observed_at:this.now()};
    }
    const previous = this.options.store.get(row.principal_id,row.request_id)!;
    const fact = previous.state === 'unknown' && ['registered','waiting_owner','running'].includes(snapshot.fact.state) ? {...snapshot.fact,state:'unknown' as const} : snapshot.fact;
    if (fact.receipts.length) throw new MaterialProtocolError('conflict'); // Receipts come exclusively from committed-byte evidence below.
    const version = fact.result?.result_version ?? 0;
    call.current(); this.options.store.observe(row,fact.state,version,fact.result ? hash(fact.result) : null);
    const latest = this.options.store.get(row.principal_id,row.request_id)!;
    const receipts: AssetReceipt[] = [];
    for (const id of this.options.store.receipts(row,version)) {
      const receipt = await this.receipt(call,row,version,id,fact);
      if (receipt) receipts.push(receipt);
    }
    return toMaterialResultDto({...fact,claimed_result_version:latest.claimed_result_version,receipts});
  }
  private async reply(call: Invocation,row: StoredMaterialRequest,binding: MaterialLedgerBinding,locator: MaterialLedgerLocator | null,reply: MaterialReply): Promise<MaterialResultFact> {
    if (!sameMaterialEndpoint(call.lease.source_binding,row.target)) throw new MaterialProtocolError('permission_denied');
    if (!locator) return this.read(call,row,binding,null);
    const snapshot = await this.snapshot(call,row,binding,locator);
    if (!snapshot) throw new MaterialProtocolError('result_unknown');
    assertMaterialReplyBinding(reply,snapshot.request,snapshot.fact.question,this.now());
    return this.lock(`reply:${call.lease.principal_id}:${reply.client_id}`,call,async () => {
      const claim = this.options.store.claimReply(row,call.lease.principal_id,reply.client_id,materialPayloadHash(reply));
      const accepted = claim.locator ?? (claim.fresh ? await call.io(() => this.options.ledger.answer(reply,binding,claim.key)) : await call.io(() => this.options.ledger.lookup(binding,claim.key)));
      if (!accepted) throw new MaterialProtocolError('result_unknown');
      call.current(); this.options.store.mapReply(claim.key,accepted);
      const fact = await this.read(call,row,binding,accepted);
      if (!fact.result || hash(fact.result) !== hash(reply.result)) throw new MaterialProtocolError('conflict');
      return fact;
    });
  }
  private async lock<T>(key: string,call: Invocation,work: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const next = new Promise<void>(resolve => { unlock = resolve; });
    this.locks.set(key,next);
    try { await call.io(() => prior); return await work(); }
    finally { unlock(); if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  private currentAssets(fences: AssetFence[]): void {
    for (const {lease,scope} of fences) {
      this.options.authorization.current(lease,scope);
      if (this.now() >= lease.expires_at) throw new MaterialProtocolError('expired');
    }
  }
  private async receipt(call: Invocation,row: StoredMaterialRequest,version: number,id: string,fact: MaterialResultFact): Promise<AssetReceipt> {
    if (!this.options.readReceipt || !fact.result || version !== fact.result.result_version) throw new MaterialProtocolError('unsupported');
    // Locate by committed receipt ID under request ownership, then prove the corresponding exact asset.
    const indexed = await call.io(() => this.options.readReceipt!(id,call.lease,call.scope));
    if (!indexed) throw new MaterialProtocolError('not_found');
    const receipt = parseAssetReceipt(indexed);
    const asset = fact.result.assets.find(a => a.kind === 'asset' && a.asset_id === receipt.asset_id);
    if (receipt.receipt_id !== id || receipt.request_id !== row.request_id || !sameMaterialEndpoint(receipt.destination,row.return_to) || !asset || asset.kind !== 'asset' || asset.version !== receipt.asset_version || asset.sha256 !== receipt.sha256 || asset.byte_length !== receipt.byte_length) throw new MaterialProtocolError('conflict');
    if (this.now() >= asset.expires_at) throw new MaterialProtocolError('expired');
    const assetScope: MaterialAuthorizationScope = immutable({kind:'request',action:'read_chunk',request_id:row.request_id,source:row.source,return_to:row.return_to,target:row.target,transfer:{asset_id:asset.asset_id,asset_version:asset.version,source:fact.result.target_work ? {kind:'work',work:fact.result.target_work} : row.target,destination:row.return_to}});
    const assetLease = immutable(await call.io(() => this.options.authorization.before(call.lease,assetScope)));
    if (assetLease.principal_id !== call.lease.principal_id || assetLease.pairing_id !== call.lease.pairing_id || assetLease.grant_revision !== call.lease.grant_revision || assetLease.authorization_epoch !== call.lease.authorization_epoch || !sameMaterialEndpoint(assetLease.source_binding,call.lease.source_binding)) throw new MaterialProtocolError('permission_denied');
    call.assetFences.push({lease:assetLease,scope:assetScope});
    call.current();
    let proof: AssetReceipt | null = null;
    try { proof = await call.io(() => this.options.readReceipt!(id,assetLease,assetScope)); }
    finally { await call.io(() => this.options.authorization.after(assetLease,assetScope)); call.current(); }
    if (!proof || hash(parseAssetReceipt(proof)) !== hash(receipt)) throw new MaterialProtocolError('conflict');
    return receipt;
  }
  /** Called by trusted asset integration after byte commit; records only the verified receipt ID. */
  async attachReceipt(requestId: string,resultVersion: number,receiptId: string,context: MaterialTrustedContext): Promise<MaterialResultFact> {
    const supplied = immutable(context);
    const assetFences: AssetFence[] = [];
    const operationDeadline = this.now() + this.timeout;
    this.options.currentContext(supplied);
    const fact = await this.invokeObserved('get_result',{version:1,request_id:requestId},supplied,undefined,assetFences) as MaterialResultFact;
    const row = this.options.store.get(supplied.principal_id,requestId);
    if (!row || !fact.result || fact.result.result_version !== resultVersion) throw new MaterialProtocolError('conflict');
    const scope = immutable(this.scope('get_result',{version:1,request_id:requestId},row,supplied));
    this.options.currentContext(supplied);
    let lease: MaterialTrustedContext;
    try { lease = immutable(await this.bounded(() => this.options.authorization.before(supplied,scope),operationDeadline)); } finally { this.options.currentContext(supplied); }
    if (lease.principal_id !== supplied.principal_id || lease.pairing_id !== supplied.pairing_id || lease.grant_revision !== supplied.grant_revision || lease.authorization_epoch !== supplied.authorization_epoch || !sameMaterialEndpoint(lease.source_binding,supplied.source_binding)) throw new MaterialProtocolError('permission_denied');
    const deadline = Math.min(operationDeadline,lease.expires_at);
    const current = () => { this.options.currentContext(supplied); this.options.authorization.current(lease,scope);
      this.currentAssets(assetFences); this.active(row); if (this.now() >= deadline) throw new MaterialProtocolError('timeout'); if (this.now() >= lease.expires_at) throw new MaterialProtocolError('expired'); };
    const call: Invocation = {lease,scope,current,assetFences,io:async work => { current(); let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new MaterialProtocolError('timeout')),Math.max(0,deadline-this.now()));})]); } finally { if(timer) clearTimeout(timer); try { await this.bounded(() => this.options.authorization.after(lease,scope),deadline); } finally { current(); } } }};
    let failed=false,failure:unknown,result:MaterialResultFact|undefined;
    try {
      const receipt = await this.receipt(call,row,resultVersion,receiptId,fact);
      const fresh = await this.invokeObserved('get_result',{version:1,request_id:requestId},supplied,undefined,assetFences) as MaterialResultFact;
      if (fresh.result?.result_version !== resultVersion) throw new MaterialProtocolError('conflict');
      current(); if (receipt) this.options.store.receipt(row,resultVersion,receipt);
      result = await this.invokeObserved('get_result',{version:1,request_id:requestId},supplied,undefined,assetFences) as MaterialResultFact;
      if (result.result?.result_version !== resultVersion) throw new MaterialProtocolError('conflict');
    } catch(error) { failed=true;failure=error; }
    try { await this.bounded(() => this.options.authorization.after(lease,scope),deadline); } finally { current(); }
    if (failed) throw failure;
    return result!;
  }
}
