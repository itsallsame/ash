/** Carry-over (SPEC-01 §6.6): 「这次可以」 covers the same request again for five minutes. Memory only: a restart forgets it. */
export const CARRY_MS = 5 * 60_000;

export class Carry {
  private readonly until = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly ms = CARRY_MS) {}
  remember(key: string): void {
    const t = this.now();
    for (const [k, until] of this.until) if (until <= t) this.until.delete(k);
    this.until.set(key, t + this.ms);
  }
  has(key: string): boolean { return (this.until.get(key) ?? 0) > this.now(); }
}
