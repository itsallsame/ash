const context = item => item ? Object.fromEntries(["id", "seq", "ts", "side", "from", "group", "type"].filter(key => item[key] !== undefined).map(key => [key, item[key]])) : null;

/** One bounded, ordered window of hydrated display items. No ledger history is retained here. */
export class ConversationStore {
  constructor({ maxItems = 60, maxBytes = 256 * 1024 } = {}) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.reset();
  }

  reset() {
    this.items = [];
    this.byId = new Map();
    this.bytes = 0;
    this.dataset = null;
    this.snapshot = 0;
    this.previous = this.next = null;
    this.hasBefore = this.hasAfter = false;
    this.intro = false;
    this.protected = new Set();
  }

  protect(ids) { this.protected = new Set(ids); }
  canPage(direction) {
    const edge = direction === "before" ? this.items.at(-1) : this.items[0];
    return this.items.length < this.maxItems && this.bytes < this.maxBytes || !this.protected.has(edge?.id);
  }

  /** Replace for a jump; prepend/append for continuous reading. Older snapshots cannot undo newer answers. */
  apply(page, direction = "replace") {
    if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.snapshot_seq)) throw new Error("invalid display page");
    for (const item of page.items) if (typeof item?.id !== "string" || !Number.isSafeInteger(item.seq) || item.seq < 1) throw new Error("invalid display item");
    // A selection or focused card at the edge owns its DOM until the interaction ends. Stop prefetching there.
    if (direction !== "replace" && !this.canPage(direction)) return new Set();
    if (this.dataset !== null && this.dataset !== page.dataset_id) { this.reset(); direction = "replace"; }
    this.dataset = page.dataset_id;
    const changed = new Set();
    if (direction === "replace") {
      for (const item of this.items) changed.add(item.id);
      this.items = [];
      this.byId.clear();
    }
    for (const item of page.items) {
      if (typeof item?.id !== "string" || !Number.isSafeInteger(item.seq) || item.seq < 1) throw new Error("invalid display item");
      const prior = this.byId.get(item.id);
      if (prior && prior.revision > page.snapshot_seq) continue;
      // Size is calculated only when received, never during painting.
      const bytes = Number.isSafeInteger(item.byte_size) && item.byte_size >= 0 ? item.byte_size : new TextEncoder().encode(JSON.stringify(item)).byteLength;
      const expandedBytes = prior?.expandedBytes ?? this.expandedSize?.(item) ?? 0;
      this.byId.set(item.id, { item, bytes: bytes + expandedBytes, baseBytes: bytes, expandedBytes, revision: page.snapshot_seq });
      changed.add(item.id);
    }
    this.items = [...this.byId.values()].map(entry => entry.item).sort((a, b) => a.seq - b.seq);
    this.bytes = [...this.byId.values()].reduce((total, entry) => total + entry.bytes, 0);
    if (direction !== "after") {
      this.previous = page.previous ?? null;
      this.hasBefore = page.has_more_before === true;
      this.intro = page.intro === true;
    }
    if (direction !== "before") {
      this.next = page.next ?? null;
      this.hasAfter = page.has_more_after === true;
    }
    // A single oversized legitimate item is retained alone, rather than truncated into a misleading preview.
    this.trim(direction, changed);
    this.snapshot = Math.max(this.snapshot, page.snapshot_seq);
    return changed;
  }

  trim(direction, changed = new Set(), keep = null) {
    while (this.items.length > 1 && (this.items.length > this.maxItems || this.bytes > this.maxBytes)) {
      let fromEnd = direction === "before";
      let edge = fromEnd ? this.items.at(-1) : this.items[0];
      if (edge.id === keep || this.protected.has(edge.id)) {
        fromEnd = !fromEnd;
        edge = fromEnd ? this.items.at(-1) : this.items[0];
        if (edge.id === keep || this.protected.has(edge.id)) break;
      }
      const item = fromEnd ? this.items.pop() : this.items.shift();
      this.bytes -= this.byId.get(item.id).bytes;
      this.byId.delete(item.id);
      changed.add(item.id);
      if (fromEnd) { this.next = context(item); this.hasAfter = true; }
      else { this.previous = context(item); this.hasBefore = true; this.intro = false; }
    }
    return changed;
  }

  /** Full text counts toward the same mounted-window budget as summaries. Keep the reading/expanded row. */
  expand(id, bytes, anchor = id) {
    const entry = this.byId.get(id);
    if (!entry) return new Set();
    this.bytes += bytes - entry.expandedBytes;
    entry.expandedBytes = bytes;
    entry.bytes = entry.baseBytes + bytes;
    const index = this.items.findIndex(item => item.id === anchor);
    return this.trim(index < this.items.length / 2 ? "before" : "after", new Set([id]), id);
  }

  get before() { return this.items[0]?.seq ?? null; }
  get after() { return this.items.at(-1)?.seq ?? null; }
  get(id) { return this.byId.get(id)?.item ?? null; }

  update(item, revision, insert = false) {
    if (!insert && !this.byId.has(item.id)) return new Set();
    return this.apply({ dataset_id: this.dataset, snapshot_seq: revision, items: [item],
      has_more_after: this.hasAfter, next: this.next }, "after");
  }
}
