import { initialView, projectRecords } from "../../sdk/src/conversation.ts";
import { ConversationStore } from "./conversation-store.js";

/** Hydrated history and finite current state; live facts never become a retained ledger replay. */
export class ConversationTimeline {
  constructor(net, onChange = () => {}) {
    this.net = net;
    this.onChange = onChange;
    this.store = new ConversationStore();
    this.reset();
  }
  reset() {
    this.epoch = (this.epoch ?? 0) + 1;
    this.pageAbort?.abort();
    clearTimeout(this.currentTimer);
    this.store.reset();
    this.current = null;
    this.ready = this.loading = false;
    this.targets = new Set();
    this.reloadNeeded = false;
    this.currentDirty = false;
    this.liveScheduled = false;
    this.liveSerial = (this.liveSerial ?? 0) + 1;
    this.unseen = 0;
    this.onChange(this.view, true);
  }
  get exhausted() { return !this.store.hasBefore; }
  get view() {
    const view = initialView();
    view.conversation = this.store.items.filter(item => item.type !== "failed");
    const lastOwner = [...view.conversation].reverse().find(item => item.side === "owner");
    view.failures = this.store.items.filter(item => item.type === "failed" && Date.now() - item.ts < 86400000 && !(lastOwner && lastOwner.ts > item.ts));
    view.presence = this.current?.presence ?? view.presence;
    const asks = new Map(this.store.items.filter(item => item.ask).map(item => [item.ask.id, item.ask]));
    for (const item of this.current?.items ?? []) if (item.ask) asks.set(item.ask.id, item.ask);
    view.asks = [...asks.values()];
    const progress = this.current?.progress;
    if (progress) view.turns = { [progress.id]: progress };
    return view;
  }
  historyReady() { this.ready = true; this.onChange(this.view, true); }
  acceptPage(page, direction = "replace") {
    if (this.store.dataset !== null && this.store.dataset !== page.dataset_id) this.reset();
    const dirty = this.store.apply(page, direction);
    if (direction === "replace") this.unseen = 0;
    this.onChange(this.view, true, dirty);
    return page.items.length;
  }
  acceptCurrent(current) {
    if (this.store.dataset !== null && this.store.dataset !== current.dataset_id) return;
    if (this.current?.dataset_id === current.dataset_id && this.current.snapshot_seq > current.snapshot_seq) return;
    if (this.current?.dataset_id === current.dataset_id && this.current.snapshot_seq === current.snapshot_seq && this.current.as_of > current.as_of) return;
    this.current = current;
    clearTimeout(this.currentTimer);
    if (Number.isFinite(current.next_change_at)) this.currentTimer = setTimeout(() => { this.currentDirty = true; this.scheduleLive(); }, Math.max(50, current.next_change_at - Date.now() + 50));
    this.onCurrent?.(current);
    this.onChange(this.view, false);
  }
  async read(params, direction) {
    if (this.loading) return 0;
    const epoch = this.epoch;
    const controller = this.pageAbort = new AbortController();
    this.loading = true;
    try {
      const page = await this.net.window(params, controller.signal);
      return epoch === this.epoch ? this.acceptPage(page, direction) : 0;
    } finally { if (epoch === this.epoch) this.loading = false; }
  }
  older() { return this.store.hasBefore && this.store.before && this.store.canPage("before") ? this.read({ before: this.store.before }, "before") : Promise.resolve(0); }
  newer() { return this.store.hasAfter && this.store.after && this.store.canPage("after") ? this.read({ after: this.store.after }, "after") : Promise.resolve(0); }
  locate(params) {
    this.epoch++;
    this.pageAbort?.abort();
    this.loading = false;
    return this.read(params, "replace");
  }
  latest() { return this.locate({}); }
  jump(id) { return this.locate({ around_id: id }); }
  get(id) { return this.store.get(id); }

  /** Simple insertions use one already-safe fact. Relations are hydrated by id, rather than replaying older events. */
  add(fact) {
    const visible = ["owner.say", "agent.say", "show", "ask", "app.card"].includes(fact.type);
    if (visible) {
      if (!this.store.hasAfter) {
        const item = projectRecords([fact]).conversation[0];
        if (item) this.onChange(this.viewAfter(item, fact.seq), true, new Set([item.id]));
      } else this.unseen++;
    }
    const targets = [fact.reply_to, fact.message_id, fact.in_reply_to, ...(fact.type === "turn.start" ? fact.ids ?? [] : [])];
    for (const id of targets) if (this.store.get(id)) this.queueTarget(id);
    if (fact.type === "turn.start" && !fact.ids?.length) {
      // The ids array can be a blob. Loaded owner rows are bounded; the server's relation index still knows every read id.
      for (const item of this.store.items) if (item.side === "owner" && item.delivery !== "read") this.queueTarget(item.id);
    }
    if (fact.type === "turn.end" && fact.outcome === "error" && !this.store.hasAfter) this.queueTarget(fact.turn);
    if (["ask", "ask.answer", "turn.start", "turn.end", "tool", "activity.request", "activity.response"].includes(fact.type)) this.currentDirty = true;
    this.scheduleLive();
  }
  viewAfter(item, revision) {
    this.store.update(item, revision, true);
    if (!this.store.get(item.id)) { this.store.hasAfter = true; this.unseen++; }
    return this.view;
  }
  queueTarget(id) {
    if (this.targets.size < this.store.maxItems) this.targets.add(id);
    else this.reloadNeeded = true;
  }
  scheduleLive() {
    if (this.liveScheduled || !this.targets.size && !this.currentDirty && !this.reloadNeeded) return;
    this.liveScheduled = true;
    const serial = ++this.liveSerial;
    setTimeout(() => { if (serial === this.liveSerial) void this.flushLive(serial); }, 0);
  }
  async flushLive(serial) {
    const epoch = this.epoch, binding = this.net.binding();
    const ids = [...this.targets].slice(0, 8);
    for (const id of ids) this.targets.delete(id);
    const refreshCurrent = this.currentDirty;
    this.currentDirty = false;
    const reload = this.reloadNeeded;
    this.reloadNeeded = false;
    const dirty = new Set();
    try {
      if (reload) {
        try {
          const page = await this.net.window(this.store.hasAfter && this.store.items[0] ? { around_id: this.store.items[0].id } : {});
          if (epoch === this.epoch && this.net.same(binding)) this.acceptPage(page);
        } catch { /* no retained replay grows while the connection is unavailable */ }
      }
      await Promise.all(ids.map(async id => {
        try {
          const page = await this.net.window({ around_id: id, limit: 1 });
          if (epoch !== this.epoch || !this.net.same(binding)) return;
          for (const item of page.items) for (const changed of this.store.update(item, page.snapshot_seq, item.type === "failed" && !this.store.hasAfter)) dirty.add(changed);
        } catch { /* the next authoritative snapshot can still confirm this item */ }
      }));
      if (refreshCurrent) {
        try {
          const current = await this.net.current();
          if (epoch === this.epoch && this.net.same(binding)) this.acceptCurrent(current);
        } catch { /* connection state tells the owner when the current picture cannot be refreshed */ }
      }
      if (dirty.size && epoch === this.epoch && this.net.same(binding)) this.onChange(this.view, true, dirty);
    } finally { if (serial === this.liveSerial) { this.liveScheduled = false; this.scheduleLive(); } }
  }
}
