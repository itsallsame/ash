import { drawsConversation, fold, foldMany, initialView, OWNER } from "./project.js";
import { Net } from "./net.js";
import { WindowView, changedIds } from "./window-view.js";
import { renderProgress } from "./progress.js";
import { presentUiOpen } from "./suggestions.js";
import { composerContext } from "./composer.js";
import { openInlineBlob, prepareUploads } from "./attachments.js";
import { addPicked, attachMenu } from "./attach-menu.js";
import { PresenceBar } from "./presence.js";
import { answerGateAsk } from "./approvals.js";
import { IdentityName } from "./identity-name.js";
import { Files } from "./files.js";
import { framePainter } from "./frame-painter.js";
import { agentPicker } from "./agent-picker.js";
import { addIcon, avatarUrl } from "./chat-ui.js";

/** The pages of her home that the kernel (or the agent) can ask this page to open, by the name it uses; others are aliases. */
const HOME_SECTIONS = new Set(["waiting", "upcoming", "memory", "promises", "hands", "backstage", "identity", "files", "activity",
  "settled", "device", "connect", "browser", "apps", "app", "keys", "model", "usage", "advanced"]);
const TARGET_SECTION = Object.freeze({ approvals: "waiting", turn: "activity" });

export class Timeline {
  constructor(net, onChange = () => {}) {
    this.net = net;
    this.onChange = onChange;
    this.reset();
  }
  reset() {
    this.epoch = (this.epoch ?? 0) + 1;
    this.pageAbort?.abort();
    this.records = new Map();
    this.byId = new Map();
    this.view = initialView();
    this.loading = false;
    this.exhausted = false;
    this.ready = false;
    this.onChange(this.view, true);
  }
  /** The first history page has been applied; an empty conversation is now genuinely empty. */
  historyReady() {
    if (this.ready) return;
    this.ready = true;
    this.onChange(this.view, true);
  }
  add(message) {
    if (!Number.isSafeInteger(message?.seq) || message.seq < 1 || typeof message.id !== "string") return;
    if (this.records.has(message.seq)) return;
    this.records.set(message.seq, message);
    this.byId.set(message.id, message);
    this.view = fold(this.view, message);
    this.onChange(this.view, drawsConversation(message) || message.word === "turn.ended" && message.body?.outcome === "error", changedIds([message]));
  }
  addMany(messages) {
    const accepted = [];
    let conversation = false;
    for (const message of messages.sort((a, b) => a.seq - b.seq)) {
      if (!Number.isSafeInteger(message?.seq) || message.seq < 1 || typeof message.id !== "string" || this.records.has(message.seq)) continue;
      this.records.set(message.seq, message);
      this.byId.set(message.id, message);
      accepted.push(message);
      if (!conversation && (drawsConversation(message) || message.word === "turn.ended" && message.body?.outcome === "error")) conversation = true;
    }
    if (accepted.length) {
      this.view = foldMany(this.view, accepted);
      this.onChange(this.view, conversation, changedIds(accepted));
    }

  }
  async older() {
    if (this.loading || this.exhausted || !this.records.size) return 0;
    const before = Math.min(...this.records.keys());
    const epoch = this.epoch;
    const controller = new AbortController();
    this.pageAbort = controller;
    this.loading = true;
    try {
      const page = await this.net.page(before, controller.signal);
      if (epoch !== this.epoch) return 0;
      if (!page.end?.has_more) this.exhausted = true;
      this.addMany(page.messages);
      if (this.exhausted && !page.messages.length) this.onChange(this.view, true);
      return page.messages.length;
    } finally {
      if (epoch === this.epoch) this.loading = false;
    }
  }

  /** The attachment [index] of a message of the owner's conversation: its bytes in the row, or the blob that holds them. */
  inlineAttachment(messageId, index) {
    const message = this.byId.get(messageId);
    const agent = /^agent:[a-z][a-z0-9_-]*$/;
    if (!message || message.kind !== "request" || message.word !== "say" || !((message.from === OWNER && agent.test(message.to)) || (message.to === OWNER && agent.test(message.from))) || !Number.isSafeInteger(index) || index < 0) return null;
    const item = message.body?.attachments?.[index];
    if (!item || typeof item.name !== "string" || typeof item.mime_type !== "string") return null;
    if (typeof item.data === "string") return { item };
    return typeof item.data?.$blob === "string" ? { blob: item.data.$blob, name: item.name, mime_type: item.mime_type } : null;
  }
}

function text(parent, tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
}

/** Turns of the front lane that ended in an error in the last day and were not followed by anything the owner said: each gets a card. */
export function failedTurns(view, now = Date.now()) {
  const ownerBefore = (at, anyTime = false) => {
    for (let index = view.conversation.length - 1; index >= 0; index--) { const item = view.conversation[index];
      if (item.type === "say" && item.side === "owner" && (anyTime || item.ts <= at)) return item;
    }
    return null;
  };
  const last = ownerBefore(undefined, true);
  // A failure from yesterday is history, not something to retry.
  return Object.entries(view.turns ?? {})
    .filter(([, turn]) => turn.background !== true && turn.outcome === "error" && Number.isFinite(turn.ended) && now - turn.ended < 86_400_000 && !(last && last.ts > turn.ended))
    .map(([turn, info]) => {
      // What to say again: the owner's last words before the turn began, when they were plain text.
      const said = ownerBefore(info.started);
      return { turn, ts: info.ended, retry: said && !said.full && said.text && !(said.attachments?.length) ? { text: said.text, to: said.to } : null };
    });
}

const views = new WeakMap();
const conversationView = log => {
  let view = views.get(log);
  if (!view || view.closed) { view = new WindowView(log); views.set(log, view); }
  return view;
};

export function render(view, outbox = [], openInline, presenceBar, cardActions, dirty = null) {
  const log = document.querySelector("#log");
  const loading = cardActions?.loading?.() === true;
  conversationView(log).update(view.conversation, outbox, { openInline, ...cardActions, loading,
    failures: loading ? [] : failedTurns(view), atStart: cardActions?.atStart?.() === true,
    herName: cardActions?.herName?.() ?? "Ash", epoch: cardActions?.epoch?.() }, dirty);
  presenceBar?.render(loading ? { state: "unknown" } : view.presence);
}

export function boot({ bridge } = {}) {
  performance.mark("shell.boot");
  const form = document.querySelector("#f");
  const input = document.querySelector("#t");
  let identityName;
  const presenceBar = new PresenceBar(document, { onOpen: () => openHome({ agent: recipient?.picked() }) });
  const connection = document.querySelector("#connection");
  const progressRoot = document.querySelector("#progress");
  const log = document.querySelector("#log");
  const suggestions = document.querySelector("#suggestions");
  const contextRoot = document.querySelector("#context");
  const context = composerContext(contextRoot, input);
  const fileInput = document.querySelector("#file");
  const attachButton = document.querySelector("#attach");
  const selected = document.querySelector("#selected");
  const sendButton = document.querySelector("#send");
  const appsButton = document.querySelector("#apps");
  addIcon(appsButton, "grid");
  addIcon(attachButton, "plus");
  addIcon(sendButton, "up");
  addIcon(document.querySelector("#netBannerIcon"), "wifioff", "i-s");
  /** Files chosen so far (photos, videos, files), sent with the next message. */
  let picked = [];
  /** The send button is the coral one only when there is something to send. */
  const sendable = () => { sendButton.classList.toggle("idle", !input.value.trim() && !picked.length); };
  const showPicked = () => {
    selected.replaceChildren();
    selected.hidden = !picked.length;
    sendable();
    if (!picked.length) return;
    const chip = document.createElement("span");
    chip.className = "ctx";
    chip.title = picked.map((file) => file.name).join("、").slice(0, 200);
    chip.append(`${picked.length} 个附件`);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "chip-clear";
    clear.setAttribute("aria-label", "移除附件");
    addIcon(clear, "x", "i-xs");
    clear.addEventListener("click", () => { picked = []; showPicked(); });
    chip.append(clear);
    selected.append(chip);
  };
  let timeline;
  let recipient;
  let files;
  /** Ask for her home, or for the apps page (`page: "apps"`): whoever owns that page answers the event. */
  const openHome = ({ page = "home", agent, section } = {}) => window.dispatchEvent(new CustomEvent("ash:open",
    { cancelable: true, detail: { page, ...(agent ? { agent } : {}), ...(section ? { section } : {}) } }));
  const askIntents = new Map();
  const optionPending = new Set();
  /** Long texts read from the ledger on demand, by blob hash. */
  const fullTexts = new Map();
  const redraw = () => { if (timeline) paintView(timeline.view, true); };
  const cardActions = {
    agentName: id => recipient?.name(id) ?? id.replace(/^agent:/, ""),
    get primary() { return net.primary; },
    loading: () => !timeline?.ready,
    epoch: () => timeline?.epoch,
    atStart: () => timeline?.exhausted === true,
    herName: () => presenceBar.title.textContent || "Ash",
    onRetry: async (failure) => {
      await net.enqueueSay(failure.retry.text, [], null, failure.retry.to ?? recipient.target());
      conversationView(log).position.latest();
    },
    onOpenFile: (ref) => files.open(ref),
    onFileLink: (href) => files.openLink(href),
    fullTexts,
    onExpand: async (hash) => { fullTexts.set(hash, await net.readBlobText(hash)); redraw(); },
    optionPending,
    askIntents,
    onPermission: /\bAshApp\//.test(navigator.userAgent) ? (permission) => {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(permission)) return;
      location.href = `ash://permission/${permission}`;
    } : undefined,
    onSelect: async (item, option) => {
      if (item.locked || optionPending.has(item.id)) return;
      optionPending.add(item.id);
      try { await net.enqueueSay(option.text, [], { in_reply_to: item.id, option_id: option.id }); }
      catch (error) { optionPending.delete(item.id); throw error; }
    },
    onAnswerAsk: async (ask, choice, answerText) => {
      const fresh = timeline.view.asks.find((item) => item.id === ask.id);
      if (!fresh || fresh.seq !== ask.seq || fresh.state !== "pending") throw new Error("这个问题已经过期，不用再回答了。");
      let intent = askIntents.get(ask.id);
      if (intent?.choice && (intent.choice !== choice || intent.answerText !== answerText || intent.status === "pending" || intent.status === "confirmed" || intent.status === "rejected")) return;
      if (!intent?.choice) { intent = { choice, answerText, customDraft: intent?.customDraft, clientId: crypto.randomUUID(), status: "pending" }; askIntents.set(ask.id, intent); }
      else intent.status = "pending";
      const binding = net.binding();
      try {
        if (!net.same(binding)) throw new Error("连接刚换过，回答没有送出，请再点一次。");
        await answerAsk(net, fresh, choice, intent.clientId, { answerText });
        intent.status = "confirmed";
      } catch (error) {
        intent.status = /无权|被拒绝|已失效|不可用|已经过期|没有这个选项|没被接受/.test(error?.message || "") ? "rejected" : "uncertain";
        presenceBar.problem(error instanceof Error ? error.message : "回答有没有送到还不知道，请再点一次。");
      }
      redraw();
    },
  };
  const clearContext = context.clear;
  const progress = () => renderProgress(progressRoot, timeline?.view, { onOpen: () => { openHome({ section: "activity" }); } });
  /** The kernel (or the agent) asks the page to open a page: her home or one of its pages, a file... */
  const openUiTarget = async (target, request = {}) => {
    if (!net.session) return false;
    if (target === "file") {
      if (typeof request.id !== "string" || !request.id) return false;
      void files.open({ workspace: "main", path: request.id });
      return true;
    }
    const section = TARGET_SECTION[target] ?? (HOME_SECTIONS.has(target) ? target : undefined);
    if (target !== "settings" && !section) return false;
    // The answer is whether the home page took the event.
    return !openHome({ section });
  };
  const openInline = async (messageId, index) => {
    const ref = timeline.inlineAttachment(messageId, index);
    if (!ref) return null;
    if (ref.item) return openInlineBlob(ref.item);
    // A large attachment is held as a blob whose text is the file's base64.
    const { data } = await net.readBlob(ref.blob);
    return openInlineBlob({ name: ref.name, mime_type: ref.mime_type, data: new TextDecoder().decode(data) });
  };
  const net = new Net({
    bridge,
    label: sessionStorage.getItem("ash.web.label")?.trim().slice(0, 80) || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? "手机浏览器" : "电脑浏览器"),
    onMessage: (message) => { timeline.add(message); },
    onHistory: (messages) => { timeline.addMany(messages); performance.mark("shell.history-rendered"); },
    onHistoryReady: () => { timeline.historyReady(); },
    onPresent: async (request) => {
      const opened = await presentUiOpen(suggestions, request, openUiTarget).catch(() => false);
      return { ok: true, data: { opened } };
    },
    onState: (status, detail) => {
      if (status !== "online") identityName?.reset();
      presenceBar.network(status, status === "closed" ? detail : "");
      if (status === "send-error" && detail) connection.title = String(detail.message || detail);
      if (status === "online" || status === "connecting") sendable();
    },
    onOpen: () => {
      void identityName?.refresh();
      void recipient?.refresh();
      net.setVisible(!document.hidden);
    },
    onQueue: (count, outbox) => {
      for (const item of outbox) if (item.in_reply_to && item.status === "rejected") optionPending.delete(item.in_reply_to);
      for (const item of outbox) if (item.in_reply_to && item.status !== "rejected") optionPending.add(item.in_reply_to);
      if (timeline) paintView(timeline.view, true, new Set(outbox.map(item => item.in_reply_to).filter(Boolean)));
    },
  });
  files = new Files(net, { save: net.embedded ? (file) => globalThis.__ashFileSave(file) : null });
  // Pages are counted in ledger records, and a page of background events can hold no conversation at all. Older pages
  // otherwise load only by scrolling to the top, which a short page cannot do: keep reading back until the conversation
  // fills the screen or the history ends.
  let filling = false;
  const fillScreen = async () => {
    if (filling || !timeline) return;
    filling = true;
    try {
      const log = document.querySelector("#log");
      for (let pages = 0; pages < 20 && !timeline.exhausted && log && log.scrollHeight <= log.clientHeight + 80; pages++) {
        if (!await timeline.older()) break;
      }
    } catch { /* the scroll handler can still load older pages */ }
    finally { filling = false; }
  };
  const paintView = framePainter((view, conversation, dirty) => {
    if (conversation) render(view, net.outbox, openInline, presenceBar, cardActions, dirty);
    else presenceBar?.render(timeline?.ready ? view.presence : { state: "unknown" });
    progress();
    setTimeout(fillScreen, 0);
  });
  timeline = new Timeline(net, paintView);
  identityName = new IdentityName(net, (name) => {
    presenceBar.setName(name);
  });
  // Her home puts words in the box with `ash:compose` ({text, turn?}); with a turn they come as a question about that turn.
  window.addEventListener("ash:compose", (event) => {
    const { text: words, turn } = event.detail ?? {};
    if (typeof words !== "string" || event.defaultPrevented) return;
    event.preventDefault();
    if (typeof turn === "string" && turn) context.askAbout({ turn, text: words });
    else { clearContext(); input.value = words; input.focus(); }
    sendable();
  });

  // The owner is typing to an agent: said while there is text, every few seconds, and unsaid when it is sent or cleared.
  let lastTyping = 0;
  let typingTo = null;
  function typing() {
    if (document.hidden || !input.value.trim()) { stopTyping(); return; }
    const now = Date.now();
    if (typingTo && now - lastTyping < 3000) return;
    lastTyping = now;
    typingTo = recipient.target();
    net.setTyping(true, typingTo);
  }
  function stopTyping() {
    if (!typingTo) return;
    net.setTyping(false, typingTo);
    typingTo = null;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    const files = addPicked(picked, fileInput.files);
    if (!value && !files.length) return;
    sendButton.disabled = true;
    try {
      const attachments = await prepareUploads(files, value);
      await net.enqueueSay(value, attachments, null, recipient.target());
      input.value = "";
      input.style.height = "";
      stopTyping();
      clearContext();
      fileInput.value = "";
      picked = [];
      showPicked();
      conversationView(log).position.latest();
    } catch (error) { presenceBar.problem(`没发出去：${error.message || "这台设备存不下待发送的消息"}`); }
    finally { sendButton.disabled = false; sendable(); }
  });
  input.addEventListener("input", typing);
  input.addEventListener("input", sendable);
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`; });
  recipient = agentPicker(form, input, net, redraw, { field: document.querySelector("#field") });
  document.addEventListener("visibilitychange", () => {
    net.setVisible(!document.hidden);
    if (!document.hidden) typing(); else stopTyping();
  });
  const typingTimer = setInterval(() => { if (!document.hidden && typingTo) typing(); }, 3_000);
  const progressTimer = setInterval(() => {
    if (document.hidden) return;
    if (!progressRoot.hidden) progress();
    if (timeline.view.asks.some((ask) => ask.state === "pending" && ask.expires_at <= Date.now())) redraw();
  }, 1_000);
  log.addEventListener("scroll", async () => {
    if (log.scrollTop > 80 || timeline.loading) return;
    try { await timeline.older(); }
    catch { presenceBar.problem("更早的对话暂时加载不出来，稍后再往上翻一次。"); }
  });
  attachMenu(document.querySelector("#attachMenu"), attachButton, fileInput);
  fileInput.addEventListener("change", () => {
    picked = addPicked(picked, fileInput.files);
    fileInput.value = "";
    showPicked();
  });
  // The apps page is native in the app; in a browser the home page's apps are the stand-in.
  appsButton.addEventListener("click", () => {
    if (typeof globalThis.__ashOpenNative === "function") globalThis.__ashOpenNative("apps");
    else openHome({ page: "apps" });
  });
  window.addEventListener("pagehide", () => { clearInterval(progressTimer); clearInterval(typingTimer); views.get(log)?.dispose(); net.stop(); });
  window.addEventListener("online", () => net.reconnect());
  window.addEventListener("pageshow", (event) => { if (event.persisted) net.start(); });
  net.start();
  return { net, timeline };
}

/**
 * The owner answers a question card. Approval cards (from the gate) are checked as approvals; any other question is answered
 * with one of its options, or with free text when the card allows it.
 */
async function answerAsk(net, ask, choice, clientId, { answerText } = {}) {
  if (ask.from === "service:gate") return answerGateAsk(net, ask, choice, clientId, { answerText });
  const custom = ask.allow_custom && choice === "custom" && typeof answerText === "string" && answerText.trim();
  if (!custom && !ask.options.some((option) => option.id === choice)) throw new Error("这个问题已经过期，或没有这个选项。");
  const result = await net.answerAsk(ask, { choice: custom ? "custom" : choice, ...(custom ? { text: answerText } : {}) }, clientId);
  if (result.ok) return result.message;
  throw new Error(["offline", "unavailable", "timeout", "result_unknown", "internal"].includes(result.error.code)
    ? "回答有没有送到还不知道，请再点一次同一个选项。" : "回答没被接受，这个问题可能已经过期。");
}

// In the app the page waits for the native bridge; in a browser it opens its own connection.
if (typeof document !== "undefined") {
  if (globalThis.location?.origin === "https://appassets.androidplatform.net") globalThis.__ashNativeBoot = (bridge) => boot({ bridge });
  else boot();
}
