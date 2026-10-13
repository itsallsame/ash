import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync,mkdirSync,renameSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DeviceKey,type Connection} from 'ash-gateway/client/client';import {ClientLink,currentSetupConnectionProof} from '../src/link';import {setupDiagnostics} from '../src/setup/diagnostics';
class OnlineLink extends ClientLink {
 private connectedGate!:()=>void;readonly syncing=new Promise<void>(resolve=>this.connectedGate=resolve);private sync!:()=>void;private readonly gate=new Promise<void>(resolve=>this.sync=resolve);private finish!:()=>void;
 readonly events:string[]=[];
 constructor(key:DeviceKey){super('https://signed-fixture.invalid',key,{manifest:async()=>({name:'fixture',kind:'laptop',capabilities:[]}),call:async()=>({ok:false,content:[]})},()=>{});
  const closed=new Promise<any>(resolve=>this.finish=()=>resolve({code:1000}));const conn={ws:{readyState:1,addEventListener(){},send(){},close:()=>this.finish()},closed,onStream(){},close:()=>this.finish(),send(){}} as unknown as Connection;
  Object.assign(this.gateway,{health:async()=>{this.events.push('health');return {protocol:'ash-gw/1'};},authenticate:async()=>{this.events.push('signed-authenticate');return {};},connect:async()=>{this.events.push('connect');return conn;}});
 }
 protected override async onConnected(conn:Connection){await super.onConnected(conn);this.connectedGate();await this.gate;}
 ready(){this.sync();}end(){this.finish();}
}
test('setup connection proof waits for authenticated first sync and remains bound to its physical connection and pairing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'shell-connection-')),key=await DeviceKey.generate(),owner=await DeviceKey.generate();writeFileSync(join(root,'paired.json'),JSON.stringify({owner_key:owner.publicKey,grant_version:1,permissions:[]}),{mode:0o600});const link=new OnlineLink(key);let run:Promise<void>|undefined;
 try{await link.pair(root,undefined,'fixture');assert.throws(()=>link.captureSetupConnection());run=link.run();await link.syncing;assert.equal(link.connected,true);assert.throws(()=>link.captureSetupConnection());link.ready();await new Promise<void>(resolve=>setImmediate(resolve));const proof=link.captureSetupConnection();assert.equal(currentSetupConnectionProof(proof),undefined);assert.throws(()=>currentSetupConnectionProof(structuredClone(proof)));assert.deepEqual(link.events,['health','signed-authenticate','connect']);
  const readProof=link.captureReadSetupConnection();writeFileSync(join(root,'collaboration-read.json'),'{}',{mode:0o600});assert.throws(()=>currentSetupConnectionProof(proof));assert.equal(currentSetupConnectionProof(readProof),undefined);const freshProof=link.captureSetupConnection();assert.equal(currentSetupConnectionProof(freshProof),undefined);
  writeFileSync(join(root,'paired.json'),JSON.stringify({owner_key:owner.publicKey,grant_version:2,permissions:[]}),{mode:0o600});assert.throws(()=>currentSetupConnectionProof(proof));assert.throws(()=>link.captureSetupConnection());assert.throws(()=>currentSetupConnectionProof(readProof));assert.throws(()=>link.captureReadSetupConnection());link.stop();assert.throws(()=>currentSetupConnectionProof(proof));link.end();await run;
 }finally{link.ready();link.stop();link.end();await run;rmSync(root,{recursive:true,force:true});}
});
test('shell diagnostics keep connection, interface, grants and login distinct and whitelist evidence',()=>{
 const value=setupDiagnostics({installation:'verified',gateway:'unavailable',client:'verified',version:'verified',socket:'verified',source:'verified',controlCapability:'missing',readCapability:'unavailable',login:'unknown',secret:'hidden'} as any,{pairing:'paired',readGrant:'configured',controlGrant:'missing'});
 assert.equal(value.pairing,'paired');assert.equal(value.gateway,'unavailable');assert.equal(value.client,'verified');assert.equal(value.controlCapability,'missing');assert.equal(value.readCapability,'unavailable');assert.equal(value.login,'unknown');assert.equal(Object.hasOwn(value,'secret'),false);
});

import {createServer} from 'node:net';import {SetupShellStatus} from '../src/setup/shell-status';import {ConnectionSetupService} from '../src/setup/service';
// Synthetic diagnostic timing only: no native capability or authorization proof
// is issued. The service, scope files, socket identity and epoch fences are real.
async function diagnosticFixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'shell-status-retry-'))),owner=await DeviceKey.generate(),socket=join(root,'native.sock'),server=createServer();await new Promise<void>(resolve=>server.listen(socket,resolve));writeFileSync(join(root,'paired.json'),JSON.stringify({owner_key:owner.publicKey,grant_version:1,permissions:[]}),{mode:0o600});writeFileSync(join(root,'collaboration-control-runtime.json'),JSON.stringify({socket}),{mode:0o600});const cwd=join(root,'project');mkdirSync(cwd,{mode:0o700});writeFileSync(join(root,'collaboration-read.json'),JSON.stringify({version:2,owner_id:owner.id,endpoint_id:'fixture',authorization_generation:1,allowedCwds:[cwd]}),{mode:0o600});let epoch=0;
 const shell=new SetupShellStatus({stateDir:root,connection(){throw Error('offline fixture');},verification:{verifyScope:async()=>false,diagnostics:async()=>({})},current:()=>undefined}),service=new ConnectionSetupService({stateDir:root,endpointId:'fixture',shellStatus:shell,observationEpoch:()=>String(epoch)});
 return {root,cwd,shell,service,changeEpoch(){epoch++;},async close(){service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}};
}
for(const mode of ['once','continuous','config','directory','owner'] as const)test(`readonly status fresh recapture is bounded and rejects changed ${mode} evidence`,async()=>{const f=await diagnosticFixture();let captured=0,released=0;
 try{f.shell.capture=async()=>{captured++;if(mode==='once'&&captured===1||mode==='continuous')f.changeEpoch();if(captured===1&&mode==='config'){writeFileSync(join(f.root,'collaboration-control-runtime.json'),JSON.stringify({socket:join(f.root,'native.sock')}),{mode:0o600});f.changeEpoch();}if(captured===1&&mode==='owner'){const other=await DeviceKey.generate();writeFileSync(join(f.root,'paired.json'),JSON.stringify({owner_key:other.publicKey,grant_version:2}),{mode:0o600});}if(captured===1&&mode==='directory'){renameSync(f.cwd,f.cwd+'-old');mkdirSync(f.cwd,{mode:0o700});f.changeEpoch();}return {evidence:{login:'unknown',readCapability:'unknown',controlCapability:'unknown'},current:()=>undefined,release:()=>{released++;return undefined;}};};
 if(mode==='once'){const status=await f.service.scopeStatus();assert.equal(status.diagnostics.login,'unknown');assert.equal(captured,2);}else{await assert.rejects(f.service.scopeStatus());assert.equal(captured,mode==='continuous'?2:1);}assert.equal(released,captured);
 }finally{await f.close();}
});
for(const changed of ['owner','grant'] as const)test(`scope projection refuses ${changed} replacement after status observation returns`,async()=>{const f=await diagnosticFixture();try{f.shell.capture=async()=>({evidence:{login:'unknown'},current:()=>undefined,release:()=>undefined});const original=f.service.status.bind(f.service);f.service.status=async(...args)=>{const result=await original(...args);if(changed==='owner'){const other=await DeviceKey.generate();writeFileSync(join(f.root,'paired.json'),JSON.stringify({owner_key:other.publicKey,grant_version:2}),{mode:0o600});}else writeFileSync(join(f.root,'collaboration-read.json'),JSON.stringify({version:2,owner_id:result.precondition!.ownerId,endpoint_id:'fixture',authorization_generation:1,allowedCwds:[f.root]}),{mode:0o600});return result;};await assert.rejects(f.service.scopeStatus());}finally{await f.close();}});

import {EventEmitter} from 'node:events';import {SetupNativeVerification} from '../src/setup/native-verification';
for(const when of ['native-initialize','scope-merge'] as const)test(`true privately issued native diagnostic proof cannot report control ready after expiry during ${when}`,async()=>{
 const f=await diagnosticFixture();let now=1000,initializations=0;const methods:string[]=[];
 writeFileSync(join(f.root,'collaboration-control.json'),JSON.stringify({version:1,owner_id:(await f.service.status(()=>undefined,false)).precondition!.ownerId,endpoint_id:'fixture',authorization_generation:1,allowed_actions:['send_input','create_work'],scope:{kind:'exact_cwd',cwd:f.cwd},expires_at:1500}),{mode:0o600});
 writeFileSync(join(f.root,'collaboration-control-runtime.json'),JSON.stringify({version:1,endpoint_id:'fixture',socket:join(f.root,'native.sock'),executable:'/fixture-executable',supportedVersions:['1.0.0']}),{mode:0o600});
 class Socket extends EventEmitter{send(data:string){const frame=JSON.parse(data);methods.push(frame.method);if(frame.method==='initialize'){initializations++;if(when==='native-initialize')now=2000;queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({id:frame.id,result:{userAgent:'fixture 1.0.0'}}))));}}close(){this.emit('close');}}
 const verification=new SetupNativeVerification({stateDir:f.root,nodeId:'fixture',endpointId:'fixture',current:()=>undefined,testing:{listener:()=>({socket:join(f.root,'native.sock'),executable:'/fixture-executable',pid:1,version:'1.0.0',identity:'explicit-test-native'}),connectSocket:async()=>new Socket()}});
 const shell=new SetupShellStatus({stateDir:f.root,verification,connection(){throw Error('offline fixture');},current:()=>undefined,now:()=>now}),service=new ConnectionSetupService({stateDir:f.root,endpointId:'fixture',shellStatus:shell,now:()=>now});
 try{
  // Wait for genuine fixture writes before the independent diagnostic capture.
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(when==='scope-merge'){const original=service.status.bind(service);service.status=async(...args)=>{const status=await original(...args);now=2000;return status;};}
  const result=await service.scopeStatus();assert.equal(result.diagnostics.controlCapability,'missing');assert.equal(result.defaultProject.state,'unavailable');assert.equal(result.control!.expires_at,1500);assert.equal(verification.busy,0);assert.ok(initializations<=2);assert.ok(methods.every(method=>['initialize','initialized'].includes(method)));
 }finally{service.close();await verification.close();await f.close();}
});
