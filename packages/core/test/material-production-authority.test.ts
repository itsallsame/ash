import test from 'node:test';
import assert from 'node:assert/strict';
import {productionFixture} from './fixtures/material-production';

test('real screen registration, durable admission and exact cloned context; H3 fixture is explicit',async()=>{
 const f=await productionFixture();try{
 const request=f.request();f.registry.registerRequest(f.management,request,f.workProof,f.phoneProof);
 const ctx=f.registry.context(f.workProof),fact=await f.service.invoke('submit',request,ctx);assert.equal(fact.state,'waiting_owner');assert.ok(fact.question);
 assert.equal(f.ledger.list().length,1);assert.equal(f.registry.request(ctx.principal_id,'req')?.locator?.ledger_request_id,f.ledger.list()[0]?.id);
 const scope={kind:'request' as const,action:'get_result' as const,request_id:'req',source:request.source,return_to:request.return_to,target:f.phone,transfer:null};
 const lease=await f.authorization.before(ctx,scope);f.authorization.current(structuredClone(lease),scope);
 assert.throws(()=>f.registry.currentContext({...ctx,principal_id:'person:owner'}));assert.throws(()=>f.registry.currentManagement(structuredClone(f.management)));
 f.revokeHost();assert.throws(()=>f.authorization.current(lease,scope));
 }finally{await f.close();}
});

import {MaterialRegistry} from '../src/collaboration/material-registry';
import {RegistryMaterialAdmissionAuthority,RegistryMaterialAuthorization,RegistryMaterialCustodyAuthority} from '../src/collaboration/material-authorization';
import {MaterialDurableLedgerFacade} from '../src/collaboration/material-durable-ledger';
import {materialStableKey} from '../src/collaboration/material-request-store';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {writeFileSync,readFileSync,lstatSync} from 'node:fs';

test('production H3/remote peer absence denies; fake and released management proofs deny',async()=>{
 const f=await productionFixture();let other:MaterialRegistry|undefined;try{
 other=await MaterialRegistry.open({...f.options,environment:'production'});const management=other.management(f.headers,f.screen.token);
 await assert.rejects(other.workActor(management,'absent-H3'));await assert.rejects(other.remoteNodeActor(management,'unproven-peer','materials',Date.now()+60000));
 assert.throws(()=>other!.localNodeActor({management:'material'},'materials',Date.now()+60000));other.releaseManagement(management);assert.throws(()=>other!.currentManagement(management));
 }finally{other?.close();await f.close();}
});

test('stable key / reply request exactness with multiple registrations; fake permits and role mismatch',async()=>{
 const f=await productionFixture();try{
 const first=f.request(),second=f.request('second');f.registry.registerRequest(f.management,first,f.workProof,f.phoneProof);f.registry.registerRequest(f.management,second,f.workProof,f.phoneProof);
 const context=f.registry.context(f.workProof),owner=context.principal_id,binding={context,owner_principal_id:owner,external_member_id:f.registry.externalMember(owner,first.source)};
 const input={action:'lookup' as const,binding,request:null,reply:null,stableKey:materialStableKey(owner,second.client_id,'submit'),locator:null};
 const permit=await f.admission.before(input);f.admission.current(permit);assert.throws(()=>f.admission.current(structuredClone(permit)));f.admission.release(permit);assert.throws(()=>f.admission.current(permit));
 await assert.rejects(f.admission.before({...input,stableKey:null}));await assert.rejects(f.admission.before({...input,stableKey:'unregistered'}));
 const phone=f.registry.context(f.phoneProof);await assert.rejects(f.admission.before({...input,binding:{...binding,context:phone}}));
 const secondFact=await f.service.invoke('submit',first,context);assert.ok(secondFact.question);
 const reply={version:1 as const,kind:'human_answer' as const,client_id:'wrong',request_id:'second',source:second.source,pending_id:secondFact.question!.pending_id,question_version:1,expires_at:second.expires_at,result:{version:1 as const,request_id:'second',reply_to:'second',result_version:1,source:second.source,target_work:null,summary:'wrong question',assets:[],missing:[],error_code:null,observed_at:Date.now()}};
 await assert.rejects(f.service.invoke('reply',reply,phone));assert.equal(f.ledger.list().length,1);
 }finally{await f.close();}
});

test('disk grant ABA, watcher error, real pairing state and signer changes permanently stale contexts',async()=>{
 const f=await productionFixture();try{
 const r=f.request();f.registry.registerRequest(f.management,r,f.workProof,f.phoneProof);const old=f.registry.context(f.workProof);
 const db=new DatabaseSync(join(f.root,'state','material-registry.sqlite'));db.exec("UPDATE material_registry_grants SET revoked=1;UPDATE material_registry_grants SET revoked=0;");db.close();assert.throws(()=>f.registry.currentContext(old));
 const fresh=f.registry.context(f.workProof);const token=f.state.capture();f.state.write('paired.json',JSON.stringify({version:1,owner_id:'different'}),token);assert.throws(()=>f.registry.currentContext(fresh));
 }finally{await f.close();}
 const failed=await productionFixture();try{const ctx=failed.registry.context(failed.workProof);failed.registry.failClosed();assert.throws(()=>failed.registry.currentContext(ctx));}finally{await failed.close();}
 const signer=await productionFixture();try{const ctx=signer.registry.context(signer.workProof),file=join(signer.root,'state','device.jwk'),bytes=readFileSync(file);writeFileSync(file,bytes,{mode:0o600});assert.throws(()=>signer.registry.currentContext(ctx));}finally{await signer.close();}
});

test('bounded metadata retains tombstones and reopened registry keeps canonical authority',async()=>{
 const f=await productionFixture(2);let reopened:MaterialRegistry|undefined;try{
 const r=f.request();f.registry.registerRequest(f.management,r,f.workProof,f.phoneProof);const context=f.registry.context(f.workProof);await f.service.invoke('submit',r,context);
 reopened=await MaterialRegistry.open({...f.options,max_records:2});const row=reopened.request(context.principal_id,'req');assert.ok(row?.locator);assert.equal(row?.payload_hash,f.registry.request(context.principal_id,'req')?.payload_hash);
 assert.equal(lstatSync(join(f.root,'state','material-registry.sqlite')).mode&0o777,0o600);
 f.registry.revokeRequest(f.management,context.principal_id,'req');assert.throws(()=>f.registry.registerRequest(f.management,f.request('new'),f.workProof,f.phoneProof));
 }finally{reopened?.close();await f.close();}
});

test('cross-owner request IDs remain distinct and ambiguous target denies; registered producer exact work fences internal actions',async()=>{
 const f=await productionFixture();try{
 const targetProof=await f.registry.workActor(f.management,'testing-target'),target=f.registry.context(targetProof),first=f.request();
 f.registry.registerRequest(f.management,first,f.workProof,f.phoneProof);
 const other={...first,client_id:'other-client',source:target.source_binding,return_to:target.source_binding};f.registry.registerRequest(f.management,other,targetProof,f.phoneProof);
 const source=f.registry.context(f.workProof),second=f.registry.context(targetProof);assert.ok(f.registry.request(source.principal_id,'req'));assert.ok(f.registry.request(second.principal_id,'req'));assert.throws(()=>f.registry.requestForActor(f.registry.context(f.phoneProof),'req'));
 const agent={...f.request('job'),kind:'agent_task' as const,target:{node_id:target.source_binding.kind==='work'?target.source_binding.work.node_id:'invalid',endpoint_id:'codex',capability_id:'testing.restricted'},target_work:null};f.registry.registerRequest(f.management,agent,f.workProof,targetProof);
 const context=f.registry.context(f.workProof),binding={context,owner_principal_id:context.principal_id,external_member_id:f.registry.externalMember(context.principal_id,agent.source)},input={action:'dispatch' as const,binding,request:agent,reply:null,stableKey:null,locator:null};
 const result={version:1 as const,request_id:'job',reply_to:'job',result_version:1,source:agent.source,target_work:target.source_binding.kind==='work'?target.source_binding.work:null,summary:'testing adapter result',assets:[],missing:[],error_code:null,observed_at:Date.now()};

 let executions=0;const facade=new MaterialDurableLedgerFacade({ledger:f.ledger,authority:f.admission,taskDispatch:{async authorize(request,bound){assert.equal(request.target.capability_id,'testing.restricted');const registration=f.registry.request(bound.owner_principal_id,request.request_id)!;f.registry.currentProducer(registration);let active=true;return {idempotentRecovery:true,production_work:result.target_work,current(){assert.ok(active);f.registry.currentContext(bound.context);f.registry.currentProducer(registration);return undefined;},async execute(){executions++;return result;},release(){active=false;return undefined;}};},async recoverBinding(){throw Error('explicit test has no recovery fixture');}}});
 const locator=await facade.accept(agent,binding,materialStableKey(context.principal_id,agent.client_id,'submit'));facade.close();assert.equal(executions,1);assert.equal((await f.facade.read(locator,binding))?.fact.result?.summary,result.summary);const canonicalInput={...input,locator};
 await assert.rejects(f.admission.before({...canonicalInput,action:'complete',result:{...result,target_work:{...result.target_work!,native_id:'different'}}}));
 const complete=await f.admission.before({...canonicalInput,action:'complete',result});f.admission.current(complete);f.revokeHost();assert.throws(()=>f.admission.current(complete));
 }finally{await f.close();}
});

test('unregistered versions/directions and request quota deny; fresh context cannot revive revoked transfer grant',async()=>{
 const f=await productionFixture();try{
 const r=f.request();f.registry.registerRequest(f.management,r,f.workProof,f.phoneProof);await f.service.invoke('submit',r,f.registry.context(f.workProof));
 const asset={kind:'asset' as const,asset_id:'slot',version:1,sha256:'a'.repeat(64),byte_length:1,media_type:'text/plain',display_name:'slot',provenance:[],expires_at:r.expires_at};
 assert.throws(()=>f.registry.registerAsset(f.management,f.registry.context(f.phoneProof),{request_id:'req',asset,source:f.work,destination:f.phone}));f.registry.registerAsset(f.management,f.registry.context(f.phoneProof),{request_id:'req',asset,source:f.phone,destination:f.work});
 const context=f.registry.context(f.workProof),input={version:1 as const,request_id:'req',asset_id:'slot',asset_version:2,transfer_id:'not-a-proof',chunk_index:0};assert.throws(()=>f.registry.resolveTransferScope('read_chunk',input,context));
 const scope=f.registry.resolveTransferScope('read_chunk',{...input,asset_version:1},context);await f.authorization.before(context,scope);
 const db=new DatabaseSync(join(f.root,'state','material-registry.sqlite'));db.prepare('UPDATE material_registry_grants SET revoked=1 WHERE actor=?').run(context.principal_id);db.close();const fresh=f.registry.context(f.workProof);await assert.rejects(f.authorization.before(fresh,scope));
 assert.throws(()=>f.registry.registerAsset(f.management,f.registry.context(f.phoneProof),{request_id:'req',asset:{...asset,asset_id:'too-big',byte_length:8*1024*1024},source:f.phone,destination:f.work}));
 }finally{await f.close();}
});

import {LocalStateTransaction} from '../../device/src/collaboration/local-state-transaction';
test('durable management namespace survives a fresh physical-state observer while live generations and owners remain distinct',async()=>{
 const f=await productionFixture();let state:LocalStateTransaction|undefined,other:MaterialRegistry|undefined;try{
 const original=f.registry.managementBinding(f.management);state=new LocalStateTransaction(f.state.stateDir);other=await MaterialRegistry.open({...f.options,state});
 const screen=f.edge.screens.register(f.edge.localCaller(f.headers)!,'new-current-screen'),permit=other.management(f.headers,screen.token),fresh=other.managementBinding(permit);
 assert.equal(fresh.durable_generation,original.durable_generation);assert.notEqual(fresh.generation,original.generation);assert.notEqual(fresh.screen,original.screen);
 (f.tokens.api as Record<string,string>).another='person:owner';const headers={authorization:'Bearer another'},differentScreen=f.edge.screens.register(f.edge.localCaller(headers)!,'different-owner'),different=other.managementBinding(other.management(headers,differentScreen.token));assert.notEqual(different.principal,original.principal);
 const before=fresh.durable_generation,token=state.capture();state.write('collaboration-read.json','{}',token);assert.throws(()=>other!.currentManagement(permit));const after=other.managementBinding(other.management(f.headers,screen.token));assert.notEqual(after.durable_generation,before);
 }finally{other?.close();state?.close();await f.close();}
});
