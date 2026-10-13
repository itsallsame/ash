/**
 * What the gate keeps in the ledger's database (HUB-MODULES §1.5): the approval rules, the audit (one evidence row
 * per request that was judged), the mode, and the pending requests that wait for the owner. Carry-over is not here:
 * it lives in memory only (carry.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { errorBody, type ErrorCode } from "../../../../sdk/src/message";
import type { Caller, Message, WordContract } from "../types";
import type { Ledger } from "../ledger";

export type Mode = "auto" | "always";
const MODE_KEY = "gate.mode";

/** JSON with sorted keys, so equal values give equal text. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Changes when the contract of the word changes, so a rule written for the old contract stops applying. */
export const contractFingerprint = (c: WordContract): string =>
  sha(stable({ member: c.member, word: c.word, effect: c.effect, risk: c.risk, input: c.input_schema }));

/** What "always" would cover: a recipient, a calendar, a site; otherwise every use of the word (`*`). */
export function objectOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const key of ["recipient_id", "calendar_id"]) if (typeof b[key] === "string" && b[key]) return (b[key] as string).toLowerCase();
  if (typeof b.site === "string" && /^[a-z0-9][a-z0-9.-]{0,200}$/i.test(b.site)) return `site:${b.site.toLowerCase()}`;
  return null;
}

export interface Rule {
  id: string; subject: string; to: string; word: string; object_pattern: string; risk: string;
  contract_fingerprint: string; created_at: number; expires_at: number; revoked_at?: number; created_by?: string;
}

export interface Evidence {
  request_id: string; at: number; requester: string; member: string; word: string; label?: string; effect: string; risk: string;
  turn?: string; content?: string; object?: string; fingerprint?: string; offer_always?: boolean;
  decision?: string; decided_by?: string; reason?: string; rule_id?: string; answered_at?: number; executed?: number;
}

export type PendingState = "waiting" | "approved" | "denied" | "expired" | "withdrawn" | "skipped" | "redeemed";

export interface PendingRecord {
  /** The id of the original request message. */
  id: string;
  originator: string;
  /** The caller as stamped when the request was made; used to run the request again. */
  caller: Caller;
  to: string;
  word: string;
  /** The body with secret fields masked. */
  body: unknown;
  thread?: string;
  label?: string;
  effect: string;
  risk: string;
  state: PendingState;
  created_at: number;
  expires_at: number;
  offer_always: boolean;
  purpose?: string;
  /** What the member itself says the request will do (`Member.cardDetail`), shown on the card after the usual detail. */
  detail?: string;
  /** The review model's one sentence on what the request does and where the risk is; the card's first line. */
  review_reason?: string;
  answer?: { choice: string; at: number };
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
type Row = Record<string, unknown>;

export type LeaseState = "asking" | "active" | "ended";
export type LeaseKind = "task" | "timed";

/** The owner lending the real screen to one agent for a while (service:gate/lease.*). */
export interface LeaseRecord {
  id: string;
  agent: string;
  /** The turn that asked; a "task" lease ends with it. */
  turn?: string;
  purpose: string;
  asked_minutes: number;
  kind?: LeaseKind;
  state: LeaseState;
  requested_at: number;
  granted_at?: number;
  expires_at?: number;
  /** When the agent last did something on the screen under this lease (the phone shows its floating ball for a few seconds after). */
  last_action_at?: number;
  ended_at?: number;
  ended_reason?: string;
}

export class GateStore {
  /** Called when a question that was waiting becomes expired (it counts as a refusal); `service:gate` tells the originator. */
  onExpired?: (pending: PendingRecord) => void;
  /** Called with the response recorded when a request ends without being carried out; the router passes it to its subscribers. */
  onClosed?: (response: Message) => void;
  /** Calls that hold for the owner's answer (the fast path), by pending id: told the state the question ends in. */
  private readonly holds = new Map<string, (state: PendingState) => void>();

  constructor(private readonly ledger: Ledger, readonly now: () => number = Date.now) {
    ledger.db().exec(`
      CREATE TABLE IF NOT EXISTS gate_rules (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, to_member TEXT NOT NULL, word TEXT NOT NULL, object_pattern TEXT NOT NULL,
        risk TEXT NOT NULL, contract_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        revoked_at INTEGER, created_by TEXT);
      CREATE TABLE IF NOT EXISTS gate_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gate_pending (
        id TEXT PRIMARY KEY, originator TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gate_pending_originator ON gate_pending(originator, state);
      CREATE TABLE IF NOT EXISTS gate_leases (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, turn TEXT, purpose TEXT NOT NULL, asked_minutes INTEGER NOT NULL, kind TEXT, state TEXT NOT NULL,
        requested_at INTEGER NOT NULL, granted_at INTEGER, expires_at INTEGER, last_action_at INTEGER, ended_at INTEGER, ended_reason TEXT);
      CREATE INDEX IF NOT EXISTS gate_leases_agent ON gate_leases(agent, state);`);
  }

  private get db() { return this.ledger.db(); }

  // ---- mode ----------------------------------------------------------------------------------------------------
  mode(): Mode {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(MODE_KEY) as { value: string } | undefined;
    return row?.value === "always" ? "always" : "auto";
  }
  setMode(mode: Mode): void {
    this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(MODE_KEY, mode);
  }

  // ---- rules ---------------------------------------------------------------------------------------------------
  addRule(rule: Omit<Rule, "id" | "created_at"> & { id?: string; created_at?: number }): Rule {
    const full: Rule = { ...rule, id: rule.id ?? newId("gr"), created_at: rule.created_at ?? this.now() };
    this.db.prepare(`INSERT INTO gate_rules(id,subject,to_member,word,object_pattern,risk,contract_fingerprint,created_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(full.id, full.subject, full.to, full.word, full.object_pattern, full.risk, full.contract_fingerprint, full.created_at, full.expires_at, full.created_by ?? null);
    return full;
  }
  private rule(row: Row): Rule {
    return { id: String(row.id), subject: String(row.subject), to: String(row.to_member), word: String(row.word), object_pattern: String(row.object_pattern),
      risk: String(row.risk), contract_fingerprint: String(row.contract_fingerprint), created_at: Number(row.created_at), expires_at: Number(row.expires_at),
      ...(row.revoked_at === null ? {} : { revoked_at: Number(row.revoked_at) }), ...(row.created_by === null ? {} : { created_by: String(row.created_by) }) };
  }
  matchRule(subject: string, to: string, word: string, fingerprint: string, object: string | null): Rule | null {
    const rows = this.db.prepare(`SELECT * FROM gate_rules WHERE subject=? AND to_member=? AND word=? AND contract_fingerprint=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at`)
      .all(subject, to, word, fingerprint, this.now()) as Row[];
    const hit = rows.map((r) => this.rule(r)).find((r) => r.object_pattern === "*" || r.object_pattern === object);
    return hit ?? null;
  }
  /** Newest first; `next_before` continues the list. */
  listRules(q: { before?: number; limit?: number } = {}): { rules: Rule[]; next_before?: number } {
    const limit = Math.min(q.limit ?? 100, 100);
    const rows = this.db.prepare(`SELECT rowid AS rid, * FROM gate_rules WHERE revoked_at IS NULL AND expires_at>? ${q.before ? "AND rowid<?" : ""} ORDER BY rowid DESC LIMIT ?`)
      .all(...[this.now(), ...(q.before ? [q.before] : []), limit + 1]) as Row[];
    const page = rows.slice(0, limit);
    return { rules: page.map((r) => this.rule(r)), ...(rows.length > limit ? { next_before: Number(page[page.length - 1]!.rid) } : {}) };
  }
  revokeRule(id: string): boolean {
    return Number(this.db.prepare("UPDATE gate_rules SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(this.now(), id).changes) > 0;
  }

  // ---- leases --------------------------------------------------------------------------------------------------
  private lease(row: Row): LeaseRecord {
    const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
    return { id: String(row.id), agent: String(row.agent), ...(row.turn ? { turn: String(row.turn) } : {}), purpose: String(row.purpose),
      asked_minutes: Number(row.asked_minutes), ...(row.kind ? { kind: row.kind as LeaseKind } : {}), state: row.state as LeaseState,
      requested_at: Number(row.requested_at), ...(n(row.granted_at) !== undefined ? { granted_at: n(row.granted_at)! } : {}),
      ...(n(row.expires_at) !== undefined ? { expires_at: n(row.expires_at)! } : {}), ...(n(row.last_action_at) !== undefined ? { last_action_at: n(row.last_action_at)! } : {}),
      ...(n(row.ended_at) !== undefined ? { ended_at: n(row.ended_at)! } : {}), ...(row.ended_reason ? { ended_reason: String(row.ended_reason) } : {}) };
  }
  askLease(agent: string, purpose: string, minutes: number, turn?: string): LeaseRecord {
    const id = newId("ls");
    this.db.prepare("INSERT INTO gate_leases(id,agent,turn,purpose,asked_minutes,state,requested_at) VALUES(?,?,?,?,?,'asking',?)").run(id, agent, turn ?? null, purpose, minutes, this.now());
    return this.getLease(id)!;
  }
  getLease(id: string): LeaseRecord | null {
    const row = this.db.prepare("SELECT * FROM gate_leases WHERE id=?").get(id) as Row | undefined;
    return row ? this.lease(row) : null;
  }
  /** The lease the agent holds now: granted, not ended, and its time has not come. */
  activeLease(agent: string): LeaseRecord | null {
    const row = this.db.prepare("SELECT * FROM gate_leases WHERE agent=? AND state='active' AND expires_at>? ORDER BY expires_at DESC LIMIT 1").get(agent, this.now()) as Row | undefined;
    return row ? this.lease(row) : null;
  }
  askingLease(agent: string): LeaseRecord | null {
    const row = this.db.prepare("SELECT * FROM gate_leases WHERE agent=? AND state='asking' ORDER BY requested_at DESC LIMIT 1").get(agent) as Row | undefined;
    return row ? this.lease(row) : null;
  }
  /** The leases still waiting for the owner (after a restart their cards are sent again). */
  askingLeases(): LeaseRecord[] {
    return (this.db.prepare("SELECT * FROM gate_leases WHERE state='asking' ORDER BY requested_at").all() as Row[]).map((r) => this.lease(r));
  }
  /** Every lease in force, soonest end first. */
  activeLeases(): LeaseRecord[] {
    return (this.db.prepare("SELECT * FROM gate_leases WHERE state='active' AND expires_at>? ORDER BY expires_at").all(this.now()) as Row[]).map((r) => this.lease(r));
  }
  /** Leases that are active by the table but whose time has come (a restart, or the timer): they are ended by the caller. */
  dueLeases(): LeaseRecord[] {
    return (this.db.prepare("SELECT * FROM gate_leases WHERE state='active' AND expires_at<=?").all(this.now()) as Row[]).map((r) => this.lease(r));
  }
  /** The last lease the agent had that is over, with how it ended (the refusal says why). */
  lastEnded(agent: string): LeaseRecord | null {
    const row = this.db.prepare("SELECT * FROM gate_leases WHERE agent=? AND state='ended' AND granted_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1").get(agent) as Row | undefined;
    return row ? this.lease(row) : null;
  }
  /** Grants a lease that was asked for; an agent holds one at a time, so an earlier one of the agent ends. */
  grantLease(id: string, kind: LeaseKind, expiresAt: number): LeaseRecord | null {
    const asked = this.getLease(id);
    if (!asked || asked.state !== "asking") return null;
    this.db.prepare("UPDATE gate_leases SET state='ended',ended_at=?,ended_reason='replaced' WHERE agent=? AND state='active'").run(this.now(), asked.agent);
    this.db.prepare("UPDATE gate_leases SET state='active',kind=?,granted_at=?,expires_at=? WHERE id=? AND state='asking'").run(kind, this.now(), expiresAt, id);
    return this.getLease(id);
  }
  /** Ends a lease (asked or active) with a reason; null when it was over already. */
  endLease(id: string, reason: string): LeaseRecord | null {
    const done = Number(this.db.prepare("UPDATE gate_leases SET state='ended',ended_at=?,ended_reason=? WHERE id=? AND state IN ('asking','active')").run(this.now(), reason, id).changes) > 0;
    return done ? this.getLease(id) : null;
  }
  noteLeaseAction(id: string, at: number): void {
    this.db.prepare("UPDATE gate_leases SET last_action_at=? WHERE id=? AND state='active'").run(at, id);
  }
  bindLeaseTurn(id: string, turn: string): void {
    this.db.prepare("UPDATE gate_leases SET turn=? WHERE id=? AND state='active'").run(turn, id);
  }

  // ---- audit ---------------------------------------------------------------------------------------------------
  record(e: Evidence): void {
    this.db.prepare("INSERT INTO gate_audit(request_id,at,data) VALUES(?,?,?) ON CONFLICT(request_id) DO UPDATE SET data=excluded.data").run(e.request_id, e.at, JSON.stringify(e));
  }
  evidence(requestId: string): Evidence | null {
    const row = this.db.prepare("SELECT data FROM gate_audit WHERE request_id=?").get(requestId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Evidence : null;
  }
  amend(requestId: string, patch: Partial<Evidence>): void {
    const e = this.evidence(requestId);
    if (e) this.record({ ...e, ...patch });
  }
  /** Newest first. */
  audit(q: { request_id?: string; requester?: string; word?: string; decision?: string; decisions?: readonly string[]; before?: number; limit?: number } = {}): { entries: Evidence[]; next_before?: number } {
    const where: string[] = []; const args: (string | number)[] = [];
    if (q.request_id) { where.push("request_id=?"); args.push(q.request_id); }
    if (q.before) { where.push("id<?"); args.push(q.before); }
    const limit = Math.min(q.limit ?? 50, 1000);
    const kept: { id: number; e: Evidence }[] = [];
    for (const r of this.db.prepare(`SELECT id,data FROM gate_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`).iterate(...args) as Iterable<{ id: number; data: string }>) {
      const e = JSON.parse(r.data) as Evidence;
      if (q.requester && e.requester !== q.requester) continue;
      if (q.word && e.word !== q.word) continue;
      if (q.decision && e.decision !== q.decision) continue;
      if (q.decisions && !(e.decision && q.decisions.includes(e.decision))) continue;
      kept.push({ id: r.id, e });
      if (kept.length > limit) break;
    }
    const page = kept.slice(0, limit);
    return { entries: page.map((k) => k.e), ...(kept.length > limit ? { next_before: page[page.length - 1]!.id } : {}) };
  }

  // ---- pending -------------------------------------------------------------------------------------------------
  park(p: Omit<PendingRecord, "state" | "created_at">): PendingRecord {
    const rec: PendingRecord = { ...p, state: "waiting", created_at: this.now() };
    const { id, originator, state, created_at, expires_at, ...rest } = rec;
    this.db.prepare("INSERT INTO gate_pending(id,originator,state,created_at,expires_at,data) VALUES(?,?,?,?,?,?)")
      .run(id, originator, state, created_at, expires_at, JSON.stringify(rest));
    return rec;
  }
  private pending(row: Row): PendingRecord {
    return { ...JSON.parse(String(row.data)), id: String(row.id), originator: String(row.originator), state: row.state as PendingState,
      created_at: Number(row.created_at), expires_at: Number(row.expires_at) };
  }
  /**
   * The record as it is now: a question still waiting after its time is expired, which counts as a refusal; an approval
   * not carried out by then is expired too.
   */
  getPending(id: string): PendingRecord | null {
    const row = this.db.prepare("SELECT * FROM gate_pending WHERE id=?").get(id) as Row | undefined;
    if (!row) return null;
    const rec = this.pending(row);
    if ((rec.state === "waiting" || rec.state === "approved") && rec.expires_at <= this.now()) return this.setState(id, [rec.state], "expired") ?? rec;
    return rec;
  }
  listPending(originator: string): PendingRecord[] {
    const rows = this.db.prepare("SELECT id FROM gate_pending WHERE originator=? AND state IN ('waiting','approved','denied','expired') ORDER BY created_at").all(originator) as { id: string }[];
    return rows.map((r) => this.getPending(r.id)!);
  }
  /** Waiting and approved records whose time has come; they become expired. */
  expireDue(): PendingRecord[] {
    const rows = this.db.prepare("SELECT id FROM gate_pending WHERE state IN ('waiting','approved') AND expires_at<=?").all(this.now()) as { id: string }[];
    return rows.map((r) => this.getPending(r.id)).filter((p): p is PendingRecord => p !== null && p.state === "expired");
  }
  waiting(): PendingRecord[] {
    return (this.db.prepare("SELECT id FROM gate_pending WHERE state='waiting' ORDER BY created_at").all() as { id: string }[])
      .map((r) => this.getPending(r.id)!).filter((p) => p.state === "waiting");
  }
  /**
   * Move a record from one of the given states to another; null when it was not in one of them. A question that ends
   * without being carried out (refused, expired, withdrawn, skipped) closes its request in the ledger with a response
   * that says how it ended.
   */
  setState(id: string, from: PendingState[], to: PendingState, answer?: PendingRecord["answer"]): PendingRecord | null {
    const row = this.db.prepare("SELECT * FROM gate_pending WHERE id=?").get(id) as Row | undefined;
    if (!row || !from.includes(row.state as PendingState)) return null;
    const rec = this.pending(row);
    const data = JSON.parse(String(row.data)) as Record<string, unknown>;
    if (answer) data.answer = answer;
    this.db.prepare("UPDATE gate_pending SET state=?,data=? WHERE id=? AND state=?").run(to, JSON.stringify(data), id, String(row.state));
    const next: PendingRecord = { ...rec, state: to, ...(answer ? { answer } : {}) };
    if (to === "expired") this.amend(id, { decision: "timeout", answered_at: this.now() });
    if (to === "withdrawn") this.amend(id, { decision: "cancelled", answered_at: this.now() });
    const ending = ENDINGS[to];
    if (ending) this.close(next, ending[0], ending[1]);
    if (to === "expired" && rec.state === "waiting") { try { this.onExpired?.(next); } catch { /* telling is best effort */ } }
    this.holds.get(id)?.(to);
    return next;
  }

  /**
   * The fast path of an approval: a call waits here for the question [id] to be answered, at most [ms]. Resolves with the state it ended
   * in (approved, denied, expired, withdrawn), "timeout" when the time came first, or "cancelled" when [signal] fired. Whichever comes first
   * decides, and the others find nothing to do: after a timeout or a cancel the question is an ordinary one (`isHeld` is false).
   */
  hold(id: string, ms: number, signal?: AbortSignal): Promise<PendingState | "timeout" | "cancelled"> {
    return new Promise((resolve) => {
      const end = (state: PendingState | "timeout" | "cancelled") => {
        if (this.holds.get(id) !== settle) return;
        this.holds.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(state);
      };
      const settle = (state: PendingState) => end(state);
      const onAbort = () => end("cancelled");
      const timer = setTimeout(() => end("timeout"), Math.max(0, ms));
      this.holds.set(id, settle);
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  /** Some call holds for the owner's answer to [id] now. */
  isHeld(id: string): boolean { return this.holds.has(id); }

  private close(p: PendingRecord, code: ErrorCode, message: string): void {
    if (this.ledger.request(p.id)?.state !== "waiting_owner") return;
    this.ledger.setRequest(p.id, "done");
    const response = this.ledger.append({ from: p.to, to: p.originator, kind: "response", word: p.word, body: { ok: false, error: errorBody(code, message) }, reply_to: p.id, ...(p.thread ? { thread: p.thread } : {}) });
    try { this.onClosed?.(response); } catch { /* a subscriber must not undo the state */ }
  }
}

const ENDINGS: Partial<Record<PendingState, [ErrorCode, string]>> = {
  denied: ["denied", "the owner refused"],
  expired: ["timeout", "the owner did not answer in time, which counts as a refusal"],
  withdrawn: ["cancelled", "the question was taken back before it was answered"],
  skipped: ["cancelled", "the agent decided not to carry it out"],
};
