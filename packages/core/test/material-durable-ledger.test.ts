import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../src/world/ledger';
import { WorldRouter } from '../src/world/router';
import { MaterialDurableLedgerFacade, type MaterialAdmissionAuthority, type MaterialAdmissionInput, type MaterialAdmissionPermit, type MaterialTaskDispatchAdapter } from '../src/collaboration/material-durable-ledger';
import type { MaterialLedgerBinding } from '../src/collaboration/material-ledger-facade';
import { CoreMaterialRequestService } from '../src/collaboration/material-request-service';
import { MaterialRequestStore, materialStableKey } from '../src/collaboration/material-request-store';
import { MaterialProtocolError, type CollaborationRequest, type MaterialReply, type MaterialTrustedContext, type ResultEnvelope } from '../../device/src/collaboration/material-types';
import { sameMaterialEndpoint } from '../../device/src/collaboration/material-protocol';

// Explicitly synthetic protected authority. It proves only the Ledger port, not native host custody.
const source = {kind:'work' as const,work:{kind:'conversation' as const,node_id:'desktop',endpoint_id:'codex',native_id:'synthetic-original'}};
const target = {kind:'node' as const,node_id:'phone',endpoint_id:'materials'};
const member = `external:material:${createHash('sha256').update('synthetic-owner/original').digest('hex')}`;
const now = 10000;
function request(kind: CollaborationRequest['kind'] = 'human_material', id='req'): CollaborationRequest {
  const work = kind === 'material_to_work' ? {...source.work,native_id:'synthetic-target',node_id:'phone',endpoint_id:'materials'} : null;
  return {version:1,request_id:id,client_id:`client-${id}`,source,return_to:source,target:{node_id:target.node_id,endpoint_id:target.endpoint_id,...(kind==='agent_task'?{capability_id:'synthetic.summarize'}:{})},target_work:work,kind,purpose:'Synthetic material question',
    context:{goal:'Canonical question body marker',confirmed_decisions:[],increment:'synthetic',expected_output:'text',uncertain:[],missing:[],refs:[],provenance:[]},expected_output:'text',expires_at:90000};
}
function context(actor='owner', endpoint: MaterialTrustedContext['source_binding']=source): MaterialTrustedContext {
  return {principal_id:actor,pairing_id:`pair-${actor}`,grant_revision:'g1',authorization_epoch:'e1',source_binding:endpoint,expires_at:100000};
}
function binding(actor='owner', endpoint: MaterialTrustedContext['source_binding']=source): MaterialLedgerBinding {
  return {context:context(actor,endpoint),owner_principal_id:'owner',external_member_id:member};
}
function syntheticAuthority(clock=()=>now) {
  const issued = new WeakMap<object,{input: MaterialAdmissionInput;epoch:number;active:boolean}>();
  let epoch=1, deny=false;
  const authority: MaterialAdmissionAuthority = {
    currentInput() { return undefined; },
    async before(input) {
      const b=input.binding,c=b.context;
      if(deny || b.owner_principal_id!=='owner' || b.external_member_id!==member || c.pairing_id!==`pair-${c.principal_id}` || c.authorization_epoch!=='e1') throw new MaterialProtocolError('permission_denied');
      if(c.principal_id!=='owner' && c.principal_id!=='phone-actor' && c.principal_id!=='target-work') throw new MaterialProtocolError('permission_denied');
      const endpoint = c.principal_id==='owner' ? source : c.principal_id==='phone-actor' ? target : {kind:'work' as const,work:request('material_to_work').target_work!};
      if(!sameMaterialEndpoint(c.source_binding,endpoint)) throw new MaterialProtocolError('permission_denied');
      if(input.request) {
        if(!sameMaterialEndpoint(input.request.source,source)) throw new MaterialProtocolError('permission_denied');
        if(input.action==='accept' && c.principal_id!=='owner') throw new MaterialProtocolError('permission_denied');
        if(input.action==='answer' && (input.request.kind==='human_material'?c.principal_id!=='phone-actor':c.principal_id!=='target-work')) throw new MaterialProtocolError('permission_denied');
      }
      const permit=Object.freeze({}) as MaterialAdmissionPermit;
      issued.set(permit,{input,epoch,active:true});return permit;
    },
    current(permit) { const row=issued.get(permit);if(!row?.active || row.epoch!==epoch || deny) throw new MaterialProtocolError('permission_denied');if(clock()>=row.input.binding.context.expires_at) throw new MaterialProtocolError('expired'); return undefined; },
    release(permit) { const row=issued.get(permit);if(row) row.active=false; return undefined; },
  };
  return {authority,revoke(){epoch++;deny=true;},restore(){epoch++;deny=false;}};
}
function result(r: CollaborationRequest, summary='Canonical answer marker'): ResultEnvelope {
  return {version:1,request_id:r.request_id,reply_to:r.request_id,result_version:1,source:r.source,target_work:r.target_work,summary,assets:[],missing:[],error_code:null,observed_at:now};
}
function reply(r: CollaborationRequest,pending: string,summary?: string): MaterialReply {
  const base={version:1 as const,client_id:'answer-client',request_id:r.request_id,source:r.source,expires_at:r.expires_at,result:result(r,summary)};
  return r.kind==='human_material'?{...base,kind:'human_answer',pending_id:pending,question_version:1}:{...base,kind:'work_result'};
}
const key=(id='req')=>materialStableKey('owner',`client-${id}`,'submit');
const answerKey=materialStableKey('phone-actor','answer-client','reply');
function temp() { return mkdtempSync(join(tmpdir(),'ash-material-actualledger-')); }
function code(expected:string) { return (error:unknown)=>error instanceof MaterialProtocolError && error.code===expected; }

test('actual Ledger: two connections accept/answer one canonical body and stable locator, reopen',async()=>{
  const dir=temp(),file=join(dir,'ledger.db'); const one=await Ledger.open(file),two=await Ledger.open(file);
  const auth=syntheticAuthority();const a=new MaterialDurableLedgerFacade({ledger:one,authority:auth.authority,now:()=>now}),b=new MaterialDurableLedgerFacade({ledger:two,authority:auth.authority,now:()=>now});
  try {
    const r=request(),[x,y]=await Promise.all([a.accept(r,binding(),key()),b.accept(r,binding(),key())]); assert.deepEqual(x,y);
    const phone=binding('phone-actor',target),answer=reply(r,x.pending_id!);
    const [p,q]=await Promise.all([a.answer(answer,phone,answerKey),b.answer(answer,phone,answerKey)]);assert.deepEqual(p,q);
    const fact=await a.read(x,binding());assert.equal(fact?.fact.state,'result_available');assert.equal(fact?.fact.question?.pending_id,x.pending_id);
    assert.equal(one.humanPending(x.pending_id!)?.turn,null);assert.equal(one.humanPending(x.pending_id!)?.state,'answered');assert.equal(one.humanPendingList().items.length,0);assert.equal(one.activeHumanPending().length,0);
    const db=new DatabaseSync(file);assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as {n:number}).n,2);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM human_pending').get() as {n:number}).n,1);
    for(const table of ['material_external_admissions','material_external_operations']) assert.doesNotMatch(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()),/Canonical (question body|answer) marker/);
    assert.equal(one.responseTo(x.ledger_request_id)?.reply_to,x.ledger_request_id);db.close();one.close();two.close();
    const reopened=await Ledger.open(file);try{const facade=new MaterialDurableLedgerFacade({ledger:reopened,authority:auth.authority,now:()=>now});assert.deepEqual(await facade.lookup(binding(),key()),x);assert.deepEqual(await facade.lookup(phone,answerKey),x);}finally{reopened.close();}
  } finally { try{one.close();}catch{}try{two.close();}catch{}rmSync(dir,{recursive:true,force:true}); }
});

test('conflicts, exact actor/source/target, opaque permits, question/result versions and expiry',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'db'));let clock=now;const auth=syntheticAuthority(()=>clock);const f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>clock});
  try {
    const r=request(),loc=await f.accept(r,binding(),key());
    await assert.rejects(f.accept({...r,purpose:'changed'},binding(),key()),code('conflict'));
    await assert.rejects(f.lookup({...binding(),owner_principal_id:'other'},key()),code('permission_denied'));
    await assert.rejects(f.read({...loc,pending_id:'other'},binding()),code('conflict'));
    await assert.rejects(f.read(loc,binding('phone-actor',source)),code('permission_denied'));
    await assert.rejects(f.read(loc,{...binding(),context:{...context(),pairing_id:'other'}}),code('permission_denied'));
    assert.throws(()=>ledger.admitExternalMaterial(r,binding(),key(),{} as MaterialAdmissionPermit,now),code('permission_denied'));
    await assert.rejects(f.answer({...reply(r,loc.pending_id!),question_version:2} as MaterialReply,binding('phone-actor',target),answerKey),code('conflict'));
    const answer=reply(r,loc.pending_id!);await assert.rejects(f.answer({...answer,result:{...answer.result,result_version:2}},binding('phone-actor',target),answerKey),code('conflict'));
    await f.answer(answer,binding('phone-actor',target),answerKey);
    await assert.rejects(f.answer(reply(r,loc.pending_id!,'different'),binding('phone-actor',target),answerKey),code('conflict'));
    await assert.rejects(f.answer({...answer,client_id:'other'},binding('phone-actor',target),materialStableKey('phone-actor','other','reply')),code('conflict'));
    clock=r.expires_at;assert.equal((await f.read(loc,binding()))?.fact.state,'expired');await assert.rejects(f.accept(r,binding(),key()),code('expired'));
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

for(const stage of ['before-transaction','after-request','before-commit','after-commit'] as const) test(`accept/answer crash recovery at ${stage}`,async()=>{
  const dir=temp(),file=join(dir,'db');let failing=false;
  let ledger=await Ledger.open(file,{materialFailpoint:s=>{if(failing&&s===stage)throw new Error('synthetic crash');}});
  const auth=syntheticAuthority();let f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});
  try {
    failing=true;await assert.rejects(f.accept(request(),binding(),key()));ledger.close();ledger=await Ledger.open(file);
    f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});const loc=await f.accept(request(),binding(),key());ledger.close();
    ledger=await Ledger.open(file,{materialFailpoint:s=>{if(failing&&s===stage)throw new Error('synthetic crash');}});f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});
    await assert.rejects(f.answer(reply(request(),loc.pending_id!),binding('phone-actor',target),answerKey));ledger.close();ledger=await Ledger.open(file);
    f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});await f.answer(reply(request(),loc.pending_id!),binding('phone-actor',target),answerKey);
    assert.equal(ledger.list().length,2);assert.equal((await f.read(loc,binding()))?.fact.result?.summary,'Canonical answer marker');
  }finally{try{ledger.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('current fence rolls back before commit, after commit retains dedupe through revoke/restore ABA',async()=>{
  for(const stage of ['before-commit','after-commit'] as const){
    const dir=temp(),file=join(dir,'db'),auth=syntheticAuthority();let revoke=true;
    const ledger=await Ledger.open(file,{materialFailpoint:s=>{if(revoke&&s===stage){revoke=false;auth.revoke();auth.restore();}}});const f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});
    try{await assert.rejects(f.accept(request(),binding(),key()),code('permission_denied'));assert.equal(ledger.list().length,stage==='before-commit'?0:1);const loc=await f.accept(request(),binding(),key());assert.equal(ledger.list().length,1);assert.ok(loc.pending_id);}finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
  }
});

test('actual A2 service/store recovers missing accept and answer mapping after commit',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'ledger'));let store=new MaterialRequestStore({file:join(dir,'mapping'),now:()=>now});const auth=syntheticAuthority();const f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});
  const make=()=>new CoreMaterialRequestService({store,ledger:f,authorization:{async before(c){return c;},async after(){},current(){return undefined;}},currentContext(){return undefined;},async resolveExternalMember(){return member;},now:()=>now});
  try {
    // Simulates crash between actual ledger commit and A2 metadata map.
    const originalMap=store.map.bind(store);let fail=true;store.map=(...args)=>{if(fail){fail=false;throw new Error('synthetic A2 mapping crash');}return originalMap(...args);};
    await assert.rejects(make().invoke('submit',request(),context()));store.close();store=new MaterialRequestStore({file:join(dir,'mapping'),now:()=>now});
    const fact=await make().invoke('submit',request(),context());assert.equal(fact.state,'waiting_owner');assert.ok(fact.question);
    const originalReplyMap=store.mapReply.bind(store);fail=true;store.mapReply=(...args)=>{if(fail){fail=false;throw new Error('synthetic reply mapping crash');}return originalReplyMap(...args);};
    const answer=reply(request(),fact.question!.pending_id);
    await assert.rejects(make().invoke('reply',answer,context('phone-actor',target)));store.close();store=new MaterialRequestStore({file:join(dir,'mapping'),now:()=>now});
    const answered=await make().invoke('reply',answer,context('phone-actor',target));assert.equal(answered.state,'result_available');
    const read=await make().invoke('get_result',{version:1,request_id:'req'},context());assert.equal(read.result?.summary,'Canonical answer marker');assert.equal(ledger.list().length,2);
    const claimed=await make().invoke('ack_result',{version:1,request_id:'req',result_version:1},context());assert.equal(claimed.claimed_result_version,1);
  }finally{store.close();ledger.close();rmSync(dir,{recursive:true,force:true});}
});

test('material_to_work has no human pending and only target-work result can answer',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'db')),auth=syntheticAuthority(),f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});
  try{const r=request('material_to_work'),loc=await f.accept(r,binding(),key());assert.equal(loc.pending_id,null);assert.equal((await f.read(loc,binding()))?.fact.state,'registered');const b=binding('target-work',{kind:'work',work:r.target_work!});await f.answer(reply(r,''),b,materialStableKey('target-work','answer-client','reply'));assert.equal((await f.read(loc,binding()))?.fact.state,'result_available');}finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

function syntheticDispatch(counter: {calls:number}, idempotent:boolean, lose=false): MaterialTaskDispatchAdapter {
  return {async recoverBinding(){return binding();},async authorize(r,b){
    assert.equal(r.target.capability_id,'synthetic.summarize');assert.deepEqual(r.target,{node_id:target.node_id,endpoint_id:target.endpoint_id,capability_id:'synthetic.summarize'});assert.equal(b.external_member_id,member);
    return {current(){return undefined;},idempotentRecovery:idempotent,production_work:null,async execute(id,canonical){assert.match(id,/^m_/);counter.calls++;if(lose)throw new Error('synthetic lost response');return result(canonical,'Actual synthetic handler response');},release(){return undefined;}};
  }};
}
test('actual router recovery routes material tasks exclusively; non-idempotent lost response remains unknown',async()=>{
  const dir=temp(),file=join(dir,'db'),auth=syntheticAuthority(),calls={calls:0};let ledger=await Ledger.open(file);let router=new WorldRouter(ledger,()=>true);
  try {
    const f=new MaterialDurableLedgerFacade({ledger,router,authority:auth.authority,taskDispatch:syntheticDispatch(calls,false,true),now:()=>now});
    await assert.rejects(f.accept(request('agent_task'),binding(),key()));assert.equal(calls.calls,1);
    const identity=ledger.externalMaterialRecoveryIdentity(ledger.list()[0]!.id)!;
    assert.equal(ledger.agentJob(member,identity.locator.job_id!),null);assert.deepEqual(ledger.pendingAgentJobs(member),[]);
    assert.equal((await f.read(identity.locator,binding()))?.fact.state,'unknown');router.dispose();ledger.close();ledger=await Ledger.open(file);router=new WorldRouter(ledger,()=>true);
    const recovered=new MaterialDurableLedgerFacade({ledger,router,authority:auth.authority,taskDispatch:syntheticDispatch(calls,false),now:()=>now});await router.recover();assert.equal(calls.calls,1);assert.equal(ledger.responseTo(identity.locator.ledger_request_id),null);assert.equal((await recovered.read(identity.locator,binding()))?.fact.state,'unknown');
    const db=new DatabaseSync(file);const job=db.prepare('SELECT * FROM agent_jobs').get() as {turn:null;origin:string};assert.equal(job.turn,null);assert.equal(job.origin,'external_material');db.close();
  }finally{router.dispose();ledger.close();rmSync(dir,{recursive:true,force:true});}
});
test('idempotent recovery retains canonical request ID and commits actual handler response',async()=>{
  const dir=temp(),file=join(dir,'db'),auth=syntheticAuthority(),calls={calls:0};const ledger=await Ledger.open(file),router=new WorldRouter(ledger,()=>true);
  try{
    const fail=new MaterialDurableLedgerFacade({ledger,router,authority:auth.authority,taskDispatch:syntheticDispatch(calls,true,true),now:()=>now});await assert.rejects(fail.accept(request('agent_task'),binding(),key()));
    const good=new MaterialDurableLedgerFacade({ledger,router,authority:auth.authority,taskDispatch:syntheticDispatch(calls,true),now:()=>now});await router.recover();const loc=await good.lookup(binding(),key());assert.equal((await good.read(loc!,binding()))?.fact.result?.summary,'Actual synthetic handler response');assert.equal(ledger.list().length,2);await router.recover();assert.equal(calls.calls,2);
  }finally{router.dispose();ledger.close();rmSync(dir,{recursive:true,force:true});}
});
test('old jobs migrate with backup, retain local origin and exact non-null turns',async()=>{
  const dir=temp(),file=join(dir,'db');let ledger=await Ledger.open(file);
  const message=ledger.append({from:'agent:main',to:'device:synthetic',kind:'request',word:'synthetic.call',body:{},turn:'t_real'}).message;
  ledger.recordAgentJob({requestId:message.id,owner:'agent:main',turn:'t_real',member:'device:synthetic',word:'synthetic.call',label:'Synthetic local',at:now});ledger.close();
  const db=new DatabaseSync(file);db.exec(`ALTER TABLE agent_jobs RENAME TO new_jobs;DROP INDEX agent_jobs_owner;
    CREATE TABLE agent_jobs(request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,turn TEXT NOT NULL,member TEXT NOT NULL,word TEXT NOT NULL,label TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(request_id) REFERENCES request_state(request_id));
    INSERT INTO agent_jobs SELECT request_id,owner,turn,member,word,label,created_at FROM new_jobs;DROP TABLE new_jobs;`);db.close();
  try{ledger=await Ledger.open(file);assert.ok(ledger.migration.backup);assert.equal(ledger.agentJob('agent:main',message.id)?.turn,'t_real');assert.equal(ledger.pendingAgentJobs('agent:main').length,1);assert.throws(()=>ledger.recordAgentJob({requestId:message.id,owner:member,turn:'fake',member:'device:synthetic',word:'synthetic.call',label:'bad',at:now}));assert.throws(()=>ledger.createHumanAsk(member,'fake','question','bad',{}));}finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

// Type assertions prevent async functions from satisfying a supposedly synchronous current fence.
function synchronousFenceTypeChecks() {
  // @ts-expect-error Promise return is forbidden for the synchronous admission fence.
  const asyncCurrent: MaterialAdmissionAuthority['current'] = async () => undefined;
  // @ts-expect-error Promise return is forbidden before authority admission.
  const asyncInput: MaterialAdmissionAuthority['currentInput'] = async () => undefined;
  return [asyncCurrent,asyncInput];
}
void synchronousFenceTypeChecks;

test('two actual OS processes compete on accept and answer stable keys',async()=>{
  const dir=temp(),file=join(dir,'db');const initial=await Ledger.open(file);initial.close();
  const fixture=fileURLToPath(new URL('./fixtures/material-durable-ledger-process.ts',import.meta.url));
  const run=(input:string,op:string)=>new Promise<string>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',fixture,file,input,op],{stdio:['ignore','pipe','pipe']});let out='',error='';
    child.stdout.on('data',part=>out+=part);child.stderr.on('data',part=>error+=part);
    const timer=setTimeout(()=>{child.kill();reject(new Error('synthetic child deadline'));},10000);
    child.once('error',reject);child.once('exit',status=>{clearTimeout(timer);status===0?resolve(out):reject(new Error(error));});
  });
  try {
    const input=join(dir,'accept.json');writeFileSync(input,JSON.stringify({request:request(),binding:binding(),key:key()}));
    const [a,b]=await Promise.all([run(input,'accept'),run(input,'accept')]);assert.deepEqual(JSON.parse(a),JSON.parse(b));const loc=JSON.parse(a);
    const answers=join(dir,'answer.json');writeFileSync(answers,JSON.stringify({reply:reply(request(),loc.pending_id),binding:binding('phone-actor',target),key:answerKey}));
    const [x,y]=await Promise.all([run(answers,'answer'),run(answers,'answer')]);assert.deepEqual(JSON.parse(x),JSON.parse(y));
    const ledger=await Ledger.open(file);try{assert.equal(ledger.list().length,2);assert.equal(ledger.humanPending(loc.pending_id)?.state,'answered');}finally{ledger.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('permanent metadata capacity never releases expired dedupe for replay',async()=>{
  const dir=temp(),file=join(dir,'db'),ledger=await Ledger.open(file),auth=syntheticAuthority(),f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});
  try {
    const loc=await f.accept(request(),binding(),key());const db=new DatabaseSync(file);
    const insert=db.prepare(`INSERT INTO material_external_admissions(request_id,canonical_id,owner,member,source,target,kind,expires_at) VALUES(?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN IMMEDIATE');for(let i=1;i<4096;i++)insert.run(`tombstone-${i}`,`expired-${i}`,'synthetic-tombstone',member,JSON.stringify(source),JSON.stringify(target),'material_to_work',1);db.exec('COMMIT');db.close();
    await assert.rejects(f.accept(request('human_material','new'),binding(),key('new')),code('too_large'));assert.deepEqual(await f.accept(request(),binding(),key()),loc);
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

test('async current fence is rejected at runtime and before failure is synchronously fenced',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'db')),auth=syntheticAuthority();let checked=0;
  try {
    const broken={...auth.authority,current:async()=>undefined} as unknown as MaterialAdmissionAuthority;
    const f=new MaterialDurableLedgerFacade({ledger,authority:broken,now:()=>now});await assert.rejects(f.accept(request(),binding(),key()),code('permission_denied'));assert.equal(ledger.list().length,0);
    const reject={...auth.authority,currentInput(){checked++;return undefined;},async before(){throw new Error('synthetic authority failure');}};
    await assert.rejects(new MaterialDurableLedgerFacade({ledger,authority:reject,now:()=>now}).accept(request(),binding(),key()));assert.equal(checked,2);
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

for(const stage of ['before-transaction','after-request','before-commit','after-commit'] as const) test(`real SIGKILL accept and answer at ${stage} recover one fact`,async()=>{
  const dir=temp(),file=join(dir,'db');let ledger=await Ledger.open(file);ledger.close();
  const fixture=fileURLToPath(new URL('./fixtures/material-durable-ledger-process.ts',import.meta.url));
  const crash=(input:string,op:string)=>new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',fixture,file,input,op,stage],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',part=>error+=part);
    const timer=setTimeout(()=>{child.kill();reject(new Error('synthetic SIGKILL deadline'));},10000);
    child.once('error',reject);child.once('exit',(status,signal)=>{clearTimeout(timer);signal==='SIGKILL'?resolve():reject(new Error(error+status));});
  });
  const auth=syntheticAuthority();
  try {
    const input=join(dir,'accept.json');writeFileSync(input,JSON.stringify({request:request(),binding:binding(),key:key()}));await crash(input,'accept');
    ledger=await Ledger.open(file);let f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});const loc=await f.accept(request(),binding(),key());ledger.close();
    const answers=join(dir,'answer.json');writeFileSync(answers,JSON.stringify({reply:reply(request(),loc.pending_id!),binding:binding('phone-actor',target),key:answerKey}));await crash(answers,'answer');
    ledger=await Ledger.open(file);f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});await f.answer(reply(request(),loc.pending_id!),binding('phone-actor',target),answerKey);
    assert.equal(ledger.list().length,2);assert.equal(ledger.humanPending(loc.pending_id!)?.state,'answered');
  }finally{try{ledger.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('wait is bounded, abort only observes, current revocation fences query and local settle cannot inject response',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'db')),clock=()=>Date.now();const auth=syntheticAuthority(clock);
  const r=request('material_to_work');r.expires_at=Date.now()+60000;const b={...binding(),context:{...context(),expires_at:Date.now()+90000}};
  const f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:clock});
  try {
    const loc=await f.accept(r,b,materialStableKey('owner',r.client_id,'submit'));
    assert.throws(()=>ledger.settle(loc.ledger_request_id,'service:material',{ok:true,result:{}}),/admission authority/);assert.equal(ledger.responseTo(loc.ledger_request_id),null);
    const controller=new AbortController();const observing=f.wait(loc,b,Date.now()+20000,controller.signal);setTimeout(()=>controller.abort(),10);await observing;
    assert.equal((await f.read(loc,b))?.fact.state,'registered');assert.equal(ledger.list().length,1);
    const start=Date.now();await f.wait(loc,b,Date.now()+30,new AbortController().signal);assert.ok(Date.now()-start<1000);
    const invalid=f.wait(loc,b,Date.now()+1000,new AbortController().signal);setTimeout(()=>auth.revoke(),10);await assert.rejects(invalid,code('permission_denied'));
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

test('commit observation carries only locators/versions, subscriber failure does not affect durable facts',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'db')),auth=syntheticAuthority(),f=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now});const events:unknown[]=[];
  const remove=ledger.observeMaterialCommits(event=>events.push(event));ledger.observeMaterialCommits(()=>{throw new Error('synthetic observer');});
  try{const loc=await f.accept(request(),binding(),key());await f.answer(reply(request(),loc.pending_id!),binding('phone-actor',target),answerKey);assert.equal(events.length,2);assert.doesNotMatch(JSON.stringify(events),/Canonical|principal|context|summary/);remove();assert.equal((await f.read(loc,binding()))?.fact.state,'result_available');}finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

async function eventually(check:()=>boolean) {
  const end=Date.now()+1000;while(!check()){if(Date.now()>end)throw new Error('synthetic observation deadline');await new Promise(resolve=>setTimeout(resolve,2));}
}
test('hung material adapter never blocks later local recovery; repeated recovery/timeout keeps actual bounded slots',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'db')),router=new WorldRouter(ledger,()=>true),auth=syntheticAuthority();
  const completions=new Map<string,()=>void>();let executions=0,authorizations=0,releases=0;
  const adapter:MaterialTaskDispatchAdapter={async recoverBinding(){return binding();},async authorize(r){authorizations++;return {current(){return undefined;},production_work:null,idempotentRecovery:true,
    async execute(id){executions++;await new Promise<void>(resolve=>completions.set(id,resolve));return result(r,'Late original synthetic execution');},release(){releases++;return undefined;}};}};
  const facade=new MaterialDurableLedgerFacade({ledger,router,authority:auth.authority,taskDispatch:adapter,now:()=>now,max_unfinished_tasks:2,dispatch_observation_timeout_ms:15});
  try {
    await assert.rejects(facade.accept(request('agent_task','hung-a'),binding(),key('hung-a')),code('timeout'));
    const first=ledger.externalMaterialRecoveryIdentity(ledger.list()[0]!.id)!.locator;
    const local=ledger.append({from:'person:owner',to:'agent:main',kind:'request',word:'say',body:{n:1}}).message;let localCalls=0;
    router.register({member:'agent:main',idempotentRecovery:true,spec:{word:'say',kind:'request',description:'Synthetic local recovery',risk:'none',timeout_ms:500,input_schema:{type:'object',properties:{n:{type:'integer'}},required:['n'],additionalProperties:false},result_schema:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}},handle(){localCalls++;return {ok:true,result:{value:1}};}});
    const recovery=router.recover();await eventually(()=>localCalls===1);assert.equal(executions,1);await recovery;assert.ok(ledger.responseTo(local.id));
    await Promise.all(Array.from({length:6},()=>router.recover()));assert.equal(executions,1);assert.equal(authorizations,2);
    await assert.rejects(facade.accept(request('agent_task','hung-b'),binding(),key('hung-b')),code('timeout'));assert.equal(executions,2);
    await assert.rejects(facade.accept(request('agent_task','hung-c'),binding(),key('hung-c')),code('too_large'));assert.equal(authorizations,4);assert.equal(ledger.list().filter(m=>m.word==='material.request').length,2);
    await assert.rejects(facade.accept({...request('agent_task','hung-a'),purpose:'different'},binding(),key('hung-a')),code('conflict'));
    const closedObserver=facade.accept(request('agent_task','hung-a'),binding(),key('hung-a'));await new Promise(resolve=>setTimeout(resolve,1));facade.close();await assert.rejects(closedObserver,code('offline'));
    for(const finish of completions.values())finish();await eventually(()=>releases===4);
    assert.equal(ledger.responseTo(first.ledger_request_id)?.body.summary,'Late original synthetic execution');assert.equal(ledger.list().filter(m=>m.word==='material.result').length,2);
    await assert.rejects(facade.accept(request('agent_task','hung-c'),binding(),key('hung-c')),code('offline'));assert.equal(executions,2);
  }finally{for(const finish of completions.values())finish();facade.close();router.dispose();ledger.close();rmSync(dir,{recursive:true,force:true});}
});

test('pre-admission hung authorize consumes a slot until actual settlement; close cannot admit a late request',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'db')),auth=syntheticAuthority();let finish!:()=>void,authorizations=0,releases=0;
  const adapter:MaterialTaskDispatchAdapter={async recoverBinding(){return binding();},async authorize(r){authorizations++;await new Promise<void>(resolve=>finish=resolve);return {current(){return undefined;},production_work:null,idempotentRecovery:false,async execute(){throw new Error('must not execute');},release(){releases++;return undefined;}};}};
  const facade=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,taskDispatch:adapter,now:()=>now,max_unfinished_tasks:1,dispatch_observation_timeout_ms:10});
  try{await assert.rejects(facade.accept(request('agent_task','pre-a'),binding(),key('pre-a')),code('timeout'));assert.equal(ledger.list().length,0);
    await assert.rejects(facade.accept(request('agent_task','pre-b'),binding(),key('pre-b')),code('too_large'));await assert.rejects(facade.accept(request('agent_task','pre-a'),binding(),key('pre-a')),code('timeout'));assert.equal(authorizations,1);
    facade.close();finish();await eventually(()=>releases===1);assert.equal(ledger.list().length,0);
  }finally{finish?.();facade.close();ledger.close();rmSync(dir,{recursive:true,force:true});}
});

test('late task response after timeout and authority invalidation cannot commit or return success',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'db')),auth=syntheticAuthority();let finish!:()=>void,releases=0;
  const adapter:MaterialTaskDispatchAdapter={async recoverBinding(){return binding();},async authorize(r){return {current(){return undefined;},production_work:null,idempotentRecovery:false,async execute(){await new Promise<void>(resolve=>finish=resolve);return result(r,'Revoked late result');},release(){releases++;return undefined;}};}};
  const facade=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,taskDispatch:adapter,now:()=>now,dispatch_observation_timeout_ms:10});
  try{await assert.rejects(facade.accept(request('agent_task'),binding(),key()),code('timeout'));const id=ledger.list()[0]!.id;auth.revoke();finish();await eventually(()=>releases===2);assert.equal(ledger.responseTo(id),null);assert.equal(ledger.trackedRequests()[0]?.phase,'dispatching');}finally{finish?.();facade.close();ledger.close();rmSync(dir,{recursive:true,force:true});}
});

test('router retains unfinished generic material handler slots across timeout/dispose without serial local blocking',async()=>{
  const dir=temp(),ledger=await Ledger.open(join(dir,'db')),auth=syntheticAuthority(),facade=new MaterialDurableLedgerFacade({ledger,authority:auth.authority,now:()=>now}),router=new WorldRouter(ledger,()=>true);
  const finishers=new Map<string,()=>void>();let calls=0;
  try {
    for(const id of ['router-a','router-b','router-c'])await facade.accept(request('human_material',id),binding(),key(id));
    router.setMaterialRecoveryHandler(async tracked=>{calls++;await new Promise<void>(resolve=>finishers.set(tracked.message.id,resolve));},{maxUnfinishedTasks:2,observationTimeoutMs:10});
    await router.recover();assert.equal(calls,2);await Promise.all([router.recover(),router.recover()]);assert.equal(calls,2);
    router.dispose();await router.recover();assert.equal(calls,2);
    for(const finish of finishers.values())finish();await new Promise(resolve=>setTimeout(resolve,2));
  }finally{for(const finish of finishers.values())finish();facade.close();router.dispose();ledger.close();rmSync(dir,{recursive:true,force:true});}
});
