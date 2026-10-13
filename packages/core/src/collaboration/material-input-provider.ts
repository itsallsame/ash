import {randomUUID} from 'node:crypto';
import {MaterialProtocolError,type MaterialTrustedContext} from '../../../device/src/collaboration/material-types';
import {sameMaterialEndpoint} from '../../../device/src/collaboration/material-protocol';
import {freezeInputMetadata,parseInputProviderSelection,assertInputCanonicalSelection,type InputProviderSelection,type InputCanonicalFacts} from '../../../device/src/collaboration/material-provider-protocol';
import type {InputProviderCall} from '../../../device/src/collaboration/material-provider-channel';
import type {MaterialRelayPeer} from '../../../device/src/collaboration/material-client';
import type {MaterialTargetProvider} from './material-target-provider';
import type {MaterialTargetInput} from '../../../device/src/collaboration/material-target-work';
import {MaterialRegistry,type MaterialManagementPermit,type MaterialActorProof} from './material-registry';
interface Binding {permit:MaterialManagementPermit;actor:MaterialActorProof;peer:MaterialRelayPeer;request:string;asset:string;version:number;epoch:string;expires:number;target:MaterialTargetInput;}
export interface MaterialInputTransferBinding {readonly binding_id:string;readonly selection:InputProviderSelection;readonly context:MaterialTrustedContext;current():undefined;}
/** Source-owned, memory-only input bindings. A locator cannot enrol a receiver or a work actor. */
export class MaterialInputProvider {
 private readonly bindings=new Map<string,Binding>();private closed=false;
 constructor(private readonly registry:MaterialRegistry,private readonly peerCurrent:(peer:MaterialRelayPeer)=>undefined,private readonly targetProvider?:MaterialTargetProvider){}
 issue(permit:MaterialManagementPermit,actor:MaterialActorProof,peer:MaterialRelayPeer,requestId:string,assetId:string,version:number):MaterialInputTransferBinding {
  this.registry.currentManagement(permit);peer=freezeInputMetadata(peer);this.peerCurrent(peer);const context=this.registry.context(actor),projection=this.registry.inputAsset(context,requestId,assetId,version),request=projection.registration;
  if(request.target_binding.kind!=='work'||request.target_binding.work.node_id!==peer.peer_id||peer.local_id!==this.registry.nodeId||request.target_pairing!==peer.pairing_id)throw new MaterialProtocolError('permission_denied');
  for(const [id,row]of this.bindings)if(row.expires<=this.registry.now())this.bindings.delete(id);if(this.closed)throw new MaterialProtocolError('offline');if(this.bindings.size>=128)throw new MaterialProtocolError('too_large');
  const id=randomUUID(),row:Binding={permit,actor,peer,request:requestId,asset:assetId,version,epoch:this.registry.currentEpoch(),expires:Math.min(request.expires_at,projection.asset.expires_at),target:this.registry.inputTargetMetadata(context,requestId)};this.bindings.set(id,row);
  const asset=projection.asset,selection=freezeInputMetadata({purpose:'input_asset' as const,binding_id:id,request_id:requestId,asset_id:assetId,asset_version:version,sha256:asset.sha256,byte_length:asset.byte_length,media_type:asset.media_type});
  const current=():undefined=>{this.current(id,row);this.registry.currentContext(context);return undefined;};current();return Object.freeze({binding_id:id,selection,context,current});
 }
 private current(id:string,row:Binding):undefined{if(this.closed||this.bindings.get(id)!==row)throw new MaterialProtocolError('offline');if(this.registry.now()>=row.expires)throw new MaterialProtocolError('expired');this.registry.currentManagement(row.permit);if(row.epoch!==this.registry.currentEpoch()||this.peerCurrent(row.peer)!==undefined)throw new MaterialProtocolError('permission_denied');return undefined;}
 async resolve(input:InputProviderSelection,call:InputProviderCall):Promise<{value:InputCanonicalFacts;current():undefined}>{input=parseInputProviderSelection(input);const row=this.bindings.get(input.binding_id);if(!row)throw new MaterialProtocolError('not_found');const current=():undefined=>{call.current();this.current(input.binding_id,row);if(JSON.stringify(call.peer)!==JSON.stringify(row.peer))throw new MaterialProtocolError('permission_denied');return undefined;};current();if(input.request_id!==row.request||input.asset_id!==row.asset||input.asset_version!==row.version)throw new MaterialProtocolError('conflict');const context=this.registry.context(row.actor);if(!this.targetProvider)throw new MaterialProtocolError('unsupported');const target=await this.targetProvider.captureTarget(row.target);current();this.registry.refreshInputTarget(row.permit,context,row.request,target);const {registration:request,asset}=this.registry.inputAsset(context,row.request,row.asset,row.version);if(request.target_binding.kind!=='work'||!sameMaterialEndpoint(request.source,context.source_binding))throw new MaterialProtocolError('permission_denied');
  const value=freezeInputMetadata({version:1 as const,purpose:'input_asset' as const,authority_id:this.registry.authorityId,owner_principal_id:request.owner,request_id:request.request_id,request_hash:request.payload_hash,source:request.source,return_to:request.return_to,target_work:request.target_binding.work,asset,expires_at:Math.min(request.expires_at,asset.expires_at),grant_revision:context.grant_revision,proof_expires_at:Math.min(row.expires,this.registry.now()+30000)});assertInputCanonicalSelection(input,value);current();this.registry.currentContext(context);return {value,current:()=>{current();this.registry.currentContext(context);this.registry.inputAsset(context,row.request,row.asset,row.version);return undefined;}};
 }
 invalidate():void{this.bindings.clear();}
 close():void{this.closed=true;this.invalidate();}
}
