import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceKey,GatewayClient} from 'ash-gateway/client/client';
import {productionFixture} from './fixtures/material-production';
import {DeviceMaterialRuntime} from '../../device/src/collaboration/material-runtime';
import {MATERIAL_REQUEST_TYPE,type MaterialRelayTransport} from '../../device/src/collaboration/material-client';
import type {MaterialRequestService} from '../../device/src/collaboration/material-types';

test('actual device delegated requests retain bounded raw slots across A3 observer invalidation and close',async()=>{
 const f=await productionFixture(),remote=await DeviceKey.generate();let runtime:DeviceMaterialRuntime|undefined;const releases:Array<()=>void>=[];try{
 const pairing='testing-host-pair',transport:MaterialRelayTransport={async capture(){return {local_id:f.signer.id,peer_id:remote.id,public_key:remote.publicKey,pairing_id:pairing,generation:'1'};},current(){return undefined;},send(){return undefined;}},ctx=f.registry.context(f.workProof),inputs:string[]=[];
 const requests:MaterialRequestService={invoke:((_action,input)=>{inputs.push((input as {request_id:string}).request_id);return new Promise(resolve=>releases.push(()=>resolve({version:1,request_id:'req',state:'waiting_owner',question:null,result:null,claimed_result_version:null,receipts:[],error:null} as any)));}) as MaterialRequestService['invoke']};
 runtime=await DeviceMaterialRuntime.open({signer:f.signer,rootDir:f.options.stores[1].root_dir,localStoreId:'work-store',custody:f.workCustody,authorization:f.authorization,currentContext:context=>f.registry.currentContext(context),physicalCurrent:()=>{f.registry.currentPhysicalStore('work-store');return undefined;},resolveScope:async(action,input,context)=>f.registry.resolveTransferScope(action,input,context),gateway:new GatewayClient('https://fixture.invalid',f.signer as DeviceKey),transport,bindings:{async resolve(){return {context:ctx,current:()=>f.registry.currentContext(ctx)};}},requests});
 const sender=new GatewayClient('https://fixture.invalid',remote);for(let i=0;i<32;i++){const frame=await sender.envelope(MATERIAL_REQUEST_TYPE,f.signer.id,{version:1,call_id:'call-'+i,binding_id:'testing-host-binding',operation:'get_result',input:{version:1,request_id:'req'}},{ttlMs:29999});const observed=runtime.acceptFrame(frame);for(let attempt=0;releases.length<i+1&&attempt<200;attempt++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(releases.length,i+1);runtime.invalidate();await observed;assert.equal(runtime.busy,i+1);}
 assert.equal(inputs.length,32);const frame=await sender.envelope(MATERIAL_REQUEST_TYPE,f.signer.id,{version:1,call_id:'overflow',binding_id:'testing-host-binding',operation:'get_result',input:{version:1,request_id:'req'}},{ttlMs:29999});await runtime.acceptFrame(frame);assert.equal(inputs.length,32);assert.equal((await runtime.close(1)).state,'draining');assert.equal(runtime.busy,32);releases.forEach(release=>release());assert.equal((await runtime.close()).state,'closed');
 }finally{releases.forEach(release=>release());await runtime?.close();await f.close();}
});
