import { DatabaseSync } from 'node:sqlite';
import { MaterialProtocolError, type CollaborationRequest, type MaterialReply, type MaterialResultFact } from '../../../device/src/collaboration/material-types';
import { materialPayloadHash, assertMaterialReplyBinding } from '../../../device/src/collaboration/material-protocol';
import type { MaterialLedgerBinding, MaterialLedgerFacade, MaterialLedgerLocator, MaterialLedgerSnapshot } from '../../src/collaboration/material-ledger-facade';
/** Test-only sole body ledger. Metadata store is always a separate SQLite file. */
export class MaterialFaultLedger implements MaterialLedgerFacade {
  private db: DatabaseSync;
  fault: 'accept' | 'answer' | null = null;
  lookupUnknown = false;
  deleted = false;
  reads = 0; accepts = 0; answers = 0; waits = 0;
  hook?: () => Promise<void>;
  constructor(file: string, private readonly now: () => number) {
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS canonical_requests(id TEXT PRIMARY KEY, owner TEXT, request TEXT, fact TEXT, locator TEXT);
      CREATE TABLE IF NOT EXISTS atomic_dedupe(stable_key TEXT PRIMARY KEY, owner TEXT, hash TEXT, id TEXT);`);
  }
  close() { this.db.close(); }
  private lookupRow(binding: MaterialLedgerBinding,key: string,hash?: string): MaterialLedgerLocator | null {
    const r = this.db.prepare('SELECT d.*,r.locator FROM atomic_dedupe d JOIN canonical_requests r ON r.id=d.id WHERE d.stable_key=? AND d.owner=?').get(key,binding.owner_principal_id) as Record<string,unknown> | undefined;
    if (!r) return null;
    if (hash && r.hash !== hash) throw new MaterialProtocolError('conflict');
    return JSON.parse(String(r.locator));
  }
  async accept(request: CollaborationRequest,binding: MaterialLedgerBinding,key: string): Promise<MaterialLedgerLocator> {
    this.accepts++;
    const existing = this.lookupRow(binding,key,materialPayloadHash(request)); if (existing) return existing;
    const locator: MaterialLedgerLocator = {ledger_request_id:`ledger:${key}`,pending_id:request.kind === 'human_material' ? `pending:${key}` : null,question_version:request.kind === 'human_material' ? 1 : null,job_id:request.kind === 'agent_task' ? `job:${key}` : null};
    const fact: MaterialResultFact = {version:1,request_id:request.request_id,state:request.kind === 'human_material' ? 'waiting_owner' : 'running',result:null,question:locator.pending_id ? {pending_id:locator.pending_id,question_version:1,expires_at:request.expires_at} : null,claimed_result_version:null,receipts:[],business_state:'unverified',observed_at:this.now()};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO canonical_requests VALUES(?,?,?,?,?)').run(locator.ledger_request_id,binding.owner_principal_id,JSON.stringify(request),JSON.stringify(fact),JSON.stringify(locator));
      this.db.prepare('INSERT INTO atomic_dedupe VALUES(?,?,?,?)').run(key,binding.owner_principal_id,materialPayloadHash(request),locator.ledger_request_id);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    await this.hook?.();
    if (this.fault === 'accept') { this.fault=null; throw new Error('crash after atomic accept'); }
    return locator;
  }
  async lookup(binding: MaterialLedgerBinding,key: string) { return this.lookupUnknown ? null : this.lookupRow(binding,key); }
  async read(locator: MaterialLedgerLocator,binding: MaterialLedgerBinding): Promise<MaterialLedgerSnapshot | null> {
    this.reads++;
    if (this.deleted) return null;
    const row = this.db.prepare('SELECT * FROM canonical_requests WHERE id=? AND owner=?').get(locator.ledger_request_id,binding.owner_principal_id) as Record<string,unknown> | undefined;
    return row ? {request:JSON.parse(String(row.request)),fact:JSON.parse(String(row.fact))} : null;
  }
  async answer(reply: MaterialReply,binding: MaterialLedgerBinding,key: string): Promise<MaterialLedgerLocator> {
    this.answers++;
    const prior = this.lookupRow(binding,key,materialPayloadHash(reply)); if (prior) return prior;
    const rows = this.db.prepare('SELECT * FROM canonical_requests WHERE owner=?').all(binding.owner_principal_id) as Record<string,unknown>[];
    const row = rows.find(row => JSON.parse(String(row.request)).request_id === reply.request_id);
    if (!row) throw new MaterialProtocolError('not_found');
    const request: CollaborationRequest = JSON.parse(String(row.request));
    const fact: MaterialResultFact = JSON.parse(String(row.fact));
    assertMaterialReplyBinding(reply,request,fact.question,this.now());
    if (fact.result) throw new MaterialProtocolError('conflict');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE canonical_requests SET fact=? WHERE id=?').run(JSON.stringify({...fact,state:'result_available',result:reply.result}),String(row.id));
      this.db.prepare('INSERT INTO atomic_dedupe VALUES(?,?,?,?)').run(key,binding.owner_principal_id,materialPayloadHash(reply),String(row.id));
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    await this.hook?.();
    if (this.fault === 'answer') { this.fault=null; throw new Error('crash after atomic answer'); }
    return JSON.parse(String(row.locator));
  }
  async wait(_locator: MaterialLedgerLocator,_binding: MaterialLedgerBinding,_deadline: number,signal: AbortSignal) {
    this.waits++;
    await this.hook?.();
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort',() => resolve(),{once:true}));
  }
  mutate(requestId: string,change: (snapshot: MaterialLedgerSnapshot) => MaterialLedgerSnapshot) {
    const rows = this.db.prepare('SELECT * FROM canonical_requests').all() as Record<string,unknown>[];
    const row = rows.find(row => JSON.parse(String(row.request)).request_id === requestId)!;
    const s = change({request:JSON.parse(String(row.request)),fact:JSON.parse(String(row.fact))});
    this.db.prepare('UPDATE canonical_requests SET request=?,fact=? WHERE id=?').run(JSON.stringify(s.request),JSON.stringify(s.fact),String(row.id));
  }
}
