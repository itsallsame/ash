/**
 * The ledger (HUB-MODULES §1.2): every message, and how far each request has got. One SQLite file, one connection;
 * other modules create their own tables in the same file through `db()` and must not open the file again.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HumanOrigin, Message } from "../../../../sdk/src/message";
import { BlobStore } from "./blob-store";
import { externalize } from "./externalize";
import { indexMessage } from "./relations";
import { REQUEST_STATES, SCHEMA_KEY, SCHEMA_SQL, SCHEMA_VERSION } from "./schema";
import { messageSummary, MESSAGE_SUMMARY_MAX, textSummary } from "./summary";

export type Db = DatabaseSync;

/** The exit code of a process that refuses to start because its state is not usable (EX_CONFIG). */
export const EXIT_CONFIG = 78;

/** The state file was written by another version. There is no migration: clear the state directory. */
export class LedgerVersionError extends Error {
  readonly exitCode = EXIT_CONFIG;
  constructor(readonly found: string, readonly path: string) {
    super(`状态库版本 ${found} 不支持（需要 ${SCHEMA_VERSION}），请清空 state 目录: ${path}`);
    this.name = "LedgerVersionError";
  }
}

/** A message as it is recorded: the `Message` plus the summary and the original size. Long content is `{$blob,...}` references. */
export type LedgerMessage = Message & { summary: string; size: number };

export type NewMessage = Pick<Message, "from" | "to" | "kind" | "word" | "body">
  & Partial<Pick<Message, "id" | "ts" | "reply_to" | "origin" | "turn" | "thread">>;

export interface AppendOptions {
  /** The sender's own summary; used instead of the generated one. */
  summary?: string;
  /** For a request: where it starts (default `dispatched`) and when it is due (Unix ms; 0 = no deadline recorded). */
  request?: { state?: RequestState["state"]; deadline?: number };
}

export interface PageQuery {
  /** Only messages with a larger seq. */
  after?: number;
  /** Only messages with a smaller seq; with `before`, the newest `limit` of them. */
  before?: number;
  /** 1 to 1000. */
  limit: number;
  /** Sender id. */
  from?: string;
  /** Recipient id. */
  to?: string;
  word?: string;
  /** Substring (SQL LIKE) of the summary or of the recorded body. */
  text?: string;
  thread?: string;
}

export interface RequestState {
  id: string; from: string; to: string; word: string;
  state: "waiting_owner" | "dispatched" | "done" | "interrupted";
  deadline: number;
}

export interface BlobApi {
  put(bytes: Uint8Array, mime: string): string;
  get(ref: string): { bytes: Uint8Array; mime: string } | null;
}

export interface Ledger {
  /** Assign id and seq, record the message; a body over 16 KB (or with long strings, or binary) leaves the row as attachments. Returns what was recorded. */
  append(m: NewMessage, options?: AppendOptions): LedgerMessage;
  get(id: string): LedgerMessage | null;
  /** In seq order, oldest first. */
  page(q: PageQuery): LedgerMessage[];
  request(id: string): RequestState | null;
  /** The request must have been appended. */
  setRequest(id: string, state: RequestState["state"]): void;
  /** Requests that are not `done`, oldest first. */
  unfinished(): RequestState[];
  readonly blob: BlobApi;
  /** The one connection, for other modules' own tables. */
  db(): Db;
  /** All or nothing. A call inside another `tx` joins it: nothing is undone until the outermost one fails. */
  tx<T>(fn: () => T): T;
  close(): void;
}

const PAGE_LIMIT_MAX = 1000;

type Row = Record<string, unknown>;
const newId = () => `m_${randomBytes(9).toString("base64url")}`;

function decode(row: Row): LedgerMessage {
  return {
    seq: Number(row.seq), id: String(row.id), ts: Number(row.ts), from: String(row.from),
    to: row.to === null ? null : String(row.to), kind: row.kind as Message["kind"], word: String(row.word),
    body: JSON.parse(String(row.body)),
    ...(row.reply_to === null ? {} : { reply_to: String(row.reply_to) }),
    ...(row.origin === null ? {} : { origin: JSON.parse(String(row.origin)) as HumanOrigin }),
    ...(row.turn === null ? {} : { turn: String(row.turn) }),
    ...(row.thread === null ? {} : { thread: String(row.thread) }),
    summary: String(row.summary), size: Number(row.size),
  };
}

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

class SqliteLedger implements Ledger {
  readonly blob: BlobApi;
  private depth = 0;
  private readonly store: BlobStore;

  constructor(private readonly conn: DatabaseSync, blobDir: string) {
    this.store = new BlobStore(blobDir, conn);
    this.blob = {
      put: (bytes, mime) => this.store.put(bytes, mime),
      get: (ref) => this.store.get(ref),
    };
  }

  db(): Db { return this.conn; }

  close(): void { this.conn.close(); }

  tx<T>(fn: () => T): T {
    // Inside a transaction the work simply joins it: whoever opened the outer one commits or rolls back all of it.
    if (this.depth > 0) return this.run(fn);
    this.conn.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = this.run(fn);
      this.conn.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.conn.exec("ROLLBACK"); } catch { /* the original error matters more */ }
      throw error;
    } finally { this.depth--; }
  }

  private run<T>(fn: () => T): T {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === "function") throw new TypeError("ledger.tx takes a synchronous function");
    return result;
  }

  append(m: NewMessage, options: AppendOptions = {}): LedgerMessage {
    if (m.kind === "request" && m.to === null) throw new TypeError("a request needs a recipient");
    const id = m.id ?? newId();
    const ts = m.ts ?? Date.now();
    return this.tx(() => {
      const out = externalize(m.body, (bytes, mime) => this.store.put(bytes, mime));
      const summary = messageSummary(m.kind, m.word, m.body, out.notes, options.summary === undefined ? undefined : textSummary(options.summary, MESSAGE_SUMMARY_MAX));
      const info = this.conn.prepare(
        `INSERT INTO messages(id,ts,"from","to",kind,word,body,reply_to,origin,turn,thread,summary,size) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, ts, m.from, m.to, m.kind, m.word, JSON.stringify(out.stored), m.reply_to ?? null,
          m.origin ? JSON.stringify(m.origin) : null, m.turn ?? null, m.thread ?? null, summary, out.size);
      const link = this.conn.prepare("INSERT OR IGNORE INTO message_blobs(message_id,hash,path) VALUES(?,?,?)");
      for (const ref of out.refs) link.run(id, ref.hash, ref.path);
      indexMessage(this.conn, m, out.stored, id, ts, Number(info.lastInsertRowid));
      if (m.kind === "request") {
        const state = options.request?.state ?? "dispatched";
        if (!(REQUEST_STATES as readonly string[]).includes(state)) throw new RangeError(`unknown request state: ${state}`);
        this.conn.prepare(`INSERT INTO requests(id,"from","to",word,state,deadline,updated_at) VALUES(?,?,?,?,?,?,?)`)
          .run(id, m.from, m.to!, m.word, state, options.request?.deadline ?? 0, ts);
      }
      return decode({
        seq: Number(info.lastInsertRowid), id, ts, from: m.from, to: m.to, kind: m.kind, word: m.word, body: JSON.stringify(out.stored),
        reply_to: m.reply_to ?? null, origin: m.origin ? JSON.stringify(m.origin) : null, turn: m.turn ?? null, thread: m.thread ?? null,
        summary, size: out.size,
      });
    });
  }

  get(id: string): LedgerMessage | null {
    const row = this.conn.prepare("SELECT * FROM messages WHERE id=?").get(id) as Row | undefined;
    return row ? decode(row) : null;
  }

  page(q: PageQuery): LedgerMessage[] {
    const limit = Math.min(Math.max(Math.trunc(q.limit) || 1, 1), PAGE_LIMIT_MAX);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.after !== undefined) { where.push("seq>?"); args.push(q.after); }
    if (q.before !== undefined) { where.push("seq<?"); args.push(q.before); }
    if (q.from !== undefined) { where.push(`"from"=?`); args.push(q.from); }
    if (q.to !== undefined) { where.push(`"to"=?`); args.push(q.to); }
    if (q.word !== undefined) { where.push("word=?"); args.push(q.word); }
    if (q.thread !== undefined) { where.push("thread=?"); args.push(q.thread); }
    if (q.text !== undefined && q.text !== "") {
      where.push(`(summary LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`);
      args.push(`%${likeEscape(q.text)}%`, `%${likeEscape(q.text)}%`);
    }
    const descending = q.before !== undefined;
    const tail = `${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ${descending ? "DESC" : "ASC"} LIMIT ?`;
    const rows = (this.conn.prepare(`SELECT * FROM messages${tail}`).all(...args, limit) as Row[]).map(decode);
    return descending ? rows.reverse() : rows;
  }

  request(id: string): RequestState | null {
    const row = this.conn.prepare("SELECT * FROM requests WHERE id=?").get(id) as Row | undefined;
    return row ? this.requestOf(row) : null;
  }

  setRequest(id: string, state: RequestState["state"]): void {
    if (!(REQUEST_STATES as readonly string[]).includes(state)) throw new RangeError(`unknown request state: ${state}`);
    const done = this.conn.prepare("UPDATE requests SET state=?,updated_at=? WHERE id=?").run(state, Date.now(), id);
    if (Number(done.changes) === 0) throw new Error(`unknown request: ${id}`);
  }

  unfinished(): RequestState[] {
    return (this.conn.prepare(`SELECT * FROM requests WHERE state IN ('waiting_owner','dispatched') ORDER BY rowid`).all() as Row[])
      .map((row) => this.requestOf(row));
  }

  private requestOf(row: Row): RequestState {
    return { id: String(row.id), from: String(row.from), to: String(row.to), word: String(row.word), state: row.state as RequestState["state"], deadline: Number(row.deadline) };
  }
}

function open(path: string): Ledger {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new DatabaseSync(path);
  try {
    // Read the version before changing anything: a file of another version is left exactly as it is.
    const tables = (conn.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n;
    if (Number(tables) > 0) {
      const hasKv = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'").get();
      const found = hasKv ? (conn.prepare("SELECT value FROM kv WHERE key=?").get(SCHEMA_KEY) as { value: string } | undefined)?.value : undefined;
      if (found !== SCHEMA_VERSION) throw new LedgerVersionError(found ?? "unknown", path);
    }
    conn.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    if (Number(tables) === 0) {
      conn.exec("BEGIN IMMEDIATE");
      try {
        conn.exec(SCHEMA_SQL);
        conn.prepare("INSERT INTO kv(key,value) VALUES(?,?)").run(SCHEMA_KEY, SCHEMA_VERSION);
        conn.prepare("INSERT INTO kv(key,value) VALUES(?,?)").run("dataset_id", randomBytes(18).toString("base64url"));
        conn.exec("COMMIT");
      } catch (error) { conn.exec("ROLLBACK"); throw error; }
    }
  } catch (error) {
    conn.close();
    throw error;
  }
  return new SqliteLedger(conn, join(dirname(path), "blobs"));
}

/** `Ledger.open(path)`: the only way to get a ledger. */
export const Ledger = { open };
