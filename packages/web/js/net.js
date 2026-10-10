// The page's side of the kernel: one connection (link.js), the ledger as the page reads it (`sync`), the owner's own
// messages (queued so that nothing typed is lost offline, sent with a stable `client_id`), and every word the sheets call.
import { openPort, retryable, unwrap, WordFailure } from "./link.js";
import { MAX_WIRE_BYTES, openPendingStore } from "./pending-store.js";

const AGENT = /^agent:[a-z][a-z0-9_-]{0,31}$/;
const PAGE = 200;
/** The longest the page waits for one page of history. */
const PAGE_WAIT_MS = 20_000;

export const OWNER = "person:owner";
const PRIMARY_KEY = "ash.primary";
const remembered = () => { try { const id = globalThis.localStorage?.getItem(PRIMARY_KEY); return AGENT.test(id ?? "") ? id : null; } catch { return null; } };

export class Net {
  /**
   * [bridge] is the app's AshNative bridge (absent in a browser). [pendingStore], [connector] and [clock] are for tests.
   * The callbacks: onMessage(message, {historical}), onHistory(messages), onHistoryReady(), onState(status, detail),
   * onOpen(info) after every (re)connection, onQueue(count, outbox), onPresent(frame) -> {ok, data?, error?}.
   */
  constructor({ bridge, label = "网页", pendingStore = null, url, connector, clock, random, onMessage = () => {}, onHistory = () => {},
    onHistoryReady = () => {}, onState = () => {}, onOpen = () => {}, onQueue = () => {}, onPresent = async () => ({ ok: false, error: { code: "unavailable", message: "not shown here" } }) } = {}) {
    this.onMessage = onMessage;
    this.onHistory = onHistory;
    this.onHistoryReady = onHistoryReady;
    this.onState = onState;
    this.onOpen = onOpen;
    this.onQueue = onQueue;
    this.onPresent = onPresent;
    this.status = "connecting";
    this.session = null;
    this.client = null;
    this.local = false;
    this.generation = 0;
    /** The hub names the primary agent (`service:agents/list`); until it has, the one it named last time; before that, none. */
    this.primary = remembered();
    this.primaryLoad = null;
    this.queue = [];
    this.outbox = [];
    this.seenLedgerIds = new Set();
    this.cursor = null;
    this.history = null;
    this.bootstrapped = false;
    this.tabOwner = crypto.randomUUID();
    this.flushing = false;
    this.visible = null;
    this.pendingReady = Promise.resolve(pendingStore ?? openPendingStore()).catch(() => null);
    this.port = openPort({
      state: (state, info) => this.portState(state, info),
      present: (frame) => this.present(frame),
      log: () => {},
    }, { bridge, label, url, connector, clock, random });
    this.embedded = this.port.native === true;
  }

  // ---- the connection ----

  start() { this.port.start(); }

  stop() {
    this.history?.close();
    this.history = null;
    clearTimeout(this.retryTimer);
    this.port.stop();
    this.queue = [];
    this.outbox = [];
    this.publishOutbox();
  }

  reconnect() { if (this.status !== "online") this.port.reconnect(); }

  /** A fixed picture of which connection this is; it stops matching when the connection changes. */
  binding() { return { session: this.session, generation: this.generation }; }
  same(binding) { return Boolean(binding?.session) && binding.session === this.session && binding.generation === this.generation; }

  setStatus(status, detail) {
    this.status = status;
    this.onState(status, detail);
  }

  portState(state, info) {
    if (state === "online") {
      this.session = info.session;
      this.client = info.client;
      this.local = info.local === true;
      this.generation++;
        this.visible = null; // the kernel forgets what a connection said about itself when it ends
      this.setStatus("online");
      this.onOpen(info);
      this.openHistory();
      void this.refreshPrimary();
      void this.restorePending().then(() => this.flush());
      return;
    }
    this.history = null;
    this.session = null;
    this.client = null;
    this.local = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    if (state === "closed") this.setStatus("closed", info?.denied);
    else this.setStatus(state === "connecting" ? "connecting" : "offline");
  }

  refreshPrimary() {
    const binding = this.binding();
    this.primaryLoad = (async () => {
      try {
        const { agents } = unwrap(await this.call("service:agents", "list"));
        const primary = agents?.find((agent) => agent.primary === true);
        if (primary && this.same(binding)) {
          this.primary = primary.id;
          try { globalThis.localStorage?.setItem(PRIMARY_KEY, primary.id); } catch { /* not remembered */ }
        }
      } catch { /* what we had stands */ }
    })();
    return this.primaryLoad;
  }

  // ---- words ----

  /** Calls a word as the owner and waits for its `Reply` (an error is a reply, not an exception). */
  call(to, word, body = {}, options) { return this.port.call(to, word, body, options); }
  /** Calls a word and returns its data; a failed word throws [WordFailure]. */
  async data(to, word, body = {}, options) { return unwrap(await this.call(to, word, body, options)); }
  /** The bytes a `resource` part of a result stands for. */
  stream(sid) { return this.port.stream(sid); }

  /** The bytes of a long attachment of the ledger (`service:blobs/get`). */
  async readBlob(hash) {
    const info = await this.data("service:blobs", "get", { hash });
    return this.stream(info.stream);
  }

  /** The text of a long field of the ledger, in full (`service:blobs/read`, in pieces). */
  async readBlobText(hash) {
    let text = "";
    let offset = 0;
    for (let pieces = 0; pieces < 200; pieces++) {
      const piece = await this.data("service:blobs", "read", { hash, offset });
      text += piece.text;
      if (piece.next_offset === null || piece.next_offset === undefined) return text;
      offset = piece.next_offset;
    }
    throw new WordFailure({ code: "too_large", message: "文本太长" });
  }

  // ---- presence ----

  /** Whether this tab is in view. The app's native layer reports this itself, so there the page says nothing. */
  setVisible(visible) {
    if (this.embedded || this.visible === visible) return;
    this.visible = visible;
    this.port.presence({ visible });
  }

  /** The owner is (or stopped) typing to [agent]. */
  setTyping(typing, agent = this.primary) { if (agent) this.port.presence({ typing, agent }); }

  // ---- history ----

  openHistory() {
    this.history?.close();
    const params = this.cursor === null ? { limit: PAGE } : { after: this.cursor, limit: 1000 };
    this.history = this.port.sync({ ...params, follow: true, summary: true }, {
      page: (frame) => {
        const messages = frame.messages.filter((m) => this.accept(m));
        if (messages.length) this.onHistory(messages);
        if (frame.end) {
          if (!this.bootstrapped) this.onHistoryReady();
          this.bootstrapped = true;
          if (this.cursor === null) this.cursor = 0;
        }
      },
      message: (frame) => { if (this.accept(frame.message)) this.onMessage(frame.message, { historical: false }); },
      error: () => {},
    });
  }

  /** Notes a ledger row (cursor, outbox); false for a row the page cannot use or already has. */
  accept(message) {
    if (!Number.isSafeInteger(message?.seq) || message.seq < 1 || typeof message.id !== "string") return false;
    if (this.cursor !== null && message.seq <= this.cursor && this.seenLedgerIds.has(message.id)) return false;
    this.cursor = Math.max(this.cursor ?? 0, message.seq);
    this.seenLedgerIds.add(message.id);
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((item) => item.id !== message.id);
    if (this.outbox.length !== before) this.publishOutbox();
    void this.pendingReady.then((store) => store?.removeAccepted(message.id)).catch(() => {});
    return true;
  }

  /** One page of older history: the messages before seq [before], newest [PAGE] of them. */
  async page(before, signal) {
    if (!Number.isSafeInteger(before) || before < 1) throw new Error("invalid page cursor");
    const messages = await this.collect({ before, limit: PAGE, summary: true }, signal);
    messages.sort((a, b) => a.seq - b.seq);
    return { messages: messages.filter((item, index) => index === 0 || item.seq !== messages[index - 1].seq), end: { has_more: messages.length >= PAGE } };
  }

  /** A one-time sync (no follow): every page of its answer. */
  collect(params, signal) {
    return new Promise((resolve, reject) => {
      const messages = [];
      let handle = null;
      const finish = (error) => {
        clearTimeout(timer);
        handle?.close();
        if (error) reject(error); else resolve(messages);
      };
      const timer = setTimeout(() => finish(new Error("history timed out")), PAGE_WAIT_MS);
      signal?.addEventListener("abort", () => finish(new DOMException("Aborted", "AbortError")), { once: true });
      handle = this.port.sync(params, {
        page: (frame) => { messages.push(...frame.messages); if (frame.end) finish(); },
        message: () => {},
        error: (error) => finish(new Error(error?.message || "history unavailable")),
      });
      if (!handle) finish(new Error("not connected"));
    });
  }

  // ---- the owner's own messages ----

  publishOutbox() {
    this.onQueue(this.queue.length, this.outbox.map((item) => ({ ...item })));
  }

  async restorePending() {
    const store = await this.pendingReady;
    if (!store) { this.onState("send-error", new Error("pending storage unavailable")); return; }
    const items = (await store.list()).filter((item) => {
      if (!item.id || !this.seenLedgerIds.has(item.id)) return true;
      void store.removeAccepted(item.id).catch(() => {});
      return false;
    });
    this.queue = items.filter((item) => item.wire && !item.id).map((item) => item.wire);
    this.outbox = items.map((item) => ({ client_id: item.client_id, text: item.text, attachments: item.attachments,
      in_reply_to: item.wire?.body?.in_reply_to, option_id: item.wire?.body?.option_id,
      status: item.status === "sending" && item.leaseUntil <= Date.now() ? "unsent" : item.status, id: item.id, seq: item.seq }));
    this.publishOutbox();
  }

  setOutbox(clientId, patch) {
    const item = this.outbox.find((entry) => entry.client_id === clientId);
    if (!item) return;
    Object.assign(item, patch);
    this.publishOutbox();
  }

  /** Keeps what the owner typed, then sends it as soon as there is a connection. Returns the message's `client_id`. */
  async enqueueSay(text, attachments = [], option = null, target = null) {
    if (!target && !this.primary) await this.primaryLoad;
    target ??= this.primary;
    if (!target) throw new Error("还不知道该对谁说话；连上后再试");
    const store = await this.pendingReady;
    if (!store) throw new Error("pending storage unavailable");
    if (typeof text !== "string" || (!text.trim() && !attachments.length)) throw new Error("empty message");
    if (option && (typeof option.in_reply_to !== "string" || !option.in_reply_to || typeof option.option_id !== "string" || !option.option_id || attachments.length))
      throw new Error("invalid option reply");
    if (!AGENT.test(target)) throw new Error("invalid agent target");
    const body = { text, ...(attachments.length ? { attachments } : {}), ...(option ? { in_reply_to: option.in_reply_to, option_id: option.option_id } : {}) };
    const message = { to: target, kind: "request", word: "say", body, client_id: crypto.randomUUID() };
    await store.enqueue(message);
    await this.restorePending();
    void this.flush();
    return message.client_id;
  }

  /** The owner answers a question (`ask`) from the card. The kernel records the answer; the first answer counts. */
  async answerAsk(ask, { choice, text }, clientId) {
    const result = await this.port.send({ to: ask.from, kind: "response", word: "ask", reply_to: ask.id,
      body: { ok: true, result: { data: { choice, ...(text ? { text } : {}) } } }, client_id: clientId });
    return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
  }

  async flush() {
    if (this.flushing || this.status !== "online") return;
    this.flushing = true;
    const binding = this.binding();
    const retry = (ms) => {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (this.same(binding)) void this.restorePending().then(() => this.flush()).catch(() => this.onState("send-error", new Error("pending storage unavailable")));
      }, Math.max(100, ms));
      this.retryTimer.unref?.();
    };
    try {
      const store = await this.pendingReady;
      if (!store) { this.onState("send-error", new Error("pending storage unavailable")); return; }
      while (this.same(binding)) {
        const queued = await store.claim(this.tabOwner);
        if (!queued) break;
        if (queued.blockedUntil) { retry(queued.blockedUntil - Date.now() + 20); break; }
        this.setOutbox(queued.client_id, { status: "sending" });
        const leaseTimer = setInterval(() => { void store.renew(queued, this.tabOwner).catch(() => {}); }, 10_000);
        let result;
        try { result = await this.port.send(queued.wire); }
        finally { clearInterval(leaseTimer); }
        if (!result.ok) {
          // Not taken: wait for the connection when it was only lost, otherwise the kernel said no.
          const lost = retryable(result.error);
          const status = lost ? "unsent" : "rejected";
          await store.release(queued, this.tabOwner, status);
          this.setOutbox(queued.client_id, { status });
          this.onState(lost ? "offline" : "send-error", new Error(result.error?.message || "send failed"));
          if (lost) retry(5_000);
          break;
        }
        if (typeof result.message?.id !== "string" || !Number.isSafeInteger(result.message.seq) || result.message.seq < 1) {
          await store.release(queued, this.tabOwner, "unsent");
          this.setOutbox(queued.client_id, { status: "unsent" });
          this.onState("send-error", new Error("send acknowledgement invalid"));
          retry(5_000);
          break;
        }
        await store.accept(queued, this.tabOwner, result.message.id, result.message.seq);
        if (this.seenLedgerIds.has(result.message.id)) await store.removeAccepted(result.message.id);
        await this.restorePending();
      }
    } catch { this.onState("send-error", new Error("pending storage unavailable")); }
    finally {
      this.flushing = false;
      if (this.session && !this.same(binding)) queueMicrotask(() => { void this.flush(); });
    }
  }

  // ---- what the kernel presents on the chat surface ----

  async present(frame) {
    if (frame.surface !== "chat") return { ok: false, error: { code: "unavailable", message: `${frame.surface} is not shown on this page` } };
    if (frame.op === "focus") { globalThis.focus?.(); return { ok: true, data: {} }; }
    if (frame.op !== "open") return { ok: false, error: { code: "unavailable", message: `chat ${frame.op} is not shown on this page` } };
    // The body is `{target, id?, mode?}` (SPEC-03 §5.4).
    const { target, id, mode } = frame.body;
    if (typeof target !== "string") return { ok: false, error: { code: "bad_request", message: "no target" } };
    return this.onPresent({ target, ...(id !== undefined ? { id } : {}), ...(mode !== undefined ? { mode } : {}) });
  }
}

export { MAX_WIRE_BYTES };
