/**
 * `agent_jobs`: the receipts an agent was given (SPEC-02 §3.4). A row exists once a call has been answered with a
 * receipt, so it can be asked about after a restart of the hub. The table lives in the ledger's database (its own table,
 * the one connection).
 *
 * A call that was still running when the hub stopped is `interrupted`: nobody knows whether it was done, so the answer
 * is `result_unknown` (the router says the same to the sender of that request) and nothing is replayed.
 *
 * Two marks say whether the agent still has to be told (SPEC-02 §3.4, the result comes back by itself): `taken` (the agent
 * fetched the answer with await_result, or cancelled the call) and `woken` (the agent was woken for it, or never needs to
 * be). A wake is owed while the call is settled, neither mark is set and the turn that made the call is over.
 */
import type { Db } from "../../kernel/ledger";
import { failure, withoutImages, type Shaped } from "./result";

export type JobState = "running" | "done" | "interrupted";

export interface JobRow {
  id: string;
  agent: string;
  turn: string | null;
  member: string;
  word: string;
  label: string;
  at: number;
  state: JobState;
  /** The answer as the agent was given it (images left out), once there is one. */
  outcome: Shaped | null;
  settled_at: number | null;
  taken: boolean;
  woken: boolean;
}

/** Settled receipts are kept this long. */
export const KEEP_MS = 30 * 24 * 3_600_000;

const UNKNOWN = (): Shaped => failure("result_unknown", "Ash restarted while this call was running; whether it was done is not known.");

export class JobTable {
  constructor(private readonly db: Db, private readonly now: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      turn TEXT,
      member TEXT NOT NULL,
      word TEXT NOT NULL,
      label TEXT NOT NULL,
      at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running','done','interrupted')),
      outcome TEXT,
      settled_at INTEGER,
      taken INTEGER NOT NULL DEFAULT 0,
      woken INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_jobs_agent ON agent_jobs(agent, at);`);
    // A new process: whatever was running is not running any more.
    db.prepare("UPDATE agent_jobs SET state='interrupted', outcome=?, settled_at=? WHERE state='running'").run(JSON.stringify(UNKNOWN()), now());
    db.prepare("DELETE FROM agent_jobs WHERE at < ?").run(now() - KEEP_MS);
  }

  /** `woken`: the agent needs no wake for this one (the gate parked the call for the owner: its answer comes from `service:gate`). */
  insert(row: Pick<JobRow, "id" | "agent" | "turn" | "member" | "word" | "label" | "at"> & { outcome?: Shaped; woken?: boolean }): void {
    const settled = row.outcome !== undefined;
    this.db.prepare("INSERT INTO agent_jobs(id,agent,turn,member,word,label,at,state,outcome,settled_at,woken) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.agent, row.turn, row.member, row.word, row.label, row.at, settled ? "done" : "running", settled ? JSON.stringify(withoutImages(row.outcome!)) : null, settled ? this.now() : null, row.woken ? 1 : 0);
  }

  /** `wake` false: the answer is a receipt of another kind (waiting_owner) and nobody is woken for it. */
  settle(id: string, outcome: Shaped, wake = true): void {
    this.db.prepare("UPDATE agent_jobs SET state='done', outcome=?, settled_at=?, woken=? WHERE id=? AND state='running'").run(JSON.stringify(withoutImages(outcome)), this.now(), wake ? 0 : 1, id);
  }

  /** The agent has the answer (await_result gave it) or does not want one (it cancelled the call): no wake. */
  take(id: string): void {
    this.db.prepare("UPDATE agent_jobs SET taken=1 WHERE id=?").run(id);
  }

  /** Claim the one wake of a settled call that nobody took: true exactly once. */
  claimWake(id: string): boolean {
    return Number(this.db.prepare("UPDATE agent_jobs SET woken=1 WHERE id=? AND woken=0 AND taken=0 AND state!='running'").run(id).changes) === 1;
  }

  /** Settled calls of one turn that still owe a wake (checked when the turn ends). */
  owing(agent: string, turn: string): string[] {
    return (this.db.prepare("SELECT id FROM agent_jobs WHERE agent=? AND turn=? AND state!='running' AND woken=0 AND taken=0 ORDER BY at").all(agent, turn) as { id: string }[]).map((r) => r.id);
  }

  /** Calls the last process left running: their agents are told once the hub is up. */
  unknown(): string[] {
    return (this.db.prepare("SELECT id FROM agent_jobs WHERE state='interrupted' AND woken=0 AND taken=0 ORDER BY at").all() as { id: string }[]).map((r) => r.id);
  }

  /** One agent's receipt; nobody else's. */
  find(agent: string, id: string): JobRow | null {
    const row = this.get(id);
    return row && row.agent === agent ? row : null;
  }

  get(id: string): JobRow | null {
    const row = this.db.prepare("SELECT * FROM agent_jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: String(row.id), agent: String(row.agent), turn: row.turn === null ? null : String(row.turn), member: String(row.member), word: String(row.word),
      label: String(row.label), at: Number(row.at), state: row.state as JobState, outcome: row.outcome === null ? null : (JSON.parse(String(row.outcome)) as Shaped),
      settled_at: row.settled_at === null ? null : Number(row.settled_at), taken: Number(row.taken) === 1, woken: Number(row.woken) === 1 };
  }
}

/** A gate-parked call is a receipt, not a result; its answer reaches the agent from `service:gate`. */
export const isWaitingOwner = (shaped: Shaped): boolean => !shaped.isError && shaped.structuredContent?.status === "waiting_owner";

/** A `wake`'s `context.outcome` is cut to this many characters; the whole answer stays in the table for await_result. */
export const WAKE_OUTCOME_CHARS = 4000;

/**
 * What the agent is told in the wake about the call's answer: the answer itself when it is short, else a summary with the
 * attachment references (a result over 60000 characters is already an attachment, SPEC-02 §3.5) and the way to fetch it all.
 */
export function wakeOutcome(shaped: Shaped, requestId: string): Record<string, unknown> {
  const value = shaped.structuredContent ?? { text: shaped.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n") };
  const full: Record<string, unknown> = shaped.isError ? { ok: false, ...value } : { ok: true, result: value };
  const json = JSON.stringify(full);
  if (json.length <= WAKE_OUTCOME_CHARS) return full;
  const attachments = !shaped.isError && Array.isArray(value.attachments) ? value.attachments : undefined;
  const preview = !shaped.isError && typeof value.preview === "string" ? value.preview : json;
  return { ok: !shaped.isError, truncated: true, preview: preview.slice(0, WAKE_OUTCOME_CHARS), ...(attachments ? { attachments } : {}),
    note: `Cut short. The whole answer: await_result {request_id: "${requestId}"}${attachments ? "; the attachments are read in pieces with service:blobs/read using an attachment's hash" : ""}.` };
}
