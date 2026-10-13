/** Restore previously expanded text after scrolling settles. At most one read/build owns this controller. */
export class IdleExpansion {
  constructor({ candidates, contains, near = () => true, restore, delay = 150, now = () => performance.now(), timer = (fn, ms) => setTimeout(fn, ms), clear = handle => clearTimeout(handle) }) {
    Object.assign(this, { candidates, contains, near, restore, delay, now, timer, clear });
    this.idleAt = now() + delay;
    this.active = null; this.attempts = new Map(); this.closed = false;
  }
  idle() { return !this.closed && this.now() >= this.idleAt; }
  scroll() {
    this.idleAt = this.now() + this.delay;
    if (this.active?.phase === "reading") this.active.controller.abort();
    this.wake();
  }
  wake() {
    if (this.closed) return;
    for (const id of this.attempts.keys()) if (!this.contains(id)) this.attempts.delete(id);
    if (this.active && (!this.contains(this.active.item.id) || !this.near(this.active.item.id))) this.active.controller.abort();
    this.clear(this.scheduled);
    this.scheduled = this.timer(() => { void this.run(); }, Math.max(0, this.idleAt - this.now()));
  }
  async run() {
    if (this.active) return;
    // A fractional timeout may fire just before idleAt; keep a wakeup until the quiet interval actually ends.
    if (!this.idle()) { this.wake(); return; }
    const item = this.candidates().find(item => this.attempts.get(item.id) !== item.full);
    if (!item) return;
    const active = this.active = { item, controller: new AbortController(), phase: "reading" };
    this.attempts.set(item.id, item.full);
    try {
      await this.restore(item, active.controller.signal, () => { active.phase = "building"; });
    } catch { /* manual expansion remains available after a failed automatic read */ }
    finally {
      if (active.controller.signal.aborted) this.attempts.delete(item.id);
      if (this.active === active) this.active = null;
      this.wake();
    }
  }
  cancel() { this.active?.controller.abort(); }
  reset() { this.cancel(); this.attempts.clear(); this.idleAt = this.now() + this.delay; }
  dispose() { this.closed = true; this.cancel(); this.clear(this.scheduled); this.attempts.clear(); }
}
