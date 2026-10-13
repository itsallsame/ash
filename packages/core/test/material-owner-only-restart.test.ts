import test from 'node:test';
import assert from 'node:assert/strict';
import {materialUiFixture} from './fixtures/material-ui-input';
import {MaterialInputReader} from '../../device/src/collaboration/material-input-reader';
import {MaterialInputStaging} from '../../device/src/collaboration/material-input-staging';
import {join} from 'node:path';
// Actual production links/signatures; only the native socket and queue relay are fixtures.
test('owner-only Core restart recovers verified material peer identity without desktop reconnect',{timeout:20000},async()=>{
 let f:Awaited<ReturnType<typeof materialUiFixture>>,stage:MaterialInputStaging|undefined;
 f=await materialUiFixture(root=>{stage=new MaterialInputStaging({rootDir:join(root,'stage'),verifyRetirement(){throw Error('fixture');}});return new MaterialInputReader({staging:stage,captureInput:(input,proof)=>f.receiver.captureInput(input,proof)});});
 const connect=f.client.connect.bind(f.client);let suppressed=0;
 try{
  assert.equal((await f.owner.materialTransport(f.desktop.id).capture()).peer_id,f.desktop.id);
  // Existing fixture normally reconnects BOTH processes. Keep desktop physically
  // connected to its original real Link connection to represent owner-only restart.
  f.client.connect=async()=>{suppressed++;};
  await f.restartSource();
  assert.equal(suppressed,1);
  const peer=await f.owner.materialTransport(f.desktop.id).capture();
  assert.equal(peer.peer_id,f.desktop.id);
  assert.equal(peer.public_key,f.desktop.publicKey);
  await f.owner.materialInputPeer(f.desktop.id);
  assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);
 }finally{f.client.connect=connect;await f.close();stage?.close();}
});
