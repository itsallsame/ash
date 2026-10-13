import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { MaterialProtocolError, type CollaborationRequest, type MaterialEndpointRef, type MaterialRequestState, type AssetReceipt, type MaterialQuestionFact } from '../../../device/src/collaboration/material-types';
import { sameMaterialEndpoint, canTransitionMaterialRequest } from '../../../device/src/collaboration/material-protocol';
import type { MaterialLedgerLocator } from './material-ledger-facade';

export interface MaterialRequestStoreOptions {
  file: string;
  max_requests?: number;
  max_operations?: number;
  retention_ms?: number;
  now?: () => number;
}
export interface StoredMaterialRequest {
  principal_id: string; request_id: string; client_id: string; payload_sha256: string;
  source: MaterialEndpointRef; return_to: MaterialEndpointRef; target: MaterialEndpointRef;
  grant_revision: string; authorization_epoch: string; expires_at: number;
  admission_expires_at: number; question: MaterialQuestionFact | null;
  stable_key: string; locator: MaterialLedgerLocator | null; state: MaterialRequestState;
  result_version: number; result_hash: string | null; claimed_result_version: number | null;
  tombstone: boolean; retained_until: number;
}
export function materialStableKey(principal: string, client: string, operation: 'submit' | 'reply'): string {
  return createHash('sha256').update(JSON.stringify(['material/v1', operation, principal, client])).digest('hex');
}
/** Durable intentions and associations only. No request, reply or result body columns. */
export class MaterialRequestStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly retention: number;
  private readonly maximum: number;
  private readonly opMaximum: number;
  constructor(options: MaterialRequestStoreOptions) {
    this.now = options.now ?? Date.now;
    this.retention = options.retention_ms ?? 7 * 86400000;
    this.maximum = options.max_requests ?? 4096;
    this.opMaximum = options.max_operations ?? this.maximum * 8;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || !Number.isSafeInteger(this.opMaximum) || this.opMaximum < 1 || !Number.isSafeInteger(this.retention) || this.retention < 1) throw new MaterialProtocolError('invalid');
    this.db = new DatabaseSync(options.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS material_requests (
        principal_id TEXT NOT NULL, request_id TEXT NOT NULL, client_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
        source TEXT NOT NULL, return_to TEXT NOT NULL, target TEXT NOT NULL, grant_revision TEXT NOT NULL,
        authorization_epoch TEXT NOT NULL, expires_at INTEGER NOT NULL, stable_key TEXT NOT NULL UNIQUE,
        locator TEXT, question TEXT, admission_expires_at INTEGER NOT NULL, state TEXT NOT NULL, result_version INTEGER NOT NULL DEFAULT 0, result_hash TEXT,
        claimed_result_version INTEGER, tombstone INTEGER NOT NULL DEFAULT 0, retained_until INTEGER NOT NULL,
        PRIMARY KEY(principal_id,request_id), UNIQUE(principal_id,client_id));
      CREATE TABLE IF NOT EXISTS material_operations (
        stable_key TEXT PRIMARY KEY, principal_id TEXT NOT NULL, request_id TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL, locator TEXT, retained_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS material_receipts (
        principal_id TEXT NOT NULL, request_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
        asset_id TEXT NOT NULL, result_version INTEGER NOT NULL, PRIMARY KEY(principal_id,request_id,asset_id));`);
  }
  close(): void { this.db.close(); }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  private decode(raw: unknown): StoredMaterialRequest | null {
    if (!raw) return null;
    const row = raw as Record<string, unknown>;
    return { ...row, source: JSON.parse(String(row.source)), return_to: JSON.parse(String(row.return_to)), target: JSON.parse(String(row.target)), locator: row.locator ? JSON.parse(String(row.locator)) : null, question: row.question ? JSON.parse(String(row.question)) : null, tombstone: row.tombstone === 1 } as unknown as StoredMaterialRequest;
  }
  get(principal: string, request: string): StoredMaterialRequest | null {
    return this.decode(this.db.prepare('SELECT * FROM material_requests WHERE principal_id=? AND request_id=?').get(principal, request));
  }
  /** Only trusted exact target endpoints may find a request for answering. Ambiguity rejects. */
  forTarget(request: string, target: MaterialEndpointRef): StoredMaterialRequest | null {
    const rows = this.db.prepare('SELECT * FROM material_requests WHERE request_id=? LIMIT ?').all(request,this.maximum).filter(raw => sameMaterialEndpoint(this.decode(raw)!.target,target));
    if (rows.length > 1) throw new MaterialProtocolError('conflict');
    return this.decode(rows[0]);
  }
  claim(request: CollaborationRequest, principal: string, hash: string, revision: string, epoch: string, admissionExpiry: number): { row: StoredMaterialRequest; fresh: boolean } {
    return this.transaction(() => {
      const prior = this.decode(this.db.prepare('SELECT * FROM material_requests WHERE principal_id=? AND client_id=?').get(principal, request.client_id));
      if (prior) { if (prior.payload_sha256 !== hash) throw new MaterialProtocolError('conflict'); return { row: prior, fresh: false }; }
      if (this.get(principal, request.request_id)) throw new MaterialProtocolError('conflict');
      this.gc(100);
      if (Number((this.db.prepare('SELECT COUNT(*) AS n FROM material_requests').get() as { n: number }).n) >= this.maximum) throw new MaterialProtocolError('too_large');
      const key = materialStableKey(principal, request.client_id, 'submit');
      const target: MaterialEndpointRef = request.target_work ? { kind: 'work', work: request.target_work } : { kind: 'node', node_id: request.target.node_id, endpoint_id: request.target.endpoint_id };
      this.db.prepare(`INSERT INTO material_requests(principal_id,request_id,client_id,payload_sha256,source,return_to,target,grant_revision,authorization_epoch,expires_at,stable_key,admission_expires_at,state,retained_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'registered',?)`).run(principal,request.request_id,request.client_id,hash,JSON.stringify(request.source),JSON.stringify(request.return_to),JSON.stringify(target),revision,epoch,request.expires_at,key,admissionExpiry,request.expires_at + this.retention);
      return { row: this.get(principal, request.request_id)!, fresh: true };
    });
  }
  bindQuestion(row: StoredMaterialRequest, question: MaterialQuestionFact): MaterialQuestionFact {
    return this.transaction(() => {
      const current = this.get(row.principal_id,row.request_id)!;
      if (question.expires_at > current.expires_at || question.expires_at > current.admission_expires_at) throw new MaterialProtocolError('conflict');
      if (current.question) {
        if (current.question.pending_id !== question.pending_id || current.question.question_version !== question.question_version || current.question.expires_at !== question.expires_at) throw new MaterialProtocolError('conflict');
        return current.question;
      }
      this.db.prepare('UPDATE material_requests SET question=? WHERE principal_id=? AND request_id=?').run(JSON.stringify(question),row.principal_id,row.request_id);
      return question;
    });
  }
  map(row: StoredMaterialRequest, locator: MaterialLedgerLocator): void {
    this.db.prepare('UPDATE material_requests SET locator=? WHERE principal_id=? AND request_id=?').run(JSON.stringify(locator),row.principal_id,row.request_id);
  }
  claimReply(row: StoredMaterialRequest, principal: string, client: string, hash: string): { key: string; fresh: boolean; locator: MaterialLedgerLocator | null } {
    return this.transaction(() => {
      const key = materialStableKey(principal,client,'reply');
      const prior = this.db.prepare('SELECT * FROM material_operations WHERE stable_key=?').get(key) as Record<string, unknown> | undefined;
      if (prior) {
        if (prior.payload_sha256 !== hash || prior.principal_id !== row.principal_id || prior.request_id !== row.request_id) throw new MaterialProtocolError('conflict');
        return { key, fresh: false, locator: prior.locator ? JSON.parse(String(prior.locator)) : null };
      }
      this.gc(100);
      if (Number((this.db.prepare('SELECT COUNT(*) AS n FROM material_operations').get() as { n: number }).n) >= this.opMaximum) throw new MaterialProtocolError('too_large');
      this.db.prepare('INSERT INTO material_operations(stable_key,principal_id,request_id,payload_sha256,retained_until) VALUES(?,?,?,?,?)').run(key,row.principal_id,row.request_id,hash,row.retained_until);
      return { key, fresh: true, locator: null };
    });
  }
  mapReply(key: string, locator: MaterialLedgerLocator): void {
    this.db.prepare('UPDATE material_operations SET locator=? WHERE stable_key=?').run(JSON.stringify(locator),key);
  }
  observe(row: StoredMaterialRequest, state: MaterialRequestState, version: number, hash: string | null): void {
    this.transaction(() => {
      const current = this.get(row.principal_id,row.request_id)!;
      if (version < current.result_version || version === current.result_version && current.result_hash !== null && hash !== current.result_hash) throw new MaterialProtocolError('result_unknown');
      if (current.tombstone || current.state === 'expired') throw new MaterialProtocolError('expired');
      if (!canTransitionMaterialRequest(current.state,state) || current.result_version > 0 && state !== 'result_available' && state !== 'expired') throw new MaterialProtocolError('result_unknown');
      this.db.prepare('UPDATE material_requests SET state=?,result_version=?,result_hash=?,claimed_result_version=CASE WHEN result_version=? THEN claimed_result_version ELSE NULL END WHERE principal_id=? AND request_id=?').run(state,version,hash,version,row.principal_id,row.request_id);
    });
  }
  acknowledge(row: StoredMaterialRequest, version: number): void {
    const changed = this.db.prepare("UPDATE material_requests SET claimed_result_version=? WHERE principal_id=? AND request_id=? AND result_version=? AND state='result_available' AND tombstone=0").run(version,row.principal_id,row.request_id,version);
    if (Number(changed.changes) !== 1) throw new MaterialProtocolError('conflict');
  }
  receipt(row: StoredMaterialRequest, version: number, receipt: AssetReceipt): void {
    const current = this.get(row.principal_id,row.request_id);
    if (!current || current.tombstone || current.state !== 'result_available' || current.result_version !== version) throw new MaterialProtocolError('conflict');
    this.db.prepare('INSERT INTO material_receipts(principal_id,request_id,receipt_id,asset_id,result_version) VALUES(?,?,?,?,?) ON CONFLICT(principal_id,request_id,asset_id) DO UPDATE SET receipt_id=excluded.receipt_id,result_version=excluded.result_version').run(row.principal_id,row.request_id,receipt.receipt_id,receipt.asset_id,version);
  }
  receipts(row: StoredMaterialRequest, version: number): string[] {
    return (this.db.prepare('SELECT receipt_id FROM material_receipts WHERE principal_id=? AND request_id=? AND result_version=?').all(row.principal_id,row.request_id,version) as { receipt_id: string }[]).map(r => r.receipt_id);
  }
  expire(row: StoredMaterialRequest): void { this.db.prepare("UPDATE material_requests SET tombstone=1,state='expired' WHERE principal_id=? AND request_id=?").run(row.principal_id,row.request_id); }
  /** Compact expired metadata to permanent bounded tombstones; never erase dedupe keys. */
  gc(limit = 100): number {
    limit = Math.min(1000,Math.max(0,Math.floor(limit)));
    const rows = this.db.prepare('SELECT principal_id,request_id FROM material_requests WHERE retained_until<=? AND tombstone=0 LIMIT ?').all(this.now(),limit) as {principal_id:string;request_id:string}[];
    for (const row of rows) {
      this.db.prepare('DELETE FROM material_receipts WHERE principal_id=? AND request_id=?').run(row.principal_id,row.request_id);
      this.db.prepare('UPDATE material_operations SET locator=NULL WHERE principal_id=? AND request_id=?').run(row.principal_id,row.request_id);
      this.db.prepare("UPDATE material_requests SET locator=NULL,tombstone=1,state='expired' WHERE principal_id=? AND request_id=?").run(row.principal_id,row.request_id);
    }
    return rows.length;
  }
}
