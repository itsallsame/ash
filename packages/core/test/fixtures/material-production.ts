import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileSigner} from '../../../device/src/link';
import {LocalStateTransaction} from '../../../device/src/collaboration/local-state-transaction';
import {MaterialAssetStore} from '../../../device/src/collaboration/material-store';
import {Ledger} from '../../src/world/ledger';
import {WorldRouter} from '../../src/world/router';
import {WorldMembers} from '../../src/world/member';
import {EdgeRouter} from '../../src/server';
import {MaterialRegistry} from '../../src/collaboration/material-registry';
import {RegistryMaterialAuthorization,RegistryMaterialAdmissionAuthority,RegistryMaterialCustodyAuthority} from '../../src/collaboration/material-authorization';
import {MaterialReceiptIndex} from '../../src/collaboration/material-receipt-index';
import {MaterialDurableLedgerFacade} from '../../src/collaboration/material-durable-ledger';
import {MaterialRequestStore} from '../../src/collaboration/material-request-store';
import {CoreMaterialRequestService} from '../../src/collaboration/material-request-service';
import type {CollaborationRequest} from '../../../device/src/collaboration/material-types';
export async function productionFixture(maxRecords=4096,reuseRoot?:string){
 let clock=Date.now();const now=()=>clock;const root=reuseRoot??realpathSync(mkdtempSync(join(tmpdir(),'ash-material-production-')));for(const d of ['state','phone','work'])mkdirSync(join(root,d),{mode:0o700,recursive:true});
 const signer=await fileSigner(join(root,'state')),state=new LocalStateTransaction(join(root,'state')),ledger=await Ledger.open(join(root,'ledger'));
 const world=new WorldRouter(ledger,async()=>false),members=new WorldMembers(world),tokens={api:{secret:'person:owner'},mcp:{}};
 const edge=new EdgeRouter(ledger,world,members,tokens,{authScopeKey:Buffer.alloc(32,17),clock:now}),headers={authorization:'Bearer secret'},caller=edge.localCaller(headers)!;
 const screen=edge.screens.register(caller,'material-test-management');let generation=0;const expires=now()+600000;
 const work={kind:'work' as const,work:{kind:'conversation' as const,node_id:signer.id,endpoint_id:'codex',native_id:'testing-host-selected-work'}};
 const options:import('../../src/collaboration/material-registry').MaterialRegistryOptions={state,signer,now,signerCurrent:()=>{state.capture();return undefined;},edge,ledger,stores:[{local_store_id:'phone-store',endpoint_id:'materials',root_dir:join(root,'phone')},{local_store_id:'work-store',endpoint_id:'codex',root_dir:join(root,'work')}],environment:'testing',hostProofs:{source:'testing_fixture',currentEpoch:()=>String(generation),async capture(bindingId){const captured=generation,target=bindingId==='testing-target',endpoint=target?{kind:'work' as const,work:{...work.work,native_id:'testing-host-target'}}:work;return {principal_id:target?'testing-target-work':'testing-host-work',pairing_id:target?'testing-target-pair':'testing-host-pair',endpoint,expires_at:expires,generation:String(captured),current(){if(captured!==generation)throw Error('testing host revoked');return undefined;}};}}};
 const registry=await MaterialRegistry.open({...options,max_records:maxRecords});
 const management=registry.management(headers,screen.token),phoneProof=registry.localNodeActor(management,'materials',expires),workProof=await registry.workActor(management,'testing-explicit-host');
 const authorization=new RegistryMaterialAuthorization(registry),admission=new RegistryMaterialAdmissionAuthority(registry),facade=new MaterialDurableLedgerFacade({ledger,authority:admission,now});
 const phoneCustody=new RegistryMaterialCustodyAuthority(registry,'phone-store'),workCustody=new RegistryMaterialCustodyAuthority(registry,'work-store');
 const phoneStore=new MaterialAssetStore({rootDir:join(root,'phone'),localStoreId:'phone-store',authorization,custody:phoneCustody,clock:now}),workStore=new MaterialAssetStore({rootDir:join(root,'work'),localStoreId:'work-store',authorization,custody:workCustody,clock:now});
 const index=new MaterialReceiptIndex(registry,authorization,[{local_store_id:'phone-store',store:phoneStore,custody:phoneCustody},{local_store_id:'work-store',store:workStore,custody:workCustody}]);
 const requestStore=new MaterialRequestStore({file:join(root,'requests'),now});
 const service=new CoreMaterialRequestService({store:requestStore,ledger:facade,authorization,now,currentContext:authorization.currentContext,resolveExternalMember:async(ctx,owner)=>registry.externalMember(owner,registry.requestForActor(ctx,'req').source),readReceipt:index.readReceipt});
 const phone=registry.context(phoneProof).source_binding;
 function request(id='req'):CollaborationRequest{return {version:1,request_id:id,client_id:'client-'+id,source:work,return_to:work,target:{node_id:signer.id,endpoint_id:'materials'},target_work:null,kind:'human_material',purpose:'Registered selection',context:{goal:'Sole canonical body',confirmed_decisions:[],increment:'selection',expected_output:'asset',uncertain:[],missing:[],refs:[],provenance:[]},expected_output:'asset',expires_at:expires};}
 return {root,advance:(ms:number)=>{clock+=ms;},state,ledger,options,edge,tokens,headers,screen,signer,registry,authorization,admission,facade,service,index,requestStore,management,phoneProof,workProof,phone,work,phoneStore,workStore,phoneCustody,workCustody,request,revokeHost(){generation++;},async close(){index.close();facade.close();await phoneStore.close();await workStore.close();authorization.close();admission.close();registry.close();requestStore.close();state.close();ledger.close();if(!reuseRoot)rmSync(root,{recursive:true,force:true});}};
}
