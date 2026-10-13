import test from 'node:test';import assert from 'node:assert/strict';
import { targetFixture } from './fixtures/material-target';
import { currentMaterialTargetProof,type MaterialTargetWorkProof } from '../src/collaboration/material-target-provider';
import { MaterialRegistry,type MaterialActorProof } from '../src/collaboration/material-registry';
import type { CollaborationRequest } from '../../device/src/collaboration/material-types';
function request(f:Awaited<ReturnType<typeof targetFixture>>,id='input'):CollaborationRequest{return {version:1,request_id:id,client_id:'client-'+id,source:{kind:'node',node_id:f.phone.id,endpoint_id:'materials'},return_to:{kind:'node',node_id:f.phone.id,endpoint_id:'materials'},target:{node_id:f.desktop.id,endpoint_id:'codex'},target_work:f.work,kind:'material_to_work',purpose:'phone selected material',context:{goal:'input',confirmed_decisions:[],increment:'input',expected_output:'input',uncertain:[],missing:[],refs:[],provenance:[]},expected_output:'input',expires_at:Date.now()+300000};}
test('production paired Link transports and actual Unix metadata register phone input without host proof or target reply',{timeout:60000},async()=>{
 const f=await targetFixture();let reopened:MaterialRegistry|undefined;try{
 const proof=await f.provider.captureTarget(f.input()),record=currentMaterialTargetProof(proof),registry=f.entry.runtime.registry,admin=registry.management(f.headers,f.screen.token),source=registry.localNodeActor(admin,'materials',Date.now()+600000),req=request(f);
 const row=registry.registerInputTarget(admin,req,source,proof);assert.equal(row.target_purpose,'input_target');assert.equal(row.expires_at,req.expires_at);assert.ok(row.expires_at>record.facts.expires_at);assert.equal(record.facts.cwd,f.grant.scope.cwd);assert.equal(registry.currentInputTarget(row),undefined);
 assert.throws(()=>registry.context(proof as unknown as MaterialActorProof));assert.throws(()=>registry.currentProducer(row));await assert.rejects(registry.workActor(admin,'no-host'),{code:'unsupported'});
 assert.throws(()=>registry.registerRequest(admin,req,source,proof as unknown as MaterialActorProof));assert.throws(()=>registry.registerInputTarget(admin,req,proof as unknown as MaterialActorProof,proof));assert.throws(()=>registry.registerInputTarget(admin,{...req,kind:'agent_task',target_work:null},source,proof));assert.throws(()=>registry.registerInputTarget(admin,{...req,target_work:{...f.work,native_id:'same-name-other-id'}},source,proof));assert.throws(()=>registry.registerInputTarget(admin,req,source,{...proof} as MaterialTargetWorkProof));
 const context=registry.context(source);assert.equal(registry.authorizeDiscovery(context,{kind:'discovery',action:'discover',target:req.target}).request_id,req.request_id);assert.throws(()=>registry.authorizeAdmissionActor(context,row,'answer'));
 const submitted=await f.entry.runtime.requests.invoke('submit',req,context);assert.equal(submitted.request_id,req.request_id);assert.equal(submitted.question,null);assert.equal(f.calls.filter(c=>c.method==='thread/read').length,2);assert.deepEqual(new Set(f.calls.map(c=>c.method)),new Set(['initialize','initialized','thread/read']));assert.equal(f.calls.find(c=>c.method==='thread/read')!.params.includeTurns,false);
 reopened=await MaterialRegistry.open(f.options);assert.equal(reopened.request(row.owner,row.request_id)!.target_purpose,'input_target');assert.throws(()=>reopened!.currentInputTarget(row),{code:'unsupported'});const admin2=reopened.management(f.headers,f.screen.token),src2=reopened.localNodeActor(admin2,'materials',Date.now()+600000);assert.throws(()=>reopened!.registerInputTarget(admin2,req,src2,proof));const recaptured=await f.provider.captureTarget(f.input());reopened.registerInputTarget(admin2,req,src2,recaptured);assert.equal(reopened.currentInputTarget(row),undefined);
 }finally{reopened?.close();await f.close();}
});
test('exact metadata, control revision, peer ABA and proof lifecycle reject mismatches',{timeout:60000},async()=>{
 const f=await targetFixture();try{
 await assert.rejects(f.provider.captureTarget({...f.input(),work:{...f.work,node_id:f.phone.id}}),{code:'permission_denied'});
 await assert.rejects(f.provider.captureTarget({...f.input(),work:{...f.work,endpoint_id:'other'}}),{code:'permission_denied'});await assert.rejects(f.provider.captureTarget({...f.input(),work:{...f.work,native_id:'same-name-other-id'}}),{code:'permission_denied'});
 const proof=await f.provider.captureTarget(f.input()),record=currentMaterialTargetProof(proof);f.changeGrant({allowed_actions:['steer'],authorization_generation:2});await f.settle();assert.equal(await record.check(),false);f.changeGrant({});await f.settle();assert.throws(()=>record.current());
 f.setCwd(f.root);await assert.rejects(f.provider.captureTarget(f.input()),{code:'permission_denied'});f.setCwd(f.grant.scope.cwd);
 f.deleteThread();await assert.rejects(f.provider.captureTarget(f.input()),{code:'permission_denied'});
 assert.equal(f.calls.some(c=>['turn/start','thread/resume','turn/steer'].includes(c.method)),false);
 }finally{await f.close();}
});
test('missing control reports offline and close invalidates signed target evidence',{timeout:60000},async()=>{
 const f=await targetFixture();try{const proof=await f.provider.captureTarget(f.input()),record=currentMaterialTargetProof(proof);f.provider.invalidate();assert.throws(()=>record.current());await f.runtime.close();await assert.rejects(f.provider.captureTarget(f.input()),{code:'offline'});}finally{await f.close();}
});
test('endpoint retains original capture through deferred signing; grant revoke/restore sends zero stale proof',{timeout:60000},async()=>{
 const f=await targetFixture();let release!:()=>void;try{const original=f.endpointGateway.envelope.bind(f.endpointGateway);let start!:()=>void;const ready=new Promise<void>(r=>start=r),gate=new Promise<void>(r=>release=r);f.endpointGateway.envelope=async(...args)=>{const e=await original(...args);start();await gate;return e;};
 const pending=f.provider.captureTarget(f.input()),reject=assert.rejects(pending,{code:'offline'});await ready;assert.equal(f.endpoint.inflight,1);assert.ok(f.targetWork.busy>0);f.changeGrant({allowed_actions:['steer'],authorization_generation:2});await f.settle();f.changeGrant({});await f.settle();assert.ok(f.targetWork.busy>0);f.provider.close();release();await reject;for(let i=0;i<100&&f.targetWork.busy;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.targetWork.busy,0);assert.equal(f.endpoint.inflight,0);assert.equal(f.responses.length,0);
 }finally{release?.();await f.close();}
});
test('native cwd change during endpoint signing is rechecked before final send',{timeout:60000},async()=>{
 const f=await targetFixture();let release!:()=>void;try{const original=f.endpointGateway.envelope.bind(f.endpointGateway);let start!:()=>void;const ready=new Promise<void>(r=>start=r),gate=new Promise<void>(r=>release=r);f.endpointGateway.envelope=async(...args)=>{const e=await original(...args);start();await gate;return e;};const pending=f.provider.captureTarget(f.input()),reject=assert.rejects(pending,{code:'offline'});await ready;assert.equal(f.calls.filter(c=>c.method==='thread/read').length,1);f.setCwd(f.root);await f.settle();release();for(let i=0;i<300&&f.targetWork.busy;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.targetWork.busy,0);assert.equal(f.calls.filter(c=>c.method==='thread/read').length,2);assert.equal(f.responses.length,0);f.provider.close();await reject;
 }finally{release?.();await f.close();}
});
