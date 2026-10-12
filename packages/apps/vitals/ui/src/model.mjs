// 她的状态 · 页面的数据模型：把应用服务端给的 vitals.status / vitals.day 变成页面要画的东西。纯函数，不碰 DOM、不碰主机，单测直接跑。
// 灯、她说的那句话、哪条越界、哪些底线在忙 / 在看，都是服务端判好的（packages/apps/vitals）；这里只做查表、分档、换算和排版。
// 界面上的字全从 design/vitals/copy.json 取（COPY），这里只代入 {v} {n} {hhmm} {device}。
import COPY from "../../../../../design/vitals/copy.json" with { type: "json" };

export { COPY };
const MIN = 60_000, HOUR = 3_600_000;

/** 把 {a} {b} 代入文字；没给的原样留着。 */
export const fill = (text, values = {}) => String(text ?? "").replace(/\{(\w+)\}/g, (all, key) => (values[key] === undefined ? all : String(values[key])));
const pad = (n) => String(n).padStart(2, "0");
export const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v) => Math.round(v);
const fmtValue = (v) => (num(v) === null ? "—" : Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
export const money = (cny) => `¥${Math.max(0, cny).toFixed(2)}`;

/** 一条检查的文案；不认识的 id 返回 null（调用方用 COPY.unknown）。 */
export const copyFor = (id) => COPY.invariants[id] ?? null;

/** 分档：第一个 v < 上限的档；最后一档（上限 null）兜底。返回档的序号和字。 */
export function band(bands, v) {
  const i = bands.findIndex(([limit]) => limit === null || v < limit);
  return { index: i, word: bands[i][1] };
}

/** 状态头那句话：id 是 copy.say 的 key，或者一条越界的 id（取它的 say，不认识的用 unknown）。 */
export function sayOf(say) {
  const id = say?.id, args = say?.args ?? {};
  if (id in COPY.say) return fill(COPY.say[id], args);
  return fill((copyFor(id) ?? COPY.unknown).say, { device: args.device, n: args.n });
}

/** 此刻三格：说人话的一档 + 小字数字；越界那格变色（tone: "" | "warn" | "err"）。 */
export function nowTiles(v) {
  const cpu = num(v?.cpu_pct), mem = num(v?.rss_mb), lag = num(v?.lag_p99_ms);
  const N = COPY.now;
  const red = cpu !== null && v.idle !== false && cpu > N.busy.red_when_idle_over;
  const word = (bands, x) => (x === null ? "—" : band(bands, x).word);
  const tone = (bands, x) => (x === null ? "" : ["", "warn", "err"][band(bands, x).index]);
  return [
    { id: "busy", label: N.busy.label, word: word(N.busy.bands, cpu), num: cpu === null ? "—" : fill(N.busy.num, { v: round(cpu) }) + (red ? N.busy.idle_suffix : ""), tone: red ? "err" : "" },
    { id: "mem", label: N.mem.label, word: word(N.mem.bands, mem), num: mem === null ? "—" : fill(N.mem.num, { v: round(mem) }), tone: tone(N.mem.bands, mem) },
    { id: "lag", label: N.lag.label, word: word(N.lag.bands, lag), num: lag === null ? "—" : fill(N.lag.num, { v: round(lag) }), tone: tone(N.lag.bands, lag) },
  ];
}

/** 今天五个数；null 是「—」，为 0 的变淡（zero），正在越界的变红（tone）。 */
export function todayCells(day, alerts) {
  const live = new Set((alerts ?? []).filter((a) => a.state === "live").map((a) => a.id));
  const t = day?.today ?? {};
  const raws = { turns: num(t.turns), calls: num(t.calls), cost: num(t.cost_cny), reconnects: num(t.reconnects), errors: num(t.errors) };
  const tone = { reconnects: live.has("link.reconnect_storm") ? "err" : "", errors: live.has("errors.rate") || live.has("errors.internal") ? "err" : "" };
  return COPY.today.cells.map(([id, label]) => {
    const v = raws[id];
    return { id, label, text: v === null ? "—" : id === "cost" ? money(v) : String(round(v)), zero: v === 0, tone: tone[id] ?? "" };
  });
}

const ICONS = { "idle.msg_rate": "repeat", "idle.msg_key_rate": "repeat", "idle.cpu": "cpu", "idle.ledger_growth": "list", "link.reconnect_storm": "wifioff", "errors.rate": "alert", "errors.internal": "alert", "loop.lag": "clock" };

/** 一条告警要画的全部：列表里一行，也是详情页要的。 */
export function alertView(a, now) {
  const c = copyFor(a.id) ?? COPY.unknown;
  const live = a.state === "live";
  const v = { v: fmtValue(a.value), budget: fmtValue(a.budget), device: a.device?.name ?? COPY.app.unknown_device };
  const past = !live && c.recovered ? c.recovered : null;
  return {
    key: `${a.id}@${a.since}`, id: a.id, live, started: a.since, minutes: Math.max(1, num(a.minutes) ?? Math.round((now - a.since) / MIN)),
    tone: live ? "err" : "warn", icon: ICONS[a.id] ?? "alert",
    title: fill(c.title, v), lead: fill(past?.lead ?? c.lead, v), row: fill(c.row, v), why: fill(past?.why ?? c.why, v),
    value: a.value, limit: num(a.budget), unit: c.value?.unit ?? "", limitUnit: c.value?.limit_unit ?? "",
    actions: (c.actions ?? []).map(([label, kind]) => ({ label: fill(label, v), kind })),
    restartEffect: c.restart_effect ?? "",
    device: a.device ?? null,
    debug: { ...a },
  };
}

/** 读数条的比例：纵轴取 值 × 1.25，取两位有效数字；返回值和上限刻度各占几成（0–1）。 */
export function gauge(value, limit) {
  const v = num(value) ?? 0, l = num(limit) ?? 0;
  const top = Math.max(v, l) * 1.25 || 1;
  const digits = Math.floor(Math.log10(top)) - 1;
  const max = digits > 0 ? Math.round(top / 10 ** digits) * 10 ** digits : Math.round(top);
  return { v: Math.min(1, v / max), lim: Math.min(1, l / max) };
}

/** 运行：六条底线，每条一行（tone: ok | err | mute）；一条底线管几个检查（copy.rules[].ids），越界的先说，再是「在看」，再是「在忙」。 */
export function ruleRows(rules) {
  const by = new Map((rules ?? []).map((r) => [r.id, r]));
  const order = ["err", "wait", "busy", "ok"];
  return COPY.rules.map((r) => {
    const found = r.ids.map((id) => by.get(id)).filter(Boolean);
    const pick = [...found].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))[0];
    const line = fill(r.line, { v: fmtValue(pick?.value) });
    if (!pick || pick.state === "ok") return { name: r.name, line, tag: COPY.rule_tags.ok, tone: "ok" };
    if (pick.state === "err") return { name: r.name, line, tag: COPY.rule_tags.err, tone: "err" };
    if (pick.state === "wait") return { name: r.name, line: COPY.rule_tags.wait_line, tag: COPY.rule_tags.wait, tone: "mute" };
    return { name: r.name, line, tag: COPY.rule_tags.busy, tone: "mute" };
  });
}

/** 体检：手和眼（没推过就不画；全好一行；有待办列出要修的 + 去修）。 */
export function checkupView(c) {
  if (!c?.known) return null;
  const fix = (c.groups ?? []).filter((g) => g.todo > 0 && !g.optional);
  if (!fix.length) return { title: COPY.checkup.hands, good: { title: COPY.checkup.all_good_t, sub: COPY.checkup.all_good_s }, fix: [] };
  const part = (g) => { const p = COPY.checkup.parts[g.id] ?? {}; return { id: g.id, name: g.title || p.name || g.id, icon: p.icon ?? "alert", bad: p.bad ?? g.text ?? "" }; };
  return { title: fill(COPY.checkup.hands_todo, { n: fix.length }), good: null, fix: fix.map(part), rest: fill(COPY.checkup.rest, { n: Math.max(0, c.groups.length - fix.length) }) };
}

/** 最近 24 小时：每小时一根（做事 = 每小时的消息数，CPU = 平均）；出过越界的那一小时标红；最右一根是现在（这一小时还没过完，按已过的分钟折成一小时）。 */
export function trend(day, alerts, now) {
  if (!day?.has_data || (day.hours ?? []).length !== 24) return null;
  const hours = day.hours;
  const inHour = Math.max(10, Math.min(60, Math.floor((now - hours[23].at) / MIN)));
  const act = hours.map((h, i) => (i === 23 ? Math.round((h.act * 60) / inHour) : h.act));
  const cpu = hours.map((h) => num(h.cpu_pct) ?? 0);
  const bad = new Set();
  for (const a of alerts ?? []) { const i = hours.findIndex((h) => a.since >= h.at && a.since < h.at + HOUR); if (i >= 0 && i < 23) bad.add(i); }
  return { act, cpu, bad: [...bad].sort((x, y) => x - y), ticks: [0, 6, 12, 18].map((i) => `${pad(new Date(hours[i].at).getHours())}:00`).concat(COPY.trend.now) };
}

/** 整页：一次算好，页面照着画。 */
export function build(status, day, now = status?.now ?? Date.now()) {
  const level = status?.lamp ?? "err";
  const alerts = (status?.alerts ?? []).map((a) => alertView(a, now));
  const primary = status?.primary_alert;
  return {
    now, level, levelName: COPY.levels[level].name, say: sayOf(status?.say ?? { id: "err_brain_down" }),
    chips: { online: fill(COPY.chips.online, { n: status?.hands_online ?? 0 }), idle: !status?.busy, busy: status?.busy_what ?? null },
    action: level === "err" && primary ? alerts.find((a) => a.key === `${primary.id}@${primary.since}`) ?? null : null,
    tiles: nowTiles(status?.vitals), today: todayCells(day, status?.alerts), since: level === "new" ? hhmm(now - (status?.uptime_s ?? 0) * 1000) : null,
    alerts, firstRun: level === "new", alertsFirst: alerts.length > 0,
    checkup: checkupView(status?.checkup), rules: ruleRows(status?.rules), trend: trend(day, status?.alerts, now),
  };
}
