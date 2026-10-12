// 她的状态 · 页面怎么画：按 design/vitals/reference 的结构，用 ash-ui.css 的 class 和 vitals.css 的新 class。
// 颜色只有令牌（var(--…)），文字只来自 model.mjs 里的 COPY。
import { chartSvg } from "../../../../../design/vitals/chart/chart.mjs";
import { COPY, fill, gauge, hhmm } from "./model.mjs";

const SVG = "http://www.w3.org/2000/svg";

/** 建一个元素：attrs 里 class / style / on* / 其它按属性；children 里字符串变成文字。 */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}
const span = (cls, ...children) => h("span", cls ? { class: cls } : {}, ...children);

/** 图标：页面里放了一份精灵（id = i-名字），这里只引用。 */
export function ico(name, cls = "i") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", cls);
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

const TONE = { ok: "ok", warn: "warn", err: "err", new: "her", paused: "text-3" };
const lampClass = (level) => (level === "paused" ? "lamp-off" : `lamp-${level}`);

// ---------- 状态头 ----------
function header(view, actions) {
  const L = COPY.levels[view.level];
  const halo = L.halo ? h("div", { style: `position:absolute;left:-60px;top:-120px;width:360px;height:300px;background:radial-gradient(closest-side,var(--${L.halo}),transparent);pointer-events:none` }) : null;
  const chips = [
    span("vt-chip", ico("laptop", "i i-xs"), view.chips.online),
    view.chips.idle
      ? span("vt-chip", ico("moon", "i i-xs"), COPY.chips.idle)
      : h("span", { class: "vt-chip", style: "color:var(--her)" }, h("span", { class: "spinner", style: "width:12px;height:12px" }), view.chips.busy ? fill(COPY.chips.busy, { what: view.chips.busy }) : COPY.chips.busy.split(" · ")[0]),
  ];
  return h("div", { style: "position:relative;padding:2px 16px 22px;display:flex;flex-direction:column;gap:14px" },
    halo,
    h("div", { style: "position:relative;display:flex;align-items:center;gap:10px" },
      h("span", { class: `lamp lamp-xl ${lampClass(view.level)}`, role: "img", "aria-label": L.name }),
      h("span", { style: "display:flex;flex-direction:column;gap:2px;min-width:0" },
        h("span", { class: `lvl-${view.level === "paused" ? "off" : view.level}`, style: "font-size:13px;line-height:18px;font-weight:650" }, L.name),
        h("span", { class: "tx-title", style: "font-size:21px;line-height:29px" }, view.say))),
    h("div", { style: "position:relative;display:flex;gap:8px;flex-wrap:wrap" }, ...chips),
    view.action ? h("div", { style: "position:relative" },
      h("button", { class: "a-btn btn-primary btn-sm", style: "padding:0 16px", type: "button", onclick: () => actions.open(view.action) }, COPY.err_action, ico("chev", "i i-xs"))) : null);
}

const section = (title, right, ...body) => h("div", { class: "vt-sec" }, h("div", { class: "vt-sec-hd" }, span("tx-headline", title), right ? h("span", { class: "tx-sub", style: "display:flex;align-items:center" }, right) : null), ...body);
const toneStyle = (tone) => (tone ? `color:var(--${tone})` : null);

// ---------- 此刻 ----------
function nowSection(view) {
  return section(COPY.now.title, COPY.now.right,
    h("div", { style: "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px" },
      ...view.tiles.map((t) => h("div", { class: "vt-tile" },
        span("tx-caption", t.label),
        h("span", { class: "vt-word", style: toneStyle(t.tone) }, t.word),
        h("span", { class: "tx-caption tx-num", style: toneStyle(t.tone) }, t.num)))));
}

// ---------- 今天 ----------
function todaySection(view, withFoot) {
  return section(COPY.today.title, view.since ? fill(COPY.today.since, { hhmm: view.since }) : null,
    h("div", { class: "list vt-day" }, ...view.today.map((c) => h("span", { class: c.zero ? "z" : null },
      h("b", { style: toneStyle(c.tone) }, c.text), h("span", { class: "tx-caption", style: toneStyle(c.tone) }, c.label)))),
    withFoot ? span("group-foot", COPY.today.foot) : null);
}

// ---------- 最近告警 ----------
function alertRow(a, actions) {
  return h("div", { class: "li", style: "min-height:64px", role: "button", tabindex: "0", onclick: () => actions.open(a), onkeydown: (e) => { if (e.key === "Enter") actions.open(a); } },
    h("span", { class: "lic", style: `background:var(--${a.tone}-soft);color:var(--${a.tone})` }, ico(a.icon, "i i-s")),
    span("lt",
      h("span", { class: "t", style: "display:flex;align-items:center;gap:6px" }, a.title, a.live ? span("tag tag-err", COPY.detail.live_tag) : null),
      span("s", (a.live ? "" : COPY.alerts.recovered_prefix) + a.row)),
    h("span", { class: "tx-caption tx-num", style: "white-space:nowrap" }, hhmm(a.started)),
    ico("chev", "i i-s chev"));
}
function alertsSection(view, actions) {
  const rows = view.alerts.map((a) => alertRow(a, actions));
  const empty = view.firstRun
    ? h("div", { class: "li", style: "min-height:60px" }, h("span", { class: "lic", style: "background:var(--her-soft);color:var(--her)" }, ico("clock", "i i-s")), span("lt", span("t", COPY.alerts.first_t), span("s", COPY.alerts.first_s)))
    : h("div", { class: "li", style: "min-height:60px" }, h("span", { class: "lic", style: "background:var(--ok-soft);color:var(--ok)" }, ico("check", "i i-s")), span("lt", span("t", COPY.alerts.empty_t), span("s", COPY.alerts.empty_s)));
  return section(COPY.alerts.title, null, h("div", { class: "list" }, ...(rows.length ? rows : [empty])));
}

// ---------- 体检 ----------
function checkupSection(view, actions) {
  const hands = view.checkup;
  const handsGroup = !hands ? null : h("div", { class: "group" }, span("group-ttl", hands.title),
    h("div", { class: "list" },
      ...(hands.good ? [h("div", { class: "li", style: "min-height:60px", role: "button", tabindex: "0", onclick: () => actions.checkup() },
        h("span", { class: "lic", style: "background:var(--ok-soft);color:var(--ok)" }, ico("check", "i i-s")),
        span("lt", span("t", hands.good.title), span("s", hands.good.sub)), ico("chev", "i i-s chev"))] : [
        ...hands.fix.map((p) => h("div", { class: "li", style: "min-height:60px" },
          h("span", { class: "lic", style: "background:var(--warn-soft);color:var(--warn)" }, ico(p.icon, "i i-s")),
          span("lt", span("t", p.name), h("span", { class: "s", style: "color:var(--warn)" }, p.bad)),
          h("button", { class: "btn-fix", type: "button", onclick: () => actions.checkup(p.id) }, COPY.checkup.fix))),
        h("div", { class: "li", style: "min-height:52px", role: "button", tabindex: "0", onclick: () => actions.checkup() },
          h("span", { class: "lic", style: "background:transparent;color:var(--ok)" }, ico("check", "i i-s")),
          span("lt", h("span", { class: "t", style: "font-size:14.5px;color:var(--text-2)" }, hands.rest)), ico("chev", "i i-s chev"))])));
  const run = h("div", { class: "group" }, span("group-ttl", COPY.checkup.run),
    h("div", { class: "list noic" }, ...view.rules.map((r) => h("div", { class: "li noic", style: "min-height:56px" },
      span("lt", h("span", { class: "t", style: "font-size:15px" }, r.name), h("span", { class: "s", style: r.tone === "err" ? "color:var(--err)" : null }, r.line)),
      span(`tag tag-${r.tone}`, r.tag)))));
  return section(COPY.checkup.title, null, handsGroup, run);
}

// ---------- 最近 24 小时 ----------
const BAR_H = { act: 44, cpu: 22 };
function trendSection(view) {
  const t = view.trend;
  if (!t) return section(COPY.trend.title, null, h("div", { class: "list", style: "padding:14px" }, span("tx-sub", COPY.trend.empty)));
  const row = (label, key) => h("div", { style: "display:flex;align-items:flex-end;gap:10px" }, span("tx-caption", label), h("div", { class: "vt-chart", "data-key": key, style: `flex:1;height:${BAR_H[key]}px` }));
  const rows = [row(COPY.trend.act, "act"), row(COPY.trend.cpu, "cpu")];
  rows[0].firstChild.style.width = "30px"; rows[1].firstChild.style.width = "30px";
  const ticks = h("div", { style: "display:flex;gap:10px" }, h("span", { style: "width:30px" }), h("span", { class: "tx-caption tx-num", style: "flex:1;display:flex;justify-content:space-between" }, ...t.ticks.map((x) => span("", x))));
  return section(COPY.trend.title, null, h("div", { class: "list", style: "padding:14px 14px 10px;display:flex;flex-direction:column;gap:10px" }, ...rows, ticks));
}

/** 趋势的柱：宽度要量出来才画得准，所以挂上去以后、窗口变宽变窄时都重画。 */
export function drawTrend(root, view) {
  const t = view.trend;
  if (!t) return;
  for (const box of root.querySelectorAll(".vt-chart")) {
    const w = Math.floor(box.clientWidth);
    if (w < 20) continue;
    const values = t[box.dataset.key];
    const colors = Object.fromEntries(t.bad.map((i) => [i, "err-fill"]));
    // 做事：最高的一根顶到头；CPU：纵轴 max(15%, 最大值 × 1.25)（交接 §6），闲着时都是低低的几根
    const axis = box.dataset.key === "act" ? { max: Math.max(...values, 1) } : { floor: 15 };
    box.innerHTML = chartSvg({ series: [{ type: "bars", values, color: "surface-3", colors, lastColor: "her-fill", ...axis }], gap: 3 }, w, BAR_H[box.dataset.key]);
  }
}

// ---------- 整页 ----------
export function homePage(view, actions) {
  const order = view.alertsFirst
    ? [alertsSection(view, actions), nowSection(view), todaySection(view, false)]
    : [nowSection(view), todaySection(view, view.level === "ok"), alertsSection(view, actions)];
  return h("div", {},
    header(view, actions),
    h("div", { class: "page", style: "gap:26px" }, ...order, checkupSection(view, actions), trendSection(view)));
}

/** 读不到的时候：不假装一切正常，也不乱说「大脑没在运行」。 */
export function unreadable() {
  return h("div", { class: "page", style: "gap:26px;padding-top:24px" },
    section(COPY.name, null, h("div", { class: "list" }, h("div", { class: "li", style: "min-height:60px" },
      h("span", { class: "lic", style: "background:var(--surface-2);color:var(--text-2)" }, ico("clock", "i i-s")),
      span("lt", span("t", COPY.app.read_failed_t), span("s", COPY.app.read_failed_s))))));
}

// ---------- 告警详情 ----------
const col = (label, value, unit, tone) => h("div", { style: "display:flex;flex-direction:column;gap:1px" },
  span("tx-caption", label), h("span", { class: "tx-num", style: `font-size:22px;line-height:28px;font-weight:700;color:var(--${tone})` }, value), span("tx-caption", unit));
const fmt = (v) => (v === undefined || v === null ? "—" : Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

export function detailPage(a, actions, { back, avatar }) {
  const D = COPY.detail;
  const g = gauge(a.value, a.limit);
  const tone = a.live ? "err" : "warn";
  const cols = a.live ? D.cols_live : D.cols_recovered;
  const when = fill(a.live ? D.live_when : D.recovered_when, { hhmm: hhmm(a.started), n: a.minutes });
  const pct = (x) => `${x * 100}%`;
  const buttons = !a.live
    ? [h("button", { class: "a-btn btn-neutral btn-block", type: "button", onclick: () => actions.dismiss() }, D.recovered_action), span("group-foot", D.recovered_foot)]
    : a.actions.map((x, i) => h("button", { class: `a-btn ${i === 0 ? "btn-primary" : i === 1 ? "btn-neutral" : "btn-ghost"} btn-block`, type: "button", onclick: () => actions.act(a, x) }, x.label));
  return h("div", {},
    back ? h("div", { class: "navbar" }, h("button", { class: "iconbtn", type: "button", "aria-label": COPY.app.back, onclick: () => actions.dismiss() }, ico("back")), span("ttl"), h("span", { style: "width:44px" })) : null,
    h("div", { class: "page", style: "gap:18px;padding-top:0" },
      h("div", { style: "display:flex;flex-direction:column;gap:8px;padding:0 4px" },
        h("span", { style: "display:flex;align-items:center;gap:8px" }, span(`tag tag-${a.live ? "err" : "ok"}`, a.live ? D.live_tag : D.recovered_tag), span("tx-sub", when)),
        h("span", { class: "tx-display", style: "font-size:27px;line-height:36px" }, a.title),
        h("span", { class: "tx-body", style: "color:var(--text-2)" }, a.lead)),
      h("div", { class: "list", style: "padding:18px 16px 16px;display:flex;flex-direction:column;gap:16px" },
        h("div", { style: "padding-top:16px;position:relative" },
          h("span", { class: "tx-caption", style: `position:absolute;top:-2px;left:${pct(g.lim)};transform:translateX(-50%);white-space:nowrap` }, D.gauge_mark),
          h("div", { class: "gauge" }, h("span", { class: "v", style: `width:${pct(g.v)};background:var(--${tone}-fill)` }), h("span", { class: "lim", style: `left:${pct(g.lim)}` }))),
        h("div", { style: "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px" },
          col(cols[0], fmt(a.value), a.unit, tone), col(cols[1], fmt(a.limit), a.limitUnit, "ink"), col(cols[2], String(a.minutes), D.minutes_unit, "ink"))),
      h("div", { class: "group" }, span("group-ttl", D.why),
        h("div", { class: "list", style: "padding:14px 16px;display:flex;gap:12px;align-items:flex-start" },
          h("span", { class: "av av-28" }, h("img", { src: avatar, alt: "" })),
          h("span", { style: "flex:1;font-size:15px;line-height:24px;color:var(--text)" }, a.why))),
      h("div", { class: "group" }, span("group-ttl", D.what), h("div", { style: "display:flex;flex-direction:column;gap:8px" }, ...buttons)),
      h("button", { class: "a-btn btn-ghost btn-sm", type: "button", style: "align-self:center;color:var(--text-3)", onclick: () => actions.copyDebug(a) }, ico("copy", "i i-xs"), D.copy_debug)));
}

/** 重启前的确认：这一步就是审批，不点「重启大脑」什么都不会发生。 */
export function confirmSheet(a, { yes, no, busy }) {
  const C = COPY.confirm_restart;
  return h("div", { class: "vt-layer" },
    h("div", { class: "scrim", onclick: no }),
    h("div", { class: "sheet", role: "dialog", "aria-label": C.title },
      span("grabber"),
      h("div", { style: "display:flex;align-items:center;gap:12px;padding-top:4px" },
        h("span", { class: "lic", style: "width:40px;height:40px;border-radius:12px;background:var(--you-soft);color:var(--you-text);display:flex;align-items:center;justify-content:center;flex:none" }, ico("refresh")),
        span("tx-title", C.title)),
      h("span", { class: "tx-body", style: "color:var(--text-2)" }, fill(C.body, { restart_effect: a.restartEffect })),
      h("div", { style: "display:flex;flex-direction:column;gap:8px;margin-top:4px" },
        h("button", { class: "a-btn btn-primary btn-block btn-lg", type: "button", disabled: busy ? "" : null, onclick: yes }, busy ? COPY.app.restarting : C.yes),
        h("button", { class: "a-btn btn-neutral btn-block btn-lg", type: "button", onclick: no }, C.no))));
}
