/** Explicit subprocess integration fixture: real stores/registry/screen proof, synthetic H3 only. */
import {productionFixture} from './material-production';
import type {AssetInputs} from '../../../device/src/collaboration/material-types';
const [root,encoded,mode]=process.argv.slice(2),f=await productionFixture(4096,root),identity=JSON.parse(encoded!) as AssetInputs['commit'];
try{
 if(mode==='commit-kill'){const context=f.registry.context(f.phoneProof),scope=f.registry.resolveTransferScope('commit',identity,context),lease=await f.authorization.before(context,scope),fact=await f.workStore.commit(identity,{context,scope,lease});process.stdout.write(`committed:${fact.receipt!.receipt_id}\n`);await new Promise(()=>{});}
 const context=f.registry.context(f.workProof),scope=f.registry.resolveTransferScope('read_chunk',{...identity,chunk_index:0},context),lease=await f.authorization.before(context,scope);
 const receipt=await f.index.record(identity,lease,scope);
 if(mode==='index-kill'){process.stdout.write(`indexed:${receipt.receipt_id}\n`);await new Promise(()=>{});}
 if(mode==='attach'||mode==='attach-kill'){const fact=await f.service.attachReceipt(identity.request_id,1,receipt.receipt_id,context);process.stdout.write(JSON.stringify({receipt_id:receipt.receipt_id,receipts:fact.receipts.length})+'\n');if(mode==='attach-kill')await new Promise(()=>{});}
}finally{await f.close();}
