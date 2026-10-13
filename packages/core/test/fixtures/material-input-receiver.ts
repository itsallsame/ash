import { mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { spawn,execFileSync } from 'node:child_process';import { fileURLToPath } from 'node:url';import { GatewayClient,type Connection,DeviceKey } from 'ash-gateway/client/client';
import { fileSigner,ClientLink } from '../../../device/src/link';import { OwnerLink } from '../../src/gateway/link';
import { Ledger } from '../../src/world/ledger';import { WorldRouter } from '../../src/world/router';import { WorldMembers } from '../../src/world/member';import { EdgeRouter } from '../../src/server';
import { LocalStateTransaction } from '../../../device/src/collaboration/local-state-transaction';import { createCoreMaterialEntry } from '../../src/collaboration/material-edge';
import { createDeviceControlRuntime,controlRuntimePath } from '../../../device/src/collaboration/control-runtime';import { currentPinnedOwnerId } from '../../../device/src/collaboration/pairing';
import { loadControlAuthorization } from '../../../device/src/collaboration/control-authorization';import { MaterialLinkWork } from '../../../device/src/collaboration/material-link-bindings';
import { MaterialTargetEndpoint,MATERIAL_PROVIDER_REQUEST_TYPE,MATERIAL_PROVIDER_RESPONSE_TYPE } from '../../../device/src/collaboration/material-target-work';import { MaterialTargetProvider } from '../../src/collaboration/material-target-provider';
class Owner extends OwnerLink {async connect(c:Connection){this.conn=c;this.connected=true;await this.onConnected(c);}feed(f:Record<string,unknown>){this.onFrame(f);}disconnect(){this.connected=false;this.conn=null;this.onDisconnected();}}
class Client extends ClientLink {async connect(c:Connection){this.conn=c;this.connected=true;this.onAttempt();await this.onConnected(c);}feed(f:Record<string,unknown>){this.onFrame(f);}}
export async function inputReceiverFixture(createReader:(root:string)=>import('../../../device/src/collaboration/material-input-reader').MaterialInputReader){
 const cleanups:Array<()=>void|Promise<unknown>>=[];let closed=false;const close=async()=>{if(closed)return;closed=true;const failures:unknown[]=[];for(const cleanup of cleanups.reverse()){try{await cleanup();}catch(e){failures.push(e);}}if(failures.length)throw failures[0];};
 const root=realpathSync(mkdtempSync(join(tmpdir(),'target-')));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));try{for(const d of ['phone','desktop','store','project'])mkdirSync(join(root,d),{mode:0o700});
 const phone=await fileSigner(join(root,'phone')),desktop=await fileSigner(join(root,'desktop')),state=new LocalStateTransaction(join(root,'phone'));cleanups.push(()=>state.close());const ledger=await Ledger.open(join(root,'ledger'));cleanups.push(()=>ledger.close());
 const world=new WorldRouter(ledger,async()=>false),members=new WorldMembers(world),edge=new EdgeRouter(ledger,world,members,{api:{secret:'person:owner'},mcp:{}},{authScopeKey:Buffer.alloc(32,27)}),headers={authorization:'Bearer secret'},screen=edge.screens.register(edge.localCaller(headers)!,'target-management');
 const qa:Record<string,unknown>[]=[],qb:Record<string,unknown>[]=[],logs:unknown[]=[],responses:unknown[]=[];
 const owner=new Owner('https://paired-fixture.invalid',phone,edge,(...args)=>logs.push(args));
 cleanups.push(()=>{owner.disconnect();owner.stop();});
 const options={state,signer:phone,signerCurrent:()=>{state.capture();return undefined;},edge,ledger,stores:[{local_store_id:'phone',endpoint_id:'materials',root_dir:join(root,'store')}],peerProofs:owner.materialPeerProofs()};
 const entry=await createCoreMaterialEntry(options);owner.attachMaterial(entry.runtime,entry.bindings,entry.work);cleanups.push(()=>entry.close());
 writeFileSync(join(root,'desktop','paired.json'),JSON.stringify({owner_key:phone.publicKey,permissions:[],grant_version:1}),{mode:0o600});
 const client=new Client('https://paired-fixture.invalid',desktop,{async manifest(){return {name:'desktop',kind:'laptop',capabilities:[]};},async call(){return {ok:false,content:[]};}},(...args)=>logs.push(args));cleanups.push(()=>client.stop());await client.pair(join(root,'desktop'),undefined,'desktop');
 const list={grant_version:1,devices:[{id:desktop.id,permissions:[],grant_version:1,revoked:false,online:true,created_at:Date.now()}]};
 const conn=(q:Record<string,unknown>[])=>({ws:{readyState:1,close(){}},async request(i:{op:string}){return i.op==='device.list'?list:{requests:[]};},send(f:Record<string,unknown>){q.push(structuredClone(f));},onStream(){},close(){}} as unknown as Connection);
 await owner.connect(conn(qb));await owner.materialTransport(desktop.id).capture().catch(()=>{});await new Promise(r=>setTimeout(r,20));await client.connect(conn(qa));
 async function pump(){while(qa.length){const f=qa.shift()!;if(f.type===MATERIAL_PROVIDER_RESPONSE_TYPE&&provider){responses.push(f);void provider.acceptFrame(f).catch(()=>{});}else owner.feed(f);}while(qb.length){const f=qb.shift()!;if(f.type===MATERIAL_PROVIDER_REQUEST_TYPE&&endpoint)void endpoint.acceptFrame(f).catch(()=>{});else client.feed(f);}}
 let provider:MaterialTargetProvider|undefined,endpoint:MaterialTargetEndpoint|undefined;
 const interval=setInterval(()=>{void pump();},2);cleanups.push(()=>clearInterval(interval));
 const until=Date.now()+5000;let ready=false;while(Date.now()<until){try{await owner.materialTransport(desktop.id).capture();ready=true;break;}catch{await new Promise(r=>setTimeout(r,5));}}if(!ready)throw Error('actual pairing deadline '+JSON.stringify(logs));
 const socket=join(root,'native.sock'),calls:{method:string;params:any}[]=[],images:{sha256:string;byte_length:number}[]=[];
 const fixtureEnv={HOME:root,TMPDIR:root,PATH:'/opt/homebrew/bin:/usr/bin:/bin',LANG:'en_US.UTF-8',PYTHONNOUSERSITE:'1'};
 const executable=realpathSync(execFileSync('python3',['-c','import sys;print(sys.executable)'],{env:fixtureEnv,encoding:'utf8',timeout:5000}).trim()),version=execFileSync(executable,['--version'],{env:fixtureEnv,encoding:'utf8',timeout:5000}).match(/\b\d+\.\d+\.\d+\b/)![0];
 const child=spawn(executable,[fileURLToPath(new URL('./material-input-receiver-native.py',import.meta.url)),socket,join(root,'project')],{env:fixtureEnv,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stderr.on('data',b=>{stderr+=b.toString();});
 const exited=new Promise<void>(r=>child.once('exit',()=>r()));cleanups.push(async()=>{child.stdin.end();child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([exited,new Promise<never>((_,j)=>{timer=setTimeout(()=>{child.kill('SIGKILL');j(Error('fixture cleanup deadline'));},2000);})]);}finally{if(timer)clearTimeout(timer);}});
 await new Promise<void>((r,j)=>{const timeout=setTimeout(()=>j(Error('fixture startup deadline '+stderr)),3000);const fail=(error:Error)=>{clearTimeout(timeout);j(error);};child.once('error',fail);child.once('exit',()=>fail(Error('fixture exited '+stderr)));child.stdout.on('data',b=>{stdout+=b.toString();let i:number;while((i=stdout.indexOf('\n'))>=0){const line=JSON.parse(stdout.slice(0,i));stdout=stdout.slice(i+1);if(line.ready){clearTimeout(timeout);r();}if(line.call)calls.push(line.call);if(line.image)images.push(line.image);}});});
 const nativeExecutable=realpathSync(execFileSync('lsof',['-a','-p',String(child.pid),'-d','txt','-Fn'],{encoding:'utf8',timeout:5000}).split('\n').find(line=>line.startsWith('n'))!.slice(1));
 const grant={version:1,owner_id:phone.id,endpoint_id:'codex',authorization_generation:1,allowed_actions:['send_input','steer'],scope:{kind:'exact_cwd',cwd:join(root,'project')},expires_at:Date.now()+600000};
 writeFileSync(join(root,'desktop','collaboration-control.json'),JSON.stringify(grant),{mode:0o600});writeFileSync(controlRuntimePath(join(root,'desktop')),JSON.stringify({version:1,endpoint_id:'codex',socket,executable:nativeExecutable,supportedVersions:[version]}),{mode:0o600});
 const runtime=createDeviceControlRuntime({stateDir:join(root,'desktop'),nodeId:desktop.id,endpointId:'codex',pinnedOwnerId:()=>currentPinnedOwnerId(join(root,'desktop')),deadlineMs:15000,materialInputReader:createReader(root)});
 cleanups.push(()=>runtime.close());
 const targetWork=new MaterialLinkWork(),endpointGateway=new GatewayClient('https://paired-fixture.invalid',desktop as DeviceKey);endpoint=new MaterialTargetEndpoint({runtime,gateway:endpointGateway,transport:client.materialTransport(),observeUnfinished:raw=>{raw.catch(e=>logs.push({stage:'target',code:e.code,stack:e.stack}));return targetWork.observeUnfinished(raw);}});
 cleanups.push(async()=>{endpoint!.close();targetWork.stop();try{await runtime.close();}finally{await targetWork.drain();}});
 provider=new MaterialTargetProvider({gateway:new GatewayClient('https://paired-fixture.invalid',phone as DeviceKey),transport:owner.materialTransport(desktop.id),observeUnfinished:entry.work.observeUnfinished,budgetMs:30000});
 cleanups.push(()=>provider!.close());
 async function settle(){const until=Date.now()+3000;let observed='',stableSince=Date.now();while(Date.now()<until){try{const transport=client.materialTransport(),peer=await transport.capture();transport.current(peer);const revision=loadControlAuthorization(join(root,'desktop'),'codex').authorization_revision;if(revision!==runtime.manifest().authorization_revision)throw Error('revision');const next=peer.generation+':'+revision;if(next!==observed){observed=next;stableSince=Date.now();}if(Date.now()-stableSince>=100)return;}catch{observed='';stableSince=Date.now();}await new Promise(r=>setTimeout(r,10));}throw Error('fixture current peer/control revision stability deadline');}
 await settle();
 const work={node_id:desktop.id,endpoint_id:'codex',kind:'conversation' as const,native_id:'exact-thread'},input=()=>({work,authorization_revision:loadControlAuthorization(join(root,'desktop'),'codex').authorization_revision!,action:'send_input' as const});
 return {root,phone,desktop,entry,options,headers,screen,provider,endpoint,runtime,work,input,calls,images,grant,owner,client,list,logs,targetWork,endpointGateway,responses,
   setCwd:(value:string)=>{child.stdin.write(JSON.stringify({cwd:value})+'\n');},deleteThread:()=>{child.stdin.write(JSON.stringify({deleted:true})+'\n');},
   changeGrant:(patch:Record<string,unknown>)=>{writeFileSync(join(root,'desktop','collaboration-control.json'),JSON.stringify({...grant,...patch}),{mode:0o600});},
   settle,
   close
 };
 }catch(error){await close().catch(()=>{});throw error;}
}
