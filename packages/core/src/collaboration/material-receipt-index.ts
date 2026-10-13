import { constants, openSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MaterialAssetStore } from '../../../device/src/collaboration/material-store';
import { MaterialProtocolError, type AssetReceipt, type AssetRef, type AssetInputs, type MaterialTrustedContext, type MaterialAuthorizationScope } from '../../../device/src/collaboration/material-types';
import { parseAssetReceipt } from '../../../device/src/collaboration/material-protocol';
import { MaterialRegistry, freezeMaterial, materialMetadataHash } from './material-registry';
import { RegistryMaterialAuthorization, RegistryMaterialCustodyAuthority } from './material-authorization';

type TransferScope=Extract<MaterialAuthorizationScope,{kind:'request';action:import('../../../device/src/collaboration/material-types').AssetOperation}>;
interface StorePort {local_store_id:string;store:MaterialAssetStore;custody:RegistryMaterialCustodyAuthority;}
interface Indexed {owner:string;request_id:string;local_store_id:string;custody_id:string;receipt:AssetReceipt;locator:AssetInputs['commit'];}
const fail=(code:ConstructorParameters<typeof MaterialProtocolError>[0]='permission_denied'):never=>{throw new MaterialProtocolError(code);};
/** Metadata candidate lookup is followed by a current, physical A1 committed-fact proof. */
export class MaterialReceiptIndex {
  private readonly db:DatabaseSync;private readonly identity:string;private readonly file:string;
  private readonly stores=new Map<string,StorePort>();private closed=false;
  private readonly observers=new Set<()=>void>();
  private readonly unfinished=new Map<string,Promise<{receipt:AssetReceipt;store:string;custody:string}>>();
  constructor(readonly registry:MaterialRegistry,readonly authorization:RegistryMaterialAuthorization,stores:readonly StorePort[],private readonly maximum=4096,private readonly timeoutMs=20000){
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>4096||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000)fail('invalid');
    if(authorization.registry!==registry)fail();for(const port of stores){if(!(port.store instanceof MaterialAssetStore))fail();registry.currentPhysicalStore(port.local_store_id);if(port.custody.registry!==registry||port.custody.localStoreId!==port.local_store_id||this.stores.has(port.local_store_id))fail();this.stores.set(port.local_store_id,Object.freeze({...port}));}
    this.file=join(registry.stateDir,'material-receipts.sqlite');const fd=openSync(this.file,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    let db:DatabaseSync|undefined;
    try{const s=fstatSync(fd,{bigint:true});if(!s.isFile()||s.nlink!==1n||(s.mode&0o077n)!==0n)fail();this.identity=`${s.dev}:${s.ino}`;
      this.checkFile();db=new DatabaseSync(this.file);this.checkFile();db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA max_page_count=16384;
        CREATE TABLE IF NOT EXISTS material_receipt_index(receipt_id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL,local_store_id TEXT NOT NULL,custody_id TEXT NOT NULL,receipt TEXT NOT NULL,locator TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS material_receipt_authority(authority TEXT PRIMARY KEY);`);
      this.checkFile();const prior=db.prepare('SELECT authority FROM material_receipt_authority').get() as {authority:string}|undefined;if(prior&&prior.authority!==registry.authorityId)fail();db.prepare('INSERT OR IGNORE INTO material_receipt_authority VALUES(?)').run(registry.authorityId);this.db=db;db=undefined;
    }finally{db?.close();closeSync(fd);}
  }
  private checkFile():undefined {const s=lstatSync(this.file,{bigint:true});if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1n||(s.mode&0o077n)!==0n||`${s.dev}:${s.ino}`!==this.identity)fail();return undefined;}
  private current(context:Readonly<MaterialTrustedContext>,scope:MaterialAuthorizationScope):undefined{if(this.closed)fail('offline');this.checkFile();this.authorization.current(context as MaterialTrustedContext,scope);return undefined;}
  private async proof(input:AssetInputs['commit'],context:MaterialTrustedContext,scope:TransferScope):Promise<{receipt:AssetReceipt;store:string;custody:string}> {
    this.current(context,scope);const endpoint=this.registry.storeFor(scope.transfer.destination),port=this.stores.get(endpoint.local_store_id);if(!port)fail('unsupported');
    let custody:Awaited<ReturnType<RegistryMaterialCustodyAuthority['acquire']>>|undefined;
    try{try{custody=await port!.custody.acquire(context,scope,'destination_transfer','wire');}finally{this.current(context,scope);}if(!custody)return fail();port!.custody.current(custody);const fact=await port!.store.getTransfer(input,{context,lease:context,scope});this.current(context,scope);port!.custody.current(custody);
      if(!fact.receipt||!['committed','acknowledged'].includes(fact.state))fail('result_unknown');const receipt=parseAssetReceipt(fact.receipt);
      if(receipt.transfer_id!==input.transfer_id||receipt.request_id!==input.request_id||receipt.asset_id!==input.asset_id||receipt.asset_version!==input.asset_version||receipt.sha256!==custody.descriptor.sha256||receipt.byte_length!==custody.descriptor.byte_length)fail('conflict');
      return {receipt,store:endpoint.local_store_id,custody:custody.descriptor.custody_id};
    }finally{if(custody)port!.custody.release(custody);}
  }
  private observedProof(input:AssetInputs['commit'],context:MaterialTrustedContext,scope:TransferScope):Promise<{receipt:AssetReceipt;store:string;custody:string}> {
    this.current(context,scope);const key=materialMetadataHash([input,scope,context.principal_id,context.pairing_id,context.grant_revision,this.registry.currentEpoch()]);let task=this.unfinished.get(key);
    if(!task){if(this.unfinished.size>=8)fail('too_large');task=this.proof(freezeMaterial(input),context,scope);this.unfinished.set(key,task);task.finally(()=>{if(this.unfinished.get(key)===task)this.unfinished.delete(key);}).catch(()=>{});}
    if(this.observers.size>=64)fail('too_large');
    return new Promise((resolve,reject)=>{let settled=false;const finish=(error:unknown,value?:{receipt:AssetReceipt;store:string;custody:string})=>{if(settled)return;try{this.current(context,scope);}catch(fence){error=fence;}settled=true;clearTimeout(timer);this.observers.delete(close);if(error)reject(error);else resolve(value!);};const close=()=>finish(new MaterialProtocolError('offline'));const timer=setTimeout(()=>finish(new MaterialProtocolError('timeout')),this.timeoutMs);this.observers.add(close);
      task!.then(value=>{try{this.current(context,scope);finish(null,value);}catch(error){finish(error);}},error=>finish(error));});
  }
  /** Recover the original committed transfer after commit→index interruption; never offers bytes. */
  async record(input:AssetInputs['commit'],context:MaterialTrustedContext,scope:TransferScope):Promise<AssetReceipt>{
    input=freezeMaterial(input);context=freezeMaterial(context);scope=freezeMaterial(scope);const proof=await this.observedProof(input,context,scope);this.current(context,scope);
    const owner=this.registry.authorizeScope(context,scope).owner,row:Indexed={owner,request_id:input.request_id,local_store_id:proof.store,custody_id:proof.custody,receipt:proof.receipt,locator:freezeMaterial(input)};
    this.db.exec('BEGIN IMMEDIATE');try{const prior=this.lookup(proof.receipt.receipt_id);if(prior&&materialMetadataHash(prior)!==materialMetadataHash(row))fail('conflict');
      if(!prior){if(Number((this.db.prepare('SELECT COUNT(*) n FROM material_receipt_index').get() as {n:number}).n)>=this.maximum)fail('too_large');this.db.prepare('INSERT INTO material_receipt_index(receipt_id,owner,request_id,local_store_id,custody_id,receipt,locator) VALUES(?,?,?,?,?,?,?)').run(proof.receipt.receipt_id,owner,input.request_id,proof.store,proof.custody,JSON.stringify(proof.receipt),JSON.stringify(input));}
      this.current(context,scope);this.db.exec('COMMIT');this.current(context,scope);return freezeMaterial(proof.receipt);
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
  }
  private lookup(id:string):Indexed|null {const row=this.db.prepare('SELECT * FROM material_receipt_index WHERE receipt_id=? AND tombstone=0').get(id) as Record<string,string>|undefined;return row?{owner:row.owner!,request_id:row.request_id!,local_store_id:row.local_store_id!,custody_id:row.custody_id!,receipt:parseAssetReceipt(JSON.parse(row.receipt!)),locator:JSON.parse(row.locator!)}:null;}
  readReceipt=(id:string,context:Readonly<MaterialTrustedContext>,scope:MaterialAuthorizationScope):Promise<AssetReceipt|null>=>{
    context=freezeMaterial(context);scope=freezeMaterial(scope);this.current(context,scope);const row=this.lookup(id);if(!row)return Promise.resolve(null);const request=this.registry.authorizeScope(context,scope);if(row.owner!==request.owner||row.request_id!==request.request_id)fail();
    const asset=this.registry.asset(row.owner,row.request_id,row.receipt.asset_id,row.receipt.asset_version);if(!asset||asset.provisional||asset.tombstone||asset.custody_id!==row.custody_id||this.registry.now()>=asset.expires_at)fail();this.registry.localStore(row.local_store_id,asset!.destination);
    if(scope.kind!=='request')return fail();if(!scope.transfer){if(scope.action!=='get_result'&&scope.action!=='ack_result')return fail();this.current(context,scope);return Promise.resolve(freezeMaterial(row.receipt));}
    if(scope.action!=='read_chunk'||scope.transfer.asset_id!==row.receipt.asset_id||scope.transfer.asset_version!==row.receipt.asset_version)fail();
    return this.observedProof(row.locator,context as MaterialTrustedContext,scope as TransferScope).then(proof=>{
      if(proof.store!==row.local_store_id||proof.custody!==row.custody_id||materialMetadataHash(proof.receipt)!==materialMetadataHash(row.receipt))fail('conflict');this.current(context,scope);return freezeMaterial(proof.receipt);
    });
  };
  /** Internal UI lookup: no caller-supplied transfer ID, and no receipt without current A1 proof. */
  async locateTransfer(owner:string,requestId:string,asset:AssetRef,context:MaterialTrustedContext):Promise<{value:AssetInputs['commit'];receipt:AssetReceipt;current():undefined}>{
    context=freezeMaterial(context);asset=freezeMaterial(asset);const row=this.registry.requestForActor(context,requestId);if(row.owner!==owner)fail();this.registry.canonical(row);const requestScope={kind:'request' as const,action:'get_result' as const,request_id:requestId,source:row.source,return_to:row.return_to,target:row.target,transfer:null};const lease=await this.authorization.before(context,requestScope);this.current(lease,requestScope);
    const candidates=this.db.prepare('SELECT receipt_id FROM material_receipt_index WHERE owner=? AND request_id=? AND tombstone=0 LIMIT ?').all(owner,requestId,this.maximum) as {receipt_id:string}[];const matches=candidates.map(c=>this.lookup(c.receipt_id)!).filter(c=>c.receipt.asset_id===asset.asset_id&&c.receipt.asset_version===asset.version&&c.receipt.sha256===asset.sha256&&c.receipt.byte_length===asset.byte_length);if(!matches.length)fail('not_found');if(matches.length!==1)fail('conflict');const candidate=matches[0],scope=this.registry.resolveTransferScope('read_chunk',{...candidate.locator,chunk_index:0},context),readLease=await this.authorization.before(context,scope);this.current(lease,requestScope);const receipt=await this.readReceipt(candidate.receipt.receipt_id,readLease,scope);this.current(lease,requestScope);this.current(readLease,scope);if(!receipt||materialMetadataHash(receipt)!==materialMetadataHash(candidate.receipt))fail('conflict');return Object.freeze({value:freezeMaterial(candidate.locator),receipt:receipt!,current:():undefined=>{this.current(lease,requestScope);return this.current(readLease,scope);}});
  }
  close():void{if(this.closed)return;this.closed=true;for(const close of this.observers)close();this.db.close();/* Real unfinished A1 tasks retain their slots until settle. */}
}
