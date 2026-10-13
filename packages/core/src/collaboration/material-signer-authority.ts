import type {Signer} from '../gateway/link';
import {HostDeviceLink,type HostSignerProof} from '../host-v2';
export interface MaterialSignerLease {readonly signer:Signer;readonly id:string;readonly publicKey:string;readonly generation:string;}
const ISSUE=Symbol('native material signer issuer');
const hostSigner=HostDeviceLink.prototype.signer,hostCapture=HostDeviceLink.prototype.captureSignerProof,hostCurrent=HostDeviceLink.prototype.currentSignerProof;
const authorities=new WeakSet<object>();
/** Physical node custody only; this is never a Codex work or receiver authorization. */
export class NativeMaterialSignerAuthority {
 readonly #host:HostDeviceLink;readonly #leases=new WeakMap<object,HostSignerProof>();#closed=false;
 private constructor(host:HostDeviceLink,issuer:symbol){if(issuer!==ISSUE)throw Error('native signer authority unavailable');this.#host=host;authorities.add(this);Object.freeze(this);}
 static async fromHost(host:HostDeviceLink):Promise<NativeMaterialSignerAuthority>{if(!(host instanceof HostDeviceLink))throw Error('native signer authority unavailable');const signer=await hostSigner.call(host);const proof=await hostCapture.call(host,signer);hostCurrent.call(host,proof);return new NativeMaterialSignerAuthority(host,ISSUE);}
 async capture(signer:Signer):Promise<MaterialSignerLease>{if(this.#closed)throw Error('native signer authority unavailable');const proof=await hostCapture.call(this.#host,signer);if(this.#closed)throw Error('native signer authority unavailable');const lease=Object.freeze({signer,id:proof.id,publicKey:proof.publicKey,generation:proof.generation});this.#leases.set(lease,proof);this.current(lease);return lease;}
 current(lease:MaterialSignerLease):undefined{const proof=this.#leases.get(lease);if(this.#closed||!proof||lease.signer.id!==lease.id||lease.signer.publicKey!==lease.publicKey||lease.id!==proof.id||lease.publicKey!==proof.publicKey||lease.generation!==proof.generation)throw Error('native signer custody unavailable');hostCurrent.call(this.#host,proof);return undefined;}
 close():void{this.#closed=true;}
 static isIssued(value:unknown):value is NativeMaterialSignerAuthority{return!!value&&typeof value==='object'&&authorities.has(value);}
}

Object.freeze(NativeMaterialSignerAuthority.prototype);Object.freeze(NativeMaterialSignerAuthority);
