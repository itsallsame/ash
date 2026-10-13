import {MaterialClient} from '../../../device/src/collaboration/material-client';
import {join} from 'node:path';
import type {Connection} from 'ash-gateway/client/client';
import {fileSigner} from '../../../device/src/link';
import {LocalStateTransaction} from '../../../device/src/collaboration/local-state-transaction';
import {OwnerLink} from '../../src/gateway/link';
import {Ledger} from '../../src/world/ledger';
import {WorldRouter} from '../../src/world/router';
import {WorldMembers} from '../../src/world/member';
import {EdgeRouter} from '../../src/server';
import {createCoreMaterialEntry} from '../../src/collaboration/material-edge';
import {MaterialInputService} from '../../src/collaboration/material-input-service';
import {MaterialNativeImport} from '../../src/collaboration/material-native-import';
import {MaterialDraftStore} from '../../src/collaboration/material-draft-store';
class Owner extends OwnerLink {
 async connect(c:Connection){this.conn=c;this.connected=true;await this.onConnected(c);}
 feed(frame:Record<string,unknown>){this.onFrame(frame);}
 disconnect(){this.connected=false;this.conn=null;this.onDisconnected();}
}
const hops:Array<{path:string;status:number;code?:string;ms:number}>=[];const assetOperations:string[]=[],invokeAsset=MaterialClient.prototype.invokeAsset;MaterialClient.prototype.invokeAsset=(function(this:MaterialClient,...args:Parameters<typeof invokeAsset>){assetOperations.push(args[0]);return invokeAsset.apply(this,args);}) as typeof invokeAsset;
const send=(value:unknown)=>{if(process.connected)process.send!(value);};
let owner:Owner|undefined,entry:Awaited<ReturnType<typeof createCoreMaterialEntry>>|undefined,state:LocalStateTransaction|undefined,ledger:Ledger|undefined,service:MaterialInputService|undefined,imports:MaterialNativeImport|undefined,drafts:MaterialDraftStore|undefined,edge:EdgeRouter|undefined,screen:string|undefined,peerId:string|undefined;
const headers={authorization:'Bearer secret','x-ash-native-ui':'native-fixture-proof'};
let stopped=false;const raw=new Set<Promise<unknown>>();
async function run(method:string,input:any){
 if(method==='bootstrap'){
  send({type:'stage',stage:'bootstrap-enter'});if(state)throw Error('bootstrap_conflict');peerId=input.peerId;const signer=await fileSigner(join(input.root,'phone'));state=new LocalStateTransaction(join(input.root,'phone'));send({type:'stage',stage:'ledger-open'});ledger=await Ledger.open(join(input.root,'ledger'));const world=new WorldRouter(ledger,async()=>false);edge=new EdgeRouter(ledger,world,new WorldMembers(world),{api:{secret:'person:owner'},mcp:{}},{authScopeKey:Buffer.alloc(32,27),nativeUiToken:'native-fixture-proof'});
  send({type:'stage',stage:'entry-open'});const handle=edge.handle.bind(edge);edge.handle=async(...args)=>{const started=performance.now(),response=await handle(...args);let code:string|undefined;if('body'in response&&response.status!==200){try{code=JSON.parse(String(response.body)).error?.code;}catch{}}hops.push({path:args[0].url.pathname,status:response.status,...(code?{code}:{}),ms:Math.round(performance.now()-started)});return response;};owner=new Owner('https://paired-fixture.invalid',signer,edge,()=>{});entry=await createCoreMaterialEntry({state,signer,signerCurrent:()=>{state!.capture();return undefined;},edge,ledger,stores:[{local_store_id:'phone',endpoint_id:'materials',root_dir:join(input.root,'store')}],peerProofs:owner.materialPeerProofs()});owner.attachMaterial(entry.runtime,entry.bindings,entry.work);
  drafts=new MaterialDraftStore(join(input.root,'ui-drafts'));imports=new MaterialNativeImport(entry.runtime.registry,join(input.root,'native-selection'));service=new MaterialInputService({runtime:entry.runtime,edge,link:owner,drafts,imports});entry.service.attachInput(service,imports);
  const screenIdentity=edge.screens.register(edge.localCaller(headers)!,'source-worker-page');screen=screenIdentity.token;
  const list={grant_version:1,devices:[{id:peerId,permissions:['expose_capability'],grant_version:1,revoked:false,online:true,created_at:Date.now()}]};
  const frame=(value:Record<string,unknown>)=>send({type:'frame',frame:value});
  send({type:'stage',stage:'owner-connect'});await owner.connect({ws:{readyState:1,close(){},send(value:string){frame(JSON.parse(value));}},request:async(input:any)=>input.op==='device.list'?list:{requests:[]},send:frame,onStream(){},close(){}} as unknown as Connection);
  return {pid:process.pid,epoch:state.capture().epoch,screen:screenIdentity.screen};
 }
 if(method==='controlState'){
  const request=(path:string,body:unknown)=>({method:body===undefined?'GET':'POST',url:new URL(path,'http://core.local'),headers:{...headers,'ash-screen':screen!},body:body===undefined?null:Buffer.from(JSON.stringify(body))});
  const discovery=await edge!.handle(request('/api/collaboration/control/endpoints',undefined),edge!.localCaller(headers));if(!('body'in discovery)||discovery.status!==200)throw Error('control_discovery');const target=JSON.parse(String(discovery.body)).control_targets.find((target:any)=>target.device_id==='device:'+peerId&&target.endpoint_id===input.work.endpoint_id);if(!target)throw Error('control_target');const response=await edge!.handle(request('/api/collaboration/control/state',{version:1,device_id:target.device_id,endpoint_id:target.endpoint_id,authorization_revision:target.authorization_revision,work:input.work,action:'send_input'}),edge!.localCaller(headers));if(!('body'in response)||response.status!==200)throw Error('control_state');return JSON.parse(String(response.body)).snapshot;
 }
 if(method==='diagnostics')return {hops:[...hops],assetOperations:[...assetOperations],serviceBusy:service?.busy,importsBusy:imports?.busy};
 if(method==='ready'){await owner!.materialTransport(peerId!).capture();return {ready:true};}
 if(method==='call'){
  const result=await service!.dispatch(input.path,input.body,{method:'POST',url:new URL('http://core.local/api/collaboration/material/ui/'+input.path),headers:{...headers,'ash-screen':screen!},body:Buffer.from(JSON.stringify(input.body))});result.current();return result.value;
 }
 throw Error('unknown_command');
}
process.on('message',(message:any)=>{
 if(message.type==='frame'){if(!stopped)owner?.feed(message.frame);return;}
 if(message.type==='close'){
  stopped=true;entry?.service.stopInputAdmission();void (async()=>{await Promise.allSettled([...raw]);await service?.close();await imports?.close();drafts?.close();owner?.disconnect();owner?.stop();if(entry){const result=await entry.close();if(result.state!=='closed')throw Error('source_draining');}ledger?.close();state?.close();send({type:'reply',id:message.id,value:{closed:true,pid:process.pid}});process.disconnect();})().catch(error=>{send({type:'reply',id:message.id,error:{code:(error as any).code??'offline',stage:'close'}});process.exitCode=1;process.disconnect();});return;
 }
 if(message.type!=='request')return;
 if(stopped){send({type:'reply',id:message.id,error:{code:'offline',stage:message.method}});return;}
 const work=run(message.method,message.input);raw.add(work);work.then(value=>send({type:'reply',id:message.id,value}),error=>send({type:'reply',id:message.id,error:{code:(error as any).code??'offline',stage:message.method}})).finally(()=>raw.delete(work)).catch(()=>{});
});

send({type:"worker-ready"});
