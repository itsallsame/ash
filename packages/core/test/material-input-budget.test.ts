import test from 'node:test';import assert from 'node:assert/strict';
import {MaterialInputService,MATERIAL_INPUT_OPERATION_MS} from '../src/collaboration/material-input-service';
// Only the existing dispatch lifecycle is isolated here. This seam does not
// issue authority or claim a material/native accepted receipt.
function fixture(){const service=new MaterialInputService({runtime:{current:()=>undefined}} as any);let release!:()=>void,entered=false,lateCode:string|undefined;
 const held=new Promise<void>(r=>release=r);
 (service as any).run=async(_path:string,_input:unknown,request:any)=>{entered=true;await held;try{(service as any).current(request);return (service as any).result(request,undefined,{done:true});}catch(error){lateCode=(error as any).code;throw error;}};
 return {service,release:()=>release(),entered:()=>entered,lateCode:()=>lateCode,request:{method:'POST',url:new URL('http://core.local/api/collaboration/material/ui/input/submit'),headers:{},body:null}};
}
test('fixed overall input deadline rejects late work without releasing physical pending ownership',async t=>{
 assert.equal(MATERIAL_INPUT_OPERATION_MS,180_000);
 t.mock.timers.enable({apis:['Date','setTimeout']});
 for(const path of ['input/submit','input/send','input/retry']){
  const f=fixture(),response=f.service.dispatch(path,{},f.request),rejected=assert.rejects(response,{code:'timeout'});await Promise.resolve();assert.equal(f.entered(),true);
  t.mock.timers.tick(MATERIAL_INPUT_OPERATION_MS-1);assert.equal(f.service.busy,1);t.mock.timers.tick(1);await rejected;assert.equal(f.service.busy,1);
  f.release();await f.service.close();assert.equal(f.lateCode(),'timeout');assert.equal(f.service.busy,0);
 }
});
test('client cancellation remains offline and pending stays owned until actual settlement',async()=>{
 const f=fixture(),parent=new AbortController(),response=f.service.dispatch('input/submit',{}, {...f.request,signal:parent.signal}),rejected=assert.rejects(response,{code:'offline'});await Promise.resolve();parent.abort();await rejected;assert.equal(f.service.busy,1);f.release();await f.service.close();assert.equal(f.service.busy,0);assert.equal(f.lateCode(),'offline');
});
test('parent cancellation after raw settlement still invalidates the returned receipt fence',async()=>{
 const f=fixture(),parent=new AbortController(),response=f.service.dispatch('input/submit',{}, {...f.request,signal:parent.signal});await Promise.resolve();f.release();const receipt=await response;
 assert.equal(f.service.busy,0);receipt.current();parent.abort();assert.throws(()=>receipt.current(),{code:'offline'});await f.service.close();
});
test('query receives no new input-operation deadline and a trusted shorter deadline cannot be extended',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});
 const query=fixture(),response=query.service.dispatch('input/query',{},query.request);await Promise.resolve();t.mock.timers.tick(MATERIAL_INPUT_OPERATION_MS);assert.equal(query.service.busy,1);query.release();const result=await response;result.current();await query.service.close();
 const shorter=fixture(),limited=shorter.service.dispatch('input/send',{}, {...shorter.request,collaborationDeadline:Date.now()+1000}),rejected=assert.rejects(limited,{code:'timeout'});await Promise.resolve();t.mock.timers.tick(1000);await rejected;assert.equal(shorter.service.busy,1);shorter.release();await shorter.service.close();assert.equal(shorter.lateCode(),'timeout');
});
