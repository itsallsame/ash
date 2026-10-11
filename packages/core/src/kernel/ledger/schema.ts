/**
 * Ledger schema 2: the tables the ledger owns. Every other table (gate rules, hands, bodies, agent runs, the
 * inbox, the clock...) belongs to its own module, which creates it through `ledger.db()`.
 * There is no migration code: a database whose version is not 2 is refused (see `LedgerVersionError`).
 */

export const SCHEMA_VERSION = "2";
export const SCHEMA_KEY = "schema";

/** The state a request is in; the order is the usual one but nothing here enforces it. */
export const REQUEST_STATES = ["waiting_owner", "dispatched", "done", "interrupted"] as const;

export const SCHEMA_SQL = `
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  "from" TEXT NOT NULL,
  "to" TEXT,
  kind TEXT NOT NULL,
  word TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to TEXT,
  origin TEXT,
  turn TEXT,
  thread TEXT,
  summary TEXT NOT NULL,
  size INTEGER NOT NULL,
  display_type TEXT,
  fact_type TEXT,
  fact_turn TEXT,
  lane TEXT,
  expires_at INTEGER,
  outcome TEXT,
  answer_seq INTEGER,
  turn_end_seq INTEGER,
  tool_name TEXT,
  tool_phase TEXT,
  activity_state TEXT,
  activity_receipt TEXT,
  activity_key TEXT,
  activity_mode TEXT,
  state_facts TEXT
);
CREATE INDEX m_to ON messages("to", seq);
CREATE INDEX m_from ON messages("from", seq);
CREATE INDEX m_reply ON messages(reply_to,seq);
CREATE INDEX m_turn ON messages(turn);
CREATE INDEX m_thread ON messages(thread) WHERE thread IS NOT NULL;
CREATE INDEX m_word ON messages(word, seq);

CREATE INDEX m_display ON messages(seq) WHERE display_type IS NOT NULL;
CREATE INDEX m_owner_order ON messages(seq) WHERE display_type='owner.say';
CREATE INDEX m_owner_say ON messages(ts, seq) WHERE display_type='owner.say';
CREATE INDEX m_facts ON messages(fact_type, seq);
CREATE INDEX m_fact_turn ON messages(fact_turn, seq);
CREATE INDEX m_activity_started ON messages(ts,seq) WHERE fact_type='turn.start';
CREATE INDEX m_agent_activity ON messages("from",ts,seq) WHERE fact_type='turn.start';
CREATE INDEX m_ended ON messages(ts,seq) WHERE fact_type='turn.end';
CREATE INDEX m_pending_asks ON messages(expires_at, seq) WHERE display_type='ask' AND answer_seq IS NULL;
CREATE INDEX m_open_front ON messages(seq) WHERE fact_type='turn.start' AND lane='front' AND turn_end_seq IS NULL;
CREATE INDEX m_failed ON messages(ts, seq) WHERE fact_type='turn.end' AND outcome='error';
CREATE INDEX m_tool ON messages(fact_turn,tool_name,tool_phase,seq) WHERE fact_type='tool';
CREATE INDEX m_pending_tools ON messages(fact_turn,seq) WHERE fact_type='tool' AND tool_phase='start' AND answer_seq IS NULL;
CREATE INDEX m_pending_activity ON messages(fact_turn,seq) WHERE fact_type='activity.request' AND activity_state='pending';
CREATE INDEX m_activity_pair ON messages(fact_turn,activity_key,activity_mode,seq) WHERE fact_type='activity.request' AND activity_state='pending';
CREATE INDEX m_activity_receipt ON messages(activity_receipt) WHERE activity_receipt IS NOT NULL;
CREATE INDEX m_open_asks ON messages(expires_at, seq) WHERE display_type='ask';

CREATE TABLE message_relations (
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_seq INTEGER NOT NULL REFERENCES messages(seq),
  position INTEGER,
  PRIMARY KEY (target, kind, source_seq)
) WITHOUT ROWID;
CREATE INDEX relation_source ON message_relations(source_seq);

CREATE TABLE requests (
  id TEXT PRIMARY KEY REFERENCES messages(id),
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  word TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting_owner','dispatched','done','interrupted')),
  deadline INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX r_state ON requests(state);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta TEXT
);

CREATE TABLE message_blobs (
  message_id TEXT NOT NULL REFERENCES messages(id),
  hash TEXT NOT NULL REFERENCES blobs(hash),
  path TEXT NOT NULL,
  PRIMARY KEY (message_id, path)
);
CREATE INDEX mb_hash ON message_blobs(hash);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
