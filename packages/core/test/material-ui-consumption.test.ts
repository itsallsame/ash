import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {productionFixture} from './fixtures/material-production';
import {MaterialUiService} from '../src/collaboration/material-ui-service';
import {MaterialTransferService} from '../../device/src/collaboration/material-transfer';
import type {AssetRef,AssetInputs,AssetOperation} from '../../device/src/collaboration/material-types';

// Ordinary A4 contract regression; this fixture's host actor is explicitly testing-only.
for(const assetCount of [2,1])test(`explicit result consumption requires all original reads (${assetCount} files), including the compatible single-handle entry`,async()=>{
 const f=await productionFixture();let ui:MaterialUiService|undefined;try{
  const request=f.request();f.registry.registerRequest(f.management,request,f.workProof,f.phoneProof);
  const submitted=await f.service.invoke('submit',request,f.registry.context(f.workProof));
  const assets:AssetRef[]=Array.from({length:assetCount},(_,i)=>i).map(index=>{const bytes=Buffer.from('original result '+index);return {kind:'asset',asset_id:'result-'+index,version:1,sha256:createHash('sha256').update(bytes).digest('hex'),byte_length:bytes.length,media_type:'text/plain',display_name:'result.txt',provenance:[],expires_at:request.expires_at};});
  for(const asset of assets)f.registry.registerAsset(f.management,f.registry.context(f.phoneProof),{request_id:request.request_id,asset,source:f.phone,destination:f.work});
  const phone=f.registry.context(f.phoneProof),source=f.registry.context(f.workProof),identities:AssetInputs['commit'][]=[];
  const binding=async<K extends AssetOperation>(action:K,input:AssetInputs[K])=>{const scope=f.registry.resolveTransferScope(action,input,phone);return {context:phone,scope,lease:await f.authorization.before(phone,scope)};};
  for(const [index,asset]of assets.entries()){
   const offer:AssetInputs['offer']={version:1,request_id:request.request_id,asset,source:f.phone,destination:f.work,expires_at:request.expires_at};
   const opened=await f.workStore.offer(offer,await binding('offer',offer)),identity={version:1 as const,request_id:request.request_id,asset_id:asset.asset_id,asset_version:1,transfer_id:opened.transfer_id};
   const chunk={...identity,chunk_index:0,data_base64:Buffer.from('original result '+index).toString('base64')};await f.workStore.putChunk(chunk,await binding('put_chunk',chunk));await f.workStore.commit(identity,await binding('commit',identity));identities.push(identity);
  }
  await f.service.invoke('reply',{version:1,kind:'human_answer',client_id:'original-reply',request_id:request.request_id,source:request.source,pending_id:submitted.question!.pending_id,question_version:submitted.question!.question_version,expires_at:request.expires_at,result:{version:1,request_id:request.request_id,reply_to:request.request_id,result_version:1,source:request.source,target_work:null,summary:'two files',assets,missing:[],error_code:null,observed_at:Date.now()}},phone);
  const transfer=new MaterialTransferService({store:f.workStore,authorization:f.authorization,currentContext:f.authorization.currentContext,resolveScope:async(action,input,context)=>f.registry.resolveTransferScope(action,input,context)});
  ui=new MaterialUiService({registry:f.registry,ledger:f.ledger,facade:f.facade,requests:f.service,index:f.index,authorization:f.authorization,stores:new Map([['work-store',{store:f.workStore,custody:f.workCustody,transfer}]]),track:work=>work(),current:()=>undefined});
  const reads=await Promise.all(identities.map(identity=>ui!.readAsset(source.principal_id,request.request_id,1,identity,source)));
  assert.deepEqual(reads.map(read=>Buffer.from(read.value.bytes).toString()),Array.from({length:assetCount},(_,i)=>'original result '+i));
  const handles=reads.map(read=>read.value.consume_handle),projection=await ui.readRequest(source.principal_id,request.request_id,source);assert.equal(projection.value.fact.claimed_result_version,null);
  if(assetCount===1){const consumed=await ui.consumeResult(handles[0],source);assert.equal(consumed.value.claimed_result_version,1);await assert.rejects(ui.consumeResult(handles[0],source));reads[0].value.bytes.fill(0);return;}
  await assert.rejects(ui.consumeResult(handles[0],source),{code:'permission_denied'});
  assert.equal((await ui.readRequest(source.principal_id,request.request_id,source)).value.fact.claimed_result_version,null);
  await assert.rejects(ui.consumeCurrentResult(source.principal_id,request.request_id,1,[],source));
  await assert.rejects(ui.consumeCurrentResult(source.principal_id,request.request_id,1,[handles[0]],source));
  await assert.rejects(ui.consumeCurrentResult(source.principal_id,request.request_id,1,[handles[0],handles[0]],source),{code:'invalid'});
  await assert.rejects(ui.consumeCurrentResult(source.principal_id,request.request_id,2,handles,source),{code:'conflict'});
  const consumed=await ui.consumeCurrentResult(source.principal_id,request.request_id,1,handles,source);assert.equal(consumed.value.claimed_result_version,1);
  await assert.rejects(ui.consumeCurrentResult(source.principal_id,request.request_id,1,handles,source));
  for(const read of reads)read.value.bytes.fill(0);
 }finally{ui?.close();await f.close();}
});
