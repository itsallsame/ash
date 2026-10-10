import { drawsConversation, fold, initialView, OWNER } from "./project.js";
import { Net } from "./net.js";
import { appendConversation, appendOutbox } from "./conversation.js";
import { renderProgress } from "./progress.js";
import { presentUiOpen } from "./suggestions.js";
import { composerContext } from "./composer.js";
import { openInlineBlob, prepareUploads } from "./attachments.js";
import { addPicked, attachMenu } from "./attach-menu.js";
import { SettingsControls } from "./settings.js";
import { PresenceBar } from "./presence.js";
import { AgentSheet } from "./sheet-agent.js";
import { answerGateAsk } from "./sheet-approvals.js";
import { IdentityName } from "./identity-name.js";
import { Files } from "./files.js";
import { framePainter } from "./frame-painter.js";
import { agentPicker } from "./agent-picker.js";

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
    this.onChange(this.view, drawsConversation(message));
  }
  addMany(messages) {
    let changed = false;
    let conversation = false;
    for (const message of messages.sort((a, b) => a.seq - b.seq)) {
      if (!Number.isSafeInteger(message?.seq) || message.seq < 1 || typeof message.id !== "string" || this.records.has(message.seq)) continue;
      this.records.set(message.seq, message);
      this.byId.set(message.id, message);
      this.view = fold(this.view, message);
      changed = true;
      if (!conversation && drawsConversation(message)) conversation = true;
    }
    if (changed) this.onChange(this.view, conversation);
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

export function render(view, outbox = [], openInline, presenceBar, cardActions) {
  const log = document.querySelector("#log");
  const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const oldHeight = log.scrollHeight;
  const oldTop = log.scrollTop;
  const fragment = document.createDocumentFragment();
  appendConversation(fragment, view.conversation, { openInline, ...cardActions, loading: cardActions?.loading?.() === true });
  appendOutbox(fragment, outbox);
  log.replaceChildren(fragment);
  if (nearEnd) log.scrollTop = log.scrollHeight;
  else log.scrollTop = oldTop + Math.max(0, log.scrollHeight - oldHeight);
  presenceBar?.render(cardActions?.loading?.() === true ? { state: "unknown" } : view.presence);
}

export function boot({ bridge } = {}) {
  performance.mark("shell.boot");
  const form = document.querySelector("#f");
  const input = document.querySelector("#t");
  let agentSheet;
  let identityName;
  const presenceBar = new PresenceBar(document, { onOpen: () => {
    document.querySelector("#drawer").classList.remove("open");
    agentSheet?.open();
  } });
  const connection = document.querySelector("#connection");
  const progressRoot = document.querySelector("#progress");
  const log = document.querySelector("#log");
  const pending = document.querySelector("#pending");
  const pendingNote = document.querySelector(".pending-note");
  const suggestions = document.querySelector("#suggestions");
  const contextRoot = document.querySelector("#context");
  const context = composerContext(contextRoot, input);
  const fileInput = document.querySelector("#file");
  const attachButton = document.querySelector("#attach");
  const selected = document.querySelector("#selected");
  const sendButton = document.querySelector("#send");
  /** Files chosen so far (photos, videos, files), sent with the next message. */
  let picked = [];
  const showPicked = () => {
    selected.replaceChildren();
    if (!picked.length) return;
    selected.append(`${picked.length} 个附件，${picked.map((file) => file.name).join("、").slice(0, 120)}`);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "移除";
    clear.addEventListener("click", () => { picked = []; showPicked(); });
    selected.append(clear);
  };
  let timeline;
  let settings;
  let recipient;
  let files;
  const askIntents = new Map();
  const optionPending = new Set();
  /** Long texts read from the ledger on demand, by blob hash. */
  const fullTexts = new Map();
  const redraw = () => { if (timeline) render(timeline.view, net.outbox, openInline, presenceBar, cardActions); };
  const cardActions = {
    agentName: id => recipient?.name(id) ?? id.replace(/^agent:/, ""),
    get primary() { return net.primary; },
    loading: () => !timeline?.ready,
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
      if (!fresh || fresh.seq !== ask.seq || fresh.state !== "pending") throw new Error("待批请求已失效。");
      let intent = askIntents.get(ask.id);
      if (intent?.choice && (intent.choice !== choice || intent.answerText !== answerText || intent.status === "pending" || intent.status === "confirmed" || intent.status === "rejected")) return;
      if (!intent?.choice) { intent = { choice, answerText, customDraft: intent?.customDraft, clientId: crypto.randomUUID(), status: "pending" }; askIntents.set(ask.id, intent); }
      else intent.status = "pending";
      const binding = net.binding();
      try {
        if (!net.same(binding)) throw new Error("连接已经换过，回答没有送出。");
        await answerAsk(net, fresh, choice, intent.clientId, { answerText });
        intent.status = "confirmed";
      } catch (error) {
        intent.status = /无权|被拒绝|已失效|不可用/.test(error?.message || "") ? "rejected" : "uncertain";
        connection.textContent = error instanceof Error ? error.message : "审批结果未知；只能原样重试。";
      }
      redraw();
    },
  };
  const clearContext = context.clear;
  const progress = () => renderProgress(progressRoot, timeline?.view, { onOpen: () => {
    if (agentSheet?.open()) void agentSheet.show("activity");
  } });
  /** The kernel (or the agent) asks the page to open a page: settings, the activity of a turn, a file... */
  const openUiTarget = async (target, request = {}) => {
    if (!net.session) return false;
    if (target === "settings") {
      if (!agentSheet.close()) return false;
      document.querySelector("#drawer").classList.add("open");
      settings.opened();
      return true;
    }
    if (target === "file") {
      if (typeof request.id !== "string" || !request.id) return false;
      void files.open({ workspace: "main", path: request.id });
      return true;
    }
    const tab = target === "turn" ? "activity" : target;
    if (!agentSheet.open()) return false;
    document.querySelector("#drawer").classList.remove("open");
    await agentSheet.show(tab);
    return agentSheet.activeTab === tab;
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
      settings?.network(status);
      agentSheet?.network(status);
      if (status !== "online") identityName?.reset();
      presenceBar.network(status, status === "closed" ? detail : "");
      if (status === "send-error" && detail) connection.title = String(detail.message || detail);
    },
    onOpen: () => {
      settings?.connected();
      agentSheet?.connected();
      void identityName?.refresh();
      void recipient?.refresh();
      net.setVisible(!document.hidden);
    },
    onQueue: (count, outbox) => {
      pending.textContent = count ? `${count} 条消息等待送达` : "";
      pendingNote.hidden = !count; // the storage notice matters only while something waits to be sent
      for (const item of outbox) if (item.in_reply_to && item.status === "rejected") optionPending.delete(item.in_reply_to);
      for (const item of outbox) if (item.in_reply_to && item.status !== "rejected") optionPending.add(item.in_reply_to);
      if (timeline) render(timeline.view, outbox, openInline, presenceBar, cardActions);
    },
  });
  files = new Files(net, { save: net.embedded ? (file) => globalThis.__ashFileSave(file) : null });
  document.querySelector("#files").onclick = () => files.browse();
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
  const paintView = framePainter((view, conversation) => {
    if (conversation) render(view, net.outbox, openInline, presenceBar, cardActions);
    else presenceBar?.render(timeline?.ready ? view.presence : { state: "unknown" });
    progress();
    agentSheet?.update();
    setTimeout(fillScreen, 0);
  });
  timeline = new Timeline(net, paintView);
  identityName = new IdentityName(net, (name) => {
    presenceBar.setName(name);
    document.querySelector("#agentSheetHeader h2").textContent = name;
    agentSheet?.setName(name);
    settings?.setName(name);
  });
  settings = new SettingsControls(document.querySelector("#panel"), net,
    { onClose: () => document.querySelector("#drawer").classList.remove("open") });
  agentSheet = new AgentSheet(document.querySelector("#agentSheet"), net, { getView: () => timeline.view,
    onAskAbout: ({ turn, text: prefill }) => {
      if (!agentSheet.close()) return;
      context.askAbout({ turn, text: prefill });
    }, onPrefill: (prefill) => {
      if (!agentSheet.close()) return;
      clearContext();
      input.value = prefill;
      input.focus();
    }, onIdentityChanged: () => { void identityName.refresh(); } });
  pending.textContent = net.queue.length ? `${net.queue.length} 条消息等待送达` : "";
  pendingNote.hidden = !net.queue.length;

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
      stopTyping();
      clearContext();
      fileInput.value = "";
      picked = [];
      showPicked();
      log.scrollTop = log.scrollHeight;
    } catch (error) { connection.textContent = `未发送：${error.message || "无法保存待发送消息"}`; }
    finally { sendButton.disabled = false; }
  });
  input.addEventListener("input", typing);
  recipient = agentPicker(form, input, net, redraw);
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
    const height = log.scrollHeight;
    const top = log.scrollTop;
    try { if (await timeline.older()) log.scrollTop = top + log.scrollHeight - height; }
    catch { connection.textContent = "更早记录暂时无法加载"; }
  });
  attachMenu(document.querySelector("#attachMenu"), attachButton, fileInput);
  fileInput.addEventListener("change", () => {
    picked = addPicked(picked, fileInput.files);
    fileInput.value = "";
    showPicked();
  });
  document.querySelector("#menu").addEventListener("click", () => {
    if (!agentSheet.close()) return;
    if (document.querySelector("#drawer").classList.toggle("open")) settings.opened();
  });
  window.addEventListener("pagehide", () => { clearInterval(progressTimer); clearInterval(typingTimer); net.stop(); });
  window.addEventListener("offline", () => agentSheet.reset());
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
  if (!custom && !ask.options.some((option) => option.id === choice)) throw new Error("待批请求已失效或选项不可用。");
  const result = await net.answerAsk(ask, { choice: custom ? "custom" : choice, ...(custom ? { text: answerText } : {}) }, clientId);
  if (result.ok) return result.message;
  throw new Error(["offline", "unavailable", "timeout", "result_unknown", "internal"].includes(result.error.code)
    ? "回答的回执未知；只能用同一选项原样重试。" : "回答被拒绝；请刷新记录。");
}

// In the app the page waits for the native bridge; in a browser it opens its own connection.
if (typeof document !== "undefined") {
  if (globalThis.location?.origin === "https://appassets.androidplatform.net") globalThis.__ashNativeBoot = (bridge) => boot({ bridge });
  else boot();
}
