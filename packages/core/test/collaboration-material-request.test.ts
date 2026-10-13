import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MaterialProtocolError, type CollaborationRequest, type MaterialTrustedContext, type MaterialAuthorization, type MaterialReply, type AssetReceipt } from '../../device/src/collaboration/material-types';
import { MaterialRequestStore } from '../src/collaboration/material-request-store';
import { CoreMaterialRequestService } from '../src/collaboration/material-request-service';
import { MaterialFaultLedger } from './fixtures/material-fault-ledger';
import { UnsupportedMaterialLedgerFacade } from '../src/collaboration/material-ledger-facade';
const work = {node_id:'desktop',endpoint_id:'codex',native_id:'native-real-thread',kind:'conversation' as const};
const owner: MaterialTrustedContext = {principal_id:'source-owner',pairing_id:'pair',grant_revision:'r1',authorization_epoch:'e1',source_binding:{kind:'work',work},expires_at:999999};
const target: MaterialTrustedContext = {...owner,principal_id:'phone-owner',source_binding:{kind:'node',node_id:'phone',endpoint_id:'materials'}};
const request = (): CollaborationRequest => ({version:1,request_id:'request-1',client_id:'client-1',source:owner.source_binding,return_to:owner.source_binding,target:{node_id:'phone',endpoint_id:'materials'},target_work:null,kind:'human_material',purpose:'Need a source photograph',context:{goal:'Make a report',confirmed_decisions:[],increment:'A',expected_output:'image',uncertain:[],missing:[],refs:[],provenance:[]},expected_output:'image',expires_at:10000});
const code = (name: string) => (error: unknown) => error instanceof MaterialProtocolError && error.code === name;
function fixture(options: {max_requests?:number;retention_ms?:number;operation_timeout_ms?:number} = {}) {
  const dir=mkdtempSync(join(tmpdir(),'material-request-')); let time=100; let epoch='e1'; let denied=false;
  let store = new MaterialRequestStore({file:join(dir,'metadata.sqlite'),now:()=>time,...options});
  let ledger = new MaterialFaultLedger(join(dir,'canonical.sqlite'),()=>time);
  const auth: MaterialAuthorization = {before:async c=>{if(denied || c.authorization_epoch!==epoch) throw new MaterialProtocolError('permission_denied'); return {...c};},after:async c=>{if(denied || c.authorization_epoch!==epoch) throw new MaterialProtocolError('permission_denied');},current:c=>{if(denied || c.authorization_epoch!==epoch) throw new MaterialProtocolError('permission_denied'); return undefined;}};
  const receipts = new Map<string,AssetReceipt>();
  const service = () => new CoreMaterialRequestService({store,ledger,authorization:auth,currentContext:c=>auth.current(c,{kind:'discovery',action:'discover',target:{node_id:'phone',endpoint_id:'materials'}}),resolveExternalMember:async()=> 'external:limited-member',now:()=>time,readReceipt:async id=>receipts.get(id)??null,...options});
  let svc=service();
  return {dir,get store(){return store;},get ledger(){return ledger;},get svc(){return svc;},receipts,auth, time:(v:number)=>{time=v;},revoke:()=>{denied=true;},aba:()=>{epoch='e2';},reopen:()=>{store.close();ledger.close();store=new MaterialRequestStore({file:join(dir,'metadata.sqlite'),now:()=>time,...options});ledger=new MaterialFaultLedger(join(dir,'canonical.sqlite'),()=>time);svc=service();},close:()=>{store.close();ledger.close();rmSync(dir,{recursive:true,force:true});}};
}
async function answer(f:ReturnType<typeof fixture>): Promise<MaterialReply> {
  const fact=await f.svc.invoke('submit',request(),owner);
  return {version:1,kind:'human_answer',client_id:'answer-client',request_id:'request-1',source:owner.source_binding,expires_at:10000,pending_id:fact.question!.pending_id,question_version:1,result:{version:1,request_id:'request-1',reply_to:'request-1',result_version:1,source:owner.source_binding,target_work:null,summary:'Here is the selection',assets:[],missing:[],error_code:null,observed_at:100}};
}
test('human submit is immediate durable waiting_owner; cold duplicate and client conflicts',async()=>{const f=fixture();try{
  const a=await f.svc.invoke('submit',request(),owner); assert.equal(a.state,'waiting_owner'); assert.equal(a.question?.question_version,1);
  f.reopen(); assert.deepEqual(await f.svc.invoke('submit',request(),owner),a); assert.equal(f.ledger.accepts,0);
  await assert.rejects(f.svc.invoke('submit',{...request(),purpose:'different'},owner),code('conflict'));
  await f.svc.invoke('await_result',{version:1,request_id:'request-1',wait_ms:20000},owner); assert.equal(f.ledger.waits,0);
}finally{f.close();}});
test('concurrent duplicate acceptance issues exactly one question',async()=>{const f=fixture();try{const facts=await Promise.all(Array.from({length:20},()=>f.svc.invoke('submit',request(),owner)));assert.equal(f.ledger.accepts,1);assert.equal(new Set(facts.map(a=>a.question?.pending_id)).size,1);}finally{f.close();}});
test('atomic ledger acceptance crash before metadata mapping recovers without reissue',async()=>{const f=fixture();try{f.ledger.fault='accept';await assert.rejects(f.svc.invoke('submit',request(),owner),code('offline')); f.reopen();const a=await f.svc.invoke('submit',request(),owner);assert.equal(a.state,'waiting_owner');assert.equal(f.ledger.accepts,0);}finally{f.close();}});
test('unknown acceptance never reissues and survives another restart',async()=>{const f=fixture();try{f.ledger.fault='accept';await assert.rejects(f.svc.invoke('submit',request(),owner));f.reopen();f.ledger.lookupUnknown=true;assert.equal((await f.svc.invoke('submit',request(),owner)).state,'unknown');assert.equal(f.ledger.accepts,0);f.reopen();const recovered=await f.svc.invoke('submit',request(),owner);assert.equal(recovered.state,'unknown');assert.ok(recovered.question);assert.equal(f.ledger.accepts,0);}finally{f.close();}});
test('answers require current exact target and bound current question; no source impersonation',async()=>{const f=fixture();try{const reply=await answer(f);await assert.rejects(f.svc.invoke('reply',reply,owner),code('not_found'));await assert.rejects(f.svc.invoke('reply',{...reply,question_version:2} as MaterialReply,target),code('conflict'));await assert.rejects(f.svc.invoke('reply',{...reply,pending_id:'wrong'} as MaterialReply,target),code('conflict'));const fact=await f.svc.invoke('reply',reply,target);assert.equal(fact.state,'result_available');await assert.rejects(f.svc.invoke('get_result',{version:1,request_id:'request-1'},target),code('not_found'));}finally{f.close();}});
test('answer commit crash cold recovers stable reply key and never writes second answer',async()=>{const f=fixture();try{const reply=await answer(f);f.ledger.fault='answer';await assert.rejects(f.svc.invoke('reply',reply,target),code('offline'));f.reopen();assert.equal((await f.svc.invoke('reply',reply,target)).result?.summary,reply.result.summary);assert.equal(f.ledger.answers,0);}finally{f.close();}});
test('concurrent replies dedupe and altered same client conflicts',async()=>{const f=fixture();try{const reply=await answer(f);await Promise.all(Array.from({length:10},()=>f.svc.invoke('reply',reply,target)));assert.equal(f.ledger.answers,1);await assert.rejects(f.svc.invoke('reply',{...reply,result:{...reply.result,summary:'changed'}},target),code('conflict'));}finally{f.close();}});
test('explicit version ACK persists across turn/tool restart; get is side-effect free',async()=>{const f=fixture();try{const reply=await answer(f);await f.svc.invoke('reply',reply,target);let fact=await f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner);assert.equal(fact.claimed_result_version,null);await assert.rejects(f.svc.invoke('ack_result',{version:1,request_id:'request-1',result_version:2},owner),code('conflict'));fact=await f.svc.invoke('ack_result',{version:1,request_id:'request-1',result_version:1},owner);assert.equal(fact.claimed_result_version,1);f.reopen();assert.equal((await f.svc.invoke('ack_result',{version:1,request_id:'request-1',result_version:1},owner)).claimed_result_version,1);}finally{f.close();}});
test('expiry tombstone denies historical reads and late answers',async()=>{const f=fixture();try{const reply=await answer(f);f.time(10000);await assert.rejects(f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner),code('expired'));await assert.rejects(f.svc.invoke('reply',reply,target),code('expired'));assert.equal(f.store.get(owner.principal_id,'request-1')?.tombstone,true);f.reopen();f.time(100);await assert.rejects(f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner),code('expired'));}finally{f.close();}});
test('revoke/restore ABA during ledger IO fences success and ledger errors',async()=>{const f=fixture();try{f.ledger.hook=async()=>{f.aba();};await assert.rejects(f.svc.invoke('submit',request(),owner),code('permission_denied'));f.ledger.hook=undefined;await assert.rejects(f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner),code('permission_denied'));const fresh={...owner,authorization_epoch:'e2'};assert.equal((await f.svc.invoke('submit',request(),fresh)).state,'waiting_owner');}finally{f.close();}});
test('principal collisions isolated and fresh identity cannot claim old result',async()=>{const f=fixture();try{await f.svc.invoke('submit',request(),owner);const newOwner={...owner,principal_id:'new-source-identity'};await assert.rejects(f.svc.invoke('get_result',{version:1,request_id:'request-1'},newOwner),code('not_found'));await f.svc.invoke('submit',request(),newOwner);assert.equal(f.ledger.accepts,2);}finally{f.close();}});
test('canonical facts cannot regress result version or replace same version',async()=>{const f=fixture();try{const reply=await answer(f);await f.svc.invoke('reply',reply,target);f.ledger.mutate('request-1',s=>({...s,fact:{...s.fact,result:{...s.fact.result!,summary:'tampered same version'}}}));await assert.rejects(f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner),code('result_unknown'));}finally{f.close();}});
test('deleted canonical conversation is unknown and never reconstituted from metadata',async()=>{const f=fixture();try{await f.svc.invoke('submit',request(),owner);f.ledger.deleted=true;assert.equal((await f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner)).state,'unknown');assert.equal(f.ledger.accepts,1);const db=new DatabaseSync(join(f.dir,'metadata.sqlite'),{readOnly:true});const dump=JSON.stringify(db.prepare('SELECT * FROM material_requests').all());assert.ok(!dump.includes('source photograph'));assert.ok(!dump.includes('Make a report'));db.close();}finally{f.close();}});
test('capacity rejects rather than discarding live/unknown claims; bounded retention GC',async()=>{const f=fixture({max_requests:1,retention_ms:100});try{await f.svc.invoke('submit',request(),owner);await assert.rejects(f.svc.invoke('submit',{...request(),request_id:'other',client_id:'other'},owner),code('too_large'));assert.equal(f.store.gc(1),0);f.time(10100);assert.equal(f.store.gc(1),1);assert.equal(f.store.get(owner.principal_id,'request-1')?.tombstone,true);f.reopen();await assert.rejects(f.svc.invoke('submit',{...request(),request_id:'new',client_id:'new',expires_at:20000},owner),code('too_large'));}finally{f.close();}});
test('production ledger facade is explicitly unsupported',async()=>{await assert.rejects(new UnsupportedMaterialLedgerFacade().accept(),code('unsupported'));});
test('material_to_work binds selected native target; human/work result shape cannot substitute',async()=>{const f=fixture();try{
  const selected={node_id:'desktop',endpoint_id:'codex',kind:'conversation' as const,native_id:'selected-native-thread'};
  const phoneRequest:CollaborationRequest={...request(),kind:'material_to_work',source:target.source_binding,return_to:target.source_binding,target:{node_id:'desktop',endpoint_id:'codex'},target_work:selected};
  const selectedContext={...owner,source_binding:{kind:'work' as const,work:selected}};
  await f.svc.invoke('submit',phoneRequest,target);
  const reply:MaterialReply={version:1,kind:'work_result',client_id:'work-answer',request_id:'request-1',source:target.source_binding,expires_at:10000,result:{version:1,request_id:'request-1',reply_to:'request-1',result_version:1,source:target.source_binding,target_work:selected,summary:'Selected thread output',assets:[],missing:[],error_code:null,observed_at:100}};
  await assert.rejects(f.svc.invoke('reply',reply,owner),code('not_found'));
  await assert.rejects(f.svc.invoke('reply',{...reply,result:{...reply.result,target_work:{...selected,native_id:'wrong'}}},selectedContext),code('conflict'));
  await assert.rejects(f.svc.invoke('reply',{...reply,kind:'human_answer',pending_id:'invented',question_version:1} as MaterialReply,selectedContext),code('conflict'));
  const result=await f.svc.invoke('reply',reply,selectedContext);assert.equal(result.result?.target_work?.native_id,selected.native_id);
  f.reopen();assert.equal((await f.svc.invoke('get_result',{version:1,request_id:'request-1'},target)).result?.summary,'Selected thread output');
}finally{f.close();}});
test('agent_task observes canonical job and bounded wait, arbitrary reply cannot fill result',async()=>{const f=fixture();try{
  const agentRequest:CollaborationRequest={...request(),kind:'agent_task',target:{node_id:'phone',endpoint_id:'materials',capability_id:'selected.agent'}};
  assert.equal((await f.svc.invoke('submit',agentRequest,owner)).state,'running');
  await f.svc.invoke('await_result',{version:1,request_id:'request-1',wait_ms:10},owner);assert.equal(f.ledger.waits,1);
  const reply:MaterialReply={version:1,kind:'work_result',client_id:'forged-job',request_id:'request-1',source:owner.source_binding,expires_at:10000,result:{version:1,request_id:'request-1',reply_to:'request-1',result_version:1,source:owner.source_binding,target_work:null,summary:'forged',assets:[],missing:[],error_code:null,observed_at:100}};
  await assert.rejects(f.svc.invoke('reply',reply,target),code('conflict'));assert.equal(f.ledger.answers,0);
  f.ledger.mutate('request-1',s=>({...s,fact:{...s.fact,state:'result_available',result:{...reply.result,summary:'canonical job output'}}}));
  assert.equal((await f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner)).result?.summary,'canonical job output');
}finally{f.close();}});
test('disconnect aborts only observation and does not cancel durable execution',async()=>{const f=fixture();try{
  await f.svc.invoke('submit',{...request(),kind:'agent_task',target:{node_id:'phone',endpoint_id:'materials',capability_id:'selected.agent'}},owner);
  const controller=new AbortController();f.ledger.hook=async()=>{controller.abort();};
  await assert.rejects(f.svc.invokeWithSignal('await_result',{version:1,request_id:'request-1',wait_ms:1000},owner,controller.signal),code('offline'));
  f.ledger.hook=undefined;assert.equal((await f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner)).state,'running');assert.equal(f.ledger.accepts,1);
}finally{f.close();}});
test('unknown answer recovery never resubmits, then later lookup repairs it',async()=>{const f=fixture();try{
  const reply=await answer(f);f.ledger.fault='answer';await assert.rejects(f.svc.invoke('reply',reply,target));f.reopen();f.ledger.lookupUnknown=true;
  await assert.rejects(f.svc.invoke('reply',reply,target),code('result_unknown'));assert.equal(f.ledger.answers,0);
  f.ledger.lookupUnknown=false;assert.equal((await f.svc.invoke('reply',reply,target)).state,'result_available');assert.equal(f.ledger.answers,0);
}finally{f.close();}});
test('ledger IO failure does not expose facts after observed revocation',async()=>{const f=fixture();try{f.ledger.hook=async()=>{f.revoke();};f.ledger.fault='accept';await assert.rejects(f.svc.invoke('submit',request(),owner),code('permission_denied'));}finally{f.close();}});
test('receipt requires exact committed destination/version/hash/length; partial assets stay partial',async()=>{const f=fixture();try{
  const reply=await answer(f);
  const asset={kind:'asset' as const,asset_id:'asset-1',version:1,sha256:'a'.repeat(64),byte_length:3,media_type:'image/png',display_name:'source.png',provenance:[],expires_at:10000};
  reply.result.assets=[asset,{...asset,asset_id:'asset-2'}];
  await f.svc.invoke('reply',reply,target);
  const receipt:AssetReceipt={version:1,receipt_id:'receipt-1',transfer_id:'transfer-1',request_id:'request-1',asset_id:'asset-1',asset_version:1,sha256:asset.sha256,byte_length:3,destination:owner.source_binding,received_at:100};
  f.receipts.set(receipt.receipt_id,{...receipt,destination:target.source_binding});await assert.rejects(f.svc.attachReceipt('request-1',1,'receipt-1',owner),code('conflict'));
  f.receipts.set(receipt.receipt_id,{...receipt,byte_length:4});await assert.rejects(f.svc.attachReceipt('request-1',1,'receipt-1',owner),code('conflict'));
  f.receipts.set(receipt.receipt_id,{...receipt,asset_version:2});await assert.rejects(f.svc.attachReceipt('request-1',1,'receipt-1',owner),code('conflict'));
  f.receipts.set(receipt.receipt_id,{...receipt,sha256:'b'.repeat(64)});await assert.rejects(f.svc.attachReceipt('request-1',1,'receipt-1',owner),code('conflict'));
  f.receipts.set(receipt.receipt_id,receipt);await assert.rejects(f.svc.attachReceipt('request-1',2,'receipt-1',owner),code('conflict'));
  const fact=await f.svc.attachReceipt('request-1',1,'receipt-1',owner);assert.equal(fact.receipts.length,1);assert.equal(fact.result?.assets.length,2);assert.equal(fact.claimed_result_version,null);
  const fact2=await f.svc.attachReceipt('request-1',1,'receipt-1',owner);assert.equal(fact2.receipts.length,1);
  const db=new DatabaseSync(join(f.dir,'metadata.sqlite'),{readOnly:true});const rows=db.prepare('SELECT * FROM material_receipts').all() as Record<string,unknown>[];assert.deepEqual(Object.keys(rows[0]).sort(),['asset_id','principal_id','receipt_id','request_id','result_version']);db.close();
}finally{f.close();}});
test('request expires during final after fence, suppressing otherwise successful ledger fact',async()=>{const f=fixture();try{f.ledger.hook=async()=>{f.time(10000);};await assert.rejects(f.svc.invoke('submit',request(),owner),code('expired'));assert.equal(f.store.get(owner.principal_id,'request-1')?.tombstone,true);}finally{f.close();}});
test('independent service/store instances share durable claim before any ledger call',async()=>{const f=fixture();let other:MaterialRequestStore|undefined;try{
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});let entered!:()=>void;const atHook=new Promise<void>(r=>{entered=r;});
  f.ledger.hook=async()=>{entered();await held;};const first=f.svc.invoke('submit',request(),owner);await atHook;
  other=new MaterialRequestStore({file:join(f.dir,'metadata.sqlite'),now:()=>100});
  const authorization:MaterialAuthorization={before:async c=>({...c}),after:async()=>{},current:()=>undefined};
  const second=new CoreMaterialRequestService({store:other,ledger:f.ledger,authorization,currentContext:()=>undefined,resolveExternalMember:async()=> 'external:limited-member',now:()=>100});
  assert.equal((await second.invoke('submit',request(),owner)).state,'waiting_owner');release();await first;assert.equal(f.ledger.accepts,1);
}finally{other?.close();f.close();}});
test('pending before and after authorization IO are bounded and never expose success',async()=>{const f=fixture({operation_timeout_ms:10});try{
  const old=f.auth.before;f.auth.before=async()=>new Promise<MaterialTrustedContext>(()=>{});
  await assert.rejects(f.svc.invoke('submit',request(),owner),code('timeout'));assert.equal(f.ledger.accepts,0);
  f.auth.before=old;f.auth.after=async()=>new Promise<void>(()=>{});
  await assert.rejects(f.svc.invoke('submit',request(),owner),code('timeout'));
}finally{f.close();}});
test('current final fence runs after async auth check and suppresses successful result return on revoke',async()=>{const f=fixture();try{
  const reply=await answer(f);await f.svc.invoke('reply',reply,target);
  const original=f.auth.after;let checks=0;f.auth.after=async c=>{await original(c,{kind:'discovery',action:'discover',target:{node_id:'phone',endpoint_id:'materials'}});if(++checks===3)f.revoke();};
  await assert.rejects(f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner),code('permission_denied'));
}finally{f.close();}});
test('second asset receipt ID locates its canonical asset and survives normal rereads/reopen',async()=>{const f=fixture();try{
  const reply=await answer(f);const asset={kind:'asset' as const,asset_id:'first',version:1,sha256:'a'.repeat(64),byte_length:3,media_type:'image/png',display_name:'source.png',provenance:[],expires_at:10000};
  reply.result.assets=[asset,{...asset,asset_id:'second',sha256:'b'.repeat(64)}];await f.svc.invoke('reply',reply,target);
  const receipt:AssetReceipt={version:1,receipt_id:'second-receipt',transfer_id:'second-transfer',request_id:'request-1',asset_id:'second',asset_version:1,sha256:'b'.repeat(64),byte_length:3,destination:owner.source_binding,received_at:100};f.receipts.set(receipt.receipt_id,receipt);
  assert.equal((await f.svc.attachReceipt('request-1',1,receipt.receipt_id,owner)).receipts[0]?.asset_id,'second');
  assert.equal((await f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner)).receipts[0]?.receipt_id,receipt.receipt_id);
  f.reopen();assert.equal((await f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner)).receipts[0]?.asset_id,'second');
}finally{f.close();}});
test('attachReceipt captures reused mutable connector context before its first await',async()=>{const f=fixture();try{
  const reply=await answer(f);const asset={kind:'asset' as const,asset_id:'asset',version:1,sha256:'a'.repeat(64),byte_length:3,media_type:'image/png',display_name:'source.png',provenance:[],expires_at:10000};reply.result.assets=[asset];await f.svc.invoke('reply',reply,target);
  const receipt:AssetReceipt={version:1,receipt_id:'receipt',transfer_id:'transfer',request_id:'request-1',asset_id:'asset',asset_version:1,sha256:asset.sha256,byte_length:3,destination:owner.source_binding,received_at:100};f.receipts.set(receipt.receipt_id,receipt);
  const reused=structuredClone(owner);const original=f.auth.before;let seen=false;
  f.auth.before=async(c,s)=>{const value=await original(c,s);if(!seen){seen=true;reused.principal_id='next-connector';reused.source_binding=target.source_binding;}return value;};
  assert.equal((await f.svc.attachReceipt('request-1',1,receipt.receipt_id,reused)).receipts[0]?.receipt_id,'receipt');
  assert.equal(f.store.receipts(f.store.get(owner.principal_id,'request-1')!,1)[0],'receipt');
}finally{f.close();}});
test('complete question expiry is fixed metadata across reads and cold reopen',async()=>{const f=fixture();try{
  await f.svc.invoke('submit',request(),owner);assert.equal(f.store.get(owner.principal_id,'request-1')?.question?.expires_at,10000);f.reopen();
  f.ledger.mutate('request-1',s=>({...s,fact:{...s.fact,question:{...s.fact.question!,expires_at:9000}}}));
  await assert.rejects(f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner),code('conflict'));
  assert.equal(f.store.get(owner.principal_id,'request-1')?.question?.expires_at,10000);
}finally{f.close();}});
test('initial question cannot exceed admission lease; shorter fresh lease does not rewrite question',async()=>{const f=fixture();try{
  const short={...owner,expires_at:9000};await assert.rejects(f.svc.invoke('submit',request(),short),code('conflict'));
  assert.equal(f.store.get(owner.principal_id,'request-1')?.question,null);
}finally{f.close();}
const f2=fixture();try{await f2.svc.invoke('submit',request(),owner);await assert.rejects(f2.svc.invoke('get_result',{version:1,request_id:'request-1'},{...owner,expires_at:9000}),code('permission_denied'));assert.equal(f2.store.get(owner.principal_id,'request-1')?.question?.expires_at,10000);}finally{f2.close();}});
test('GC preserves unknown/registered and reply dedupe tombstones after retention and cold reopen',async()=>{const f=fixture({retention_ms:100,max_requests:2});try{
  f.ledger.fault='accept';await assert.rejects(f.svc.invoke('submit',request(),owner));f.reopen();f.ledger.lookupUnknown=true;await f.svc.invoke('submit',request(),owner);
  const second={...request(),request_id:'registered-request',client_id:'registered-client'};f.ledger.fault='accept';await assert.rejects(f.svc.invoke('submit',second,owner));assert.equal(f.store.get(owner.principal_id,second.request_id)?.state,'registered');
  f.time(10100);assert.equal(f.store.gc(1),1);assert.equal(f.store.gc(1),1);assert.equal(f.store.gc(1),0);f.reopen();
  await assert.rejects(f.svc.invoke('submit',{...request(),expires_at:20000},owner),code('conflict'));await assert.rejects(f.svc.invoke('submit',{...second,expires_at:20000},owner),code('conflict'));assert.equal(f.ledger.accepts,0);
}finally{f.close();}
const f2=fixture({retention_ms:100});try{const reply=await answer(f2);await f2.svc.invoke('reply',reply,target);const row=f2.store.get(owner.principal_id,'request-1')!;f2.time(10100);f2.store.gc();f2.reopen();const persisted=f2.store.get(owner.principal_id,'request-1')!;assert.equal(persisted.tombstone,true);const hash=await import('../../device/src/collaboration/material-protocol');assert.equal(f2.store.claimReply(persisted,target.principal_id,reply.client_id,hash.materialPayloadHash(reply)).fresh,false);assert.equal(row.client_id,persisted.client_id);}finally{f2.close();}});
test('normal multi-asset result finishes with every exact asset current fence after the final main after',async()=>{const f=fixture();try{
  const reply=await answer(f);const asset={kind:'asset' as const,asset_id:'first',version:1,sha256:'a'.repeat(64),byte_length:3,media_type:'image/png',display_name:'source.png',provenance:[],expires_at:10000};reply.result.assets=[asset,{...asset,asset_id:'second'}];await f.svc.invoke('reply',reply,target);
  for(const id of ['first','second']){const receipt:AssetReceipt={version:1,receipt_id:`receipt-${id}`,transfer_id:`transfer-${id}`,request_id:'request-1',asset_id:id,asset_version:1,sha256:asset.sha256,byte_length:3,destination:owner.source_binding,received_at:100};f.receipts.set(receipt.receipt_id,receipt);await f.svc.attachReceipt('request-1',1,receipt.receipt_id,owner);}
  const events:string[]=[];const originalAfter=f.auth.after;const originalCurrent=f.auth.current;
  f.auth.after=async(c,s)=>{await originalAfter(c,s);events.push(s.kind==='request'&&s.transfer ? `after:${s.transfer.asset_id}`:'after:main');};
  f.auth.current=(c,s)=>{originalCurrent(c,s);events.push(s.kind==='request'&&s.transfer ? `current:${s.transfer.asset_id}`:'current:main');return undefined;};
  assert.equal((await f.svc.invoke('get_result',{version:1,request_id:'request-1'},owner)).receipts.length,2);
  const tail=events.slice(events.lastIndexOf('after:main')+1);assert.ok(tail.includes('current:first'));assert.ok(tail.includes('current:second'));assert.ok(!tail.some(e=>e.startsWith('after:')));
}finally{f.close();}});
