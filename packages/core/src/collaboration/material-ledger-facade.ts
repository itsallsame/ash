import type { CollaborationRequest, MaterialReply, MaterialResultFact, MaterialTrustedContext } from '../../../device/src/collaboration/material-types';
import { MaterialProtocolError } from '../../../device/src/collaboration/material-types';
import type { Ledger } from '../world/ledger';

/** Admission identity supplied by the trusted connector; never a local AgentBinding. */
export interface MaterialLedgerBinding {
  readonly context: Readonly<MaterialTrustedContext>;
  readonly owner_principal_id: string;
  readonly external_member_id: string;
}
export interface MaterialLedgerLocator {
  ledger_request_id: string;
  pending_id: string | null;
  question_version: number | null;
  job_id: string | null;
}
/** All bodies are projections of the sole canonical ledger, never metadata-store copies. */
export interface MaterialLedgerSnapshot {
  request: CollaborationRequest;
  fact: MaterialResultFact;
}
export interface MaterialLedgerFacade {
  /** Atomically commits stable-key/hash dedupe together with the request and pending/job fact. */
  accept(request: CollaborationRequest, binding: MaterialLedgerBinding, stableKey: string): Promise<MaterialLedgerLocator>;
  lookup(binding: MaterialLedgerBinding, stableKey: string): Promise<MaterialLedgerLocator | null>;
  read(locator: MaterialLedgerLocator, binding: MaterialLedgerBinding): Promise<MaterialLedgerSnapshot | null>;
  /** Atomically commits stable-key/hash dedupe with the bound answer/result fact. */
  answer(reply: MaterialReply, binding: MaterialLedgerBinding, stableKey: string): Promise<MaterialLedgerLocator>;
  /** Observation only. Aborting stops observation and never cancels execution. */
  wait(locator: MaterialLedgerLocator, binding: MaterialLedgerBinding, deadline: number, signal: AbortSignal): Promise<void>;
}
/** Actual existing queries, for an A5 projector with separately verified external ownership. */
export class MaterialLedgerQueries {
  constructor(private readonly ledger: Ledger) {}
  request(id: string) { return this.ledger.byId(id); }
  response(id: string) { return this.ledger.responseTo(id); }
  pending(id: string) { return this.ledger.humanPending(id); }
  job(owner: string, id: string) { return this.ledger.agentJob(owner, id); }
}
/** Existing router admission does not yet provide atomic external-question dedupe. */
export class UnsupportedMaterialLedgerFacade implements MaterialLedgerFacade {
  private unsupported(): never { throw new MaterialProtocolError('unsupported'); }
  async accept(): Promise<MaterialLedgerLocator> { return this.unsupported(); }
  async lookup(): Promise<MaterialLedgerLocator | null> { return this.unsupported(); }
  async read(): Promise<MaterialLedgerSnapshot | null> { return this.unsupported(); }
  async answer(): Promise<MaterialLedgerLocator> { return this.unsupported(); }
  async wait(): Promise<void> { return this.unsupported(); }
}
