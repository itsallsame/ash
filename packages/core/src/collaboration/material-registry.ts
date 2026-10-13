import {NativeMaterialSignerAuthority,type MaterialSignerLease} from './material-signer-authority';
import {bindMaterialTargetProof,type MaterialTargetWorkProof,type MaterialTargetProofRecord} from './material-target-provider';
export type {MaterialTargetWorkProof} from './material-target-provider';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deviceIdForKey, verifySignature } from 'ash-gateway/src/protocol';
import { DeviceKey } from 'ash-gateway/client/client';
import { EdgeRouter } from '../server';
import { LocalStateTransaction, type LocalStateToken } from '../../../device/src/collaboration/local-state-transaction';
import { acquireDescriptorStateLock } from '../../../device/src/collaboration/descriptor-lock';
import type { Signer } from '../../../device/src/link';
import type { Ledger } from '../world/ledger';
import type { MaterialLedgerLocator } from './material-ledger-facade';
import { MATERIAL_LIMITS, MaterialProtocolError, type CollaborationRequest, type MaterialTrustedContext, type MaterialEndpointRef, type MaterialAuthorizationScope, type AssetRef, type AssetOperation, type AssetInputs } from '../../../device/src/collaboration/material-types';
import { parseMaterialEndpoint, parseCollaborationRequest, parseAssetRef, materialPayloadHash, sameMaterialEndpoint } from '../../../device/src/collaboration/material-protocol';

type Row=Record<string,unknown>;
export const materialMetadataHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function freezeMaterial<T>(value:T):T { const copy=structuredClone(value);const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(copy);return copy; }
const fail=(code:ConstructorParameters<typeof MaterialProtocolError>[0]='permission_denied'):never=>{throw new MaterialProtocolError(code);};
function id(value:string):void{if(typeof value!=='string'||!value||Buffer.byteLength(value)>256||/[\u0000-\u001f]/.test(value))fail('invalid');}
function integer(value:number,max=Number.MAX_SAFE_INTEGER):void{if(!Number.isSafeInteger(value)||value<1||value>max)fail('invalid');}
export interface MaterialManagementPermit {readonly management:'material';}
export interface MaterialActorProof {readonly actor:'material';}
/** Only a protected connector may implement this port. H3 has no production implementation yet. */
export interface MaterialHostProofProvider {
  readonly source:'host_bridge'|'testing_fixture';
  /** Monotonic protected host generation; restoring a binding must not restore this value. */
  currentEpoch():string;
  capture(bindingId:string):Promise<{principal_id:string;pairing_id:string;endpoint:MaterialEndpointRef;expires_at:number;generation:string;current():undefined}>;
}
export interface MaterialPeerProofProvider {
  /** Monotonic authenticated peer-list generation, including removal and restoration. */
  currentEpoch():string;
  /** Must return the current authenticated device.list record; absent providers deny remote enrolment. */
  capture(peerId:string):Promise<{node_id:string;public_key:string;pairing_id:string;generation:string;current():undefined}>;
}
export interface MaterialPhysicalStore {readonly local_store_id:string;readonly root_dir:string;readonly endpoint_id:string;}
export interface MaterialRegistryOptions {
  state:LocalStateTransaction;signer:Signer;signerCurrent():undefined;signerAuthority?:NativeMaterialSignerAuthority;edge:EdgeRouter;ledger:Ledger;
  stores:readonly MaterialPhysicalStore[];
  hostProofs?:MaterialHostProofProvider;peerProofs?:MaterialPeerProofProvider;
  /** Test-only host fixture is explicitly rejected by the default production environment. */
  environment?:'production'|'testing';now?:()=>number;max_records?:number;
}
interface Management {headers:Record<string,string>;token:string;principal:string;screen:string;state:LocalStateToken;}
interface Actor {principal:string;pairing:string;endpoint:MaterialEndpointRef;expires:number;current():undefined;}
interface Session {context:MaterialTrustedContext;actor:Actor;epoch:string;}
export interface MaterialRequestRegistration {
  owner:string;request_id:string;payload_hash:string;source:MaterialEndpointRef;return_to:MaterialEndpointRef;target:MaterialEndpointRef;
  source_actor:string;target_actor:string;source_pairing:string;target_pairing:string;target_binding:MaterialEndpointRef;kind:CollaborationRequest['kind'];expires_at:number;
  locator:MaterialLedgerLocator|null;tombstone:boolean;
  /** Legacy rows remain actors; input_target never supplies a work-origin identity. */
  target_purpose:'actor'|'input_target';
}
export interface MaterialAssetRegistration {
  owner:string;request_id:string;asset_id:string;asset_version:number;sha256:string;byte_length:number;
  source:MaterialEndpointRef;destination:MaterialEndpointRef;expires_at:number;custody_id:string;
  provisional:boolean;tombstone:boolean;
}
/** Metadata-only authority. No protocol body, workspace permission or ambient owner grant is inherited. */
export class MaterialRegistry {
  readonly authorityId:string;readonly nodeId:string;readonly stateDir:string;
  readonly now:()=>number;
  private readonly db:DatabaseSync;private readonly watcher:FSWatcher;private readonly initialFile:string;private readonly signerKey:string;private readonly signerFile:string;private readonly signerLease?:MaterialSignerLease;
  private readonly instance=randomUUID();private generation=0;private failed=false;private closed=false;private observed='';
  private readonly managements=new WeakMap<object,Management>();private readonly actors=new WeakMap<object,Actor>();
  private readonly storeIdentities=new Map<string,string>();
  private readonly liveActors=new Map<string,Actor>();
  private readonly inputTargets=new Map<string,MaterialTargetProofRecord>();
  private readonly sessions=new Map<string,Session>();private readonly stores=new Map<string,MaterialPhysicalStore>();
  private readonly maximum:number;
  private constructor(private readonly options:MaterialRegistryOptions,db:DatabaseSync,fileIdentity:string,signerLease?:MaterialSignerLease) {
    this.signerLease=signerLease;
    this.db=db;this.initialFile=fileIdentity;this.stateDir=options.state.stateDir;this.nodeId=options.signer.id;this.authorityId=`material:${this.nodeId}`;this.signerKey=options.signer.publicKey;this.signerFile=this.signerFingerprint();this.now=options.now??Date.now;this.maximum=options.max_records??4096;
    integer(this.maximum,4096);for(const store of options.stores){id(store.local_store_id);id(store.endpoint_id);if(this.stores.has(store.local_store_id)||!isAbsolute(store.root_dir))fail('invalid');const root=realpathSync(store.root_dir),stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||resolve(store.root_dir)!==root)fail();this.stores.set(store.local_store_id,freezeMaterial({...store,root_dir:root}));this.storeIdentities.set(store.local_store_id,`${stat.dev}:${stat.ino}`);}
    if(!this.stores.size)fail('invalid');
    this.watcher=watch(this.stateDir,{persistent:false},(_event,filename)=>{if(filename===null||String(filename).startsWith('material-registry.sqlite')){try{const disk=this.diskFingerprint();if(disk!==this.observed){this.generation++;this.observed=disk;}}catch{this.failed=true;this.generation++;}}});
    this.watcher.on('error',()=>{this.failed=true;this.generation++;});try{this.observed=this.diskFingerprint();}catch(error){this.watcher.close();throw error;}
  }
  static async open(options:MaterialRegistryOptions):Promise<MaterialRegistry> {
    if(!(options.state instanceof LocalStateTransaction)||!(options.edge instanceof EdgeRouter)||typeof options.signerCurrent!=='function')fail();
    const token=options.state.capture(),signer=options.signer;
    if(options.signerCurrent()!==undefined)fail();
    let signerLease:MaterialSignerLease|undefined;let keyCurrent:()=>void;
    if(options.signerAuthority!==undefined){if(!NativeMaterialSignerAuthority.isIssued(options.signerAuthority))fail();signerLease=await options.signerAuthority.capture(signer);keyCurrent=()=>{if(options.signerAuthority!.current(signerLease!)!==undefined)fail();};keyCurrent();options.state.assertCurrent(token);}
    else {
    const keyFile=join(options.state.stateDir,'device.jwk'),keyFd=openSync(keyFile,constants.O_RDONLY|constants.O_NOFOLLOW);let keyData:string;let keyIdentity:string;
    try{const stat=fstatSync(keyFd,{bigint:true});if(!stat.isFile()||stat.nlink!==1n||(stat.mode&0o077n)!==0n)fail();keyIdentity=`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;keyData=readFileSync(keyFd,'utf8');}finally{closeSync(keyFd);}
    keyCurrent=()=>{const stat=lstatSync(keyFile,{bigint:true});if(stat.isSymbolicLink()||`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`!==keyIdentity||readFileSync(keyFile,'utf8')!==keyData)fail();};
    const persistent=await DeviceKey.fromJwk(JSON.parse(keyData));keyCurrent();options.state.assertCurrent(token);if(persistent.id!==signer.id||persistent.publicKey!==signer.publicKey)fail();
    }
    const challenge=randomBytes(32);
    const signature=await signer.sign(challenge);
    options.state.assertCurrent(token);if(options.signerCurrent()!==undefined||await deviceIdForKey(signer.publicKey)!==signer.id||!await verifySignature(signer.publicKey,signature,challenge))fail();
    options.state.assertCurrent(token);keyCurrent();if(options.signerCurrent()!==undefined)fail();
    const lock=acquireDescriptorStateLock(options.state.stateDir);
    const file=join(options.state.stateDir,'material-registry.sqlite');let fd:number|undefined;let db:DatabaseSync|undefined;
    try{options.state.assertCurrent(token);lock.assertCurrent();fd=openSync(file,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);const stat=fstatSync(fd,{bigint:true});if(!stat.isFile()||stat.nlink!==1n||(stat.mode&0o077n)!==0n)fail();const identity=`${stat.dev}:${stat.ino}`;
      const current=()=>{const actual=lstatSync(file,{bigint:true});if(actual.isSymbolicLink()||!actual.isFile()||actual.nlink!==1n||(actual.mode&0o077n)!==0n||`${actual.dev}:${actual.ino}`!==identity)fail();options.state.assertCurrent(token);lock.assertCurrent();keyCurrent();if(options.signerCurrent()!==undefined)fail();};
      current();db=new DatabaseSync(file);current();db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA max_page_count=16384;
        CREATE TABLE IF NOT EXISTS material_registry_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS material_registry_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
          source TEXT NOT NULL,return_to TEXT NOT NULL,target TEXT NOT NULL,source_actor TEXT NOT NULL,target_actor TEXT NOT NULL,source_pairing TEXT NOT NULL,target_pairing TEXT NOT NULL,target_binding TEXT NOT NULL,
          kind TEXT NOT NULL,expires_at INTEGER NOT NULL,locator TEXT,tombstone INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,request_id));
        CREATE TABLE IF NOT EXISTS material_registry_grants(owner TEXT NOT NULL,request_id TEXT NOT NULL,actor TEXT NOT NULL,role TEXT NOT NULL,actions TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(owner,request_id,actor,role));
        CREATE TABLE IF NOT EXISTS material_registry_operations(owner TEXT NOT NULL,actor TEXT NOT NULL,stable_key TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,PRIMARY KEY(owner,actor,stable_key));
        CREATE TABLE IF NOT EXISTS material_registry_assets(owner TEXT NOT NULL,request_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_version INTEGER NOT NULL,sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,
          source TEXT NOT NULL,destination TEXT NOT NULL,expires_at INTEGER NOT NULL,custody_id TEXT NOT NULL,provisional INTEGER NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(owner,request_id,asset_id,asset_version));`);
      current();db.prepare("INSERT OR IGNORE INTO material_registry_meta VALUES('revision','1')").run();
      if(!(db.prepare('PRAGMA table_info(material_registry_requests)').all() as {name:string}[]).some(column=>column.name==='target_purpose'))db.exec("ALTER TABLE material_registry_requests ADD COLUMN target_purpose TEXT NOT NULL DEFAULT 'actor'");
      const saved=db.prepare("SELECT value FROM material_registry_meta WHERE key='authority'").get() as {value:string}|undefined;
      if(saved&&saved.value!==`material:${signer.id}`)fail();db.prepare("INSERT OR IGNORE INTO material_registry_meta VALUES('authority',?)").run(`material:${signer.id}`);
      options.state.assertCurrent(token);if(options.signerCurrent()!==undefined)fail();
      current();const registry=new MaterialRegistry(options,db,identity,signerLease);db=undefined;return registry;
    }finally{db?.close();if(fd!==undefined)closeSync(fd);lock.release();}
  }
  private signerFingerprint():string {
    if(this.signerLease){if(!NativeMaterialSignerAuthority.isIssued(this.options.signerAuthority)||this.options.signerAuthority.current(this.signerLease)!==undefined)fail();return materialMetadataHash([this.signerLease.generation,this.signerLease.id,this.signerLease.publicKey]);}
    const file=join(this.stateDir,'device.jwk'),stat=lstatSync(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||(stat.mode&0o077n)!==0n)fail();return materialMetadataHash([`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`,readFileSync(file,'utf8')]);
  }
  private diskFingerprint():string {
    const file=join(this.stateDir,'material-registry.sqlite'),stat=lstatSync(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||(stat.mode&0o077n)!==0n||`${stat.dev}:${stat.ino}`!==this.initialFile)fail();
    const signature=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
    let wal='missing';try{const w=lstatSync(`${file}-wal`,{bigint:true});if(!w.isFile()||w.isSymbolicLink()||w.nlink!==1n||(w.mode&0o077n)!==0n)fail();wal=[w.dev,w.ino,w.size,w.mtimeNs,w.ctimeNs].join(':');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return materialMetadataHash([signature,wal]);
  }
  currentEpoch():string {
    if(this.closed||this.failed)fail('offline');if(this.options.signerCurrent()!==undefined||this.options.signer.id!==this.nodeId||this.options.signer.publicKey!==this.signerKey||this.signerFingerprint()!==this.signerFile)fail();
    const state=this.options.state.capture(),disk=this.diskFingerprint();if(this.observed&&disk!==this.observed){this.generation++;this.observed=disk;}
    const revision=(this.db.prepare("SELECT value FROM material_registry_meta WHERE key='revision'").get() as {value:string}).value;
    const host=this.options.hostProofs?.currentEpoch()??'absent',peers=this.options.peerProofs?.currentEpoch()??'absent';if(typeof host!=='string'||typeof peers!=='string'||!host||!peers||host.length>256||peers.length>256)fail();
    return `${this.instance}:${this.generation}:${revision}:${state.epoch}:${state.revision}:${host}:${peers}`;
  }
  invalidate():void{this.generation++;}
  /** Watch failure cannot be repaired by restoring identical configuration bytes. */
  failClosed():void{this.failed=true;this.generation++;}
  management(headers:Record<string,string>,screenToken:string):MaterialManagementPermit {
    this.currentEpoch();headers=freezeMaterial(headers);const caller=this.options.edge.localCaller(headers);
    if(!caller||caller.member!=='person:owner'||!caller.local||caller.remote||!caller.ownerProxy)fail();
    const registered=this.options.edge.screens.verify(caller!,screenToken);
    const permit=Object.freeze({management:'material' as const});this.managements.set(permit,{headers,token:screenToken,principal:caller!.transportPrincipal,screen:registered.screen,state:this.options.state.capture()});this.currentManagement(permit);return permit;
  }
  currentManagement(permit:MaterialManagementPermit):undefined {
    this.currentEpoch();const record=this.managements.get(permit);if(!record)fail();const caller=this.options.edge.localCaller(record!.headers);
    if(!caller||caller.member!=='person:owner'||!caller.local||caller.remote||caller.transportPrincipal!==record!.principal||!caller.ownerProxy)fail();
    const registered=this.options.edge.screens.verify(caller!,record!.token);if(registered.screen!==record!.screen||!this.options.edge.screens.currentBinding(record!.screen,record!.principal))fail();this.options.state.assertCurrent(record!.state);return undefined;
  }
  releaseManagement(permit:MaterialManagementPermit):undefined{this.managements.delete(permit);return undefined;}
  managementBinding(permit:MaterialManagementPermit):Readonly<{principal:string;screen:string;generation:string;durable_generation:string}>{this.currentManagement(permit);const record=this.managements.get(permit)!;return Object.freeze({principal:record.principal,screen:record.screen,generation:materialMetadataHash([record.state.epoch,record.state.revision]),durable_generation:materialMetadataHash([record.state.revision])});}
  private mutate<T>(permit:MaterialManagementPermit,run:()=>T):T {
    this.currentManagement(permit);const token=this.options.state.capture(),lock=acquireDescriptorStateLock(this.stateDir);
    try{this.options.state.assertCurrent(token);lock.assertCurrent();this.currentManagement(permit);this.db.exec('BEGIN IMMEDIATE');
      try{const result=run();this.db.prepare("UPDATE material_registry_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
        this.currentManagement(permit);this.options.state.assertCurrent(token);lock.assertCurrent();this.db.exec('COMMIT');this.generation++;this.observed=this.diskFingerprint();this.currentManagement(permit);return result;
      }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
    }finally{lock.release();}
  }
  private capacity(table:string,count=1):void{if(Number((this.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n)+count>this.maximum)fail('too_large');}
  localNodeActor(permit:MaterialManagementPermit,endpointId:string,expiresAt:number):MaterialActorProof {
    this.currentManagement(permit);id(endpointId);integer(expiresAt);if(![...this.stores.values()].some(s=>s.endpoint_id===endpointId))fail();
    return this.issueActor({principal:`node:${this.nodeId}:${endpointId}`,pairing:`local:${this.nodeId}`,endpoint:{kind:'node',node_id:this.nodeId,endpoint_id:endpointId},expires:expiresAt,current:()=>{this.currentManagement(permit);return undefined;}});
  }
  async remoteNodeActor(permit:MaterialManagementPermit,peerId:string,endpointId:string,expiresAt:number):Promise<MaterialActorProof> {
    this.currentManagement(permit);if(!this.options.peerProofs)fail('unsupported');const peer=await this.options.peerProofs!.capture(peerId);this.currentManagement(permit);
    if(peer.current()!==undefined||peer.node_id!==peerId||await deviceIdForKey(peer.public_key)!==peerId)fail();this.currentManagement(permit);id(peer.pairing_id);id(endpointId);integer(expiresAt);
    return this.issueActor({principal:`node:${peerId}:${endpointId}`,pairing:peer.pairing_id,endpoint:{kind:'node',node_id:peerId,endpoint_id:endpointId},expires:expiresAt,current:()=>{this.currentManagement(permit);if(peer.current()!==undefined)fail();return undefined;}});
  }
  async workActor(permit:MaterialManagementPermit,bindingId:string):Promise<MaterialActorProof> {
    this.currentManagement(permit);const provider=this.options.hostProofs;if(!provider||provider.source==='testing_fixture'&&this.options.environment!=='testing')fail('unsupported');
    const proof=await provider!.capture(bindingId);this.currentManagement(permit);if(proof.current()!==undefined)fail();const endpoint=parseMaterialEndpoint(proof.endpoint);if(endpoint.kind!=='work')fail();id(proof.principal_id);id(proof.pairing_id);integer(proof.expires_at);
    return this.issueActor({principal:proof.principal_id,pairing:proof.pairing_id,endpoint,expires:proof.expires_at,current:()=>{if(proof.current()!==undefined)fail();return undefined;}});
  }
  private issueActor(actor:Actor):MaterialActorProof {const key=materialMetadataHash([actor.principal,actor.pairing,actor.endpoint]);if(this.liveActors.size>=4096&&!this.liveActors.has(key))fail('too_large');this.liveActors.set(key,actor);const proof=Object.freeze({actor:'material' as const});this.actors.set(proof,{...actor,endpoint:freezeMaterial(actor.endpoint)});return proof;}
  private actor(proof:MaterialActorProof):Actor {const actor=this.actors.get(proof);if(!actor)fail();this.currentEpoch();if(actor!.current()!==undefined)fail();if(this.now()>=actor!.expires)fail('expired');return actor!;}
  context(proof:MaterialActorProof):MaterialTrustedContext {
    const actor=this.actor(proof),epoch=this.currentEpoch();for(const [key,session] of this.sessions){if(session.epoch!==epoch||this.now()>=session.context.expires_at)this.sessions.delete(key);}if(this.sessions.size>=4096)fail('too_large');
    const context=freezeMaterial({principal_id:actor.principal,pairing_id:actor.pairing,source_binding:actor.endpoint,grant_revision:(this.db.prepare("SELECT value FROM material_registry_meta WHERE key='revision'").get() as {value:string}).value,
      authorization_epoch:`${materialMetadataHash(epoch)}:${randomUUID()}`,expires_at:actor.expires});this.sessions.set(context.authorization_epoch,{context,actor,epoch});this.currentContext(context);return context;
  }
  currentContext(context:Readonly<MaterialTrustedContext>):undefined {
    const session=this.sessions.get(context.authorization_epoch);if(!session||JSON.stringify(session.context)!==JSON.stringify(context)||session.epoch!==this.currentEpoch())fail();
    if(session!.actor.current()!==undefined)fail();if(this.now()>=Math.min(context.expires_at,session!.actor.expires))fail('expired');return undefined;
  }
  registerRequest(permit:MaterialManagementPermit,request:CollaborationRequest,sourceProof:MaterialActorProof,targetProof:MaterialActorProof):MaterialRequestRegistration {
    request=parseCollaborationRequest(request);const source=this.actor(sourceProof),target=this.actor(targetProof),endpoint=request.target_work?{kind:'work' as const,work:request.target_work}:{kind:'node' as const,node_id:request.target.node_id,endpoint_id:request.target.endpoint_id};
    if(!sameMaterialEndpoint(source.endpoint,request.source))fail();if(request.kind==='agent_task'){if(target.endpoint.kind!=='work'||target.endpoint.work.node_id!==request.target.node_id||target.endpoint.work.endpoint_id!==request.target.endpoint_id)fail('unsupported');}else if(!sameMaterialEndpoint(target.endpoint,endpoint))fail();
    const expiry=Math.min(request.expires_at,source.expires,target.expires);if(this.now()>=expiry)fail('expired');
    return this.mutate(permit,()=>{const prior=this.request(source.principal,request.request_id);if(prior){if(prior.target_purpose!=='actor'||prior.payload_hash!==materialPayloadHash(request)||prior.source_actor!==source.principal||prior.target_actor!==target.principal||prior.source_pairing!==source.pairing||prior.target_pairing!==target.pairing||!sameMaterialEndpoint(prior.target_binding,target.endpoint)||prior.tombstone)fail('conflict');return prior;}
      this.capacity('material_registry_requests');this.capacity('material_registry_grants',2);this.capacity('material_registry_operations');
      this.db.prepare(`INSERT INTO material_registry_requests(owner,request_id,payload_hash,source,return_to,target,source_actor,target_actor,source_pairing,target_pairing,target_binding,kind,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(source.principal,request.request_id,materialPayloadHash(request),JSON.stringify(request.source),JSON.stringify(request.return_to),JSON.stringify(endpoint),source.principal,target.principal,source.pairing,target.pairing,JSON.stringify(target.endpoint),request.kind,expiry);
      const insert=this.db.prepare('INSERT INTO material_registry_grants(owner,request_id,actor,role,actions,expires_at) VALUES(?,?,?,?,?,?)');
      insert.run(source.principal,request.request_id,source.principal,'source',JSON.stringify(['submit','get_result','await_result','ack_result']),expiry);
      insert.run(source.principal,request.request_id,target.principal,'target',JSON.stringify(['reply']),expiry);
      this.db.prepare('INSERT INTO material_registry_operations(owner,actor,stable_key,request_id,payload_hash) VALUES(?,?,?,?,?)').run(source.principal,source.principal,materialMetadataHash(['material/v1','submit',source.principal,request.client_id]),request.request_id,materialPayloadHash(request));
      return this.request(source.principal,request.request_id)!;
    });
  }
  /** Phone-local source, exact current input destination. No target actor or reply grant is issued. */
  registerInputTarget(permit:MaterialManagementPermit,request:CollaborationRequest,sourceProof:MaterialActorProof,targetProof:MaterialTargetWorkProof):MaterialRequestRegistration {
    request=parseCollaborationRequest(request);const source=this.actor(sourceProof),proof=bindMaterialTargetProof(targetProof,this);
    if(request.kind!=='material_to_work'||!request.target_work||source.endpoint.kind!=='node'||source.endpoint.node_id!==this.nodeId||source.pairing!==`local:${this.nodeId}`||proof.local_id!==this.nodeId||!sameMaterialEndpoint(source.endpoint,request.source))fail();
    const endpoint={kind:'work' as const,work:proof.facts.work};
    if(!sameMaterialEndpoint(endpoint,{kind:'work',work:request.target_work!})||request.target.node_id!==proof.facts.work.node_id||request.target.endpoint_id!==proof.facts.work.endpoint_id)fail();
    const targetId=`input-target:${materialMetadataHash(endpoint)}`,key=materialMetadataHash([source.principal,request.request_id]);
    // Capture freshness is deliberately separate from the registered business expiry.
    const expiry=Math.min(request.expires_at,source.expires,proof.facts.authorized_until??Infinity);if(this.now()>=expiry)fail('expired');
    if(this.inputTargets.size>=this.maximum&&!this.inputTargets.has(key))fail('too_large');
    const registered=this.mutate(permit,()=>{
      proof.current();const prior=this.request(source.principal,request.request_id);
      if(prior){if(prior.target_purpose!=='input_target'||prior.payload_hash!==materialPayloadHash(request)||prior.source_actor!==source.principal||prior.source_pairing!==source.pairing||prior.target_actor!==targetId||prior.target_pairing!==proof.pairing_id||!sameMaterialEndpoint(prior.target_binding,endpoint)||prior.tombstone)fail('conflict');return prior;}
      this.capacity('material_registry_requests');this.capacity('material_registry_grants');this.capacity('material_registry_operations');
      this.db.prepare(`INSERT INTO material_registry_requests(owner,request_id,payload_hash,source,return_to,target,source_actor,target_actor,source_pairing,target_pairing,target_binding,kind,expires_at,target_purpose) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source.principal,request.request_id,materialPayloadHash(request),JSON.stringify(request.source),JSON.stringify(request.return_to),JSON.stringify(endpoint),source.principal,targetId,source.pairing,proof.pairing_id,JSON.stringify(endpoint),request.kind,expiry,'input_target');
      this.db.prepare('INSERT INTO material_registry_grants(owner,request_id,actor,role,actions,expires_at) VALUES(?,?,?,?,?,?)').run(source.principal,request.request_id,source.principal,'source',JSON.stringify(['submit','get_result','await_result','ack_result']),expiry);
      this.db.prepare('INSERT INTO material_registry_operations(owner,actor,stable_key,request_id,payload_hash) VALUES(?,?,?,?,?)').run(source.principal,source.principal,materialMetadataHash(['material/v1','submit',source.principal,request.client_id]),request.request_id,materialPayloadHash(request));
      proof.current();return this.request(source.principal,request.request_id)!;
    });
    proof.current();this.inputTargets.set(key,proof);return registered;
  }
  /** Input-only projection: MIME and all asset metadata come from the actual canonical Ledger slot. */
  inputAsset(context:Readonly<MaterialTrustedContext>,requestId:string,assetId:string,version:number):{registration:MaterialRequestRegistration;asset:AssetRef} {
    this.currentContext(context);const request=this.requestForActor(context,requestId);this.authorizeAdmissionActor(context as MaterialTrustedContext,request,'accept');this.currentInputTarget(request);
    if(request.source.kind!=='node'||request.source.node_id!==this.nodeId||request.source.endpoint_id!=='materials'||!sameMaterialEndpoint(context.source_binding,request.source)||!sameMaterialEndpoint(request.source,request.return_to))fail();
    const canonical=this.canonical(request),slots=canonical.context.refs.filter((ref):ref is AssetRef=>ref.kind==='asset'&&ref.asset_id===assetId&&ref.version===version);
    if(slots.length!==1)fail(slots.length?'conflict':'not_found');const asset=slots[0]!,registered=this.asset(request.owner,requestId,assetId,version);
    if(!registered||registered.provisional||registered.tombstone||this.now()>=Math.min(asset.expires_at,registered.expires_at)||registered.sha256!==asset.sha256||registered.byte_length!==asset.byte_length||!sameMaterialEndpoint(registered.source,request.source)||!sameMaterialEndpoint(registered.destination,request.target_binding))fail();
    this.authorizeScope(context,{kind:'request',action:'offer',request_id:requestId,source:request.source,return_to:request.return_to,target:request.target,transfer:{asset_id:assetId,asset_version:version,source:registered!.source,destination:registered!.destination}});this.currentContext(context);return freezeMaterial({registration:request,asset});
  }
  currentInputTarget(request:MaterialRequestRegistration):undefined {
    this.currentEpoch();if(request.target_purpose!=='input_target'||request.kind!=='material_to_work'||request.target_binding.kind!=='work'||request.tombstone||this.now()>=request.expires_at)fail();
    const proof=this.inputTargets.get(materialMetadataHash([request.owner,request.request_id]));if(!proof)fail('unsupported');proof!.current();
    if(proof!.pairing_id!==request.target_pairing||!sameMaterialEndpoint({kind:'work',work:proof!.facts.work},request.target_binding))fail();return undefined;
  }
  inputTargetMetadata(context:Readonly<MaterialTrustedContext>,requestId:string) {
    const request=this.requestForActor(context,requestId);this.authorizeAdmissionActor(context as MaterialTrustedContext,request,'accept');this.currentInputTarget(request);
    const proof=this.inputTargets.get(materialMetadataHash([request.owner,request.request_id]))!;
    return freezeMaterial({work:proof.facts.work,authorization_revision:proof.facts.authorization_revision,action:proof.facts.action});
  }
  /** Refresh only live target evidence for an already canonical input request; grants and IDs remain unchanged. */
  refreshInputTarget(permit:MaterialManagementPermit,context:Readonly<MaterialTrustedContext>,requestId:string,targetProof:MaterialTargetWorkProof):undefined {
    this.currentManagement(permit);this.currentContext(context);const request=this.requestForActor(context,requestId),proof=bindMaterialTargetProof(targetProof,this);
    if(request.target_purpose!=='input_target'||request.kind!=='material_to_work'||request.source_actor!==context.principal_id||request.source.kind!=='node'||request.source.node_id!==this.nodeId||request.tombstone||this.now()>=request.expires_at||proof.local_id!==this.nodeId||proof.pairing_id!==request.target_pairing||!sameMaterialEndpoint({kind:'work',work:proof.facts.work},request.target_binding))fail();
    this.authorizeAdmissionActor(context as MaterialTrustedContext,request,'dispatch');
    proof.current();this.currentManagement(permit);this.currentContext(context);this.inputTargets.set(materialMetadataHash([request.owner,request.request_id]),proof);return undefined;
  }
  request(owner:string,requestId:string):MaterialRequestRegistration|null {
    this.currentEpoch();const raw=this.db.prepare('SELECT * FROM material_registry_requests WHERE owner=? AND request_id=?').get(owner,requestId) as Row|undefined;
    return raw?{...raw,owner:String(raw.owner),request_id:String(raw.request_id),source:JSON.parse(String(raw.source)),return_to:JSON.parse(String(raw.return_to)),target:JSON.parse(String(raw.target)),target_binding:JSON.parse(String(raw.target_binding)),locator:raw.locator?JSON.parse(String(raw.locator)):null,tombstone:raw.tombstone===1} as unknown as MaterialRequestRegistration:null;
  }
  requestForActor(context:Readonly<MaterialTrustedContext>,requestId:string):MaterialRequestRegistration {
    this.currentContext(context);const rows=this.db.prepare('SELECT owner FROM material_registry_requests WHERE request_id=? AND (source_actor=? OR target_actor=?) LIMIT 2').all(requestId,context.principal_id,context.principal_id) as {owner:string}[];
    if(rows.length!==1)fail(rows.length?'conflict':'not_found');return this.request(rows[0]!.owner,requestId)!;
  }
  authorizeScope(context:Readonly<MaterialTrustedContext>,scope:Readonly<MaterialAuthorizationScope>):MaterialRequestRegistration {
    this.currentContext(context);if(scope.kind==='discovery')return this.authorizeDiscovery(context,scope);const request=this.requestForActor(context,scope.request_id);
    if(request.tombstone||this.now()>=request.expires_at)fail('expired');
    if(request.target_purpose==='input_target'&&scope.action==='submit')this.currentInputTarget(request);
    const sourceActor=context.principal_id===request.source_actor;
    if(context.pairing_id!==(sourceActor?request.source_pairing:request.target_pairing)||!sameMaterialEndpoint(context.source_binding,sourceActor?request.source:request.target_binding))fail();
    if(!sameMaterialEndpoint(scope.source,request.source)||!sameMaterialEndpoint(scope.return_to,request.return_to)||!sameMaterialEndpoint(scope.target,request.target))fail();
    const grant=this.db.prepare('SELECT * FROM material_registry_grants WHERE owner=? AND request_id=? AND actor=? AND role=?').get(request.owner,request.request_id,context.principal_id,sourceActor?'source':'target') as Row|undefined;if(!grant||grant.revoked===1||this.now()>=Number(grant.expires_at))fail();
    if(scope.transfer){if(!['offer','put_chunk','commit','read_chunk','ack'].includes(scope.action))fail();const asset=this.asset(request.owner,request.request_id,scope.transfer.asset_id,scope.transfer.asset_version);if(!asset||asset.tombstone||this.now()>=asset.expires_at||!sameMaterialEndpoint(scope.transfer.source,asset.source)||!sameMaterialEndpoint(scope.transfer.destination,asset.destination))fail();
      const role=['offer','put_chunk','commit'].includes(scope.action)?asset!.source:asset!.destination;if(!sameMaterialEndpoint(context.source_binding,role))fail();
    }else{const role=context.principal_id===request.source_actor?'source':'target';const grant=this.db.prepare('SELECT * FROM material_registry_grants WHERE owner=? AND request_id=? AND actor=? AND role=?').get(request.owner,request.request_id,context.principal_id,role) as Row|undefined;
      if(!grant||grant.revoked===1||this.now()>=Number(grant.expires_at)||!(JSON.parse(String(grant.actions)) as string[]).includes(scope.action)||!sameMaterialEndpoint(context.source_binding,role==='source'?request.source:request.target_binding)||context.pairing_id!==(role==='source'?request.source_pairing:request.target_pairing))fail();}
    this.currentContext(context);return request;
  }
  /** Discovery sees only an already explicit material grant for this exact current target. */
  authorizeDiscovery(context:Readonly<MaterialTrustedContext>,scope:Extract<MaterialAuthorizationScope,{kind:'discovery'}>):MaterialRequestRegistration {
    this.currentContext(context);const rows=this.db.prepare('SELECT owner,request_id FROM material_registry_requests WHERE source_actor=? AND tombstone=0 LIMIT ?').all(context.principal_id,this.maximum) as {owner:string;request_id:string}[];
    for(const key of rows){const row=this.request(key.owner,key.request_id)!;const target=row.target.kind==='work'?row.target.work:row.target;
      if(target.node_id!==scope.target.node_id||target.endpoint_id!==scope.target.endpoint_id||this.now()>=row.expires_at||context.pairing_id!==row.source_pairing||!sameMaterialEndpoint(context.source_binding,row.source))continue;
      try{this.authorizeAdmissionActor(context as MaterialTrustedContext,row,'accept');if(row.target_binding.kind==='work'){if(row.target_purpose==='input_target')this.currentInputTarget(row);else this.currentProducer(row);}
        if(scope.target.capability_id){if(row.kind!=='agent_task'||!row.locator||this.canonical(row).target.capability_id!==scope.target.capability_id)continue;}this.currentContext(context);return row;
      }catch{this.currentContext(context);}
    }
    return fail('unsupported');
  }
  currentDiscovery(context:Readonly<MaterialTrustedContext>,scope:Extract<MaterialAuthorizationScope,{kind:'discovery'}>):undefined {this.authorizeDiscovery(context,scope);return undefined;}
  bindCanonical(permit:MaterialManagementPermit,owner:string,requestId:string,locator:MaterialLedgerLocator):void {
    const row=this.request(owner,requestId);if(!row)fail('not_found');const canonical=this.options.ledger.byId(locator.ledger_request_id);if(!canonical||materialPayloadHash(parseCollaborationRequest(canonical.body))!==row!.payload_hash||canonical.from!==this.externalMember(row!.owner,row!.source))fail('conflict');
    this.mutate(permit,()=>{if(row!.locator&&JSON.stringify(row!.locator)!==JSON.stringify(locator))fail('conflict');this.db.prepare('UPDATE material_registry_requests SET locator=? WHERE owner=? AND request_id=?').run(JSON.stringify(locator),owner,requestId);});
  }
  canonical(row:MaterialRequestRegistration):CollaborationRequest {
    if(!row.locator)fail('result_unknown');const message=this.options.ledger.byId(row.locator!.ledger_request_id);if(!message)fail('result_unknown');const request=parseCollaborationRequest(message!.body);if(materialPayloadHash(request)!==row.payload_hash)fail('conflict');return request;
  }
  inspectCanonical(owner:string,locator:MaterialLedgerLocator):{registration:MaterialRequestRegistration;request:CollaborationRequest} {
    this.currentEpoch();const identity=this.options.ledger.externalMaterialRecoveryIdentity(locator.ledger_request_id),message=this.options.ledger.byId(locator.ledger_request_id);
    if(!identity||!message||identity.owner!==owner||JSON.stringify(identity.locator)!==JSON.stringify(locator))fail();const request=parseCollaborationRequest(message!.body),registration=this.request(owner,request.request_id);
    if(!registration||registration.tombstone||registration.payload_hash!==materialPayloadHash(request)||identity!.member!==this.externalMember(owner,registration.source)||(registration.locator&&JSON.stringify(registration.locator)!==JSON.stringify(locator)))fail();
    return {registration:registration!,request};
  }
  bindObservedCanonical(owner:string,locator:MaterialLedgerLocator):MaterialRequestRegistration {
    const inspected=this.inspectCanonical(owner,locator);if(inspected.registration.locator)return inspected.registration;
    const epoch=this.currentEpoch();this.db.exec('BEGIN IMMEDIATE');try{const row=this.request(owner,inspected.request.request_id)!;
      if(row.locator&&JSON.stringify(row.locator)!==JSON.stringify(locator))fail('conflict');if(epoch!==this.currentEpoch())fail();
      this.db.prepare('UPDATE material_registry_requests SET locator=? WHERE owner=? AND request_id=?').run(JSON.stringify(locator),owner,row.request_id);this.db.exec('COMMIT');this.observed=this.diskFingerprint();return this.request(owner,row.request_id)!;
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
  }
  admissionRegistration(owner:string,actor:string):MaterialRequestRegistration {
    this.currentEpoch();const rows=this.db.prepare('SELECT request_id FROM material_registry_requests WHERE owner=? AND (source_actor=? OR target_actor=?) AND tombstone=0 LIMIT ?').all(owner,actor,actor,this.maximum) as {request_id:string}[];
    if(rows.length!==1)fail(rows.length?'conflict':'permission_denied');return this.request(owner,rows[0]!.request_id)!;
  }
  question(locator:MaterialLedgerLocator):{pending_id:string;question_version:number;expires_at:number}|null {
    if(!locator.pending_id)return null;const pending=this.options.ledger.humanPending(locator.pending_id);if(!pending||pending.pending_id!==locator.pending_id)fail('result_unknown');return {pending_id:pending!.pending_id,question_version:locator.question_version!,expires_at:pending!.expires_at};
  }
  externalMember(owner:string,source:MaterialEndpointRef):string{return `external:material:${materialMetadataHash([this.authorityId,owner,parseMaterialEndpoint(source)])}`;}
  registerAsset(permit:MaterialManagementPermit,context:MaterialTrustedContext,input:{request_id:string;asset:AssetRef;source:MaterialEndpointRef;destination:MaterialEndpointRef;provisional?:boolean}):MaterialAssetRegistration {
    this.currentContext(context);const request=this.requestForActor(context,input.request_id),asset=parseAssetRef(input.asset),source=parseMaterialEndpoint(input.source),destination=parseMaterialEndpoint(input.destination);
    if(!sameMaterialEndpoint(context.source_binding,source)||!((sameMaterialEndpoint(source,request.source)&&sameMaterialEndpoint(destination,request.target_binding))||(sameMaterialEndpoint(source,request.target_binding)&&sameMaterialEndpoint(destination,request.return_to))))fail();
    if(!input.provisional){const canonical=this.canonical(request);if(canonical.kind==='human_material'&&sameMaterialEndpoint(source,request.target)){const pending=this.options.ledger.humanPending(request.locator!.pending_id!);if(!pending||pending.state!=='waiting')fail('conflict');}}
    const expires=Math.min(asset.expires_at,request.expires_at,context.expires_at,...(input.provisional?[this.now()+MATERIAL_LIMITS.temporary_ttl_ms]:[]));
    return this.mutate(permit,()=>{const prior=this.asset(request.owner,request.request_id,asset.asset_id,asset.version);if(prior){if(prior.sha256!==asset.sha256||prior.byte_length!==asset.byte_length||!sameMaterialEndpoint(prior.source,source)||!sameMaterialEndpoint(prior.destination,destination)||prior.tombstone)fail('conflict');if(prior.provisional&&!input.provisional){this.db.prepare('UPDATE material_registry_assets SET provisional=0 WHERE owner=? AND request_id=? AND asset_id=? AND asset_version=?').run(request.owner,request.request_id,asset.asset_id,asset.version);return {...prior,provisional:false};}return prior;}
      this.capacity('material_registry_assets');
      const used=this.db.prepare('SELECT COUNT(*) files,COALESCE(SUM(byte_length),0) bytes FROM material_registry_assets WHERE owner=? AND tombstone=0 AND expires_at>?').get(request.owner,this.now()) as {files:number;bytes:number};
      const local=this.db.prepare('SELECT COUNT(*) files,COALESCE(SUM(byte_length),0) bytes FROM material_registry_assets WHERE owner=? AND request_id=? AND tombstone=0 AND expires_at>?').get(request.owner,request.request_id,this.now()) as {files:number;bytes:number};
      if(used.files>=MATERIAL_LIMITS.principal_files||used.bytes+asset.byte_length>MATERIAL_LIMITS.principal_bytes||local.files>=MATERIAL_LIMITS.assets||local.bytes+asset.byte_length>MATERIAL_LIMITS.request_bytes)fail('too_large');
      this.db.prepare('INSERT INTO material_registry_assets(owner,request_id,asset_id,asset_version,sha256,byte_length,source,destination,expires_at,custody_id,provisional) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(request.owner,request.request_id,asset.asset_id,asset.version,asset.sha256,asset.byte_length,JSON.stringify(source),JSON.stringify(destination),expires,materialMetadataHash([this.authorityId,request.owner,request.request_id,asset.asset_id,asset.version,source,destination]),input.provisional?1:0);return this.asset(request.owner,request.request_id,asset.asset_id,asset.version)!;});
  }
  asset(owner:string,requestId:string,assetId:string,version:number):MaterialAssetRegistration|null {
    this.currentEpoch();const row=this.db.prepare('SELECT * FROM material_registry_assets WHERE owner=? AND request_id=? AND asset_id=? AND asset_version=?').get(owner,requestId,assetId,version) as Row|undefined;
    return row?{...row,source:JSON.parse(String(row.source)),destination:JSON.parse(String(row.destination)),provisional:row.provisional===1,tombstone:row.tombstone===1} as unknown as MaterialAssetRegistration:null;
  }
  localStore(localStoreId:string,endpoint:MaterialEndpointRef):MaterialPhysicalStore {
    this.currentEpoch();const store=this.stores.get(localStoreId),node=endpoint.kind==='work'?endpoint.work.node_id:endpoint.node_id,entry=endpoint.kind==='work'?endpoint.work.endpoint_id:endpoint.endpoint_id;
    if(!store||node!==this.nodeId||entry!==store.endpoint_id)fail('unsupported');const actual=realpathSync(store!.root_dir),stat=lstatSync(actual);if(actual!==store!.root_dir||`${stat.dev}:${stat.ino}`!==this.storeIdentities.get(localStoreId)||!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)fail();return store!;
  }
  storeFor(endpoint:MaterialEndpointRef):MaterialPhysicalStore {const found=[...this.stores.values()].filter(s=>s.endpoint_id===(endpoint.kind==='work'?endpoint.work.endpoint_id:endpoint.endpoint_id));if(found.length!==1)fail('unsupported');return this.localStore(found[0]!.local_store_id,endpoint);}
  currentPhysicalStore(localStoreId:string):undefined {const store=this.stores.get(localStoreId);if(!store)fail('unsupported');this.localStore(localStoreId,{kind:'node',node_id:this.nodeId,endpoint_id:store!.endpoint_id});return undefined;}
  operation(owner:string,actor:string,stableKey:string):MaterialRequestRegistration|null {
    this.currentEpoch();const row=this.db.prepare('SELECT request_id FROM material_registry_operations WHERE owner=? AND actor=? AND stable_key=?').get(owner,actor,stableKey) as {request_id:string}|undefined;
    return row?this.request(owner,row.request_id):null;
  }
  recordAnswerOperation(context:MaterialTrustedContext,owner:string,requestId:string,stableKey:string,payloadHash:string):void {
    this.currentContext(context);const request=this.request(owner,requestId);if(!request||request.target_actor!==context.principal_id)fail();const epoch=this.currentEpoch();this.db.exec('BEGIN IMMEDIATE');
    try{const prior=this.db.prepare('SELECT request_id,payload_hash FROM material_registry_operations WHERE owner=? AND actor=? AND stable_key=?').get(owner,context.principal_id,stableKey) as {request_id:string;payload_hash:string}|undefined;
      if(prior){if(prior.request_id!==requestId||prior.payload_hash!==payloadHash)fail('conflict');}else{this.capacity('material_registry_operations');this.db.prepare('INSERT INTO material_registry_operations(owner,actor,stable_key,request_id,payload_hash) VALUES(?,?,?,?,?)').run(owner,context.principal_id,stableKey,requestId,payloadHash);}
      if(epoch!==this.currentEpoch())fail();this.db.exec('COMMIT');this.observed=this.diskFingerprint();this.currentContext(context);
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
  }
  authorizeAdmissionActor(context:MaterialTrustedContext,request:MaterialRequestRegistration,action:string):undefined {
    this.currentContext(context);if(request.tombstone||this.now()>=request.expires_at)fail('expired');
    if(request.target_purpose==='input_target'&&action==='accept')this.currentInputTarget(request);
    const source=context.principal_id===request.source_actor,target=context.principal_id===request.target_actor;
    if(!source&&!target||context.pairing_id!==(source?request.source_pairing:request.target_pairing)||!sameMaterialEndpoint(context.source_binding,source?request.source:request.target_binding))fail();
    if(['accept','dispatch','complete','wait'].includes(action)&&!source||action==='answer'&&!target)fail();
    const role=source?'source':'target',operation=source?(['accept','dispatch','complete'].includes(action)?'submit':action==='wait'?'await_result':'get_result'):'reply',grant=this.db.prepare('SELECT revoked,expires_at,actions FROM material_registry_grants WHERE owner=? AND request_id=? AND actor=? AND role=?').get(request.owner,request.request_id,context.principal_id,role) as {revoked:number;expires_at:number;actions:string}|undefined;
    if(!grant||grant.revoked||this.now()>=grant.expires_at||!JSON.parse(grant.actions).includes(operation))fail();this.currentContext(context);return undefined;
  }
  /** Proves only the registered host actor/work. The dispatch adapter separately proves exact capability, generation and execution budget. */
  currentProducer(request:MaterialRequestRegistration):undefined {
    this.currentEpoch();if(request.target_purpose!=='actor'||request.target_binding.kind!=='work')fail('unsupported');
    const actor=this.liveActors.get(materialMetadataHash([request.target_actor,request.target_pairing,request.target_binding]));if(!actor)fail('unsupported');if(actor!.current()!==undefined)fail();if(this.now()>=actor!.expires)fail('expired');return undefined;
  }
  resolveTransferScope<K extends AssetOperation>(operation:K,input:AssetInputs[K],context:MaterialTrustedContext):Extract<MaterialAuthorizationScope,{kind:'request';action:AssetOperation}> {
    const request=this.requestForActor(context,input.request_id),assetId=operation==='offer'?(input as AssetInputs['offer']).asset.asset_id:(input as AssetInputs['commit']).asset_id,version=operation==='offer'?(input as AssetInputs['offer']).asset.version:(input as AssetInputs['commit']).asset_version;
    const asset=this.asset(request.owner,request.request_id,assetId,version);if(!asset)fail('not_found');return {kind:'request',action:operation,request_id:request.request_id,source:request.source,return_to:request.return_to,target:request.target,transfer:{asset_id:asset!.asset_id,asset_version:asset!.asset_version,source:asset!.source,destination:asset!.destination}};
  }
  revokeRequest(permit:MaterialManagementPermit,owner:string,requestId:string):void{this.mutate(permit,()=>{this.db.prepare('UPDATE material_registry_requests SET tombstone=1 WHERE owner=? AND request_id=?').run(owner,requestId);this.db.prepare('UPDATE material_registry_grants SET revoked=1 WHERE owner=? AND request_id=?').run(owner,requestId);});}
  revokeAsset(permit:MaterialManagementPermit,owner:string,requestId:string,assetId:string,version:number):void{this.mutate(permit,()=>{this.db.prepare('UPDATE material_registry_assets SET tombstone=1 WHERE owner=? AND request_id=? AND asset_id=? AND asset_version=?').run(owner,requestId,assetId,version);});}
  close():void{if(this.closed)return;this.closed=true;this.generation++;this.sessions.clear();this.liveActors.clear();this.inputTargets.clear();this.watcher.close();this.db.close();}
}
