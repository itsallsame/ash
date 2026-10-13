/** Isolated synthetic child process fixture. No native host, credentials, daemon or business execution. */
import { readFileSync } from 'node:fs';
import { Ledger } from '../../src/world/ledger';
import { MaterialDurableLedgerFacade, type MaterialAdmissionAuthority, type MaterialAdmissionPermit } from '../../src/collaboration/material-durable-ledger';
import { MaterialProtocolError } from '../../../device/src/collaboration/material-types';
import type { CollaborationRequest, MaterialReply } from '../../../device/src/collaboration/material-types';
import type { MaterialLedgerBinding } from '../../src/collaboration/material-ledger-facade';
const [file,inputFile,operation,crashStage] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputFile!,'utf8')) as {request: CollaborationRequest; reply: MaterialReply; binding: MaterialLedgerBinding; key: string};
const issued = new WeakSet<object>();
const authority: MaterialAdmissionAuthority = {
  currentInput(value) { if(value.binding.owner_principal_id !== 'owner' || value.binding.external_member_id !== input.binding.external_member_id) throw new MaterialProtocolError('permission_denied');return undefined; },
  async before(value) { this.currentInput(value);const permit = Object.freeze({}) as MaterialAdmissionPermit;issued.add(permit);return permit; },
  current(permit) { if(!issued.has(permit)) throw new MaterialProtocolError('permission_denied');return undefined; },
  release(permit) { issued.delete(permit);return undefined; },
};
const ledger = await Ledger.open(file!,{materialFailpoint(stage){if(stage===crashStage)process.kill(process.pid,'SIGKILL');}});
try {
  const facade=new MaterialDurableLedgerFacade({ledger,authority,now:()=>10000});
  const locator=operation==='answer'?await facade.answer(input.reply,input.binding,input.key):await facade.accept(input.request,input.binding,input.key);
  process.stdout.write(JSON.stringify(locator));
}finally{ledger.close();}
