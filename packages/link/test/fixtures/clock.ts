import type { Clock } from "../../src/clock";

/** A clock that only moves when the test says so: `advance(ms)` runs every timer that falls due, in order. */
export class FakeClock implements Clock {
  private time = 1_760_000_000_000;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  now(): number { return this.time; }
  setTimer(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
    return id;
  }
  clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
  get pending(): number { return this.timers.size; }
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].fn();
    }
    this.time = target;
  }
}
