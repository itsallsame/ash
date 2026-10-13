import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startOwner,type Config} from '../src/main';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {nativeHostFixture} from './fixtures/material-native-host';
import {MaterialEdgeService} from '../src/collaboration/material-edge';
import type {MaterialRegistry} from '../src/collaboration/material-registry';
import {OwnerLink} from '../src/gateway/link';
import {MaterialInputService} from '../src/collaboration/material-input-service';
import {MaterialNativeImport} from '../src/collaboration/material-native-import';
import {MaterialDraftStore} from '../src/collaboration/material-draft-store';
import {SCREEN_TOKEN_HEADER} from '../../sdk/src/api';

// Only the network connector is replaced: main still creates its real signer, Ledger,
// registry, ScreenRegistry, source service and protected SQLite/FD stores.
async function connectedMain(dir:string,host?:Config['host']){
 const start=OwnerLink.prototype.start,wait=OwnerLink.prototype.waitConnected,attach=OwnerLink.prototype.attachMaterial;
 let attached=false,started=false;
 OwnerLink.prototype.attachMaterial=function(...args){attached=true;return attach.apply(this,args);};
 OwnerLink.prototype.start=async function(){assert.equal(attached,true);started=true;};
 OwnerLink.prototype.waitConnected=async function(){assert.equal(started,true);return true;};
 try{return await startOwner({stateDir:dir,listen:'127.0.0.1:0',agents:[{id:'agent:main',runtime:'echo'}],...(host?{host}:{}),gateway:{url:'https://transport-fixture.invalid'}});}
 finally{OwnerLink.prototype.start=start;OwnerLink.prototype.waitConnected=wait;OwnerLink.prototype.attachMaterial=attach;}
}
function request(running:Awaited<ReturnType<typeof startOwner>>){
 const token=Object.entries(running.tokens.api).find(([,member])=>member==='person:owner')![0],headers={authorization:`Bearer ${token}`};
 const screen=running.edge.screens.register(running.edge.localCaller(headers)!,'main-assembly');
 return async(route:string,body:unknown)=>{const response=await fetch(`${running.url}/api/collaboration/material/ui/${route}`,{method:'POST',headers:{...headers,[SCREEN_TOKEN_HEADER]:screen.token,'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json() as any};};
}
test('default main attaches production source coordinator before link start and serves durable draft HTTP',async()=>{
 const root=mkdtempSync(join(tmpdir(),'material-main-assembly-'));let running:Awaited<ReturnType<typeof startOwner>>|undefined;
 try{running=await connectedMain(root);const call=request(running),scope=await call('scope',{});assert.equal(scope.status,200);const saved=await call('draft/save',{draft_id:'draft',target:null,text:'actual main draft',selection_ids:[]});assert.equal(saved.status,200);assert.equal(saved.value.result.saved,'durable');const loaded=await call('draft/load',{draft_id:'draft'});assert.equal(loaded.status,200);assert.equal(loaded.value.result.text,'actual main draft');assert.ok(existsSync(join(root,'material-ui-drafts.sqlite')));assert.ok(existsSync(join(root,'material-native-sources')));}
 finally{await running?.close();rmSync(root,{recursive:true,force:true});}
});
test('main stops ingress synchronously and retains dependent stores until source close settles, then aggregates cleanup errors',async(t)=>{
 const root=mkdtempSync(join(tmpdir(),'material-main-close-')),running=await connectedMain(root),call=request(running);
 const closeInput=MaterialInputService.prototype.close,closeImports=MaterialNativeImport.prototype.close,closeDrafts=MaterialDraftStore.prototype.close;
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),order:string[]=[];
 MaterialInputService.prototype.close=function(){order.push('source');return gate.then(()=>closeInput.call(this));};
 MaterialNativeImport.prototype.close=function(){order.push('imports');return closeImports.call(this);};
 MaterialDraftStore.prototype.close=function(){order.push('drafts');closeDrafts.call(this);throw new Error('ordinary settled draft cleanup failure');};
 let closing:Promise<void>|undefined;
 try{assert.equal((await call('scope',{})).status,200);t.mock.timers.enable({apis:['setTimeout']});closing=running.close();const timeout=assert.rejects(closing,/still draining/);assert.deepEqual(order,['source']);t.mock.timers.tick(20000);await timeout;t.mock.timers.reset();assert.equal((await call('scope',{})).status,503);assert.deepEqual(order,['source']);assert.doesNotThrow(()=>running.ledger.list({limit:1}));release();closing=running.close();await assert.rejects(closing,AggregateError);assert.deepEqual(order,['source','imports','drafts']);assert.throws(()=>running.ledger.list({limit:1}));}
 finally{release();await closing?.catch(()=>{});MaterialInputService.prototype.close=closeInput;MaterialNativeImport.prototype.close=closeImports;MaterialDraftStore.prototype.close=closeDrafts;rmSync(root,{recursive:true,force:true});}
});
test('main rolls back a partial source constructor failure before exposing HTTP',async()=>{
 const root=mkdtempSync(join(tmpdir(),'material-main-rollback-'));// A file in place of its physical custody root fails before input service attachment.
 writeFileSync(join(root,'material-native-sources'),'not a directory');
 const start=OwnerLink.prototype.start,wait=OwnerLink.prototype.waitConnected;OwnerLink.prototype.start=async()=>{};OwnerLink.prototype.waitConnected=async()=>true;
 let running:Awaited<ReturnType<typeof startOwner>>|undefined;let draftsClosed=0;const close=MaterialDraftStore.prototype.close;MaterialDraftStore.prototype.close=function(){draftsClosed++;return close.call(this);};
 try{running=await startOwner({stateDir:root,listen:'127.0.0.1:0',agents:[{id:'agent:main',runtime:'echo'}],gateway:{url:'https://transport-fixture.invalid'}});assert.equal(draftsClosed,1);assert.equal((await request(running)('scope',{})).status,503);assert.doesNotThrow(()=>running!.ledger.list({limit:1}));}
 finally{await running?.close();OwnerLink.prototype.start=start;OwnerLink.prototype.waitConnected=wait;MaterialDraftStore.prototype.close=close;rmSync(root,{recursive:true,force:true});}
});

test('mounted main retains a real private source FD pin after source close error and completes cleanup on late release',async()=>{
 const root=mkdtempSync(join(tmpdir(),'material-main-real-pin-')),host=await nativeHostFixture();
 // Extend the isolated signed-host fixture only with main's bounded peripheral alarm API.
 const peripheral=createServer(async(req,res)=>{try{if(req.headers.authorization!==`Bearer ${host.config.token}`){res.writeHead(401).end('{}');return;}if(['/alarm','/widgets','/task/status','/island','/present','/present/alert','/present/hide'].includes(req.url??'')){res.end('{"ok":true,"showing":false}');return;}const body:Buffer[]=[];for await(const chunk of req)body.push(Buffer.from(chunk));const response=await fetch(host.config.url+(req.url??''),{method:req.method,headers:{authorization:`Bearer ${host.config.token}`},...(body.length?{body:Buffer.concat(body)}:{})});res.writeHead(response.status).end(await response.text());}catch{res.writeHead(500).end('{}');}});
 await new Promise<void>(resolve=>peripheral.listen(0,'127.0.0.1',resolve));const config={...host.config,url:`http://127.0.0.1:${(peripheral.address() as {port:number}).port}`};
 const attach=MaterialEdgeService.prototype.attachInput,closeInput=MaterialInputService.prototype.close;
 let imports:MaterialNativeImport|undefined,registry:MaterialRegistry|undefined;
 MaterialEdgeService.prototype.attachInput=function(input,actualImports){imports=actualImports;registry=this.runtime.registry;return attach.call(this,input,actualImports);};
 let running:Awaited<ReturnType<typeof startOwner>>|undefined,capture:Awaited<ReturnType<MaterialNativeImport['capture']>>|undefined,closing:Promise<void>|undefined;
 try{
  running=await connectedMain(root,config);MaterialEdgeService.prototype.attachInput=attach;
  assert.ok(imports);assert.ok(registry);
  const token=Object.entries(running.tokens.api).find(([,member])=>member==='person:owner')![0],headers={authorization:`Bearer ${token}`,'x-ash-native-ui':createHash('sha256').update(`${host.config.token}:home`).digest('hex')},caller=running.edge.localCaller(headers)!;
  assert.equal(caller.nativeUi,true);const screen=running.edge.screens.register(caller,'main-real-native-pin'),wire={...headers,[SCREEN_TOKEN_HEADER]:screen.token};
  const call=async(path:string,body:unknown)=>{const response=await fetch(`${running!.url}/api/collaboration/material/native/import/${path}`,{method:'POST',headers:{...wire,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json() as any;assert.equal(response.status,200,JSON.stringify(value));return value.result;};
  const opened=await call('begin',{import_id:'held-source',page_epoch:1,name:'source.txt',media_type:'text/plain',reported_length:0});
  const committed=await call('commit',{import_id:'held-source',page_epoch:1,upload_nonce:opened.upload_nonce,byte_length:0,sha256:createHash('sha256').digest('hex')});
  const permit=registry.management(wire,screen.token);capture=await imports.capture(committed.selection.selection_id,permit);
  assert.equal(imports.busy,1);assert.equal((await capture.handle.stat()).size,0);
  // A settled source cleanup error must not convert the still-held actual pin into idle.
  MaterialInputService.prototype.close=async function(){await closeInput.call(this);throw new Error('ordinary source cleanup failure');};
  closing=running.close();let settled=false;const observed=assert.rejects(closing,AggregateError).then(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(settled,false);assert.equal(imports.busy,1);
  assert.doesNotThrow(()=>running!.ledger.list({limit:1}));assert.equal((await capture.handle.stat()).size,0);
  await capture.release();capture=undefined;await observed;assert.equal(imports.busy,0);assert.throws(()=>running!.ledger.list({limit:1}));
 }finally{
  await capture?.release();await closing?.catch(()=>{});MaterialEdgeService.prototype.attachInput=attach;MaterialInputService.prototype.close=closeInput;if(running&&!closing)await running.close();peripheral.closeAllConnections();await new Promise<void>(resolve=>peripheral.close(()=>resolve()));await host.close();rmSync(root,{recursive:true,force:true});
 }
});
