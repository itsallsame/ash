// The settings drawer. Every setting is a word called on a member of the hub as the owner, over the page's one
// connection (net.js); the page keeps no secrets and no copy of the hub's state. The drawer is drawn whenever the page is
// connected; whether a word may be done from this page is the hub's call (it answers `forbidden`, and the page says so).
// `net.local` only adds a hint beside the few words that can only be done on the hub's own machine.
import { retryable, unwrap } from "./link.js";
import { ProactivePreferences } from "./settings-preferences.js";
import { AppsSettings, appsSummary } from "./settings-apps.js";
import { usdToCnyText as money, balanceText, CNY_ESTIMATE_NOTE } from "./money.js";

const ADMIN = "service:admin";
const GATE = "service:gate";
const VAULT = "service:vault";
const DEVICES = "service:devices";
const LINK = "service:link";
const COST = "service:cost";
const AGENTS = "service:agents";
const APPS = "service:apps";

const QUIET_KEY = "delivery.quiet_hours";
const QUIET_DEFAULT = "21:30-09:00";
const QUIET_FORMAT = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

function node(tag, label, className = "") {
  const element = document.createElement(tag);
  element.textContent = label;
  if (className) element.className = className;
  return element;
}

function button(label, className = "btn", id = "") {
  const element = node("button", label, className);
  element.type = "button";
  if (id) element.id = id;
  return element;
}

/** A list row: icon, title, one line underneath, and a chevron. `sub` is kept on the row so callers can update it. */
function navRow(id, icon, title, subtitle, onClick, href = "") {
  const row = document.createElement(href ? "a" : "button");
  row.id = id;
  row.className = "set-row";
  if (href) row.href = href; else row.type = "button";
  const text = document.createElement("span");
  text.className = "set-text";
  const sub = node("span", subtitle, "set-sub");
  text.append(node("span", title, "set-title"), sub);
  row.append(node("span", "", `set-icon i-${icon}`), text, node("span", "", "set-chev"));
  if (onClick) row.addEventListener("click", onClick);
  row.sub = sub;
  return row;
}

function group(header, ...rows) {
  const wrap = document.createElement("div");
  wrap.className = "set-group-wrap";
  if (header) wrap.append(node("h3", header, "set-header"));
  const box = document.createElement("div");
  box.className = "set-group";
  box.append(...rows);
  wrap.append(box);
  return wrap;
}

/** Two taps for anything that takes something away: the first says what will happen, the second does it. */
function armed(control, label, confirmLabel, onWarn, run) {
  let ready = false;
  // Leaving the page takes the first tap back: coming back never finds a destructive button one tap from done.
  control.setAttribute("data-armed", "");
  control.disarm = () => { if (ready) { ready = false; control.textContent = label; } };
  control.addEventListener("click", () => {
    if (control.disabled) return;
    if (!ready) { ready = true; control.textContent = confirmLabel; onWarn?.(); return; }
    ready = false;
    control.textContent = label;
    void run();
  });
}

const KEYS = [
  { ref: "DEEPSEEK_API_KEY", title: "DeepSeek Key", use: "用于：对话模型", hint: "没有它，Ash 无法对话。" },
  { ref: "OPENROUTER_API_KEY", title: "OpenRouter Key", use: "用于：快速判断（JEV 模型）", hint: "没有它，快速判断只能靠关键词。" },
];
const KIND_NAMES = { computer: "电脑", laptop: "电脑", server: "服务器", browser: "浏览器" };
const PROVIDER_NAMES = { deepseek: "DeepSeek", openrouter: "OpenRouter" };
const tokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const clock = (at) => {
  const d = new Date(Number(at));
  return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
};

/** The hand id behind a device id (`device:<hand>`), which `service:link` words name. */
const handOf = (device) => (typeof device === "string" ? device.replace(/^device:/, "") : "");

/** A device's diagnosis in plain words for the owner, not the raw record. */
export function deviceDiagnosis({ device = {}, connections = [], diagnosis = null } = {}) {
  const lines = [`${device.online ? "在线" : "离线"}${device.via === "gateway" ? "（经中转站）" : device.via === "local" ? "（和这台手机直连）" : ""}。`];
  if (!device.online && device.last_seen) lines.push(`上次在线：${clock(device.last_seen)}。`);
  if (connections.length) lines.push(`现在有 ${connections.length} 条连接。`);
  if (diagnosis) {
    const findings = Array.isArray(diagnosis.findings) ? diagnosis.findings.filter((finding) => typeof finding?.message === "string") : [];
    if (diagnosis.ok === true && !findings.length) lines.push("没有发现问题。");
    else lines.push(diagnosis.ok === true ? "提醒：" : "发现这些问题：", ...findings.map((finding) => `· ${finding.message}`));
  }
  return lines.join("\n");
}

/** The relay's state in one plain sentence (`service:link/gateway.status`). */
export function relayText(status) {
  if (!status || status.configured !== true) return "还没有设置中转站，其他设备暂时连不上。";
  const where = typeof status.url === "string" && status.url ? `（${status.url}）` : "";
  if (status.connected === true) return `中转站已连接${where}${status.account_email ? `，账号 ${status.account_email}` : ""}。`;
  const why = typeof status.last_error === "string" && status.last_error ? `：${status.last_error}` : "";
  return `中转站暂时连不上${where}${why}。会自动重试，也请检查网络和地址。`;
}

/** Where a Cloudflare setup stands, in words. */
export function setupText(setup) {
  switch (setup?.state) {
    case "waiting_login": return "等你在 Cloudflare 登录：登录卡片已经发到对话里。登录后回到这里点「看看进度」。";
    case "authorized": return "已登录 Cloudflare，可以开始搭建了。";
    case "deploying": return "正在搭建中转站，需要一两分钟…";
    case "claimed": return "中转站已搭好，正在连接…";
    case "connected": return "中转站已搭好，也连上了。";
    case "failed": return `搭建没有成功${setup.reason ? `：${setup.reason}` : ""}。可以重新搭一次。`;
    default: return "";
  }
}
const SETUP_ACTIVE = ["waiting_login", "authorized", "deploying", "claimed"];

/** What the account balances answer says, with an unreadable provider named rather than shown as zero. */
export function balanceSentence(data) {
  const entries = Array.isArray(data?.balances) ? data.balances : [];
  const parts = [];
  let unavailable = false;
  for (const entry of entries) {
    const balance = entry?.balance;
    if (!balance || typeof balance !== "object") continue;
    if (balance.available === false) unavailable = true;
    const list = Array.isArray(balance.balances) ? balance.balances : [];
    const label = PROVIDER_NAMES[entry.provider] ?? entry.provider ?? "";
    for (const item of list) parts.push(`${label ? `${label} ` : ""}${balanceText(item)}`);
  }
  const failed = Object.keys(data?.errors ?? {}).map((provider) => PROVIDER_NAMES[provider] ?? provider);
  return `账户余额：${parts.join("，") || "无数据"}${unavailable ? "（账户当前不可用）" : ""}${failed.length ? `（${failed.join("、")} 暂时读不到）` : ""}`;
}

/** Usage as two lists: how much per period, then where the last week went. */
export function renderUsage(summary, names = {}) {
  const zero = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0 };
  const period = (key) => ({ ...zero, ...(summary?.periods?.[key] ?? {}) });
  const line = (label, totals) => {
    const row = document.createElement("div");
    row.className = "set-line";
    const text = document.createElement("span");
    text.className = "set-text";
    const note = totals.unpriced_calls ? ` · 另有 ${totals.unpriced_calls} 次没有价格` : "";
    text.append(node("span", label, "set-title"),
      node("span", `${number(totals.calls)} 次调用 · 输入 ${tokens(number(totals.input_tokens))} / 输出 ${tokens(number(totals.output_tokens))}${note}`, "set-sub"));
    row.append(text, node("span", money(totals.cost_usd), "set-value"));
    return row;
  };
  const groups = [group("", line("今天", period("today")), line("近 7 天", period("7d")), line("近 30 天", period("30d")))];
  // Where the last week went, by whoever made the calls: a member's name where the page knows it, else its id.
  const parts = (Array.isArray(summary?.by_caller) ? summary.by_caller : []).map((entry) => ({ ...zero, ...entry })).filter((entry) => typeof entry.caller === "string");
  if (parts.length) groups.push(group("近 7 天花在哪", ...parts.map((entry) => line(names[entry.caller] ?? entry.caller, entry))));
  return groups;
}

/** The time a quiet-hours setting names: "HH:MM-HH:MM", "" for none, or null when it cannot be read. */
function quietOf(settings) {
  const value = settings?.[QUIET_KEY];
  if (value === undefined) return QUIET_DEFAULT;
  if (value === "") return "";
  return typeof value === "string" && QUIET_FORMAT.test(value) ? value : null;
}

/** Local management controls are rendered only while this page is connected to a hub on this machine. */
export class SettingsControls {
  constructor(panel, net, { onClose } = {}) {
    this.adminIntent = null;
    this.panel = panel;
    this.net = net;
    this.onClose = onClose;
    this.name = "Ash";
    this.online = false;
    this.section = null;
    this.sectionContext = null;
    this.preferences = null;
    this.refreshHome = null;
    this.render();
  }

  /** The connection just opened; the drawer is drawn for it. */
  connected() {
    this.render();
  }

  network(status) {
    this.online = status === "online";
    this.render();
  }

  reset() {
    this.online = false;
    this.render();
  }

  /** The drawer was opened: always start at the settings root, showing what is true now. */
  opened() {
    this.showHome?.();
    void this.refreshHome?.();
  }

  setName(name) {
    if (typeof name !== "string" || !name.trim() || name.trim() === this.name) return;
    this.name = name.trim();
    this.sectionContext = null;
    this.render();
  }

  render() {
    const binding = this.net.binding();
    const usable = this.online && Boolean(binding.session);
    const context = usable ? `${binding.session}\0${binding.generation}` : null;
    if (this.section && context && context === this.sectionContext) return;
    this.preferences?.dispose();
    this.preferences = null;
    this.refreshHome = null;
    this.showHome = null;
    const name = this.name;
    const android = globalThis.location?.origin === "https://appassets.androidplatform.net";
    const titleBar = document.createElement("div");
    titleBar.className = "set-titlebar";
    titleBar.append(node("h2", "设置", "set-main-title"));
    if (this.onClose) {
      const close = button("完成", "set-close");
      close.addEventListener("click", () => this.onClose());
      titleBar.append(close);
    }
    this.panel.replaceChildren(titleBar);
    this.section = null;
    this.sectionContext = null;
    if (!usable) {
      this.panel.append(node("p", `连上 ${name} 所在的这台手机后，才能在这里调整设置。`, "set-intro"));
      if (android) this.panel.append(group("", navRow("settingsConsole", "shield", "手机权限", "通知、无障碍、后台运行，以及诊断", null, "ash://console")));
      return;
    }
    const section = document.createElement("section");
    section.id = "settingsAdmin";
    const live = () => this.section === section;
    const home = document.createElement("div");
    home.id = "settingsHome";
    section.append(home);
    const pages = [];
    const show = (target) => {
      home.hidden = target !== home;
      for (const item of pages) item.hidden = item !== target;
      titleBar.hidden = target !== home;
      for (const control of section.querySelectorAll?.("[data-armed]") ?? []) control.disarm?.();
    };
    const page = (id, title, intro, onOpen) => {
      const element = document.createElement("section");
      element.id = id;
      element.className = "set-page";
      element.hidden = true;
      const back = button("设置", "set-back", `${id}Back`);
      back.addEventListener("click", () => { show(home); void this.refreshHome?.(); });
      element.append(back, node("h2", title, "set-page-title"));
      if (intro) element.append(node("p", intro, "set-intro"));
      element.open = () => { show(element); void onOpen?.(); };
      pages.push(element);
      section.append(element);
      return element;
    };

    // One word, as the owner. It answers with the reply, or with a "stale" failure when this section or the connection it
    // was drawn for is gone (so a late answer never lands on a screen that moved on). `ask` returns the data or throws.
    const stale = () => ({ ok: false, error: { code: "stale", message: "连接已经换了" } });
    const callReply = async (to, word, body = {}, options) => {
      const binding = this.net.binding();
      if (!live() || !this.online || !this.net.same(binding)) return stale();
      const reply = await this.net.call(to, word, body, options);
      if (!live() || !this.net.same(binding)) return stale();
      return reply;
    };
    const ask = async (to, word, body = {}) => unwrap(await callReply(to, word, body));

    // ---- Home: usage at a glance, then what Ash can use, how she treats your time, pause, and the rest.
    const usageCard = document.createElement("button");
    usageCard.type = "button";
    usageCard.id = "settingsUsageCard";
    usageCard.className = "set-card set-usage";
    const usageToday = node("span", "—", "set-big");
    const usageMore = node("span", "点开看花在哪里", "set-sub");
    usageCard.append(node("span", "今天花了（人民币估算）", "set-sub"), usageToday, usageMore);

    const vaultRow = navRow("settingsVaultRow", "key", "密钥", "DeepSeek、OpenRouter", () => vaultPage.open());
    const gatewayRow = navRow("settingsGatewayRow", "devices", "已连接设备", "其他电脑和浏览器", () => gatewayPage.open());
    const capability = [vaultRow, gatewayRow];
    const appsRow = navRow("settingsAppsRow", "apps", "应用", `装在 ${name} 里的应用，以及它们能用什么`, () => appsPage.open());
    capability.push(appsRow);
    if (android && typeof globalThis.__ashBrowserLogins === "function")
      capability.push(navRow("settingsBrowserRow", "globe", "浏览器登录", `${name} 的浏览器里登录过的网站`, () => browserPage.open()));
    if (android) capability.push(navRow("settingsConsole", "shield", "手机权限", "通知、无障碍、后台运行，以及诊断", null, "ash://console"));
    const quietRow = navRow("settingsQuietRow", "moon", "免打扰", "这段时间不主动找你", () => quietPage.open());
    const proactiveRow = navRow("settingsProactiveRow", "chat", "主动联系", `${name} 什么时候可以主动找你`, () => proactivePage.open());
    const approvalRow = navRow("settingsApprovalRow", "shield", "审批", `${name} 做事前什么时候先问你`, () => approvalPage.open());

    const pauseCard = document.createElement("div");
    pauseCard.id = "settingsPauseCard";
    pauseCard.className = "set-card set-pause";
    const pauseTitle = node("span", `暂停 ${name}`, "set-title");
    const pauseText = node("span", `暂停后 ${name} 会停下手头所有的事，不再主动做任何事，直到你恢复。`, "set-sub");
    const pause = button(`暂停 ${name}`, "btn red", "settingsPause");
    const resume = button(`恢复 ${name}`, "btn", "settingsResume");
    const confirmation = document.createElement("div");
    confirmation.id = "settingsResumeConfirmation";
    confirmation.className = "set-confirm";
    confirmation.hidden = true;
    confirmation.append(node("p", `确定要恢复 ${name} 吗？`));
    const yes = button("确认恢复", "btn", "settingsResumeYes");
    const no = button("取消", "btn gray");
    confirmation.append(yes, no);
    const feedback = node("p", "", "set-status");
    feedback.id = "settingsFeedback";
    feedback.setAttribute("role", "status");
    const showPaused = (paused) => {
      pauseTitle.textContent = paused === true ? `${name} 已暂停` : `暂停 ${name}`;
      pause.hidden = paused === true;
      resume.hidden = paused === false;
    };
    // Pause and resume are confirmed by what the word says (`paused`). A lost answer keeps the request id, so the same
    // request may be sent again; a definite refusal retires it.
    const setPaused = async (word) => {
      const session = this.net.session;
      if (this.adminIntent?.word !== word || this.adminIntent.session !== session) this.adminIntent = { word, session, clientId: crypto.randomUUID() };
      const intent = this.adminIntent;
      const reply = await callReply("service:admin", word, word === "resume" ? { confirmed: true } : {}, { clientId: intent.clientId });
      if (!reply.ok) {
        if (!retryable(reply.error) && this.adminIntent === intent) this.adminIntent = null;
        return { ok: false };
      }
      const paused = word === "pause";
      if (reply.result?.data?.paused !== paused) return { ok: false };
      if (this.adminIntent === intent) this.adminIntent = null;
      return { ok: true, paused };
    };
    const run = async (word) => {
      if (!live() || !this.online) return;
      pause.disabled = true;
      resume.disabled = true;
      yes.disabled = true;
      feedback.textContent = "正在处理…";
      const result = await setPaused(word);
      if (!live() || !this.online) return;
      const done = result.ok && result.paused === (word === "pause");
      feedback.textContent = done ? word === "pause" ? `已暂停 ${name}` : `已恢复 ${name}` : "状态未确认，请检查连接后重试。";
      if (done) showPaused(result.paused);
      pause.disabled = false;
      resume.disabled = false;
      yes.disabled = false;
    };
    pause.addEventListener("click", () => { void run("pause"); });
    resume.addEventListener("click", () => { confirmation.hidden = false; });
    yes.addEventListener("click", () => { confirmation.hidden = true; void run("resume"); });
    no.addEventListener("click", () => { confirmation.hidden = true; });
    pauseCard.append(pauseTitle, pauseText, pause, resume, confirmation, feedback);

    const devRow = navRow("settingsDevRow", "code", "开发者选项", "主模型、DSH 插件", () => devPage.open());
    // A few words can only be done on the machine the hub runs on; the hub refuses them elsewhere, and says so here beforehand.
    if (!this.net.local) home.append(node("p", "暂停和恢复、保存和删除密钥、查看配对码，这几项只能在 Ash 所在的手机上操作。", "set-intro"));
    home.append(usageCard, group(`${name} 能用的`, ...capability), group("相处方式", quietRow, proactiveRow, approvalRow), pauseCard, group("其他", devRow));
    usageCard.addEventListener("click", () => usagePage.open());

    // ---- Usage
    const usagePage = page("settingsUsage", "用量", "", () => refreshUsage());
    const usageTable = document.createElement("div");
    usageTable.id = "settingsUsageTable";
    const balanceLine = node("p", "", "set-intro");
    balanceLine.id = "settingsUsageBalance";
    const usageStatus = node("p", "", "set-status");
    usageStatus.id = "settingsUsageStatus";
    usageStatus.setAttribute("role", "status");
    const usageRefresh = button("刷新", "btn gray", "settingsUsageRefresh");
    usageRefresh.addEventListener("click", () => { void refreshUsage(); });
    usagePage.append(usageTable, balanceLine, usageStatus, usageRefresh);
    const showUsage = (summary) => {
      usageToday.textContent = money(summary?.periods?.today?.cost_usd);
      usageMore.textContent = `近 7 天 ${money(summary?.periods?.["7d"]?.cost_usd)} · 近 30 天 ${money(summary?.periods?.["30d"]?.cost_usd)}`;
    };
    const refreshUsage = async () => {
      usageStatus.textContent = "正在读取…";
      try {
        const summary = await ask(COST, "usage.get", { days: 7 });
        if (!live()) return;
        usageTable.replaceChildren(...renderUsage(summary, { [this.net.primary]: name }));
        showUsage(summary);
        usageStatus.textContent = `${summary.estimated ? "费用按模型的公开价格估算。" : ""}${CNY_ESTIMATE_NOTE}`;
      } catch { if (live()) usageStatus.textContent = "用量读取失败，请重试。"; return; }
      try {
        const balance = await ask(COST, "balance.get", {});
        if (live()) balanceLine.textContent = balanceSentence(balance);
      } catch { if (live()) balanceLine.textContent = "账户余额暂时读不到（不是零）。"; }
    };

    // ---- Keys. The page learns whether a key is saved, never what it is.
    const vaultPage = page("settingsVault", "密钥",
      `Key 只保存在这台手机上。${name} 知道存了哪几个，但看不到内容，Key 也不会出现在聊天里。保存后立刻生效。`, () => refreshVault());
    const vaultViews = [];
    for (const { ref, title, use, hint } of KEYS) {
      const card = document.createElement("div");
      card.id = `settingsVault_${ref}`;
      card.className = "set-card";
      const head = document.createElement("div");
      head.className = "set-text";
      head.append(node("span", title, "set-title"), node("span", use, "set-sub"));
      const status = node("p", "正在读取…", "set-status");
      status.id = `settingsVault_${ref}_status`;
      status.setAttribute("role", "status");
      const field = document.createElement("input");
      field.id = `settingsVault_${ref}_value`;
      field.type = "password";
      field.placeholder = "粘贴 Key";
      field.autocomplete = "off";
      const save = button("保存");
      const remove = button("移除", "btn gray");
      remove.hidden = true;
      const showSaved = (saved) => {
        status.textContent = saved ? "已保存。" : `还没有保存。${hint}`;
        status.className = saved ? "set-status ok" : "set-status warn";
        field.placeholder = saved ? "粘贴新的 Key 替换" : "粘贴 Key";
        field.disabled = false;
        save.disabled = false;
        remove.disabled = false;
        remove.hidden = !saved;
      };
      const lock = () => {
        status.textContent = "手机安全存储暂时不可用。原有密钥未被读取或修改，请重启手机后再试。";
        status.className = "set-status warn";
        field.value = "";
        field.disabled = true;
        save.disabled = true;
        remove.disabled = true;
        remove.hidden = true;
      };
      vaultViews.push({ ref, show: showSaved, lock, status });
      const failure = (error, text) => { if (live()) { if (error?.code === "unavailable") for (const view of vaultViews) view.lock(); else status.textContent = text; } };
      save.addEventListener("click", () => { void (async () => {
        if (save.disabled) return;
        const value = field.value.trim();
        field.value = "";
        if (!value) { status.textContent = "请先粘贴 Key。"; return; }
        save.disabled = true;
        status.textContent = "正在保存…";
        try {
          const saved = await ask(VAULT, "set", { ref, value, label: title, kind: "model" });
          if (live()) { if (saved.configured === true) showSaved(true); else status.textContent = "保存失败，请重试。"; }
        } catch (error) { failure(error, "保存失败，请重试。"); }
        finally { if (!field.disabled) save.disabled = false; }
      })(); });
      armed(remove, "移除", "确定移除？", () => { status.textContent = `移除后，${hint.replace(/^没有它，/, "")}`; }, async () => {
        remove.disabled = true;
        try {
          const removed = await ask(VAULT, "delete", { ref });
          if (live()) { if (removed.deleted === true) showSaved(false); else status.textContent = "移除失败，请重试。"; }
        } catch (error) { failure(error, "移除失败，请重试。"); }
        finally { if (!field.disabled) remove.disabled = false; }
      });
      const actions = document.createElement("div");
      actions.className = "set-actions";
      actions.append(save, remove);
      card.append(head, status, field, actions);
      vaultPage.append(card);
    }
    // `unavailable` is the locked secure storage: nothing was read or changed.
    const readVault = async () => {
      try {
        const { entries } = await ask(VAULT, "list", {});
        return { entries: Array.isArray(entries) ? entries : [], available: true };
      } catch (error) {
        if (error?.code === "unavailable") return { entries: [], available: false };
        throw error;
      }
    };
    const refreshVault = async () => {
      try {
        const vault = await readVault();
        if (!live()) return;
        if (!vault.available) { for (const view of vaultViews) view.lock(); return; }
        for (const view of vaultViews) view.show(vault.entries.find((item) => item.ref === view.ref)?.configured === true);
      } catch { if (live()) for (const view of vaultViews) view.status.textContent = "读取失败，请重试。"; }
    };

    // ---- Connected devices, and the relay they connect through
    const gatewayPage = page("settingsGateway", "已连接设备",
      `其他电脑或浏览器可以通过中转站连上这台手机上的 ${name}。每一台都要你在这里批准。`, () => openGateway());
    const item = (title, subtitle) => {
      const row = document.createElement("div");
      row.className = "set-item settings-plugin";
      const text = document.createElement("span");
      text.className = "set-text";
      text.append(node("span", title, "set-title"), node("span", subtitle, "set-sub"));
      row.append(text);
      return row;
    };
    const choose = (entries, value, id) => {
      const select = document.createElement("select"); select.id = id;
      for (const [key, label] of entries) { const option = node("option", label); option.value = key; select.append(option); }
      select.value = value; return select;
    };

    // The relay: an address to use, or a Cloudflare setup the hub walks through with the owner.
    const relayStatus = node("p", "", "set-status");
    relayStatus.id = "settingsRelayStatus";
    relayStatus.setAttribute("role", "status");
    const relayUrl = document.createElement("input");
    relayUrl.id = "settingsGatewayUrl";
    relayUrl.type = "url";
    relayUrl.placeholder = "https://你的中转站地址";
    const relayUse = button("使用这个中转站", "btn", "settingsGatewayUse");
    const relayResult = node("p", "", "set-status");
    relayResult.id = "settingsGatewayConfigStatus";
    relayResult.setAttribute("role", "status");
    const setupState = node("p", "", "set-status");
    setupState.id = "settingsGatewaySetupState";
    setupState.setAttribute("role", "status");
    const setupName = document.createElement("input");
    setupName.id = "settingsGatewaySetupName";
    setupName.placeholder = "中转站的名字（可不填）";
    const setupStart = button("在 Cloudflare 搭一个", "btn gray", "settingsGatewaySetup");
    const setupDeploy = button("开始搭建", "btn", "settingsGatewayDeploy");
    const setupCheck = button("看看进度", "btn gray", "settingsGatewaySetupCheck");
    const setupCancel = button("放弃搭建", "btn gray", "settingsGatewaySetupCancel");
    const relayCard = node("div", "", "set-card");
    relayCard.id = "settingsRelay";
    relayCard.append(node("span", "中转站", "set-title"), relayStatus, relayUrl, relayUse, relayResult,
      node("span", "没有中转站？可以在你的 Cloudflare 账号里搭一个。", "set-sub"), setupState, setupName, setupStart, setupDeploy, setupCheck, setupCancel);
    let setup = null;
    const showSetup = () => {
      const state = setup?.state;
      const active = SETUP_ACTIVE.includes(state);
      setupState.textContent = setupText(setup);
      setupStart.hidden = active || state === "connected";
      setupDeploy.hidden = setupName.hidden = state !== "authorized";
      setupCheck.hidden = !["waiting_login", "deploying", "claimed"].includes(state);
      setupCancel.hidden = !["waiting_login", "authorized", "deploying"].includes(state);
    };
    showSetup();
    let relay = null;
    const refreshRelay = async () => {
      relay = await ask(LINK, "gateway.status", {});
      if (!live()) return relay;
      relayStatus.textContent = relayText(relay);
      if (relay.configured === true && typeof relay.url === "string" && !relayUrl.value) relayUrl.value = relay.url;
      return relay;
    };
    const setupFailed = (text) => (error) => { if (live()) setupState.textContent = error?.code === "stale" ? "" : text; };
    const adopt = async (state) => {
      setup = { ...setup, ...state };
      showSetup();
      if (state.state === "claimed" || state.state === "connected") { await refreshRelay().catch(() => {}); await refreshDevices().catch(() => {}); }
    };
    relayUse.addEventListener("click", () => { void (async () => {
      const url = relayUrl.value.trim();
      if (!url) { relayResult.textContent = "请先填中转站的地址。"; return; }
      relayUse.disabled = true;
      relayResult.textContent = "正在保存…";
      try {
        const used = await ask(LINK, "gateway.use", { url });
        if (!live()) return;
        if (typeof used.url === "string") relayUrl.value = used.url;
        relayResult.textContent = `已设置中转站：${used.url ?? url}。`;
        await refreshRelay().catch(() => {});
      } catch (error) { if (live()) relayResult.textContent = error?.code === "stale" ? "" : "保存失败，请检查地址后重试。"; }
      finally { relayUse.disabled = false; }
    })(); });
    setupStart.addEventListener("click", () => { void (async () => {
      setupStart.disabled = true;
      setupState.textContent = "正在准备…";
      try { setup = await ask(LINK, "gateway.setup.start", { provider: "cloudflare" }); if (live()) showSetup(); }
      catch (error) { setupFailed("没能开始，请稍后重试。")(error); }
      finally { setupStart.disabled = false; }
    })(); });
    setupCheck.addEventListener("click", () => { void readSetup(); });
    setupDeploy.addEventListener("click", () => { void (async () => {
      if (!setup) return;
      setupDeploy.disabled = true;
      try {
        const nameText = setupName.value.trim();
        const state = await ask(LINK, "gateway.setup.deploy", { setup_id: setup.setup_id, ...(nameText ? { name: nameText } : {}) });
        if (live()) await adopt(state);
      } catch (error) { setupFailed("没能开始搭建，请重试。")(error); }
      finally { setupDeploy.disabled = false; }
    })(); });
    armed(setupCancel, "放弃搭建", "确定放弃？", () => { setupState.textContent = "放弃后，已经搭到一半的东西不会继续。"; }, async () => {
      if (!setup) return;
      try {
        await ask(LINK, "gateway.setup.cancel", { setup_id: setup.setup_id });
        if (live()) { setup = null; showSetup(); setupState.textContent = "已放弃搭建。"; }
      } catch (error) { setupFailed("没能放弃，请重试。")(error); }
    });
    const readSetup = async () => {
      if (!setup?.setup_id) return;
      try { const state = await ask(LINK, "gateway.setup.status", { setup_id: setup.setup_id }); if (live()) await adopt(state); }
      catch (error) { setupFailed("没读到进度，请重试。")(error); }
    };

    // The devices.
    const gatewayStatus = node("p", "", "set-status");
    gatewayStatus.id = "settingsGatewayStatus";
    gatewayStatus.setAttribute("role", "status");
    const gatewayList = document.createElement("div");
    gatewayList.id = "settingsGatewayList";
    gatewayList.className = "set-group";
    const pairCode = button("添加设备", "btn", "settingsGatewayPair");
    const kinds = [["computer", "电脑"], ["server", "服务器"], ["browser", "浏览器（仅聊天和界面）"]];
    const pairKind = choose(kinds, "computer", "settingsGatewayPairKind");
    const permissions = (device, prefix) => {
      const box = node("div", "", "set-card");
      const tier = choose([["ask", "按规则和影响审批"], ["full", "完全放开（命令也不再询问）"]], device.tier || "ask", `${prefix}Access`);
      const check = (title, checked, id) => {
        const label = node("label", title); const input = document.createElement("input");
        input.type = "checkbox"; input.checked = checked; input.id = id; label.append(input); box.append(label); return input;
      };
      box.append(tier);
      const lend = check("借出它的能力（让 Ash 能用它）", device.lend === true, `${prefix}Lend`);
      const body = check("当作身体：让 Ash 读写它的文件、执行命令", device.body === true, `${prefix}Body`);
      const local = check("允许本地 Agent（使用电脑本地完整权限）", device.local_agents === true, `${prefix}Agents`);
      const web = check("允许访问 Ash 聊天和网页界面", device.web_ui === true, `${prefix}Web`);
      return { box,
        read: () => ({ tier: tier.value, lend: lend.checked, body: body.checked, local_agents: local.checked, web_ui: web.checked }),
        // A browser only gets the chat and the page.
        browser: (yes) => { for (const input of [tier, lend, body, local, web]) input.disabled = yes;
          if (yes) { tier.value = "ask"; lend.checked = body.checked = local.checked = false; web.checked = true; } } };
    };

    const pairResult = node("p", "", "set-status");
    pairResult.id = "settingsGatewayPairResult";
    pairResult.setAttribute("role", "status");
    // The pairing code is shown here and nowhere else: `pair_code` answers the owner on this machine only, and starting
    // a pairing says only that one began. The page watches the pairing while it is open: a state that changed means a
    // request arrived, or a device was approved or came online, so the list is read again.
    const pairBox = node("div", "", "set-card");
    pairBox.id = "settingsGatewayPairCode";
    pairBox.hidden = true;
    const pairText = node("p", "", "set-status");
    pairText.id = "settingsGatewayPairCodeText";
    const pairCommand = node("pre", "");
    pairCommand.id = "settingsGatewayPairCommand";
    const pairCopy = button("复制地址", "btn gray", "settingsGatewayPairCopy");
    pairBox.append(pairText, pairCommand, pairCopy);
    pairCommand.hidden = pairCopy.hidden = true;
    let shown = null, signature = null, polling = null;
    pairCopy.addEventListener("click", () => { void (async () => {
      try { await globalThis.navigator.clipboard.writeText(pairCommand.textContent); pairCopy.textContent = "已复制"; }
      catch { pairCopy.textContent = "长按上面的地址复制"; }
    })(); });
    const countdown = (ms) => { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };
    const showCode = () => {
      // A pairing that ended (approved, refused, or the device is online) leaves the page.
      if (shown && ["approved", "connected", "rejected"].includes(shown.state)) shown = null;
      const left = shown ? shown.deadline - Date.now() : 0;
      const state = shown?.state === "waiting" && left <= 0 ? "expired" : shown?.state;
      pairBox.hidden = !shown;
      pairCommand.hidden = pairCopy.hidden = state !== "waiting" || !shown?.url;
      if (!shown) return;
      if (state === "requested") { pairText.textContent = "配对码已使用。新设备发来的连接请求在上面，确认是你的设备再批准。"; return; }
      if (state === "expired") { pairText.textContent = "配对码已过期。需要时再点「添加设备」。"; return; }
      const how = !shown.url ? "" : shown.kind === "browser" ? "在新浏览器里打开下面的地址，再回到这里批准：" : "在要连接的电脑上用浏览器打开下面的地址，按页面提示安装，再回到这里批准：";
      pairText.textContent = `配对码：${shown.code}（还剩 ${countdown(left)}，只能用一次）。${how}`;
      pairCommand.textContent = shown.url ?? "";
    };
    const waitingPairs = (pairs) => pairs.filter((pair) => pair.state === "requested");
    const pairSignature = (pairs) => pairs.map((pair) => `${pair.pair_id}:${pair.state}`).join(",");
    let deviceCount = 0, waitingCount = 0;
    /** Reads the devices and the requests waiting for the owner, and draws both. */
    const refreshDevices = async () => {
      const [{ devices }, { pairs }] = await Promise.all([ask(DEVICES, "list", {}), ask(DEVICES, "pair_pending", {})]);
      if (!live()) return;
      signature = pairSignature(pairs ?? []);
      gatewayList.replaceChildren();
      gatewayList.hidden = true;
      gatewayStatus.textContent = "";
      const act = async (word, body) => { await ask(DEVICES, word, body); await refreshDevices(); };
      const failed = (text) => (error) => { if (live() && error?.code !== "stale") gatewayStatus.textContent = text; };
      for (const pending of waitingPairs(pairs ?? [])) {
        if (typeof pending.pair_id !== "string") continue;
        const kindName = KIND_NAMES[pending.kind] ?? "设备";
        const row = item(pending.name || `新${kindName}`, `等你批准 · ${kindName} · 先确认它是你的设备，再选择权限`);
        const prefix = `settingsPending-${pending.pair_id}`;
        const grant = permissions({ tier: "ask", lend: pending.kind !== "browser" }, prefix);
        grant.browser(pending.kind === "browser");
        const approve = button("批准");
        approve.id = `${prefix}Approve`;
        approve.addEventListener("click", () => { void act("pair_approve", { pair_id: pending.pair_id, ...grant.read() }).catch(failed("批准未确认，请刷新状态后检查。")); });
        const reject = button("拒绝", "btn gray");
        reject.id = `${prefix}Reject`;
        reject.addEventListener("click", () => { void act("pair_reject", { pair_id: pending.pair_id }).catch(failed("拒绝未确认，请重试。")); });
        row.append(grant.box, approve, reject);
        gatewayList.append(row);
      }
      const all = Array.isArray(devices) ? devices.filter((device) => typeof device?.device === "string" && typeof device.name === "string") : [];
      for (const device of all) {
        const id = device.device;
        const kindName = KIND_NAMES[device.kind] ?? "设备";
        if (device.revoked_at) {
          const row = item(device.name, `${kindName} · 已移除，连不上了`);
          const restore = button("恢复", "btn gray");
          restore.id = `settingsDevice-${id}Restore`;
          restore.addEventListener("click", () => { void act("restore", { device: id }).catch(failed("恢复未确认，请重试。")); });
          row.append(restore);
          gatewayList.append(row);
          continue;
        }
        const seen = !device.online && device.last_seen ? ` · 上次在线 ${clock(device.last_seen)}` : "";
        const row = item(device.name, `${kindName} · ${device.online ? "在线" : "离线"}${seen}${device.via === "gateway" ? " · 经中转站" : ""} · ${device.tier === "full" ? "完全放开" : "按规则审批"}`);
        const revoke = button("移除", "btn gray");
        revoke.id = `settingsDevice-${id}Revoke`;
        armed(revoke, "移除", "确定移除？", () => { gatewayStatus.textContent = `移除后 ${device.name} 需要重新配对才能连上。`; },
          () => act("revoke", { device: id }).catch(failed("移除未确认，请重试。")));
        row.append(revoke);
        const details = node("details"); details.append(node("summary", "名称、权限与诊断"));
        const nameInput = document.createElement("input"); nameInput.value = device.name; nameInput.setAttribute("aria-label", "设备名称");
        const rename = button("保存名称", "btn gray");
        rename.addEventListener("click", () => {
          const next = nameInput.value.trim();
          if (!next) { gatewayStatus.textContent = "名称不能是空的。"; return; }
          void act("rename", { device: id, name: next }).catch(failed("名称未保存。"));
        });
        const grant = permissions(device, `settingsDevice-${id}`); grant.browser(device.kind === "browser");
        const save = button("保存权限");
        save.addEventListener("click", () => { void act("access_set", { device: id, ...grant.read() }).catch(failed("权限未确认，请刷新状态后检查。")); });
        const diagnose = button("诊断", "btn gray"); const info = node("pre", "", "set-status");
        diagnose.addEventListener("click", () => { void (async () => {
          info.textContent = "正在诊断…";
          try {
            const hand = handOf(id);
            const [diagnosis, connected] = await Promise.all([ask(LINK, "diagnose", { hand }), ask(LINK, "list", {}).catch(() => ({ connections: [] }))]);
            if (live()) info.textContent = deviceDiagnosis({ device, diagnosis, connections: (connected.connections ?? []).filter((c) => c.hand === hand) });
          } catch (error) { if (live()) info.textContent = error?.code === "stale" ? "" : "诊断失败，请刷新状态。"; }
        })(); });
        details.append(nameInput, rename, grant.box, save, diagnose, info); row.append(details);
        gatewayList.append(row);
      }
      deviceCount = all.filter((device) => !device.revoked_at).length;
      waitingCount = waitingPairs(pairs ?? []).length;
      gatewayList.hidden = gatewayList.children.length === 0;
      if (gatewayList.hidden) gatewayStatus.textContent = "还没有连接其他设备。";
      showCode();
    };
    const readPairing = async () => {
      let pairs;
      try { pairs = (await ask(DEVICES, "pair_pending", {})).pairs ?? []; } catch { return; }
      if (!live()) return;
      let changed = signature !== null && pairSignature(pairs) !== signature;
      if (shown) {
        let own = pairs.find((pair) => pair.pair_id === shown.pair_id);
        if (!own) { own = await ask(DEVICES, "pair_status", { pair_id: shown.pair_id }).catch(() => null); if (!live()) return; }
        if (own?.state && own.state !== shown.state) { shown.state = own.state; changed = true; }
      }
      showCode();
      if (changed) await refreshDevices().catch(() => {});
    };
    const watch = () => {
      if (polling) return;
      let tick = 0;
      polling = setInterval(() => {
        if (!live() || gatewayPage.hidden) { clearInterval(polling); polling = null; return; }
        if (globalThis.document?.hidden) return;
        showCode();
        if (++tick % 2 === 0) { void readPairing(); if (SETUP_ACTIVE.includes(setup?.state)) void readSetup(); }
      }, 1000);
      polling.unref?.();
    };
    pairCode.addEventListener("click", () => { void (async () => {
      pairCode.disabled = true;
      pairResult.textContent = "正在生成配对码…";
      try {
        const started = await ask(DEVICES, "pair_start", { kind: pairKind.value });
        const issued = await ask(DEVICES, "pair_code", { pair_id: started.pair_id });
        if (!live()) return;
        pairCopy.textContent = "复制地址";
        shown = { pair_id: started.pair_id, kind: pairKind.value, code: issued.code, url: typeof issued.url === "string" ? issued.url : "",
          deadline: Number(issued.expires_at ?? started.expires_at) || Date.now(), state: "waiting" };
        showCode();
        pairResult.textContent = "";
      } catch (error) { if (live()) { pairResult.textContent = error?.code === "stale" ? "" : "生成失败：中转站可能离线，请稍后重试。"; shown = null; showCode(); } }
      finally { pairCode.disabled = false; }
    })(); });
    gatewayPage.append(gatewayStatus, gatewayList, pairKind, pairCode, pairResult, pairBox, node("h3", "中转站", "set-header"), relayCard);
    const openGateway = async () => {
      gatewayStatus.textContent = "正在读取…";
      signature = null;
      void refreshRelay().catch(() => { if (live()) relayStatus.textContent = "中转站状态读取失败。"; });
      try { await refreshDevices(); } catch { if (live()) gatewayStatus.textContent = "读取失败，请重试。"; }
      await readPairing();
      watch();
    };

    // ---- Browser logins (Android only)
    const browserPage = page("settingsBrowser", "浏览器登录",
      `${name} 用自己的浏览器帮你上网。你在里面登录过的网站只保存在这台手机上。`);
    if (android && typeof globalThis.__ashBrowserLogins === "function") {
      const clear = button("清除浏览器里的所有登录", "btn red", "settingsBrowserClear");
      const browserStatus = node("p", "", "set-status");
      browserStatus.id = "settingsBrowserStatus";
      browserStatus.setAttribute("role", "status");
      armed(clear, "清除浏览器里的所有登录", "再点一次确认清除", () => {
        browserStatus.textContent = `会清掉所有网站的登录并关闭浏览器，之后 ${name} 需要你重新登录。`;
      }, async () => {
        clear.disabled = true;
        browserStatus.textContent = "正在清除…";
        try {
          const result = await globalThis.__ashBrowserLogins();
          if (live()) browserStatus.textContent = result.ok ? "已清除所有登录。" : "清除失败，请重试。";
        } catch { if (live()) browserStatus.textContent = "清除失败，请重试。"; }
        finally { clear.disabled = false; }
      });
      browserPage.append(clear, browserStatus);
    }

    // ---- Apps: the same service:apps words an agent calls; installing here is the owner's own approval of what it needs.
    const apps = new AppsSettings((word, body) => callReply(APPS, word, body), { live, name,
      onSummary: (list) => { appsRow.sub.textContent = appsSummary(list); } });
    const appsPage = page("settingsApps", "应用",
      `装在 ${name} 里的应用。安装时列出它要用的东西，你点了才算同意；停用后权限还留着，收回后要重新安装。`, () => apps.load());
    appsPage.append(apps.root);

    // ---- Quiet hours (`delivery.quiet_hours`; "" means none)
    const quietPage = page("settingsQuiet", "免打扰",
      `这段时间里，${name} 想主动跟你说的事会先攒着，到点再告诉你。你找她、你定的提醒，照常送达。`, () => loadQuiet());
    const start = document.createElement("input");
    start.id = "settingsQuietStart";
    start.type = "time";
    start.value = QUIET_DEFAULT.slice(0, 5);
    const end = document.createElement("input");
    end.id = "settingsQuietEnd";
    end.type = "time";
    end.value = QUIET_DEFAULT.slice(6);
    const save = button("保存", "btn", "settingsQuietSave");
    const quietOff = button("不设免打扰", "btn gray", "settingsQuietOff");
    const quietStatus = node("p", "", "set-status");
    quietStatus.id = "settingsQuietStatus";
    quietStatus.setAttribute("role", "status");
    const range = document.createElement("div");
    range.className = "set-card set-range";
    range.append(node("span", "从", "set-sub"), start, node("span", "到", "set-sub"), end);
    const showQuiet = (quiet) => {
      if (quiet) [start.value, end.value] = quiet.split("-");
      quietRow.sub.textContent = quiet ? `每天 ${quiet.replace("-", " 到 ")} 不主动找你` : "没有设置免打扰";
    };
    const loadQuiet = async () => {
      quietStatus.textContent = "正在读取…";
      try {
        const quiet = quietOf((await ask(ADMIN, "settings.get", { keys: [QUIET_KEY] })).settings);
        if (quiet === null) throw new Error("unreadable");
        showQuiet(quiet);
        quietStatus.textContent = "";
      } catch { if (live()) quietStatus.textContent = "读取失败，请返回后重试。"; }
    };
    const saveQuiet = async (quiet) => {
      quietStatus.textContent = "正在保存…";
      try {
        if (quiet !== "" && !QUIET_FORMAT.test(quiet)) throw new Error("invalid");
        const reply = await ask(ADMIN, "settings.set", { [QUIET_KEY]: quiet });
        if (reply[QUIET_KEY] !== quiet) throw new Error("unconfirmed");
        showQuiet(quiet);
        quietStatus.textContent = quiet ? "已保存免打扰时段。" : "已关闭免打扰。";
      } catch { if (live()) quietStatus.textContent = "保存未确认，请重试。"; }
    };
    save.addEventListener("click", () => { void saveQuiet(`${start.value}-${end.value}`); });
    quietOff.addEventListener("click", () => { void saveQuiet(""); });
    quietPage.append(range, save, quietOff, quietStatus);

    // ---- Approval: one choice, how often she asks before acting (`service:gate`).
    const APPROVAL_MODES = [
      { mode: "auto", title: "有影响时才问", sub: `替你对外发消息、删改你的数据、花钱或执行命令前先问你；看、找、打开这类可撤回的事 ${name} 直接做。` },
      { mode: "always", title: "每次都问", sub: `除了看和读，外部操作都先问你；单独设为「完全放开」的电脑除外。` },
    ];
    const approvalPage = page("settingsApproval", "审批",
      `「有影响时才问」会使用你选过的「以后都允许」规则；「每次都问」会暂停这些规则，切回后继续生效。在 ${name} 的人物页里能看到每次是怎么决定的。`, () => loadApproval());
    const approvalStatus = node("p", "", "set-status");
    approvalStatus.id = "settingsApprovalStatus";
    approvalStatus.setAttribute("role", "status");
    const approvalChoices = APPROVAL_MODES.map(({ mode, title, sub }) => {
      const row = document.createElement("button");
      row.type = "button";
      row.id = `settingsApproval_${mode}`;
      row.className = "set-row";
      row.approvalMode = mode;
      const text = document.createElement("span");
      text.className = "set-text";
      text.append(node("span", title, "set-title"), node("span", sub, "set-sub"));
      const mark = node("span", "", "set-value");
      row.append(text, mark);
      row.mark = mark;
      row.addEventListener("click", () => { void saveApproval(mode); });
      return row;
    });
    const showApproval = (mode) => {
      for (const row of approvalChoices) {
        const chosen = row.approvalMode === mode;
        row.mark.textContent = chosen ? "✓" : "";
        row.setAttribute("aria-pressed", String(chosen));
      }
      approvalRow.sub.textContent = mode === "always" ? "每次都问" : "有影响时才问";
    };
    const loadApproval = async () => {
      approvalStatus.textContent = "正在读取…";
      try {
        const { mode } = await ask(GATE, "rules.list", { limit: 1 });
        if (mode !== "auto" && mode !== "always") throw new Error("unavailable");
        showApproval(mode);
        approvalStatus.textContent = "";
      } catch { if (live()) approvalStatus.textContent = "读取失败，请返回后重试。"; }
    };
    const saveApproval = async (mode) => {
      for (const row of approvalChoices) row.disabled = true;
      approvalStatus.textContent = "正在保存…";
      try {
        const reply = await ask(GATE, "mode.set", { mode });
        if (reply.mode !== mode) throw new Error("unconfirmed");
        showApproval(mode);
        approvalStatus.textContent = "已保存。";
      } catch { if (live()) approvalStatus.textContent = "保存未确认，请重试。"; }
      finally { for (const row of approvalChoices) row.disabled = false; }
    };
    approvalPage.append(group("", ...approvalChoices), approvalStatus);

    // ---- Proactive preferences
    const proactivePage = page("settingsProactivePage", "主动联系",
      `告诉 ${name} 什么时候可以主动找你、哪些事值得说。用平常的话写就行。`, () => this.preferences?.load());
    const preferencesRoot = document.createElement("div");
    preferencesRoot.id = "settingsProactive";
    proactivePage.append(preferencesRoot);

    // ---- Developer options
    const devPage = page("settingsDev", "开发者选项", `给开发和排查问题用。改错了可能让 ${name} 无法正常工作。`, () => {
      void loadModel();
      void readPlugins().catch(() => { if (live()) pluginsStatus.textContent = "插件读取失败，请重试。"; });
    });
    const modelSection = document.createElement("div");
    modelSection.id = "settingsModel";
    modelSection.className = "set-card";
    const provider = document.createElement("input");
    provider.id = "settingsModelProvider";
    provider.placeholder = "Provider（比如 deepseek）";
    const model = document.createElement("input");
    model.id = "settingsModelName";
    model.placeholder = "Model";
    const modelSave = button("保存模型", "btn", "settingsModelSave");
    const modelStatus = node("p", "", "set-status");
    modelStatus.id = "settingsModelStatus";
    modelStatus.setAttribute("role", "status");
    // The hub has no getter for the model: it is what the primary agent runs. Only the model is known there, so the
    // provider is left for the owner to fill in rather than guessed.
    const loadModel = async () => {
      modelStatus.textContent = "正在读取…";
      try {
        const { agents } = await ask(AGENTS, "list", {});
        const runtime = (Array.isArray(agents) ? agents : []).find((agent) => agent.primary === true)?.runtime;
        if (!live()) return;
        model.value = typeof runtime?.model === "string" ? runtime.model : "";
        modelStatus.textContent = model.value ? "" : "没有读到现在用的模型，请直接填写。";
      } catch { if (live()) modelStatus.textContent = "读取失败，请返回后重试。"; }
    };
    modelSave.addEventListener("click", () => { void (async () => {
      modelStatus.textContent = "正在保存…";
      try {
        const requested = { provider: provider.value.trim(), model: model.value.trim() };
        if (!requested.provider || !requested.model) { modelStatus.textContent = "Provider 和 Model 都要填。"; return; }
        const reply = await ask(ADMIN, "model.set", requested);
        if (reply.provider !== requested.provider || reply.model !== requested.model || typeof reply.restart_required !== "boolean") throw new Error("unconfirmed");
        modelStatus.textContent = reply.restart_required ? `已保存；重启 ${name} 后主模型生效。` : "已保存，下一条消息起就用它。";
      } catch { if (live()) modelStatus.textContent = "保存未确认，请重试。"; }
    })(); });
    modelSection.append(node("span", "主模型", "set-title"), provider, model, modelSave, modelStatus);
    const pluginsSection = document.createElement("div");
    pluginsSection.id = "settingsPlugins";
    const pluginsStatus = node("p", "", "set-status");
    pluginsStatus.id = "settingsPluginsStatus";
    pluginsStatus.setAttribute("role", "status");
    const pluginsList = document.createElement("div");
    pluginsList.id = "settingsPluginsList";
    pluginsList.className = "set-group";
    const readPlugins = async () => {
      pluginsStatus.textContent = "正在读取…";
      const { plugins } = await ask(ADMIN, "plugins.list", {});
      if (!Array.isArray(plugins)) throw new Error("plugins unavailable");
      if (!live()) return;
      pluginsList.replaceChildren();
      for (const plugin of plugins) {
        const entry = plugin?.entryId ?? plugin?.id;
        const title = plugin?.moduleName ?? plugin?.name;
        if (typeof entry !== "string" || typeof title !== "string") continue;
        const row = item(title, plugin.enabled ? "已启用" : "已停用");
        row.setAttribute("data-plugin-id", entry);
        if (!plugin.readOnlyReason) {
          const toggle = button(plugin.enabled ? "停用" : "启用", "btn gray");
          toggle.addEventListener("click", () => { void (async () => {
            toggle.disabled = true;
            pluginsStatus.textContent = "正在保存…";
            try {
              const result = await ask(ADMIN, "plugins.op", { op: "plugin", id: entry, enabled: !plugin.enabled });
              if (typeof result.application === "string" && !["applied", "restart-required"].includes(result.application)) throw new Error("operation failed");
              await readPlugins();
              pluginsStatus.textContent = result.application === "restart-required" ? `已保存；重启 ${name} 后生效。` : "已更新插件。";
            } catch { if (live()) pluginsStatus.textContent = "插件更新未确认，请重试。"; }
            finally { toggle.disabled = false; }
          })(); });
          row.append(toggle);
        }
        pluginsList.append(row);
      }
      pluginsStatus.textContent = `已安装 ${plugins.length} 个插件。`;
    };
    pluginsSection.append(pluginsStatus, pluginsList);
    devPage.append(modelSection, node("h3", "DSH 插件", "set-header"), pluginsSection);

    // ---- What the home rows say: read when the drawer opens and whenever you come back to it.
    this.refreshHome = async () => {
      void apps.summary();
      const settled = (work) => work.then((value) => value, () => null);
      const readDevices = async () => {
        const [{ devices }, { pairs }] = await Promise.all([ask(DEVICES, "list", {}), ask(DEVICES, "pair_pending", {})]);
        return { devices: Array.isArray(devices) ? devices : [], pairs: Array.isArray(pairs) ? pairs : [] };
      };
      const [status, quietSettings, approval, usage, vault, devices, relayState] = await Promise.all([
        settled(ask(ADMIN, "status", {})), settled(ask(ADMIN, "settings.get", { keys: [QUIET_KEY] })), settled(ask(GATE, "rules.list", { limit: 1 })),
        settled(ask(COST, "usage.get", { days: 7 })), settled(readVault()), settled(readDevices()), settled(ask(LINK, "gateway.status", {}))]);
      if (!live()) return;
      const quiet = quietSettings ? quietOf(quietSettings.settings) : null;
      if (quiet !== null) showQuiet(quiet);
      if (typeof status?.paused === "boolean") showPaused(status.paused);
      if (approval?.mode === "auto" || approval?.mode === "always") showApproval(approval.mode);
      if (usage) showUsage(usage);
      else usageMore.textContent = "用量暂时读不到";
      if (vault?.available === false) {
        vaultRow.sub.textContent = "手机安全存储暂时不可用";
        vaultRow.sub.className = "set-sub warn";
      } else if (vault) {
        const saved = (ref) => vault.entries.find((entry) => entry.ref === ref)?.configured === true;
        vaultRow.sub.textContent = KEYS.map(({ ref, title }) => `${title} ${saved(ref) ? "已保存" : "未设置"}`).join(" · ");
        vaultRow.sub.className = saved(KEYS[0].ref) ? "set-sub" : "set-sub warn";
      }
      if (devices || relayState) {
        const count = devices ? devices.devices.filter((device) => !device.revoked_at).length : deviceCount;
        const waiting = devices ? waitingPairs(devices.pairs).length : waitingCount;
        const broken = relayState?.configured === true && relayState.connected !== true;
        gatewayRow.sub.textContent = relayState && relayState.configured !== true ? "还没有设置中转站" : broken ? "中转站连不上，点开看原因"
          : `${count ? `${count} 台设备` : "还没有连接其他设备"}${waiting ? ` · ${waiting} 个等你批准` : ""}`;
        gatewayRow.sub.className = waiting || broken ? "set-sub warn" : "set-sub";
      }
    };

    this.showHome = () => show(home);
    this.panel.append(section);
    this.section = section;
    this.sectionContext = context;
    this.preferences = new ProactivePreferences(preferencesRoot, this.net, () => live() && this.online);
  }
}
