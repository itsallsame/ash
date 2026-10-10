/**
 * `agent_jobs`: the receipts an agent was given (SPEC-02 §3.4). A row exists once a call has been answered with a
 * receipt, so it can be asked about after a restart of the hub. The table lives in the ledger's database (its own table,
 * the one connection).
 *
 * A call that was still running when the hub stopped is `interrupted`: nobody knows whether it was done, so the answer
 * is `result_unknown` (the router says the same to the sender of that request) and nothing is replayed.
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
      settled_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_jobs_agent ON agent_jobs(agent, at);`);
    // A new process: whatever was running is not running any more.
    db.prepare("UPDATE agent_jobs SET state='interrupted', outcome=?, settled_at=? WHERE state='running'").run(JSON.stringify(UNKNOWN()), now());
    db.prepare("DELETE FROM agent_jobs WHERE at < ?").run(now() - KEEP_MS);
  }

  insert(row: Pick<JobRow, "id" | "agent" | "turn" | "member" | "word" | "label" | "at"> & { outcome?: Shaped }): void {
    const settled = row.outcome !== undefined;
    this.db.prepare("INSERT INTO agent_jobs(id,agent,turn,member,word,label,at,state,outcome,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.agent, row.turn, row.member, row.word, row.label, row.at, settled ? "done" : "running", settled ? JSON.stringify(withoutImages(row.outcome!)) : null, settled ? this.now() : null);
  }

  settle(id: string, outcome: Shaped): void {
    this.db.prepare("UPDATE agent_jobs SET state='done', outcome=?, settled_at=? WHERE id=? AND state='running'").run(JSON.stringify(withoutImages(outcome)), this.now(), id);
  }

  /** One agent's receipt; nobody else's. */
  find(agent: string, id: string): JobRow | null {
    const row = this.db.prepare("SELECT * FROM agent_jobs WHERE id=? AND agent=?").get(id, agent) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: String(row.id), agent: String(row.agent), turn: row.turn === null ? null : String(row.turn), member: String(row.member), word: String(row.word),
      label: String(row.label), at: Number(row.at), state: row.state as JobState, outcome: row.outcome === null ? null : (JSON.parse(String(row.outcome)) as Shaped),
      settled_at: row.settled_at === null ? null : Number(row.settled_at) };
  }
}
