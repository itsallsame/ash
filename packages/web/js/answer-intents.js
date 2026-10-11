/** Unknown answer receipts retain their client id and choice; admission stops before this finite map can grow. */
export class AnswerIntents extends Map {
  constructor(limit = 200) { super(); this.limit = limit; }
  set(id, intent) {
    if (!this.has(id) && this.size >= this.limit) {
      for (const [key, prior] of this) if (!prior.choice) { this.delete(key); break; }
      if (this.size >= this.limit) throw new Error("还有一些回答没确认送到，请先确认已有的回答，再答新问题。");
    }
    return super.set(id, intent);
  }
  prune(active) {
    for (const [id, intent] of this) if (!active.has(id) && !["pending", "uncertain"].includes(intent.status)) this.delete(id);
  }
}
