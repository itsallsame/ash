import {createHash,randomUUID} from 'node:crypto';
import {MaterialProtocolError,type MaterialTrustedContext,type MaterialRequestService,type MaterialReply,type MaterialResultFact,type AssetInputs} from '../../../device/src/collaboration/material-types';
import {parseCollaborationRequest,assertMaterialEnvelopeSize,sameMaterialEndpoint} from '../../../device/src/collaboration/material-protocol';
import {MaterialRegistry,freezeMaterial} from './material-registry';
import type {Ledger} from '../world/ledger';
import type {MaterialDurableLedgerFacade} from './material-durable-ledger';
import type {RegistryMaterialAuthorization,RegistryMaterialCustodyAuthority} from './material-authorization';
import type {MaterialAssetStore} from '../../../device/src/collaboration/material-store';
import type {MaterialTransferService} from '../../../device/src/collaboration/material-transfer';
import type {MaterialReceiptIndex} from './material-receipt-index';
interface Options {registry:MaterialRegistry;ledger:Ledger;facade:MaterialDurableLedgerFacade;requests:MaterialRequestService;index:MaterialReceiptIndex;authorization:RegistryMaterialAuthorization;stores:Map<string,{store:MaterialAssetStore;custody:RegistryMaterialCustodyAuthority;transfer:MaterialTransferService}>;track<T>(work:()=>Promise<T>):Promise<T>;current():undefined;}
const deny=(code:ConstructorParameters<typeof MaterialProtocolError>[0]='permission_denied'):never=>{throw new MaterialProtocolError(code);};
export interface MaterialUiProjection {role:'source'|'target';request:import('../../../device/src/collaboration/material-types').CollaborationRequest;fact:MaterialResultFact;}
export interface MaterialUiResult<T> {readonly value:T;current():undefined;}
interface Consumption {context:MaterialTrustedContext;request:string;version:number;asset:string;epoch:string;}
/** Authenticated UI projection is independent of the A2 source result operation. */
export class MaterialUiService {
 private generation=0;private closed=false;private readonly consumption=new Map<string,Consumption>();
 constructor(private readonly options:Options){}
 private current(context:Readonly<MaterialTrustedContext>,epoch=this.generation):undefined{if(this.closed||epoch!==this.generation)deny('offline');this.options.current();this.options.registry.currentContext(context);return undefined;}
 private result<T>(context:MaterialTrustedContext,value:T):MaterialUiResult<T>{const epoch=this.generation;return Object.freeze({value:freezeMaterial(value),current:()=>this.current(context,epoch)});}
 currentScope(context:MaterialTrustedContext){this.current(context);return this.result(context,{principal_id:context.principal_id,node_id:this.options.registry.nodeId,generation:context.authorization_epoch,expires_at:context.expires_at,source_binding:context.source_binding});}
 private run<T>(context:MaterialTrustedContext,work:(captured:MaterialTrustedContext)=>Promise<T>):Promise<T>{try{const captured=freezeMaterial(context),epoch=this.generation;this.current(captured,epoch);return this.options.track(()=>work(captured)).then(value=>{this.current(captured,epoch);return value;},error=>{this.current(captured,epoch);throw error;});}catch(error){return Promise.reject(error);}}
 readRequest(owner:string,requestId:string,context:MaterialTrustedContext){return this.run(context,ctx=>this.readRequestRaw(owner,requestId,ctx));}
 listRequests(context:MaterialTrustedContext,before=Number.MAX_SAFE_INTEGER){return this.run(context,ctx=>this.listRequestsRaw(ctx,before));}
 answer(reply:MaterialReply,context:MaterialTrustedContext){try{const captured=freezeMaterial(reply);return this.run(context,ctx=>this.answerRaw(captured,ctx));}catch(error){return Promise.reject(error);}}
 readAsset(owner:string,requestId:string,resultVersion:number,input:AssetInputs['commit'],context:MaterialTrustedContext){try{const captured=freezeMaterial(input);if(captured.request_id!==requestId)deny();return this.run(context,ctx=>this.readAssetRaw(owner,requestId,resultVersion,captured,ctx));}catch(error){return Promise.reject(error);}}
 consumeResult(handle:string,context:MaterialTrustedContext){return this.run(context,ctx=>this.consumeResultRaw(handle,ctx));}
 /** Explicit UI consumption requires all actual private reads for this exact result. */
 consumeCurrentResult(owner:string,requestId:string,resultVersion:number,handles:readonly string[],context:MaterialTrustedContext){return this.run(context,async ctx=>{
  if(!Number.isSafeInteger(resultVersion)||resultVersion<1||!Array.isArray(handles)||handles.length>4||new Set(handles).size!==handles.length)deny('invalid');
  const read=await this.readRequestRaw(owner,requestId,ctx);read.current();if(read.value.role!=='source'||read.value.fact.result?.result_version!==resultVersion)deny('conflict');
  const assets=read.value.fact.result!.assets.filter(a=>a.kind==='asset');if(handles.length!==assets.length)deny();const seen=new Set<string>();
  for(const handle of handles){const proof=this.consumption.get(handle);if(!proof||JSON.stringify(proof.context)!==JSON.stringify(ctx)||proof.epoch!==ctx.authorization_epoch||proof.request!==requestId||proof.version!==resultVersion||seen.has(proof.asset)||!assets.some(a=>a.kind==='asset'&&a.asset_id===proof.asset))deny();seen.add(proof!.asset);}
  const fact=await this.options.requests.invoke('ack_result',{version:1,request_id:requestId,result_version:resultVersion},ctx);this.current(ctx);for(const handle of handles)this.consumption.delete(handle);return this.result(ctx,fact);
 });}
 private async readRequestRaw(owner:string,requestId:string,context:MaterialTrustedContext):Promise<MaterialUiResult<MaterialUiProjection>>{
  context=freezeMaterial(context);this.current(context);const row=this.options.registry.request(owner,requestId);if(!row||!row.locator)deny('not_found');this.options.registry.authorizeAdmissionActor(context,row!,'read');
  const binding={context,owner_principal_id:owner,external_member_id:this.options.registry.externalMember(owner,row!.source)},snapshot=await this.options.facade.read(row!.locator!,binding);this.current(context);if(!snapshot)deny('result_unknown');return this.result(context,{role:context.principal_id===owner?'source':'target',request:snapshot!.request,fact:snapshot!.fact});
 }
 private async listRequestsRaw(context:MaterialTrustedContext,before=Number.MAX_SAFE_INTEGER):Promise<MaterialUiResult<{items:MaterialUiProjection[];next_cursor:number|null}>>{
  context=freezeMaterial(context);this.current(context);if(!Number.isSafeInteger(before)||before<1)deny('invalid');const items:MaterialUiProjection[]=[];let cursor:number|null=null;
  for(const message of this.options.ledger.rawPage({before,limit:128}).reverse()){const previousCursor=cursor;cursor=message.seq;const identity=this.options.ledger.externalMaterialRecoveryIdentity(message.id);if(!identity)continue;
   const row=this.options.registry.request(identity.owner,parseCollaborationRequest(message.body).request_id);if(!row||row.tombstone)continue;try{this.options.registry.authorizeAdmissionActor(context,row,'read');}catch{this.current(context);continue;}
   const projection=await this.readRequestRaw(row.owner,row.request_id,context);this.current(context);const candidate=[...items,projection.value];try{assertMaterialEnvelopeSize({items:candidate,next_cursor:cursor});}catch{cursor=previousCursor;if(!items.length)deny('too_large');break;}items.push(projection.value);if(items.length===32)break;
  }
  this.current(context);return this.result(context,{items,next_cursor:cursor});
 }
 private async answerRaw(reply:MaterialReply,context:MaterialTrustedContext){this.current(context);const fact=await this.options.requests.invoke('reply',reply,context);this.current(context);return this.result(context,fact);}
 /** Full verified bytes are a private consume proof. Previewing never updates the result ACK. */
 private async readAssetRaw(owner:string,requestId:string,resultVersion:number,input:AssetInputs['commit'],context:MaterialTrustedContext){
  context=freezeMaterial(context);input=freezeMaterial(input);if(input.request_id!==requestId)deny();const projection=await this.readRequestRaw(owner,requestId,context);if(projection.value.role!=='source'||projection.value.fact.result?.result_version!==resultVersion)deny();
  const asset=projection.value.fact.result!.assets.find(a=>a.kind==='asset'&&a.asset_id===input.asset_id&&a.version===input.asset_version);if(!asset||asset.kind!=='asset')return deny('not_found');
  const registered=this.options.registry.asset(owner,requestId,asset.asset_id,asset.version);if(!registered||registered.tombstone||registered.provisional||registered.sha256!==asset.sha256||registered.byte_length!==asset.byte_length||!sameMaterialEndpoint(registered.destination,projection.value.request.return_to))deny();
  const scope=this.options.registry.resolveTransferScope('read_chunk',{...input,chunk_index:0},context);if(!sameMaterialEndpoint(scope.transfer.source,registered!.source)||!sameMaterialEndpoint(scope.transfer.destination,registered!.destination))deny();const storeId=this.options.registry.storeFor(scope.transfer.destination).local_store_id,port=this.options.stores.get(storeId);if(!port)deny('unsupported');
  const chunks:string[]=[];for(let chunk_index=0;chunk_index<Math.ceil(asset!.byte_length/(40*1024));chunk_index++){const chunk=await port!.transfer.invoke('read_chunk',{...input,chunk_index},context);this.current(context);chunks.push(chunk.data_base64);}
  const bytes=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk,'base64')));if(bytes.length!==asset.byte_length||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)deny('hash_mismatch');for(const [id,read] of this.consumption){try{this.options.registry.currentContext(read.context);}catch{this.consumption.delete(id);}}if(this.consumption.size>=32)deny('too_large');const handle=randomUUID();this.consumption.set(handle,{context,request:requestId,version:resultVersion,asset:input.asset_id,epoch:context.authorization_epoch});const epoch=this.generation;return Object.freeze({value:{bytes:new Uint8Array(bytes),ref:asset,verified_sha256:asset.sha256,consume_handle:handle},current:()=>this.current(context,epoch)});
 }
 private async consumeResultRaw(handle:string,context:MaterialTrustedContext){this.current(context);const proof=this.consumption.get(handle);if(!proof||JSON.stringify(proof.context)!==JSON.stringify(context)||proof.epoch!==context.authorization_epoch)deny();const read=await this.readRequestRaw(context.principal_id,proof!.request,context);read.current();const assets=read.value.fact.result?.assets.filter(asset=>asset.kind==='asset');if(read.value.role!=='source'||read.value.fact.result?.result_version!==proof!.version||assets?.length!==1||assets[0].kind!=='asset'||assets[0].asset_id!==proof!.asset)deny();const fact=await this.options.requests.invoke('ack_result',{version:1,request_id:proof!.request,result_version:proof!.version},context);this.current(context);this.consumption.delete(handle);return this.result(context,fact);}
 invalidate():void{this.generation++;this.consumption.clear();}
 close():void{if(this.closed)return;this.closed=true;this.invalidate();}
}

/** A4 browser projection. Destination byte receipt, native delivery and business success remain distinct facts. */
export function projectMaterialUiRequest(projection:MaterialUiProjection,inputReceipts:readonly import('../../../device/src/collaboration/material-types').AssetReceipt[]=[],questionDetail:string|null=null){
 const {request,fact,role}=projection;questionDetail??=fact.question?request.context.increment||request.purpose:null;const target=request.target_work?{kind:'work' as const,work:request.target_work}:{kind:'node' as const,node_id:request.target.node_id,endpoint_id:request.target.endpoint_id};
 const refs=[...request.context.refs,...(fact.result?.assets??[])].filter((ref,index,all)=>all.findIndex(other=>JSON.stringify(other)===JSON.stringify(ref))===index);
 const assets=refs.map(ref=>{const resultAsset=fact.result?.assets.some(a=>JSON.stringify(a)===JSON.stringify(ref))??false,receipt=ref.kind==='asset'?[...(resultAsset?fact.receipts:inputReceipts)].find(r=>r.request_id===request.request_id&&r.asset_id===ref.asset_id&&r.asset_version===ref.version&&r.sha256===ref.sha256&&r.byte_length===ref.byte_length):undefined;return {ref,transfer:receipt?{version:1 as const,transfer_id:receipt.transfer_id,request_id:receipt.request_id,asset_id:receipt.asset_id,asset_version:receipt.asset_version,state:'committed' as const,received_chunks:[],receipt,expires_at:ref.kind==='asset'?ref.expires_at:request.expires_at}:null,location:receipt?'destination' as const:'source_snapshot' as const,readable:!!receipt};});
 return freezeMaterial({version:1 as const,request_id:request.request_id,source:request.source,return_to:request.return_to,target,kind:request.kind,purpose:request.purpose,expires_at:request.expires_at,role,fact,assets,question_detail:questionDetail,can_answer:request.kind==='human_material'&&role==='target'&&!!fact.question&&fact.question.expires_at>Date.now(),can_consume:role==='source'&&!!fact.result&&fact.result.assets.filter(a=>a.kind==='asset').every(a=>assets.some(s=>s.readable&&JSON.stringify(s.ref)===JSON.stringify(a))),observed_at:Date.now()});
}
