// 她的状态 · 页面的控制：读数据、画、点了什么就做什么。home.html 和 alert.html 是同一份代码，只差 surface。
import { build, COPY } from "./model.mjs";
import { call, openLink, ready } from "./host.mjs";
import { confirmSheet, detailPage, drawTrend, h, homePage, unreadable } from "./view.mjs";

/** 这个应用自己的工具（packages/apps/vitals 的服务端）：status 灯、说的话、告警、底线、体检（每 15 秒），day 今天和 24 小时（每 60 秒），restart 重启大脑（只在确认之后）。 */
export const TOOLS = { status: "vitals.status", day: "vitals.day", restart: "vitals.restart" };
// 15 秒一次，不更勤：中枢「闲着时同一件事每分钟超 6 次就报空转」，页面每读一次就是窗口里的一次调用；退到后台 / 息屏就停，回来立刻读一次。
const REFRESH_MS = 15_000, DAY_MS = 60_000;

/**
 * [surface]: "home"（整页，点告警进详情，详情里有返回）或 "alert"（直接是详情：进行中的那条，没有就最近一条；「知道了」后回到列表）。
 * [avatar]: 她的头像（data: 地址，沙箱页面引不到主页面的文件）。
 */
export function start({ surface, avatar, root = document.getElementById("app"), now = () => Date.now(), refreshMs = REFRESH_MS, dayMs = DAY_MS }) {
  const state = { status: null, day: null, failed: false, view: null, selected: location.hash.slice(1) || null, sheet: null, picked: false };

  const alertOf = () => {
    const list = state.view?.alerts ?? [];
    if (state.selected) return list.find((a) => a.key === state.selected) ?? null;
    if (surface === "alert" && !state.picked) return list.find((a) => a.live) ?? list[0] ?? null;
    return null;
  };

  const actions = {
    open: (a) => { state.selected = a.key; state.picked = true; render(true); },
    dismiss: () => { state.selected = null; state.picked = true; render(true); },
    checkup: (part) => { void openLink(part ? `ash://checkup/${encodeURIComponent(part)}` : "ash://checkup").catch(() => {}); },
    act: (a, x) => {
      if (x.kind === "restart_brain") { state.sheet = { a, busy: false }; render(false); }
      else if (x.kind === "open_checkup") actions.checkup();
      else if (x.kind === "open_device") { if (a.device) void openLink(`ash://device/${encodeURIComponent(a.device.id)}`).catch(() => {}); }
      else if (x.kind === "open_keys") void openLink("ash://keys").catch(() => {});
      else if (x.kind === "dismiss") actions.dismiss();
      else if (x.kind === "copy_debug") actions.copyDebug(a);
    },
    copyDebug: async (a) => {
      let ok = false;
      const text = JSON.stringify(a.debug, null, 2);
      try { await navigator.clipboard.writeText(text); ok = true; }
      catch {
        const box = h("textarea", { style: "position:fixed;opacity:0" }); box.value = text; document.body.append(box); box.select();
        try { ok = document.execCommand("copy"); } catch { ok = false; }
        box.remove();
      }
      toast(ok ? COPY.app.copied : COPY.app.copy_failed);
    },
  };

  function toast(text) {
    const el = h("div", { class: "vt-toast", role: "status" }, text);
    document.body.append(el);
    setTimeout(() => el.remove(), 2200);
  }

  async function restart() {
    const sheet = state.sheet;
    if (!sheet || sheet.busy) return;
    sheet.busy = true; render(false);
    try { await call(TOOLS.restart, { confirmed: true }); state.sheet = null; render(false); setTimeout(() => void load(), 12_000); }
    catch { state.sheet = null; render(false); toast(COPY.app.restart_failed); }
  }

  function render(top) {
    const y = window.scrollY;
    const a = alertOf();
    const body = !state.view ? (state.failed ? unreadable() : h("div"))
      : a ? detailPage(a, actions, { back: surface === "home", avatar })
      : surface === "alert" && !state.view.alerts.length ? alertsOnly() : homePage(state.view, actions);
    root.replaceChildren(body);
    if (state.sheet) root.append(confirmSheet(state.sheet.a, { yes: restart, no: () => { state.sheet = null; render(false); }, busy: state.sheet.busy }));
    drawTrend(root, state.view ?? {});
    window.scrollTo(0, top ? 0 : y);
    document.documentElement.dataset.level = state.view?.level ?? "";
  }

  /** alert 页面没有任何告警：就是「最近一切正常」那一块（和首页同一块）。 */
  const alertsOnly = () => homePage({ ...state.view, alertsFirst: true, tiles: [], today: [], rules: [], trend: null, checkup: null, action: null }, actions);

  /** 灯和告警：读不到就留着上一次的；一次都没读到过就说读不到。 */
  async function load() {
    try { state.status = await call(TOOLS.status, {}); state.failed = false; }
    catch { state.failed = true; }
    if (!state.day) await loadDay(false);
    paint();
  }
  async function loadDay(repaint = true) {
    try { state.day = await call(TOOLS.day, {}); } catch { /* 今天和趋势读不到就先空着，下一轮再试 */ }
    if (repaint) paint();
  }
  function paint() {
    state.view = state.status ? build(state.status, state.day, state.status.now ?? now()) : null;
    render(false);
  }

  new ResizeObserver(() => drawTrend(root, state.view ?? {})).observe(root);
  void ready.then(load, () => { state.failed = true; render(false); });
  setInterval(() => { if (!document.hidden && !state.sheet) void load(); }, refreshMs);
  setInterval(() => { if (!document.hidden) void loadDay(); }, dayMs);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !state.sheet) { void load(); void loadDay(); } });
  return { actions, state, load };
}
