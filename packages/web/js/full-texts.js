/** Text is cached by hash; expansion choices are a separate finite LRU of message ids. */
export class FullTexts {
  constructor({ maxBytes = 2 * 1024 * 1024, maxChoices = 400 } = {}) {
    this.maxBytes = maxBytes;
    this.maxChoices = maxChoices;
    this.reset();
  }
  reset() { this.values = new Map(); this.choices = new Map(); this.pending = new Map(); this.bytes = 0; this.generation = (this.generation ?? 0) + 1; }
  has(hash) { return this.values.has(hash); }
  get(hash) {
    const entry = this.values.get(hash);
    if (!entry) return undefined;
    this.values.delete(hash); this.values.set(hash, entry);
    return entry.text;
  }
  expanded(id) { return this.choices.has(id); }
  remember(id, hash) {
    this.choices.delete(id); this.choices.set(id, hash);
    while (this.choices.size > this.maxChoices) this.choices.delete(this.choices.keys().next().value);
  }
  async load(id, hash, read) {
    this.remember(id, hash);
    if (this.has(hash)) return this.values.get(hash);
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
    return this.pending.get(hash);
  }
  /** Mounted texts remain complete. At most one legitimate oversized text can occupy the whole cache. */
  retain(items) {
    const active = new Set(items.map(item => item.full).filter(Boolean));
    for (const [hash, entry] of this.values) {
      if (this.bytes <= this.maxBytes) break;
      if (!active.has(hash)) { this.values.delete(hash); this.bytes -= entry.bytes; }
    }
  }
}
