// What the home pages know of the conversation: a second, lazy reader of the same ledger rows the page already receives.
// It keeps the rows (the very same objects the conversation holds, so no copy of the data) and projects them only when a
// home page is looking, once per change, instead of folding every row as it arrives.
import { projectMessages } from "./project.js";

export class HomeFeed {
  constructor() {
    this.rows = new Map();
    this.version = 0;
    this.cached = null;
    this.listeners = new Set();
    this.queued = false;
  }

  add(message) {
    if (!Number.isSafeInteger(message?.seq) || this.rows.has(message.seq)) return;
    this.rows.set(message.seq, message);
    this.changed();
  }

  addMany(messages) { for (const message of messages) this.add(message); }

  changed() {
    this.version++;
    this.cached = null;
    if (this.queued || !this.listeners.size) return;
    this.queued = true;
    // A long task writes rows by the hundred: the pages repaint a few times a second, not once per row.
    setTimeout(() => { this.queued = false; for (const listener of this.listeners) listener(); }, 120);
  }

  /** The projected view: presence, turns, asks. Computed on first use after a change. */
  view() {
    if (!this.cached || this.cached.version !== this.version) this.cached = { version: this.version, view: projectMessages([...this.rows.values()]) };
    return this.cached.view;
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

export const feed = new HomeFeed();

/** The page's connection, once it exists. */
export const link = { net: null };
