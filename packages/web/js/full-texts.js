/** Text is cached by hash; expansion choices are a separate finite LRU of message ids. */
export class FullTexts {
  constructor({ maxBytes = 2 * 1024 * 1024, maxChoices = 400, maxSources = 400 } = {}) {
    this.maxBytes = maxBytes;
    this.maxChoices = maxChoices;
    this.maxSources = maxSources;
    this.reset();
  }
  reset() { this.values = new Map(); this.choices = new Map(); this.shown = new Set(); this.pending = new Map(); this.bytes = 0; this.generation = (this.generation ?? 0) + 1; }
  has(hash, id) { return this.values.has(hash) && (!id || this.choices.get(id)?.hash === hash && this.shown.has(id)); }
  hide(id) { this.shown.delete(id); }
  discard(hash) { const entry = this.values.get(hash); if (entry) { this.values.delete(hash); this.bytes -= entry.bytes; } for (const [id, choice] of this.choices) if (choice.hash === hash) this.hide(id); }
  get(hash) {
    const entry = this.values.get(hash);
    if (!entry) return undefined;
    this.values.delete(hash); this.values.set(hash, entry);
    return entry.text;
  }
  expanded(id) { return this.choices.has(id); }
  expansionLabel(id) { return this.choices.has(id) && !this.choices.get(id).failed ? "正在展开…" : "显示全文"; }
  remember(id, hash) {
    this.choices.delete(id); this.choices.set(id, { hash, failed: false });
    while (this.choices.size > this.maxChoices) this.choices.delete(this.choices.keys().next().value);
  }
  async load(id, hash, read) {
    this.remember(id, hash);
    if (this.has(hash)) { this.shown.add(id); this.get(hash); return this.values.get(hash); }
    const generation = this.generation;
    if (!this.pending.has(hash)) {
      const request = Promise.resolve().then(() => read(hash)).then(text => {
        if (generation !== this.generation) return null;
        const entry = { text, bytes: new TextEncoder().encode(text).byteLength };
        this.values.set(hash, entry); this.bytes += entry.bytes;
        return entry;
      }).finally(() => { if (generation === this.generation) this.pending.delete(hash); });
      this.pending.set(hash, request);
    }
    try { const entry = await this.pending.get(hash); if (entry && this.choices.get(id)?.hash === hash) this.shown.add(id); return entry; }
    catch (error) { if (generation === this.generation && this.choices.get(id)?.hash === hash) { this.hide(id); this.choices.get(id).failed = true; } throw error; }
  }
  /** Mounted texts remain complete. At most one legitimate oversized text can occupy the whole cache. */
  retain(items) {
    const ids = new Set(items.map(item => item.id));
    for (const id of this.shown) if (!ids.has(id) || !this.expanded(id)) this.hide(id);
    const active = new Set(items.filter(item => this.has(item.full, item.id)).map(item => item.full).filter(Boolean));
    for (const [hash, entry] of this.values) {
      if (this.bytes <= this.maxBytes && this.values.size <= this.maxSources) break;
      if (!active.has(hash)) { this.values.delete(hash); this.bytes -= entry.bytes; }
    }
  }
}
