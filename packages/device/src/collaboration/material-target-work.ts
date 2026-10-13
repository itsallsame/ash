import { GatewayClient } from 'ash-gateway/client/client';
import type { Envelope } from 'ash-gateway/src/protocol';
import { deviceIdForKey } from 'ash-gateway/src/protocol';
import { isAbsolute, resolve } from 'node:path';
import { captureControlTarget, type DeviceControlRuntime, type ControlTargetMetadata } from './control-runtime';
import { CollaborationControlError } from './control-types';
import { NativeTransportError } from './codex-transport';
import { MaterialProtocolError } from './material-types';
import { relayFrame, relayRecord, relayId, relaySize, type MaterialRelayPeer, type MaterialRelayTransport } from './material-client';
import type { WorkRef } from './types';
export const MATERIAL_PROVIDER_REQUEST_TYPE = 'ash.material.provider.request.v1';
export const MATERIAL_PROVIDER_RESPONSE_TYPE = 'ash.material.provider.response.v1';
export interface MaterialTargetInput { work: WorkRef; authorization_revision: string; action: 'send_input'|'steer'; }
export interface MaterialTargetFacts extends MaterialTargetInput { cwd:string; generation:string; target_known:true; send_authorized:true; expires_at:number; authorized_until:number|null; }
export function parseTargetInput(value:unknown):MaterialTargetInput {
  const v=relayRecord(value,['work','authorization_revision','action']),w=relayRecord(v.work,['node_id','endpoint_id','kind','native_id']);
  if(w.kind!=='conversation'||!['send_input','steer'].includes(v.action)||typeof v.authorization_revision!=='string'||!/^[a-f0-9]{64}$/.test(v.authorization_revision))throw new MaterialProtocolError('invalid');
  return {work:{node_id:relayId(w.node_id),endpoint_id:relayId(w.endpoint_id),kind:'conversation',native_id:relayId(w.native_id)},authorization_revision:v.authorization_revision,action:v.action};
}
export function parseTargetFacts(value:unknown,now=Date.now()):MaterialTargetFacts {
  const v=relayRecord(value,['work','authorization_revision','action','cwd','generation','target_known','send_authorized','expires_at','authorized_until']);
  const input=parseTargetInput({work:v.work,authorization_revision:v.authorization_revision,action:v.action});
  if(typeof v.cwd!=='string'||Buffer.byteLength(v.cwd)>4096||!isAbsolute(v.cwd)||resolve(v.cwd)!==v.cwd||/[\x00-\x1f]/.test(v.cwd)||typeof v.generation!=='string'||!v.generation||Buffer.byteLength(v.generation)>8192||v.target_known!==true||v.send_authorized!==true||!Number.isSafeInteger(v.expires_at)||v.expires_at<=now||v.expires_at>now+30_000)throw new MaterialProtocolError('invalid');
  if(v.authorized_until!==null&&(!Number.isSafeInteger(v.authorized_until)||v.authorized_until<=now||v.expires_at>v.authorized_until))throw new MaterialProtocolError('invalid');
  return {...input,cwd:v.cwd,generation:v.generation,target_known:true,send_authorized:true,expires_at:v.expires_at,authorized_until:v.authorized_until};
}
export interface MaterialTargetEndpointOptions {
  runtime:DeviceControlRuntime; gateway:GatewayClient; transport:MaterialRelayTransport;
  /** Use the same private link-work observer as the existing material relay. */
  observeUnfinished(work:Promise<unknown>):undefined;
}
/** Fixed provider operation. Owner identity comes exclusively from the verified pairing. */
export class MaterialTargetEndpoint {
  private closed=false;private epoch=0;private active=new Set<object>();private seen=new Map<string,number>();private cancels=new Set<()=>void>();
  constructor(private readonly options:MaterialTargetEndpointOptions) {}
  async acceptFrame(value:unknown):Promise<boolean> {
    if((value as any)?.type!==MATERIAL_PROVIDER_REQUEST_TYPE)return false;
    if(this.closed||this.active.size>=32)return true;
    const token={},epoch=this.epoch;this.active.add(token);let timer:ReturnType<typeof setTimeout>|undefined;
    let cancel:(()=>void)|undefined;
    try {
      const e=relayFrame(structuredClone(value),MATERIAL_PROVIDER_REQUEST_TYPE,Date.now());
      const body=relayRecord(JSON.parse(e.payload),['version','call_id','operation','input']);
      if(body.version!==1||body.operation!=='target.resolve'||e.reply_to!==null)throw new MaterialProtocolError('invalid');
      relayId(body.call_id);const input=parseTargetInput(body.input),deadline=e.expires_at;
      let peer:MaterialRelayPeer|undefined;
      const current=():undefined=>{if(this.closed||epoch!==this.epoch||!this.active.has(token)||Date.now()>=deadline)throw new MaterialProtocolError('offline');if(peer&&this.options.transport.current(peer)!==undefined)throw new MaterialProtocolError('permission_denied');return undefined;};
      let registered=false;
      const raw=Promise.resolve().then(async()=>{
        if(!registered)throw new MaterialProtocolError('offline');current();peer=Object.freeze(structuredClone(await this.options.transport.capture()));current();
        if(e.from!==peer.peer_id||e.to!==peer.local_id||input.work.node_id!==peer.local_id||await deviceIdForKey(peer.public_key)!==peer.peer_id||!await GatewayClient.verifyEnvelope(e,peer.public_key))throw new MaterialProtocolError('permission_denied');current();relayFrame(e,MATERIAL_PROVIDER_REQUEST_TYPE,Date.now());
        for(const [key,end]of this.seen)if(end<=Date.now())this.seen.delete(key);
        const key=`${peer.pairing_id}:${e.from}:${e.message_id}`;if(this.seen.has(key))return;if(this.seen.size>=4096)throw new MaterialProtocolError('too_large');this.seen.set(key,deadline);
        let payload:object;let capture:ControlTargetMetadata|undefined;
        try {
        try {
          capture=await captureControlTarget(this.options.runtime,{transportOwnerId:peer.peer_id,isCurrent:()=>{try{current();return true;}catch{return false;}}},{...input,endpoint_id:input.work.endpoint_id});
          current();capture.current();payload={version:1,call_id:body.call_id,result:parseTargetFacts({...input,cwd:capture.cwd,generation:capture.generation,authorized_until:capture.authorized_until,target_known:true,send_authorized:true,expires_at:Math.min(deadline,Date.now()+30_000,capture.authorized_until??Infinity)})};
        }catch(error){current();const code=error instanceof CollaborationControlError||error instanceof MaterialProtocolError||error instanceof NativeTransportError?error.code:'offline';payload={version:1,call_id:body.call_id,error:['invalid','offline','unsupported','timeout'].includes(code)?code:'permission_denied'};}
        current();capture?.current();const response=await this.options.gateway.envelope(MATERIAL_PROVIDER_RESPONSE_TYPE,peer.peer_id,payload,{replyTo:e.message_id,ttlMs:Math.max(1,deadline-Date.now()-1)});
        current();if(capture&&!await capture.check())throw new MaterialProtocolError('permission_denied');current();capture?.current();relaySize(response);if(response.from!==peer.local_id||response.expires_at>deadline)throw new MaterialProtocolError('permission_denied');if(this.options.transport.send(response)!==undefined)throw new MaterialProtocolError('offline');
        }finally{capture?.release();}
      });raw.catch(()=>{});
      if(this.options.observeUnfinished(raw)!==undefined)throw new MaterialProtocolError('offline');registered=true;
      await Promise.race([raw,new Promise<never>((_,reject)=>{cancel=()=>reject(new MaterialProtocolError('offline'));this.cancels.add(cancel);timer=setTimeout(()=>{this.active.delete(token);reject(new MaterialProtocolError('timeout'));},Math.max(1,deadline-Date.now()));})]);
    }catch{/* Unverified input and late completion have no response authority. */}
    finally{if(timer)clearTimeout(timer);if(cancel)this.cancels.delete(cancel);this.active.delete(token);}
    return true;
  }
  invalidate():void{this.epoch++;for(const cancel of this.cancels)cancel();this.cancels.clear();this.active.clear();}
  close():void{this.closed=true;this.invalidate();}
  get inflight():number{return this.active.size;}
}
