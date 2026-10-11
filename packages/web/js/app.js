import { ConversationTimeline as Timeline } from "./conversation-timeline.js";
export { ConversationTimeline as Timeline } from "./conversation-timeline.js";
import { HomeFeed } from "./home-feed.js";
import { FullTexts } from "./full-texts.js";
import { connectHome } from "./home.js";
import { Net } from "./net.js";
import { appendConversation, appendOutbox } from "./conversation.js";
import { renderProgress } from "./progress.js";
import { presentUiOpen } from "./suggestions.js";
import { composerContext } from "./composer.js";
import { openInlineBlob, prepareUploads } from "./attachments.js";
import { readInlineAttachment } from "./inline-attachment.js";
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


function text(parent, tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
}

/** Turns of the front lane that ended in an error in the last day and were not followed by anything the owner said: each gets a card. */
export function failedTurns(view, now = Date.now()) {
  if (Array.isArray(view.failures)) return view.failures;
  const last = [...view.conversation].reverse().find((item) => item.type === "say" && item.side === "owner");
  // A failure from yesterday is history, not something to retry.
  return Object.entries(view.turns ?? {})
    .filter(([, turn]) => turn.background !== true && turn.outcome === "error" && Number.isFinite(turn.ended) && now - turn.ended < 86_400_000 && !(last && last.ts > turn.ended))
    .map(([turn, info]) => {
      // What to say again: the owner's last words before the turn began, when they were plain text.
      const said = [...view.conversation].reverse().find((item) => item.type === "say" && item.side === "owner" && item.ts <= info.started);
      return { turn, ts: info.ended, retry: said && !said.full && said.text && !(said.attachments?.length) ? { text: said.text, to: said.to } : null };
    });
}

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
/** Messages that have been drawn before: only the ones that are new rise into place. */
const drawn = { newest: 0, clients: new Set(), fresh: false, local: 0 };

export function render(view, outbox = [], openInline, presenceBar, cardActions) {
  const log = document.querySelector("#log");
  const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const oldHeight = log.scrollHeight;
  const oldTop = log.scrollTop;
  const loading = cardActions?.loading?.() === true;
  // A card that was waiting for an answer and is answered now folds up instead of jumping to its short form.
  const heights = new Map();
  for (const card of log.querySelectorAll?.(".a-card[data-ask-id]") ?? []) heights.set(card.dataset.askId, card.offsetHeight);
  const fragment = document.createDocumentFragment();
  appendConversation(fragment, view.conversation, { openInline, ...cardActions, loading, failures: loading ? [] : failedTurns(view), atStart: cardActions?.atStart?.() === true, herName: cardActions?.herName?.() ?? "Ash" });
  appendOutbox(fragment, outbox);
  log.replaceChildren(fragment);
  if (log.setAttribute) log.setAttribute("aria-busy", loading ? "true" : "false");
  if (log.querySelectorAll) animate(log, heights);
  if (nearEnd) log.scrollTop = log.scrollHeight;
  else log.scrollTop = oldTop + Math.max(0, log.scrollHeight - oldHeight);
  presenceBar?.render(loading ? { state: "unknown" } : view.presence);
}

/** Motion of the design: a new message rises 6px and fades in (240 ms), an answered card folds up (300 ms). */
function animate(log, heights) {
  const motion = !reducedMotion();
  const before = drawn.newest;
  let local = drawn.local;
  for (const node of log.querySelectorAll("[data-seq], [data-client-id]")) {
    const seq = Number(node.dataset.seq);
    const client = node.dataset.clientId;
    const known = client ? drawn.clients.has(client) : seq <= before;
    if (client) drawn.clients.add(client); else drawn.newest = Math.max(drawn.newest, seq);
    // The owner's own message has risen once already, as the local copy that waited to be sent.
    const settled = !client && !known && local > 0 && node.classList.contains("me") && local--;
    if (drawn.fresh && motion && !known && !settled) node.classList.add("enter");
  }
  drawn.local = log.querySelectorAll(".pending-local").length;
  if (log.querySelector("[data-seq], [data-client-id]")) drawn.fresh = true;
  if (!motion) return;
  const css = getComputedStyle(document.documentElement);
  for (const card of log.querySelectorAll(".a-card[data-ask-id]")) {
    const was = heights.get(card.dataset.askId);
    const now = card.offsetHeight;
    if (was > now + 4) card.animate?.([{ height: `${was}px`, overflow: "hidden" }, { height: `${now}px`, overflow: "hidden" }],
      { duration: parseInt(css.getPropertyValue("--dur-resolve"), 10) || 300, easing: css.getPropertyValue("--ease").trim() || "ease" });
  }
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
  const homeFeed = new HomeFeed();
  let timeline;
  let recipient;
  let files;
  /** Ask for her home, or for the apps page (`page: "apps"`): whoever owns that page answers the event. */
  const openHome = ({ page = "home", agent, section } = {}) => window.dispatchEvent(new CustomEvent("ash:open",
    { cancelable: true, detail: { page, ...(agent ? { agent } : {}), ...(section ? { section } : {}) } }));
  const askIntents = homeFeed.intents;
  const optionPending = new Set();
  /** Long texts read from the ledger on demand, by blob hash. */
  const fullTexts = new FullTexts();
  const redraw = () => { if (timeline) render(timeline.view, net.outbox, openInline, presenceBar, cardActions); };
  const cardActions = {
    agentName: id => recipient?.name(id) ?? id.replace(/^agent:/, ""),
    get primary() { return net.primary; },
    loading: () => !timeline?.ready,
    atStart: () => timeline?.store.intro === true,
    herName: () => presenceBar.title.textContent || "Ash",
    onRetry: async (failure) => {
      await net.enqueueSay(failure.retry.text, [], null, failure.retry.to ?? recipient.target());
      log.scrollTop = log.scrollHeight;
    },
    onOpenFile: (ref) => files.open(ref),
    onFileLink: (href) => files.openLink(href),
    fullTexts,
    onExpand: async (hash, id) => {
      id ??= timeline.store.items.find(item => item.full === hash)?.id;
      if (!id || !timeline.get(id)) return;
      const dataset = timeline.store.dataset;
      const entry = await fullTexts.load(id, hash, value => net.readBlobText(value));
      if (!entry || dataset !== timeline.store.dataset || !timeline.get(id)) { fullTexts.retain(timeline.store.items); return; }
      const dirty = timeline.store.expand(id, entry.bytes);
      fullTexts.retain(timeline.store.items);
      paintView(timeline.view, true, dirty);
    },
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
    const attachment = await readInlineAttachment(net, timeline.get(messageId), messageId, index);
    return attachment ? openInlineBlob(attachment) : null;
  };
  const net = new Net({
    bridge,
    label: sessionStorage.getItem("ash.web.label")?.trim().slice(0, 80) || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? "手机浏览器" : "电脑浏览器"),
    onMessage: (message) => { timeline.add(message); },
    onHistory: (page) => { timeline.acceptPage(page); performance.mark("shell.history-rendered"); },
    onCurrent: (current) => { timeline.acceptCurrent(current); },
    historyTarget: () => {
      if (!timeline?.ready || !timeline.store.hasAfter) return {};
      const first = [...log.querySelectorAll("[data-seq]")].find(node => node.getBoundingClientRect().bottom > log.getBoundingClientRect().top);
      const id = first?.dataset.rowKey?.replace(/^message:/, "") || first?.dataset.messageId;
      return id ? { around_id: id } : timeline.store.items[0] ? { around_id: timeline.store.items[0].id } : {};
    },
    onHistoryReady: () => { timeline.historyReady(); },
    onPresent: async (request) => {
      const opened = await presentUiOpen(suggestions, request, openUiTarget).catch(() => false);
      return { ok: true, data: { opened } };
    },
    onState: (status, detail) => {
      window.dispatchEvent(new CustomEvent("ash:net-state", { detail: { net, event: "onState" } }));
      if (status !== "online") identityName?.reset();
      presenceBar.network(status, status === "closed" ? detail : "");
      if (status === "send-error" && detail) connection.title = String(detail.message || detail);
      if (status === "online" || status === "connecting") sendable();
    },
    onOpen: () => {
      homeFeed.reset();
      window.dispatchEvent(new CustomEvent("ash:net-state", { detail: { net, event: "onOpen" } }));
      void identityName?.refresh();
      void recipient?.refresh();
      net.setVisible(!document.hidden);
    },
    onQueue: (count, outbox) => {
      for (const item of outbox) if (item.in_reply_to && item.status === "rejected") optionPending.delete(item.in_reply_to);
      for (const item of outbox) if (item.in_reply_to && item.status !== "rejected") optionPending.add(item.in_reply_to);
      if (timeline) render(timeline.view, outbox, openInline, presenceBar, cardActions);
    },
  });
  connectHome(net, homeFeed);
  files = new Files(net, { save: net.embedded ? (file) => globalThis.__ashFileSave(file) : null });
  // Visible-item pages cannot be drowned by background ledger events; fill a short viewport from finite older pages.
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
    // A dataset reset drops texts and transient choices before any new entity is painted.
    if (fullTexts.dataset !== timeline.store.dataset) {
      fullTexts.reset(); fullTexts.dataset = timeline.store.dataset;
      askIntents.clear(); optionPending.clear();
    }
    const active = new Set(timeline.store.items.map(item => item.id));
    askIntents.prune(active);
    for (const id of optionPending) if (!active.has(id) && !net.outbox.some(item => item.in_reply_to === id)) optionPending.delete(id);
    fullTexts.retain(timeline.store.items);
    if (conversation) render(timeline.view, net.outbox, openInline, presenceBar, cardActions);
    else presenceBar?.render(timeline?.ready ? view.presence : { state: "unknown" });
    progress();
    setTimeout(fillScreen, 0);
  });
  timeline = new Timeline(net, paintView);
  timeline.store.expandedSize = item => item.full ? fullTexts.values.get(item.full)?.bytes ?? 0 : 0;
  timeline.onCurrent = current => homeFeed.setCurrent(current);
  const protectWindow = () => {
    const selection = document.getSelection();
    const ids = [...log.querySelectorAll("[data-row-key]")].filter(node => node.contains(document.activeElement) || selection?.rangeCount && !selection.isCollapsed && selection.containsNode(node, true))
      .map(node => node.dataset.rowKey.replace(/^message:/, ""));
    timeline.store.protect(ids);
  };
  document.addEventListener("selectionchange", protectWindow);
  log.addEventListener("focusin", protectWindow);
  log.addEventListener("focusout", protectWindow);
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
      log.scrollTop = log.scrollHeight;
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
    if (timeline.loading) return;
    try {
      if (log.scrollTop < 80) await timeline.older();
      else if (log.scrollHeight - log.scrollTop - log.clientHeight < 100 && timeline.store.hasAfter) await timeline.newer();
    } catch { presenceBar.problem("这段对话暂时加载不出来，稍后再翻一次。"); }
  }, { passive: true });
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
  window.addEventListener("pagehide", () => { clearInterval(progressTimer); clearInterval(typingTimer); net.stop(); });
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
