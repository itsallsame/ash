/**
 * `sync` (SPEC-03 §5.2): a channel reads the ledger and follows it. What it gets is the ledger's own rows, which are
 * already "summary + attachment references" (SPEC-01 §4.3), so the owner's whole conversation reads the same on every channel.
 *
 *   neither after nor before   the newest `limit` messages (oldest first)
 *   after n                    everything with seq > n, in pages of `limit`, up to the newest
 *   before n                   the newest `limit` messages with seq < n (one page going back in time); cannot follow
 * `limit` is 200 unless given, at most 1000. `follow` (default false) keeps pushing new messages as `sync.msg`.
 */
import type { Message } from "../../../../../sdk/src/message";
import type { Frame, SyncFrame } from "../../../../../sdk/src/link";
import type { Ledger } from "../../../kernel/ledger";
import type { LiveClient } from "./clients";

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;
/** One `sync.page` frame stays well under the frame limit (4 MiB). */
const PAGE_BYTES = 1024 * 1024;

type Page = Record<string, unknown>;
interface Sync { sid: string; c: LiveClient; follow: boolean; last: number; buffer: Message[] | null; closed: boolean }

export class Syncs {
  private readonly open = new Map<string, Sync>();

  constructor(private readonly ledger: Pick<Ledger, "page" | "get">, private readonly log: (message: string, error?: unknown) => void) {}

  private key = (c: LiveClient, sid: string) => `${c.client}/${sid}`;

  start(c: LiveClient, frame: SyncFrame): void {
    const fail = (message: string) => void c.session.send({ t: "error", id: frame.sid, code: "bad_request", message });
    if (frame.before !== undefined && frame.follow) return fail("before pages back in time and cannot follow");
    if (this.open.has(this.key(c, frame.sid))) return fail("this sync is already open");
    const limit = Math.min(Math.max(Math.trunc(frame.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const sync: Sync = { sid: frame.sid, c, follow: frame.follow === true, last: 0, buffer: frame.follow ? [] : null, closed: false };
    if (sync.follow) this.open.set(this.key(c, sync.sid), sync);
    void this.run(sync, frame, limit).catch((error) => {
      this.log(`sync ${sync.sid} failed`, error);
      c.session.send({ t: "error", id: sync.sid, code: "internal", message: "the history could not be read" });
      this.close(c, sync.sid);
    });
  }

  close(c: LiveClient, sid: string): void {
    const sync = this.open.get(this.key(c, sid));
    if (sync) sync.closed = true;
    this.open.delete(this.key(c, sid));
  }

  closeAll(c: LiveClient): void {
    for (const sync of [...this.open.values()]) if (sync.c === c) this.close(c, sync.sid);
  }

  /** A message was recorded: every following sync gets it (in the form the ledger holds it). */
  publish(m: Message): void {
    if (!this.open.size) return;
    const row = this.ledger.get(m.id);
    if (!row) return;
    for (const sync of this.open.values()) {
      if (sync.buffer) sync.buffer.push(row);
      else this.push(sync, row);
    }
  }

  private push(sync: Sync, row: Message): void {
    if (row.seq <= sync.last) return;
    sync.last = row.seq;
    sync.c.session.send({ t: "sync.msg", sid: sync.sid, message: row as unknown as Page });
  }

  private async run(sync: Sync, frame: SyncFrame, limit: number): Promise<void> {
    if (frame.after !== undefined) {
      let after = frame.after;
      for (;;) {
        const rows = this.ledger.page({ after, limit });
        const done = rows.length < limit;
        this.page(sync, rows, done);
        if (done || sync.closed) break;
        after = rows[rows.length - 1]!.seq;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } else {
      this.page(sync, this.ledger.page({ before: frame.before ?? Number.MAX_SAFE_INTEGER, limit }), true);
    }
    // What was recorded while the pages were being read.
    const buffered = sync.buffer ?? [];
    sync.buffer = null;
    if (!sync.closed) for (const row of buffered) this.push(sync, row);
  }

  /** Sends one read as one or more `sync.page` frames; `end` is true on the last frame of the last read. */
  private page(sync: Sync, rows: Message[], end: boolean): void {
    if (sync.closed) return;
    const chunks: Message[][] = [[]];
    let bytes = 0;
    for (const row of rows) {
      const size = JSON.stringify(row).length;
      if (bytes + size > PAGE_BYTES && chunks.at(-1)!.length) { chunks.push([]); bytes = 0; }
      chunks.at(-1)!.push(row);
      bytes += size;
    }
    chunks.forEach((messages, i) => sync.c.session.send({
      t: "sync.page", sid: sync.sid, messages: messages as unknown as Page[], end: end && i === chunks.length - 1,
    } as Frame));
    if (rows.length) sync.last = Math.max(sync.last, rows[rows.length - 1]!.seq);
  }
}

