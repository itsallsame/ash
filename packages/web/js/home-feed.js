import { AnswerIntents } from "./answer-intents.js";
/** The home's finite current picture. Activity and older waiting items are read by their own pages. */
export class HomeFeed {
  constructor() { this.listeners = new Set(); this.intents = new AnswerIntents(); this.reset(); }
  reset() {
    this.current = null;
    this.cached = { conversation: [], asks: [], turns: {}, presence: { state: "idle", text: "", avatar: "default" } };
    this.changed();
  }
  setCurrent(current) {
    if (this.dataset !== undefined && this.dataset !== current.dataset_id) this.intents.clear();
    this.dataset = current.dataset_id;
    if (this.current?.dataset_id === current.dataset_id && this.current.snapshot_seq > current.snapshot_seq) return;
    if (this.current?.dataset_id === current.dataset_id && this.current.snapshot_seq === current.snapshot_seq && this.current.as_of > current.as_of) return;
    this.current = current;
    this.cached = { conversation: [], asks: current.items.filter(item => item.ask).map(item => item.ask),
      turns: current.progress ? { [current.progress.id]: current.progress } : {}, presence: current.presence,
      waiting_count: current.total_count, today_count: current.today_count, today_by_agent: current.today_by_agent };
    this.changed();
  }
  changed() {
    if (this.queued || !this.listeners.size) return;
    this.queued = true;
    setTimeout(() => { this.queued = false; for (const listener of this.listeners) listener(); }, 120);
  }
  view() { return this.cached; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
