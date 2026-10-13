import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {open,writeFile} from 'node:fs/promises';
import {productionFixture} from './fixtures/material-production';
import type {AssetInputs,AssetOperation,AssetRef,MaterialReply} from '../../device/src/collaboration/material-types';

test('two A1 roots → real committed receipt → two-stage A2 attachment → ACK',async()=>{
 const f=await productionFixture();try{
 const r=f.request();f.registry.registerRequest(f.management,r,f.workProof,f.phoneProof);
 let work=f.registry.context(f.workProof);const submitted=await f.service.invoke('submit',r,work);assert.ok(submitted.question);
 const bytes=Buffer.from('actual independently committed bytes'),asset:AssetRef={kind:'asset',asset_id:'selected',version:1,sha256:createHash('sha256').update(bytes).digest('hex'),byte_length:bytes.length,media_type:'text/plain',display_name:'selection.txt',provenance:[],expires_at:r.expires_at};
 f.registry.registerAsset(f.management,f.registry.context(f.phoneProof),{request_id:r.request_id,asset,source:f.phone,destination:f.work});
 const phone=f.registry.context(f.phoneProof);work=f.registry.context(f.workProof);
 const binding=async<K extends AssetOperation>(action:K,input:AssetInputs[K],ctx=phone)=>{const scope=f.registry.resolveTransferScope(action,input,ctx);return {context:ctx,lease:await f.authorization.before(ctx,scope),scope};};
 const offer:AssetInputs['offer']={version:1,request_id:r.request_id,asset,source:f.phone,destination:f.work,expires_at:r.expires_at};
 const selected=join(f.root,'actual-selected-source');await writeFile(selected,bytes,{mode:0o600});const handle=await open(selected,'r');try{await f.phoneStore.registerSnapshot(offer,{handle,user_registered:true},await binding('offer',offer));}finally{await handle.close();}
 const snapshot=await f.phoneStore.getSnapshot({version:1,request_id:r.request_id,asset_id:asset.asset_id,asset_version:1},await binding('offer',offer));const snapshotBytes=await f.phoneStore.readSnapshotChunk(snapshot,0,await binding('offer',offer));assert.deepEqual(Buffer.from(snapshotBytes),bytes);
 const sourceBinding=await binding('offer',offer);assert.throws(()=>f.phoneStore.readSnapshotChunk(structuredClone(snapshot),0,sourceBinding));await assert.rejects(binding('read_chunk',{version:1,request_id:r.request_id,asset_id:asset.asset_id,asset_version:1,transfer_id:snapshot.snapshot_id,chunk_index:0}));
 const offered=await f.workStore.offer(offer,await binding('offer',offer));
 const identity={version:1 as const,request_id:r.request_id,transfer_id:offered.transfer_id,asset_id:asset.asset_id,asset_version:1};
 const chunk={...identity,chunk_index:0,data_base64:Buffer.from(snapshotBytes).toString('base64')};await f.workStore.putChunk(chunk,await binding('put_chunk',chunk));
 const committed=await f.workStore.commit(identity,await binding('commit',identity));assert.ok(committed.receipt);
 const reply:MaterialReply={version:1,kind:'human_answer',client_id:'answer',request_id:r.request_id,source:r.source,pending_id:submitted.question!.pending_id,question_version:submitted.question!.question_version,expires_at:r.expires_at,result:{version:1,request_id:r.request_id,reply_to:r.request_id,result_version:1,source:r.source,target_work:null,summary:'single canonical result',assets:[asset],missing:[],error_code:null,observed_at:Date.now()}};
 const answered=await f.service.invoke('reply',reply,phone);assert.equal(answered.state,'result_available');
 const readScope=f.registry.resolveTransferScope('read_chunk',{...identity,chunk_index:0},work);const readLease=await f.authorization.before(work,readScope);
 const receipt=await f.index.record(identity,readLease,readScope);assert.deepEqual(receipt,committed.receipt);
 let calls=0;const original=f.workStore.getTransfer.bind(f.workStore);f.workStore.getTransfer=(...args)=>{calls++;return original(...args);};
 const attached=await f.service.attachReceipt('req',1,receipt.receipt_id,work);assert.deepEqual(attached.receipts,[receipt]);assert.ok(calls>0,'second phase must query actual A1');
 const read=await f.workStore.readChunk({...identity,chunk_index:0},await binding('read_chunk',{...identity,chunk_index:0},work));assert.equal(Buffer.from(read.data_base64,'base64').toString(),bytes.toString());
 const resultAck=await f.service.invoke('ack_result',{version:1,request_id:'req',result_version:1},work);assert.equal(resultAck.claimed_result_version,1);
 const ack={...identity,receipt_id:receipt.receipt_id};assert.equal((await f.workStore.ack(ack,await binding('ack',ack,work))).state,'acknowledged');
 assert.equal(f.ledger.list().length,2);const db=new DatabaseSync(join(f.root,'state','material-registry.sqlite'));assert.equal(db.prepare('SELECT COUNT(*) n FROM material_registry_requests').get()?.n,1);assert.equal(JSON.stringify(db.prepare('SELECT * FROM material_registry_requests').all()).includes('Sole canonical body'),false);db.close();
 }finally{await f.close();}
});

import {MaterialReceiptIndex} from '../src/collaboration/material-receipt-index';
async function committedFixture(reverse=false){
 const f=await productionFixture();const r=f.request();f.registry.registerRequest(f.management,r,f.workProof,f.phoneProof);await f.service.invoke('submit',r,f.registry.context(f.workProof));
 const bytes=Buffer.from('registered bytes'),asset:AssetRef={kind:'asset',asset_id:'registered',version:1,sha256:createHash('sha256').update(bytes).digest('hex'),byte_length:bytes.length,media_type:'text/plain',display_name:'registered.txt',provenance:[],expires_at:r.expires_at};
 const source=reverse?f.work:f.phone,destination=reverse?f.phone:f.work,sourceProof=reverse?f.workProof:f.phoneProof,destinationProof=reverse?f.phoneProof:f.workProof,store=reverse?f.phoneStore:f.workStore,custody=reverse?f.phoneCustody:f.workCustody,storeId=reverse?'phone-store':'work-store';
 f.registry.registerAsset(f.management,f.registry.context(sourceProof),{request_id:'req',asset,source,destination});const context=f.registry.context(sourceProof),reader=f.registry.context(destinationProof);
 async function binding<K extends AssetOperation>(action:K,input:AssetInputs[K]){const scope=f.registry.resolveTransferScope(action,input,context);return {context,lease:await f.authorization.before(context,scope),scope};}
 const offer:AssetInputs['offer']={version:1,request_id:'req',asset,source,destination,expires_at:r.expires_at},first=await store.offer(offer,await binding('offer',offer)),identity={version:1 as const,request_id:'req',transfer_id:first.transfer_id,asset_id:asset.asset_id,asset_version:1},chunk={...identity,chunk_index:0,data_base64:bytes.toString('base64')};await store.putChunk(chunk,await binding('put_chunk',chunk));const fact=await store.commit(identity,await binding('commit',identity));
 const scope=f.registry.resolveTransferScope('read_chunk',{...identity,chunk_index:0},reader),lease=await f.authorization.before(reader,scope);
 return {...f,asset,identity,reader,scope,lease,store,custody,storeId,fact,source,destination};
}

test('both registered directions, duplicate index concurrency and reopened exact original receipt',async()=>{
 for(const reverse of [false,true]){const f=await committedFixture(reverse);let reopened:MaterialReceiptIndex|undefined;try{
 const receipts=await Promise.all([f.index.record(f.identity,f.lease,f.scope),f.index.record(f.identity,f.lease,f.scope)]);assert.deepEqual(receipts[0],receipts[1]);assert.deepEqual(receipts[0],f.fact.receipt);
 reopened=new MaterialReceiptIndex(f.registry,f.authorization,[{local_store_id:f.storeId,store:f.store,custody:f.custody}]);assert.deepEqual(await reopened.record(f.identity,f.lease,f.scope),receipts[0]);assert.deepEqual(await reopened.readReceipt(receipts[0]!.receipt_id,f.lease,f.scope),receipts[0]);
 const fresh=new DatabaseSync(join(f.root,'state','material-receipts.sqlite'));assert.equal(fresh.prepare('SELECT COUNT(*) n FROM material_receipt_index').get()?.n,1);assert.equal(liveRows(fresh).includes('registered bytes'),false);fresh.close();
 }finally{reopened?.close();await f.close();}}
});
function liveRows(db:DatabaseSync){return JSON.stringify(db.prepare('SELECT * FROM material_receipt_index').all());}

test('index candidate cannot substitute for A1 unknown or different physical store; fake custody rejects',async()=>{
 const f=await committedFixture();try{
 const receipt=await f.index.record(f.identity,f.lease,f.scope),request=f.request(),candidateScope={kind:'request' as const,action:'get_result' as const,request_id:'req',source:request.source,return_to:request.return_to,target:f.phone,transfer:null},lease=await f.authorization.before(f.reader,candidateScope);
 assert.deepEqual(await f.index.readReceipt(receipt.receipt_id,lease,candidateScope),receipt);
 const original=f.store.getTransfer.bind(f.store);f.store.getTransfer=async()=>({...f.fact,state:'unknown',receipt:null});await assert.rejects(f.index.readReceipt(receipt.receipt_id,f.lease,f.scope));f.store.getTransfer=original;
 const custody=await f.custody.acquire(f.reader,f.scope,'destination_transfer','wire');assert.throws(()=>f.custody.current(structuredClone(custody)));f.custody.release(custody);assert.throws(()=>f.custody.current(custody));
 await assert.rejects(f.phoneCustody.acquire(f.reader,f.scope,'destination_transfer','wire'));assert.throws(()=>f.registry.localStore('work-store',f.phone));
 f.registry.revokeAsset(f.management,f.reader.principal_id,'req',f.asset.asset_id,1);assert.throws(()=>f.index.readReceipt(receipt.receipt_id,f.lease,f.scope));
 }finally{await f.close();}
});

test('hung A1 observations share canonical slot; timeout/close retain unfinished capacity and reject late result',async()=>{
 const f=await committedFixture();let index:MaterialReceiptIndex|undefined;try{
 index=new MaterialReceiptIndex(f.registry,f.authorization,[{local_store_id:f.storeId,store:f.store,custody:f.custody}],4096,10);
 const original=f.store.getTransfer.bind(f.store);let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);let calls=0;
 f.store.getTransfer=async(...args)=>{calls++;await held;return original(...args);};
 await Promise.all([assert.rejects(index.record(f.identity,f.lease,f.scope)),assert.rejects(index.record(f.identity,f.lease,f.scope))]);assert.equal(calls,1);
 await assert.rejects(index.record(f.identity,f.lease,f.scope));assert.equal(calls,1);
 const late=index.record(f.identity,f.lease,f.scope);index.close();release();await assert.rejects(late);await new Promise(resolve=>setTimeout(resolve,50));
 const db=new DatabaseSync(join(f.root,'state','material-receipts.sqlite'));assert.equal(db.prepare('SELECT COUNT(*) n FROM material_receipt_index').get()?.n,0);db.close();
 }finally{index?.close();await f.close();}
});

test('expired revoked orphan maintenance keeps dedupe; maintenance cannot read or cross physical store',async()=>{
 const f=await committedFixture();try{
 const proof=await f.custody.acquireMaintenance(f.storeId);assert.throws(()=>f.custody.currentMaintenance(structuredClone(proof)));await assert.rejects(f.phoneCustody.acquireMaintenance(f.storeId));
 f.custody.releaseMaintenance(proof);assert.throws(()=>f.custody.currentMaintenance(proof));
 f.registry.revokeRequest(f.management,f.reader.principal_id,'req');await assert.rejects(f.store.getTransfer(f.identity,{context:f.reader,lease:proof as never,scope:f.scope}));f.advance(600001);
 assert.equal((await f.store.collectExpiredMaintenance({limit:1})).collected,1);
 const db=new DatabaseSync(join(f.root,f.storeId==='work-store'?'work':'phone','metadata.sqlite'));assert.equal(db.prepare('SELECT COUNT(*) n FROM transfers_v2').get()?.n,1);db.close();
 assert.equal((await f.store.collectExpiredMaintenance({limit:1})).collected,0);
 }finally{await f.close();}
});

import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('actual process SIGKILL after index reopens committed locator and A2 attaches the same receipt',async()=>{
 const f=await committedFixture();try{
 const r=f.request(),pending=await f.service.invoke('get_result',{version:1,request_id:'req'},f.reader),phone=f.registry.context(f.phoneProof);
 const reply:MaterialReply={version:1,kind:'human_answer',client_id:'reply-window',request_id:'req',source:r.source,pending_id:pending.question!.pending_id,question_version:pending.question!.question_version,expires_at:r.expires_at,result:{version:1,request_id:'req',reply_to:'req',result_version:1,source:r.source,target_work:null,summary:'durable result',assets:[f.asset],missing:[],error_code:null,observed_at:Date.now()}};await f.service.invoke('reply',reply,phone);
 const script=fileURLToPath(new URL('./fixtures/material-production-reopen.ts',import.meta.url));
 await killWindow(script,f.root,f.identity,'commit-kill',`committed:${f.fact.receipt!.receipt_id}`);
 const child=spawn(process.execPath,['--import','tsx',script,f.root,JSON.stringify(f.identity),'index-kill'],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);
 const line=await new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('child timeout '+stderr));},15000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('indexed:')){clearTimeout(timer);resolve(output.trim());}});child.on('exit',code=>{if(code!==null&&code!==0){clearTimeout(timer);reject(Error(stderr));}});});
 assert.equal(line,`indexed:${f.fact.receipt!.receipt_id}`);const killed=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await killed;
 await killWindow(script,f.root,f.identity,'attach-kill',JSON.stringify({receipt_id:f.fact.receipt!.receipt_id,receipts:1}));
 const reopened=spawn(process.execPath,['--import','tsx',script,f.root,JSON.stringify(f.identity),'attach'],{stdio:['ignore','pipe','pipe']});let output='',errors='';reopened.stdout.on('data',b=>output+=b);reopened.stderr.on('data',b=>errors+=b);const exit=await new Promise(resolve=>reopened.once('exit',resolve));assert.equal(exit,0,errors);assert.deepEqual(JSON.parse(output),{receipt_id:f.fact.receipt!.receipt_id,receipts:1});
 assert.equal(f.ledger.list().length,2);
 }finally{await f.close();}
});

test('actual unfinished A1 slot cap persists after every observer timeout',async()=>{
 const f=await committedFixture();let index:MaterialReceiptIndex|undefined;let release!:()=>void;try{
 index=new MaterialReceiptIndex(f.registry,f.authorization,[{local_store_id:f.storeId,store:f.store,custody:f.custody}],4096,10);const held=new Promise<void>(resolve=>release=resolve),original=f.store.getTransfer.bind(f.store);let calls=0;f.store.getTransfer=async(...args)=>{calls++;await held;return original(...args);};
 const observations=Array.from({length:8},(_,i)=>assert.rejects(index!.record({...f.identity,transfer_id:'held-'+i},f.lease,f.scope)));await Promise.all(observations);assert.equal(calls,8);await assert.rejects(index.record({...f.identity,transfer_id:'ninth'},f.lease,f.scope));assert.equal(calls,8);
 release();await new Promise(resolve=>setTimeout(resolve,100));
 }finally{release?.();index?.close();await f.close();}
});

async function killWindow(script:string,root:string,identity:AssetInputs['commit'],mode:string,expected:string){
 const child=spawn(process.execPath,['--import','tsx',script,root,JSON.stringify(identity),mode],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',chunk=>errors+=chunk);
 const exited=new Promise(resolve=>child.once('exit',resolve));
 try{const output=await new Promise<string>((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('window timeout '+errors)),15000);child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timer);resolve(text.trim());}});child.once('exit',()=>{clearTimeout(timer);reject(Error('unexpected child exit '+errors));});});assert.equal(output,expected);}
 finally{child.kill('SIGKILL');await exited;}
}

test('connector reusing a mutable DTO cannot alter the locator after A1 proof capture',async()=>{
 const f=await committedFixture();let release!:()=>void;try{
 const original=f.store.getTransfer.bind(f.store),held=new Promise<void>(resolve=>release=resolve);let entered!:()=>void;const called=new Promise<void>(resolve=>entered=resolve);f.store.getTransfer=async(...args)=>{entered();await held;return original(...args);};
 const mutable={...f.identity},record=f.index.record(mutable,f.lease,f.scope);await called;mutable.request_id='other-request';mutable.transfer_id='other-transfer';release();const receipt=await record;assert.deepEqual(receipt,f.fact.receipt);
 const db=new DatabaseSync(join(f.root,'state','material-receipts.sqlite'));const row=db.prepare('SELECT locator,request_id FROM material_receipt_index').get() as {locator:string;request_id:string};assert.equal(row.request_id,'req');assert.deepEqual(JSON.parse(row.locator),f.identity);db.close();
 }finally{release?.();await f.close();}
});
