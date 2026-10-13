import { randomUUID } from 'node:crypto';
import { MaterialProtocolError, type MaterialAuthorization, type MaterialTrustedContext, type MaterialAuthorizationScope } from '../../../device/src/collaboration/material-types';
import type { MaterialCustodyAuthority, MaterialCustodyLease, MaterialCustodyMaintenanceLease, MaterialStorageRole, MaterialCustodyPurpose } from '../../../device/src/collaboration/material-custody';
import { assertMaterialReplyBinding, assertMaterialResultBinding, materialPayloadHash } from '../../../device/src/collaboration/material-protocol';
import type { MaterialAdmissionAuthority, MaterialAdmissionInput, MaterialAdmissionPermit } from './material-durable-ledger';
import { MaterialRegistry, freezeMaterial, materialMetadataHash } from './material-registry';

const deny=():never=>{throw new MaterialProtocolError('permission_denied');};
/** A0/A1/A2 clone leases. Only exact clones of a privately issued context+scope lease are accepted. */
export class RegistryMaterialAuthorization implements MaterialAuthorization {
  private readonly issued=new Map<string,{context:MaterialTrustedContext;scope:MaterialAuthorizationScope;epoch:string}>();
  constructor(readonly registry:MaterialRegistry){}
  async before(context:MaterialTrustedContext,scope:MaterialAuthorizationScope):Promise<MaterialTrustedContext> {
    context=freezeMaterial(context);scope=freezeMaterial(scope);this.registry.authorizeScope(context,scope);
    const epoch=this.registry.currentEpoch();for(const [id,record] of this.issued){if(record.epoch!==epoch||this.registry.now()>=record.context.expires_at)this.issued.delete(id);}
    const key=materialMetadataHash([context,scope]);if(this.issued.size>=4096&&!this.issued.has(key))throw new MaterialProtocolError('too_large');
    this.issued.set(key,{context,scope,epoch:this.registry.currentEpoch()});this.current(context,scope);return context;
  }
  async after(lease:MaterialTrustedContext,scope:MaterialAuthorizationScope):Promise<void>{this.current(lease,scope);}
  current(lease:MaterialTrustedContext,scope:MaterialAuthorizationScope):undefined {
    const record=this.issued.get(materialMetadataHash([lease,scope]));if(!record||record.epoch!==this.registry.currentEpoch())return deny();this.registry.authorizeScope(lease,scope);return undefined;
  }
  currentContext=(context:Readonly<MaterialTrustedContext>):undefined=>this.registry.currentContext(context);
  close():void{this.issued.clear();}
}
interface CustodyRecord {context:MaterialTrustedContext;scope:MaterialAuthorizationScope;epoch:string;role:MaterialStorageRole;purpose:MaterialCustodyPurpose;}
/** Physical stores are fixed by the runtime factory. No historical actor grant authorizes maintenance. */
export class RegistryMaterialCustodyAuthority implements MaterialCustodyAuthority {
  private readonly issued=new WeakMap<object,CustodyRecord>();
  private readonly maintenance=new WeakMap<object,{epoch:string;expires:number;store:string}>();
  private closed=false;
  constructor(readonly registry:MaterialRegistry,readonly localStoreId:string){}
  async acquire(context:Readonly<MaterialTrustedContext>,scope:Readonly<MaterialAuthorizationScope>,role:MaterialStorageRole,purpose:MaterialCustodyPurpose):Promise<MaterialCustodyLease> {
    if(this.closed)return deny();context=freezeMaterial(context);scope=freezeMaterial(scope);
    const request=this.registry.authorizeScope(context,scope);if(scope.kind!=='request'||!scope.transfer)return deny();
    const asset=this.registry.asset(request.owner,request.request_id,scope.transfer.asset_id,scope.transfer.asset_version);if(!asset)return deny();
    if(asset!.provisional&&(role!=='source_snapshot'||purpose==='wire'))return deny();
    if(role==='source_snapshot'&&purpose==='wire'||role==='destination_transfer'&&purpose!=='wire')return deny();
    const endpoint=role==='source_snapshot'?asset!.source:asset!.destination;
    this.registry.localStore(this.localStoreId,endpoint);
    const descriptor=freezeMaterial({version:1 as const,custody_id:asset!.custody_id,authority_id:this.registry.authorityId,owner_principal_id:request.owner,request_id:request.request_id,
      asset_id:asset!.asset_id,asset_version:asset!.asset_version,sha256:asset!.sha256,byte_length:asset!.byte_length,source:asset!.source,destination:asset!.destination,local_store_id:this.localStoreId,expires_at:asset!.expires_at});
    const lease=Object.freeze({descriptor});this.issued.set(lease,{context:context as MaterialTrustedContext,scope:scope as MaterialAuthorizationScope,epoch:this.registry.currentEpoch(),role,purpose});this.current(lease);return lease;
  }
  current(lease:MaterialCustodyLease):undefined {
    const record=this.issued.get(lease);if(this.closed||!record||record.epoch!==this.registry.currentEpoch())return deny();const request=this.registry.authorizeScope(record!.context,record!.scope);
    if(record!.scope.kind!=='request'||!record!.scope.transfer)return deny();const asset=this.registry.asset(request.owner,request.request_id,record!.scope.transfer.asset_id,record!.scope.transfer.asset_version);
    if(!asset||lease.descriptor.custody_id!==asset!.custody_id||lease.descriptor.sha256!==asset!.sha256||lease.descriptor.byte_length!==asset!.byte_length||this.registry.now()>=lease.descriptor.expires_at)return deny();
    this.registry.localStore(this.localStoreId,record!.role==='source_snapshot'?asset!.source:asset!.destination);return undefined;
  }
  async acquireMaintenance(localStoreId:string):Promise<MaterialCustodyMaintenanceLease> {
    if(this.closed||localStoreId!==this.localStoreId)return deny();this.registry.currentPhysicalStore(localStoreId);const epoch=this.registry.currentEpoch(),expires=this.registry.now()+60000;
    // Runtime-only maintenance proof validates the actual physical store without an actor or request role.
    const descriptor=freezeMaterial({version:1 as const,authority_id:this.registry.authorityId,local_store_id:localStoreId,expires_at:expires});
    const lease=Object.freeze({descriptor});this.maintenance.set(lease,{epoch,expires,store:localStoreId});this.currentMaintenance(lease);return lease;
  }
  currentMaintenance(lease:MaterialCustodyMaintenanceLease):undefined {
    const record=this.maintenance.get(lease);if(this.closed||!record||record.store!==this.localStoreId||record.epoch!==this.registry.currentEpoch()||this.registry.now()>=record.expires)return deny();
    this.registry.currentPhysicalStore(record.store);return undefined;
  }
  release(lease:MaterialCustodyLease):undefined{this.issued.delete(lease);return undefined;}
  releaseMaintenance(lease:MaterialCustodyMaintenanceLease):undefined{this.maintenance.delete(lease);return undefined;}
  close():void{this.closed=true;}
}
interface AdmissionRecord {input:MaterialAdmissionInput;epoch:string;active:boolean;}
export class RegistryMaterialAdmissionAuthority implements MaterialAdmissionAuthority {
  private readonly issued=new WeakMap<object,AdmissionRecord>();private closed=false;
  constructor(readonly registry:MaterialRegistry){}
  currentInput(input:Readonly<MaterialAdmissionInput>):undefined {
    if(this.closed||!['accept','lookup','read','answer','wait','dispatch','complete'].includes(input.action))return deny();const binding=input.binding;this.registry.currentContext(binding.context);
    let registration=input.locator?this.registry.inspectCanonical(binding.owner_principal_id,input.locator).registration:
      input.request?this.registry.request(binding.owner_principal_id,input.request.request_id):input.reply?this.registry.request(binding.owner_principal_id,input.reply.request_id):input.stableKey?this.registry.operation(binding.owner_principal_id,binding.context.principal_id,input.stableKey):null;
    if(!registration||registration.tombstone||binding.external_member_id!==this.registry.externalMember(registration.owner,registration.source))return deny();
    if(input.request&&registration.payload_hash!==materialPayloadHash(input.request))throw new MaterialProtocolError('conflict');
    if(input.action==='accept'&&(!input.request||binding.context.principal_id!==registration.source_actor))return deny();if(input.action==='accept'&&registration.kind==='agent_task')this.registry.currentProducer(registration);
    if(input.action==='dispatch'||input.action==='complete'){if(registration.kind!=='agent_task'||!input.locator||!input.request)return deny();this.registry.currentProducer(registration);}
    this.registry.authorizeAdmissionActor(binding.context as MaterialTrustedContext,registration,input.action);
    if(input.action==='complete'){if(!input.request||!input.result)return deny();assertMaterialResultBinding(input.result,input.request,registration.target_binding.kind==='work'?registration.target_binding.work:null);}
    if(input.reply&&input.stableKey&&input.stableKey!==materialMetadataHash(['material/v1','reply',binding.context.principal_id,input.reply.client_id]))return deny();
    if(input.request&&input.action==='accept'&&input.stableKey!==materialMetadataHash(['material/v1','submit',binding.context.principal_id,input.request.client_id]))return deny();
    if(input.action==='answer'){
      if(!input.reply||!input.request||!input.locator)return deny();assertMaterialReplyBinding(input.reply,input.request,this.registry.question(input.locator),this.registry.now());
    }
    return undefined;
  }
  async before(input:Readonly<MaterialAdmissionInput>):Promise<MaterialAdmissionPermit> {
    input=freezeMaterial(input);this.currentInput(input);
    if(input.action==='answer'&&input.reply&&input.stableKey)this.registry.recordAnswerOperation(input.binding.context as MaterialTrustedContext,input.binding.owner_principal_id,input.reply.request_id,input.stableKey,materialPayloadHash(input.reply));
    if(input.locator)this.registry.bindObservedCanonical(input.binding.owner_principal_id,input.locator);
    this.currentInput(input);const permit=Object.freeze({id:randomUUID()}) as unknown as MaterialAdmissionPermit;this.issued.set(permit,{input,epoch:this.registry.currentEpoch(),active:true});this.current(permit);return permit;
  }
  current(permit:MaterialAdmissionPermit):undefined {const record=this.issued.get(permit);if(this.closed||!record?.active||record.epoch!==this.registry.currentEpoch())return deny();return this.currentInput(record.input);}
  release(permit:MaterialAdmissionPermit):undefined{const record=this.issued.get(permit);if(record)record.active=false;this.issued.delete(permit);return undefined;}
  close():void{this.closed=true;}
}
