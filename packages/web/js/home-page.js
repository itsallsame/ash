// 她的主页: who she is right now, what waits for you, what is coming, what she remembers, what you agreed, her hands and eyes,
// who she is, her files, and the backstage. Every block opens a page of its own (home-pages.js).
import { ago, dayTime, duration, h, hhmm, ico, startOfDay, weekday, fill } from "./home-dom.js";
import { card, list, note, row, section, tag } from "./home-ui.js";
import { groupMemory, memoryCount, nextUp, turnsToday, urgentGroup, waitingItems } from "./home-model.js";
import { quoteOf, readApproval, readClock, readDevices, readFile, readPersona, readQuiet, readUsage, readAgents, settled } from "./home-data.js";
import { usdToCnyText as money } from "./money.js";
import { repeatText } from "./clock.js";
import { pauseControl } from "./home-pause.js";
import { listDirectory } from "./body.js";
import { BODY_MAIN } from "./body.js";
import { KEYS } from "./home-text.js";
import { appsSummary } from "./home-text.js";

const AVATAR_ROOT = globalThis.location?.origin === "https://appassets.androidplatform.net" ? "/assets/ash-ui/avatars" : "/avatars";
const FACE = { idle: "default", resting: "resting", listening: "listening", thinking: "thinking", working: "focused", done: "success", waiting_you: "listening" };
const STATE_TEXT = { idle: "在线", resting: "休息中", listening: "在听", thinking: "在想", working: "在忙", done: "", waiting_you: "等你一句话" };
const LETTER_TONES = ["--you", "--her-fill", "--warn-fill", "--ok-fill"];

/** The face and the state line of an agent: presence of the ledger, as the conversation's top bar says it. */
function stateOf(view, agent = null, online = true) {
  const turns = Object.values(view?.turns ?? {}).filter((turn) => turn.background !== true && !Number.isFinite(turn.ended) && (!agent || turn.agent === agent)).sort((a, b) => b.started - a.started);
  const open = turns[0];
  if (!online) return { state: "resting", face: "resting", text: "离线", tone: "mute", since: null };
  if (open) {
    const doing = open.steps.filter((step) => !step.summary && step.state === "pending").at(-1);
    return doing ? { state: "working", face: "focused", text: doing.label, tone: "her", since: open.started } : { state: "thinking", face: "thinking", text: "在想", tone: "her", since: open.started };
  }
  const asked = (view?.asks ?? []).some((ask) => ask.state === "pending" && ask.expires_at > Date.now() && (!agent || ask.from === agent));
  if (asked) return { state: "waiting_you", face: "listening", text: STATE_TEXT.waiting_you, tone: "warn", since: null };
  return { state: "idle", face: "default", text: STATE_TEXT.idle, tone: "ok", since: null };
}

const letterAvatar = (name, size) => {
  const letter = [...(name || "?")][0].toUpperCase();
  const tone = LETTER_TONES[[...name].reduce((sum, char) => sum + char.codePointAt(0), 0) % LETTER_TONES.length];
  return h("span", { class: `av av-letter ${size}`, style: `background:var(${tone})` }, h("span", { class: "hm-letter" }, letter));
};

const stat = (value, label, { tone = "", onClick, id }) => h("button", { type: "button", class: "hm-stat", id, onclick: onClick }, h("span", { class: `tx-num hm-stat-n${tone ? ` c-${tone}` : ""}` }, value), h("span", { class: "tx-caption" }, label));

/** Words with the changeable parts in the accent colour: `words("每天 ", ["21:30"], " 到 ")`. */
const words = (...parts) => parts.map((part) => Array.isArray(part) ? h("b", { class: "hm-word" }, part[0]) : part);

const firstLine = (text) => String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line && !/^#{1,6}\s/.test(line)) ?? "";

export function homePage(ctx, screen) {
  const agentId = ctx.agent;
  const isHer = !agentId;
  const state = { usage: null, clock: null, memory: null, quiet: undefined, approval: null, proactive: undefined, devices: null, apps: null, soul: null, files: null, agents: null, relay: null };
  const hero = h("div", { class: "hm-hero" });
  const body = h("div", { class: "hm-blocks" });
  const online = () => ctx.net.status === "online";
  const view = () => ctx.feed.view();

  // ---- 她此刻
  const heroStat = h("div", { class: "hm-stats" });
  const drawHero = () => {
    const v = view();
    const st = stateOf(v, agentId, online());
    const name = isHer ? ctx.name : (state.agents?.find((agent) => agent.id === agentId)?.name ?? agentId.replace(/^agent:/, ""));
    const waiting = !agentId && Number.isSafeInteger(v.waiting_count) ? v.waiting_count : waitingItems(v).filter((item) => !agentId || item.ask.from === agentId).length;
    const today = state.usage?.periods?.today?.cost_usd;
    const live = st.state === "working" ? " av-live" : st.state === "thinking" ? " av-breath" : st.state === "waiting_you" ? " av-wait" : "";
    // A quiet dot when she is simply here (green) or away (grey); a ring only while she is doing something, thinking or asking.
    const dot = st.state === "idle" ? h("span", { class: "dot" }) : st.state === "resting" ? h("span", { class: "dot off" }) : null;
    const face = isHer ? h("span", { class: `av hm-avatar${live}${online() ? "" : " off"}` }, h("img", { src: `${AVATAR_ROOT}/${st.face}.webp`, alt: "" }), dot) : letterAvatar(name, `hm-avatar${live}`);
    const since = st.since ? ` · ${duration(Math.max(0, Date.now() - st.since))}` : "";
    const pill = h("span", { class: `tag tag-${st.tone} hm-state`, id: "homeState" }, st.state === "working" || st.state === "thinking" ? h("span", { class: "spinner hm-spin" }) : null, `${st.text}${since}`);
    fill(heroStat, 
      stat(String(turnsToday(v, Date.now(), agentId)), "今天做的事", { onClick: () => ctx.go("activity", agentId), id: "homeStatDone" }),
      stat(String(waiting), "等你", { tone: waiting ? "warn" : "", onClick: () => ctx.go("waiting", agentId), id: "homeStatWaiting" }),
      stat(typeof today === "number" ? money(today) : "—", "今天花的", { onClick: () => ctx.go("backstage"), id: "homeStatSpent" }));
    fill(hero, face, h("span", { class: "hm-name", id: "homeName" }, name), pill, heroStat);
  };

  // ---- 等你的
  const waitingBox = h("div");
  const drawWaiting = () => {
    const v = view();
    const items = waitingItems(v).filter((item) => !agentId || item.ask.from === agentId);
    const now = Date.now();
    screen.wake("expiry", draw, Math.min(...items.map(({ ask }) => ask.expires_at)));
    const rows = items.slice(0, 3).map(({ kind, ask }) => row({ icon: kind === "approval" ? "shield" : "ask", tone: kind === "approval" ? "warn" : "her", tall: true, title: ask.title,
      sub: kind === "approval" ? `${firstLine(ask.detail).slice(0, 24)}${ask.detail ? " · " : ""}${dayTime(ask.expires_at, now)} 前有效` : `${agentId ? "" : "她"}问你 · ${ago(ask.ts, now)}`,
      onClick: () => ctx.go("waiting", agentId) }));
    fill(waitingBox, section("等你的", { right: (v.waiting_count ?? items.length) ? `${v.waiting_count ?? items.length} 件` : null },
      rows.length ? list(...rows) : list(row({ icon: "check", tone: "ok", title: "没有要你决定的事", sub: "有事她会在这里和对话里叫你" }))));
  };

  // ---- 接下来
  const upcomingBox = h("div");
  const drawUpcoming = () => {
    const timers = state.clock;
    const items = timers ? nextUp(timers.filter((timer) => !agentId || timer.to === agentId), 6) : [];
    const day = (ts) => { const diff = Math.round((startOfDay(ts) - startOfDay(Date.now())) / 86_400_000); return diff === 0 ? "今天" : diff === 1 ? "明天" : weekday(ts); };
    const cards = items.map((timer) => h("button", { type: "button", class: "hm-when", dataset: { timer: timer.id }, onclick: () => ctx.go("upcoming") },
      h("span", { class: "tx-caption" }, day(timer.next)), h("span", { class: "tx-num hm-when-time" }, hhmm(timer.next)), h("span", { class: "hm-when-what" }, timer.label || "没有名字的计划"),
      h("span", { class: "tx-caption hm-when-rep" }, timer.every ? ico("repeat") : null, repeatText(timer.every))));
    fill(upcomingBox, section("接下来", { right: timers ? "全部" : null, onOpen: () => ctx.go("upcoming") },
      !timers ? note("正在读取…") : cards.length ? h("div", { class: "hm-strip" }, ...cards) : list(row({ icon: "clock", title: "暂时没有计划", sub: "她答应到点做的事会出现在这里" }))));
  };

  // ---- 她记得你
  const memoryBox = h("div");
  const drawMemory = () => {
    const groups = state.memory;
    const total = groups ? memoryCount(groups) : 0;
    let chips = [];
    if (groups) {
      const all = groups.flatMap((g) => g.items.map((text) => ({ text, urgent: urgentGroup(g.title) })));
      all.sort((a, b) => Number(b.urgent) - Number(a.urgent));
      chips = all.slice(0, 5).map((item) => h("span", { class: `hm-chip${item.urgent ? " urgent" : ""}` }, item.text));
      if (total > 5) chips.push(h("span", { class: "hm-chip more" }, `还有 ${total - 5} 条`));
    }
    fill(memoryBox, section("她记得你", { right: groups ? (total ? `${total} 条` : null) : null, onOpen: () => ctx.go("memory") },
      !groups ? note("正在读取…") : chips.length ? card("hm-chips", ...chips) : list(row({ icon: "pen", title: "她还没记下关于你的事", sub: "聊得多了，她会自己整理在这里" }))));
  };

  // ---- 你们的约定
  const promisesBox = h("div");
  const drawPromises = () => {
    const rules = state.approval?.rules ?? [];
    const quiet = state.quiet;
    const proactive = state.proactive;
    const rows = [];
    rows.push(row({ icon: "moon", title: quiet === undefined ? "正在读取…" : quiet ? words("每天 ", [quiet.split("-")[0]], " 到 ", [quiet.split("-")[1]], " 不主动找你") : "没有设置免打扰，她随时可能找你", onClick: () => ctx.go("promises"), tall: true, right: false }));
    rows.push(row({ icon: "shield", title: state.approval?.mode === "always" ? words("", ["每次都"], "先问你再做事") : words("做", ["有影响的事"], "之前先问你"),
      sub: rules.length ? `${rules.length} 件事你说过以后都可以` : null, onClick: () => ctx.go("promises"), tall: true, right: false }));
    const line = proactive === undefined ? null : firstLine(proactive);
    rows.push(row({ icon: "bell", title: proactive === undefined ? "正在读取…" : line || "关于你的偏好，还没写", titleTone: line ? "" : "3",
      sub: line ? (proactive.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[1] ?? null) : null,
      right: line || proactive === undefined ? false : h("span", { class: "tx-sub c-you" }, "写一句"), onClick: () => ctx.go("promises", "proactive"), tall: true }));
    fill(promisesBox, section("你们的约定", {}, list(...rows)));
  };

  // ---- 她的手和眼
  const handsBox = h("div");
  const native = () => typeof globalThis.__ashOpenNative === "function";
  const drawHands = () => {
    const checkup = globalThis.__ashCheckup?.() ?? null;
    const todo = Number.isFinite(checkup?.todo) ? checkup.todo : 0;
    const devices = state.devices?.devices?.filter((device) => !device.revoked_at && device.kind !== "browser") ?? [];
    const online = devices.filter((device) => device.online);
    const waiting = state.devices?.pairs?.filter((pair) => pair.state === "requested").length ?? 0;
    const android = globalThis.location?.origin === "https://appassets.androidplatform.net";
    const cell = (icon, title, sub, { tone = "", subTone = "", onClick, id }) => h("button", { type: "button", class: "hm-cell", id, onclick: onClick },
      h("span", { class: `lic hm-cell-ic${tone ? ` lic-${tone}` : ""}` }, ico(icon, "i-s")), h("span", { class: "hm-cell-t" }, h("span", { class: "hm-cell-name" }, title), h("span", { class: `tx-caption${subTone ? ` c-${subTone}` : ""}` }, sub)));
    const cells = [];
    if (native()) cells.push(cell("phone", "这台手机", todo ? `${todo} 项要处理` : "状态良好", { tone: todo ? "warn" : "", subTone: todo ? "warn" : "ok", onClick: () => globalThis.__ashOpenNative("checkup"), id: "homeCellPhone" }));
    cells.push(cell("laptop", devices.length ? (devices.length === 1 ? devices[0].name : "电脑") : "电脑",
      waiting ? `${waiting} 台等你批准` : devices.length ? (online.length ? `${online.length} 台在线` : "都不在线") : "还没有连接",
      { subTone: waiting ? "warn" : online.length ? "ok" : "", tone: waiting ? "warn" : "", onClick: () => ctx.go("hands"), id: "homeCellComputers" }));
    if (android && typeof globalThis.__ashBrowserLogins === "function") cells.push(cell("globe", "她的浏览器", "登录过的网站", { onClick: () => ctx.go("browser"), id: "homeCellBrowser" }));
    cells.push(cell("grid", "应用", state.apps ? appsSummary(state.apps).replace(/^\d+ 个应用 · /, "") : "—", { onClick: () => native() ? globalThis.__ashOpenNative("apps") : ctx.go("apps"), id: "homeCellApps" }));
    fill(handsBox, section("她的手和眼", { right: todo ? tag(`${todo} 项要处理`, "warn") : waiting ? tag(`${waiting} 个等你批准`, "warn") : null }, h("div", { class: "hm-cells" }, ...cells)));
  };

  // ---- 她是谁
  const whoBox = h("div");
  const drawWho = () => {
    const quote = state.soul === null ? "" : quoteOf(state.soul);
    fill(whoBox, section("她是谁", { right: "性格 · 名片", onOpen: () => ctx.go("identity") },
      card("hm-quote", h("span", { class: "hm-quote-mark", "aria-hidden": "true" }, "“"),
        h("span", { class: "hm-quote-text" }, state.soul === undefined ? "正在读取…" : quote || "她的性格还没写下来。"),
        h("button", { type: "button", class: "tx-caption hm-quote-hint", onclick: () => ctx.compose?.("我想给你换个名字，以后叫你") }, `想给她换个名字？直接跟她说。`))));
  };

  // ---- 她的文件
  const filesBox = h("div");
  const drawFiles = () => {
    const entries = state.files;
    const files = entries ? entries.filter((entry) => entry.type !== "directory").slice(0, 2) : [];
    fill(filesBox, section("她的文件", { right: "全部", onOpen: () => ctx.go("files") },
      !entries ? note("正在读取…") : files.length ? list(...files.map((file) => row({ icon: "file", tone: "you", title: file.name, sub: Number.isFinite(file.size) ? `${Math.max(1, Math.ceil(file.size / 1024))} KB` : null, onClick: () => ctx.go("files", file.name) })))
        : list(row({ icon: "file", title: "还没有文件", sub: "她做出来的文档会放在这里", onClick: () => ctx.go("files") }))));
  };

  // ---- 幕后
  const backstageBox = h("div");
  const pause = pauseControl(ctx, screen, "btn-ghost btn-block hm-danger");
  const drawBackstage = () => {
    const keys = state.keys;
    const keyText = !keys ? "" : keys.problem ? keys.problem : keys.missing ? `${keys.missing}还没设` : "已保存";
    const model = state.agents?.find((agent) => agent.primary === true)?.runtime?.model;
    const week = state.usage?.periods?.["7d"]?.cost_usd;
    fill(backstageBox, h("section", { class: "hm-section hm-back" }, h("div", { class: "hm-head" }, h("span", { class: "tx-sub hm-backttl" }, "幕后")),
      h("div", { class: "list hm-plain" },
        row({ icon: "key", title: "密钥", value: keyText, valueTone: keys && (keys.problem || keys.missing) ? "warn" : "", onClick: () => ctx.go("keys") }),
        row({ icon: "cpu", title: "模型", value: model ?? "", onClick: () => ctx.go("model") }),
        row({ icon: "coin", title: "花了多少", value: typeof week === "number" ? `近 7 天 ${money(week)}` : "", onClick: () => ctx.go("usage") }),
        row({ icon: "slider", title: "高级", onClick: () => ctx.go("advanced") })),
      pause.root));
  };

  const draw = () => { drawHero(); drawWaiting(); };
  if (isHer) body.append(waitingBox, upcomingBox, memoryBox, promisesBox, handsBox, whoBox, filesBox, backstageBox);
  else body.append(waitingBox, upcomingBox);
  const drawAll = () => { draw(); drawUpcoming(); drawMemory(); drawPromises(); drawHands(); drawWho(); drawFiles(); drawBackstage(); };
  drawAll();
  screen.onView(draw);
  // The seconds she has been at it are the only thing that moves by itself; the name moves when it is changed.
  screen.every(() => { if (stateOf(view(), agentId, online()).since) drawHero(); }, 1000);
  screen.onName(drawHero);
  screen.every(() => { void refresh(); }, 15_000);
  screen.listen(globalThis, "ash:checkup", drawHands);

  async function refresh() {
    const loads = [
      settled(readUsage(screen)).then((usage) => { if (usage) state.usage = usage; drawHero(); drawBackstage(); }),
      settled(readAgents(screen)).then((agents) => { if (agents) state.agents = agents; drawHero(); drawBackstage(); }),
      settled(readClock(screen)).then((timers) => { if (timers) state.clock = timers; drawUpcoming(); }),
    ];
    if (isHer) {
      loads.push(
        settled(readFile(screen, "USER.md")).then((file) => { state.memory = file ? groupMemory(file.text) : []; drawMemory(); }),
        settled(readQuiet(screen)).then((quiet) => { if (quiet !== null) state.quiet = quiet; drawPromises(); }),
        settled(readApproval(screen)).then((approval) => { if (approval) state.approval = approval; drawPromises(); }),
        settled(readFile(screen, "PROACTIVE.md")).then((file) => { state.proactive = file ? file.text : ""; drawPromises(); }),
        settled(readDevices(screen)).then((devices) => { if (devices) state.devices = devices; drawHands(); }),
        settled(screen.call("service:apps", "apps.list", {})).then((reply) => { const apps = reply?.ok === true ? reply.result?.data?.apps : null; if (Array.isArray(apps)) state.apps = apps; drawHands(); }),
        settled(readPersona(screen, "SOUL.md")).then((soul) => { state.soul = soul ?? ""; drawWho(); }),
        settled(listDirectory(ctx.net, BODY_MAIN, "")).then((listing) => { if (screen.alive()) { state.files = (listing?.entries ?? []).sort((a, b) => a.name.localeCompare(b.name)); drawFiles(); } }),
        settled(Promise.all([screen.ask("service:vault", "list", {}), screen.ask("service:llm", "keys.status", {}).catch(() => ({ keys: [] }))])).then((result) => {
          if (!result) return;
          const [{ entries }, { keys }] = result;
          const saved = (ref) => (entries ?? []).find((entry) => entry.ref === ref)?.configured === true;
          const standing = (ref) => (keys ?? []).find((item) => item?.ref === ref && item.configured === true)?.status;
          const problem = KEYS.find(({ ref }) => saved(ref) && ["rejected", "low_balance"].includes(standing(ref)));
          const missing = KEYS.find(({ ref }) => !saved(ref));
          state.keys = { problem: problem ? (standing(problem.ref) === "rejected" ? `${problem.title} 已失效` : `${problem.title} 余额不足`) : "", missing: missing ? (missing.provider === "deepseek" ? "对话" : "快速判断") : "" };
          drawBackstage();
        }),
      );
      loads.push(pause.refresh());
    }
    await Promise.all(loads);
  }

  return { title: "", body: h("div", { class: "hm-home" }, h("div", { class: "hm-glow", "aria-hidden": "true" }), hero, body), refresh };
}
