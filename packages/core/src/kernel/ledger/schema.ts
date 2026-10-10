/**
 * Ledger schema 1: the five tables the ledger owns. Every other table (gate rules, hands, bodies, agent runs, the
 * inbox, the clock...) belongs to its own module, which creates it through `ledger.db()`.
 * There is no migration code: a database whose version is not 1 is refused (see `LedgerVersionError`).
 */

export const SCHEMA_VERSION = "1";
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
  size INTEGER NOT NULL
);
CREATE INDEX m_to ON messages("to", seq);
CREATE INDEX m_from ON messages("from", seq);
CREATE INDEX m_reply ON messages(reply_to);
CREATE INDEX m_turn ON messages(turn);
CREATE INDEX m_thread ON messages(thread) WHERE thread IS NOT NULL;
CREATE INDEX m_word ON messages(word, seq);

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
