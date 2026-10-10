/**
 * The agents' inboxes: one table, a row per message filed in a lane. The ledger holds the messages themselves; this
 * holds only what the delivery needs (text, attachments, which lane, how far it got).
 *
 *   pending      waiting for the lane to be idle (or for a quota that has run out)
 *   sent         handed to the driver (a turn was opened with it, or it was queued behind one)
 *   done         the turn it went into has ended
 *   interrupted  the turn it went into was cut off by a restart; never sent again
 *   failed       the turn it went into failed while answering the owner; delivered again if the owner chooses retry
 */
import type { HumanOrigin } from "../../../../sdk/src/message";
import type { DriverAttachment, DriverMessage } from "../../../../sdk/src/driver";
import type { Db } from "../../kernel/ledger";

export type InboxState = "pending" | "sent" | "done" | "interrupted" | "failed";
export interface InboxRow {
  id: string; agent: string; lane: string; from: string; word: string; text: string;
  attachments: DriverAttachment[]; thread?: string; at: number; origin?: HumanOrigin; state: InboxState; turn?: string;
}

const SQL = `
CREATE TABLE IF NOT EXISTS agent_inbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  agent       TEXT NOT NULL,
  lane        TEXT NOT NULL,
  sender      TEXT NOT NULL,
  word        TEXT NOT NULL,
  text        TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  thread      TEXT,
  at          INTEGER NOT NULL,
  origin      TEXT,
  state       TEXT NOT NULL DEFAULT 'pending',
  turn        TEXT
);
CREATE INDEX IF NOT EXISTS agent_inbox_lane ON agent_inbox(agent, lane, state, seq);
`;

const rowOf = (r: Record<string, unknown>): InboxRow => ({
  id: String(r.id), agent: String(r.agent), lane: String(r.lane), from: String(r.sender), word: String(r.word), text: String(r.text),
  attachments: JSON.parse(String(r.attachments)) as DriverAttachment[], ...(r.thread ? { thread: String(r.thread) } : {}), at: Number(r.at),
  ...(r.origin ? { origin: JSON.parse(String(r.origin)) as HumanOrigin } : {}), state: String(r.state) as InboxState, ...(r.turn ? { turn: String(r.turn) } : {}),
});

export const toDriverMessage = (row: InboxRow): DriverMessage => ({
  id: row.id, from: row.from, word: row.word, text: row.text, lane: row.lane, at: row.at,
  ...(row.thread ? { thread: row.thread } : {}), ...(row.attachments.length ? { attachments: row.attachments } : {}), ...(row.origin ? { origin: row.origin } : {}),
});

export class Inbox {
  constructor(private readonly db: Db) { db.exec(SQL); }

  /** Idempotent on the message id: the same message filed twice is one row. */
  add(row: Omit<InboxRow, "state" | "turn">): InboxRow {
    this.db.prepare("INSERT OR IGNORE INTO agent_inbox(id,agent,lane,sender,word,text,attachments,thread,at,origin) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.agent, row.lane, row.from, row.word, row.text, JSON.stringify(row.attachments), row.thread ?? null, row.at, row.origin ? JSON.stringify(row.origin) : null);
    return this.get(row.id)!;
  }
  get(id: string): InboxRow | null {
    const r = this.db.prepare("SELECT * FROM agent_inbox WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? rowOf(r) : null;
  }
  pending(agent: string, lane: string, limit = 50): InboxRow[] {
    return (this.db.prepare("SELECT * FROM agent_inbox WHERE agent=? AND lane=? AND state='pending' ORDER BY seq LIMIT ?").all(agent, lane, limit) as Record<string, unknown>[]).map(rowOf);
  }
  byTurn(turn: string): InboxRow[] {
    return (this.db.prepare("SELECT * FROM agent_inbox WHERE turn=? ORDER BY seq").all(turn) as Record<string, unknown>[]).map(rowOf);
  }
  /** Rows handed to a driver whose turn never ended. */
  unfinished(agent: string): InboxRow[] {
    return (this.db.prepare("SELECT * FROM agent_inbox WHERE agent=? AND state='sent' ORDER BY seq").all(agent) as Record<string, unknown>[]).map(rowOf);
  }
  mark(ids: string[], state: InboxState, turn?: string): void {
    const stmt = this.db.prepare("UPDATE agent_inbox SET state=?, turn=COALESCE(?,turn) WHERE id=?");
    for (const id of ids) stmt.run(state, turn ?? null, id);
  }
  setTurn(ids: string[], turn: string): void {
    const stmt = this.db.prepare("UPDATE agent_inbox SET turn=? WHERE id=?");
    for (const id of ids) stmt.run(turn, id);
  }
  finish(turn: string, state: "done" | "interrupted" | "failed" = "done"): void {
    this.db.prepare("UPDATE agent_inbox SET state=? WHERE turn=? AND state='sent'").run(state, turn);
  }
  /** A failed batch of this agent waits for delivery again, in its old order. False when there is no such batch (or it was retried already). */
  requeue(agent: string, turn: string): boolean {
    return Number(this.db.prepare("UPDATE agent_inbox SET state='pending', turn=NULL WHERE agent=? AND turn=? AND state='failed'").run(agent, turn).changes) > 0;
  }
  drop(agent: string): void { this.db.prepare("DELETE FROM agent_inbox WHERE agent=?").run(agent); }
  prune(before: number): void { this.db.prepare("DELETE FROM agent_inbox WHERE state IN ('done','interrupted','failed') AND at<?").run(before); }
}
