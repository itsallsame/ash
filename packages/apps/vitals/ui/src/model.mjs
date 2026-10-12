// 她的状态 · 页面的数据模型：把读到的原始数据（交接 §5）变成页面要画的东西。纯函数，不碰 DOM、不碰主机，单测直接跑。
// 界面上的字全从 design/vitals/copy.json 取（COPY），这里只做查表和代入 {v} {n} {hhmm} {device}。
import COPY from "../../../../../design/vitals/copy.json" with { type: "json" };

export { COPY };
export const CNY_PER_USD = 6.74;                // 和她的主页（packages/web/js/money.js）同一个汇率
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** 体检里「位置和健康」是可选的，不算「要修」。 */
const OPTIONAL_PART = "location";

/** 把 {a} {b} 代入文字；没给的原样留着。 */
export const fill = (text, values = {}) => String(text ?? "").replace(/\{(\w+)\}/g, (all, key) => (values[key] === undefined ? all : String(values[key])));
const pad = (n) => String(n).padStart(2, "0");
export const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v) => Math.round(v);
export const money = (usd) => `¥${(Math.max(0, usd) * CNY_PER_USD).toFixed(2)}`;

/** 一条检查的文案；不认识的 id 用 unknown。 */
export const copyFor = (id) => COPY.invariants[id] ?? null;
const rulesOf = (id) => COPY.rules.find((r) => r.ids.includes(id)) ?? null;

/** 分档：第一个 v < 上限的档；最后一档（上限 null）兜底。返回档的序号和字。 */
export function band(bands, v) {
  const i = bands.findIndex(([limit]) => limit === null || v < limit);
  return { index: i, word: bands[i][1] };
}

/** 越界的几条（status.invariants 里 ok === false），按 priority 排；不在 priority 里的排后面。 */
export function breaches(status) {
  const list = (status?.invariants ?? []).filter((x) => x && x.ok === false);
  const rank = (id) => { const i = COPY.priority.indexOf(id); return i < 0 ? COPY.priority.length : i; };
  return list.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x.id) - rank(b.x.id) || a.i - b.i).map(({ x }) => x);
}

/** 设备叫什么：top 里的 hand 去设备表查，查不到用「一台设备」。 */
export function deviceName(raw, inv) {
  const hand = inv?.top?.[0]?.hand ?? inv?.top?.hand ?? inv?.hand;
  return (hand && raw.devices?.[hand]) || COPY.app.unknown_device;
}

/** 一条越界在文案里要代入的值。 */
function values(raw, inv, extra = {}) {
  const budget = inv?.budget;
  return { v: inv?.value === undefined || inv?.value === null ? "—" : fmtValue(inv.value), budget: budget === undefined ? "—" : fmtValue(budget), device: deviceName(raw, inv), ...extra };
}
const fmtValue = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

/** 手和眼里要修的几处（可选的不算）。 */
export function handsTodo(checkup) {
  return (checkup?.groups ?? []).filter((g) => g && g.id !== OPTIONAL_PART && num(g.todo) > 0).map((g) => g.id);
}

/** 灯和她说的那句话（交接 §3）。 */
export function lamp(raw, now) {
  const status = raw.status ?? null;
  if (raw.paused) return { level: "paused", say: COPY.say.paused };
  if (!status) return { level: "err", say: COPY.say.err_brain_down };
  const bad = breaches(status);
  if (bad.length) {
    const c = copyFor(bad[0].id) ?? COPY.unknown;
    return { level: "err", say: fill(c.say, values(raw, bad[0])), id: bad[0].id };
  }
  const fresh = !(raw.minutes?.length) && num(status.uptime_s) !== null && status.uptime_s < 60;
  if (fresh) return { level: "new", say: COPY.say.new };
  const recent = (raw.events ?? []).filter((e) => e.type === "breach" && now - e.ts <= HOUR).sort((a, b) => b.ts - a.ts);
  if (recent.length) return { level: "warn", say: recent[0].id === "loop.lag" ? COPY.say.warn_recovered_lag : COPY.say.warn_recovered };
  const todo = handsTodo(raw.checkup);
  if (todo.length) return { level: "warn", say: fill(COPY.say.warn_hands, { n: todo.length }) };
  return { level: "ok", say: raw.busy_what || status.idle === false ? COPY.say.ok_busy : COPY.say.ok };
}

/** 此刻三格：说人话的一档 + 小字数字；越界那格变色（tone: "" | "warn" | "err"）。 */
export function nowTiles(raw) {
  const p = raw.status?.proc ?? {};
  const idle = raw.status?.idle !== false;
  const cpu = num(p.cpu_pct), mem = num(p.rss_mb), lag = num(p.lag_p99_ms);
  const N = COPY.now;
  const out = [];
  {
    const b = band(N.busy.bands, cpu ?? 0);
    const red = cpu !== null && idle && cpu > N.busy.red_when_idle_over;
    out.push({ id: "busy", label: N.busy.label, word: cpu === null ? "—" : b.word, num: cpu === null ? "—" : fill(N.busy.num, { v: round(cpu) }) + (red ? N.busy.idle_suffix : ""), tone: red ? "err" : "" });
  }
  {
    const b = band(N.mem.bands, mem ?? 0);
    out.push({ id: "mem", label: N.mem.label, word: mem === null ? "—" : b.word, num: mem === null ? "—" : fill(N.mem.num, { v: round(mem) }), tone: mem === null ? "" : ["", "warn", "err"][b.index] });
  }
  {
    const b = band(N.lag.bands, lag ?? 0);
    out.push({ id: "lag", label: N.lag.label, word: lag === null ? "—" : b.word, num: lag === null ? "—" : fill(N.lag.num, { v: round(lag) }), tone: lag === null ? "" : ["", "warn", "err"][b.index] });
  }
  return out;
}

/** 今天五个数；为 0 的变淡（zero），正在越界的变红（tone）。 */
export function todayCells(raw, now) {
  const midnight = startOfDay(now);
  const rows = (raw.minutes ?? []).filter((m) => m.ts >= midnight);
  const sum = (key) => rows.reduce((a, m) => a + (num(m[key]) ?? 0), 0);
  const live = new Set(breaches(raw.status).map((x) => x.id));
  const hasLink = rows.some((m) => num(m.link_opens) !== null);
  const today = raw.usage?.periods?.today ?? {};
  const raws = {
    turns: num(raw.turns_today),
    calls: num(today.calls),
    cost: num(today.cost_usd),
    // 今天还没有任何一行：什么都没发生过，是 0。有行但没有 link_opens：不知道，是「—」（交接 §9.2）
    reconnects: !rows.length ? 0 : hasLink ? sum("link_opens") : null,
    errors: sum("err"),
  };
  const tone = { reconnects: live.has("link.reconnect_storm") ? "err" : "", errors: live.has("errors.rate") || live.has("errors.internal") ? "err" : "" };
  return COPY.today.cells.map(([id, label]) => {
    const v = raws[id];
    const text = v === null || v === undefined ? "—" : id === "cost" ? money(v) : String(round(v));
    return { id, label, text, zero: v === 0, tone: tone[id] ?? "" };
  });
}

/** 开始算的钟点：刚装好的那天从装好那刻起算。 */
export function todaySince(raw, now) {
  const up = num(raw.status?.uptime_s);
  return up === null ? null : hhmm(now - up * 1000);
}

/** 「最近告警」：24 小时内的 breach，同一次越界（同 id、同 since）只算一条，倒序，最多 5 条。 */
export function alertList(raw, now) {
  const live = new Map(breaches(raw.status).map((x) => [x.id, x]));
  const episodes = new Map();
  for (const e of (raw.events ?? []).filter((x) => x.type === "breach" && now - x.ts <= DAY)) {
    const key = `${e.id}@${e.since ?? e.ts}`;
    const prev = episodes.get(key);
    if (!prev || e.ts > prev.ts) episodes.set(key, e);
  }
  const items = [];
  for (const e of episodes.values()) {
    const cur = live.get(e.id);
    const isLive = !!cur && (cur.since ?? e.since) === (e.since ?? cur.since);
    items.push(isLive ? alertOf(raw, e, cur, true, now) : alertOf(raw, e, null, false, now));
  }
  // 进行中但还没有事件记下来（刚越界）：也要列出来
  for (const cur of live.values()) if (!items.some((a) => a.id === cur.id && a.live)) items.push(alertOf(raw, { id: cur.id, ts: cur.since ?? now, since: cur.since }, cur, true, now));
  return items.sort((a, b) => b.at - a.at).slice(0, COPY.alerts.max);
}

/** 一条告警要画的全部：列表里一行，也是详情页要的。 */
function alertOf(raw, event, cur, live, now) {
  const id = event.id;
  const c = copyFor(id) ?? COPY.unknown;
  const src = cur ?? event;
  const v = values(raw, src);
  const started = num(src.since) ?? num(event.since) ?? event.ts;
  const okEvent = (raw.events ?? []).filter((e) => e.type === "ok" && e.id === id && (e.since ?? started) === started).sort((a, b) => b.ts - a.ts)[0];
  const minutes = live ? Math.max(1, Math.round((now - started) / MIN)) : Math.max(1, Math.round(((okEvent ? okEvent.ts : started + (num(src.window_s) ?? 60) * 1000) - started) / MIN));
  const past = !live && c.recovered ? c.recovered : null;
  return {
    id, live, at: live ? started : event.ts, started, minutes,
    tone: live ? "err" : "warn", icon: iconOf(id),
    title: fill(c.title, v), lead: fill(past?.lead ?? c.lead, v), row: fill(c.row, v),
    why: fill(past?.why ?? c.why, v), say: fill(c.say, v),
    value: src.value, budget: src.budget, unit: c.value?.unit ?? "", limit: c.value ? Number(c.value.limit) : num(src.budget), limitUnit: c.value?.limit_unit ?? "",
    actions: (c.actions ?? []).map(([label, kind]) => ({ label: fill(label, v), kind })),
    restartEffect: c.restart_effect ?? "",
    device: v.device,
    debug: { id, value: src.value, budget: src.budget, window_s: src.window_s, top: src.top, note: src.note, since: src.since },
  };
}
const ICONS = { "idle.msg_rate": "repeat", "idle.msg_key_rate": "repeat", "idle.cpu": "cpu", "idle.ledger_growth": "list", "link.reconnect_storm": "wifioff", "errors.rate": "alert", "errors.internal": "alert", "loop.lag": "clock" };
const iconOf = (id) => ICONS[id] ?? "alert";

/** 读数条的比例：纵轴取 值 × 1.25，取两位有效数字；返回值和上限刻度各占几成（0–1）。 */
export function gauge(value, limit) {
  const v = num(value) ?? 0, l = num(limit) ?? 0;
  const top = Math.max(v, l) * 1.25 || 1;
  const digits = Math.floor(Math.log10(top)) - 1;
  const max = digits > 0 ? Math.round(top / 10 ** digits) * 10 ** digits : Math.round(top);
  return { v: Math.min(1, v / max), lim: Math.min(1, l / max) };
}

/** 运行：六条底线，每条一行（tone: ok | err | mute；line 已代入实际值）。 */
export function ruleRows(raw) {
  const status = raw.status ?? null;
  const idle = status?.idle !== false;
  const wait = !(raw.minutes?.length) && num(status?.uptime_s) !== null && status.uptime_s < 60;
  return COPY.rules.map((r) => {
    const found = (status?.invariants ?? []).filter((x) => r.ids.includes(x.id));
    const bad = found.find((x) => x.ok === false);
    const inv = bad ?? found[0];
    const shown = fill(r.line, { v: inv?.value === undefined || inv?.value === null ? "—" : fmtValue(inv.value) });
    if (bad) return { name: r.name, line: shown, tag: COPY.rule_tags.err, tone: "err" };
    if (r.idle && wait) return { name: r.name, line: COPY.rule_tags.wait_line, tag: COPY.rule_tags.wait, tone: "mute" };
    if (r.idle && !idle) return { name: r.name, line: shown, tag: COPY.rule_tags.busy, tone: "mute" };
    return { name: r.name, line: shown, tag: COPY.rule_tags.ok, tone: "ok" };
  });
}

/** 体检：手和眼（全好一行，有待办列出来 + 去修）。 */
export function checkupView(raw) {
  const c = raw.checkup ?? null;
  if (!c) return null;
  const todo = handsTodo(c);
  const part = (id) => ({ id, ...(COPY.checkup.parts[id] ?? { name: id, icon: "alert", bad: "" }) });
  if (!todo.length) return { title: COPY.checkup.hands, good: { title: COPY.checkup.all_good_t, sub: COPY.checkup.all_good_s }, fix: [] };
  const groups = c.groups.map((g) => g.id);
  return { title: fill(COPY.checkup.hands_todo, { n: todo.length }), good: null, fix: todo.map(part), rest: fill(COPY.checkup.rest, { n: Math.max(0, groups.length - todo.length) }) };
}

/** 最近 24 小时：每小时一根（做事 = msg 加总，CPU = 平均）；出过越界的那一小时标红。 */
export function trend(raw, now) {
  const rows = raw.minutes ?? [];
  if (rows.length < 60) return null;                      // 不满一小时：画不出来，页面写「过一个小时再来看」
  const end = Math.floor(now / HOUR) * HOUR;
  const hours = Array.from({ length: 24 }, (_, i) => end - (23 - i) * HOUR);
  const act = hours.map(() => 0), cpu = hours.map(() => 0), n = hours.map(() => 0);
  for (const m of rows) {
    const i = Math.floor((m.ts - hours[0]) / HOUR);
    if (i < 0 || i > 23) continue;
    act[i] += num(m.msg) ?? 0; cpu[i] += num(m.cpu_pct) ?? 0; n[i] += 1;
  }
  const avg = cpu.map((s, i) => (n[i] ? s / n[i] : 0));
  // 现在这一小时还没过完：按每分钟的平均折成一小时，不然最右一根永远是矮的
  const perHour = act.map((s, i) => (n[i] ? (s / n[i]) * 60 : 0));
  const bad = new Set();
  for (const e of raw.events ?? []) if (e.type === "breach") { const i = Math.floor((e.ts - hours[0]) / HOUR); if (i >= 0 && i < 24) bad.add(i); }
  bad.delete(23);                                         // 最右一根永远是「现在」（薄荷色）
  return { act: perHour, cpu: avg, bad: [...bad], ticks: [0, 6, 12, 18].map((i) => `${pad(new Date(hours[i]).getHours())}:00`).concat(COPY.trend.now) };
}

/** 整页：一次算好，页面照着画。 */
export function build(raw, now = raw.now ?? Date.now()) {
  const l = lamp(raw, now);
  const alerts = alertList(raw, now);
  const status = raw.status ?? null;
  const idle = status?.idle !== false && !raw.busy_what;
  return {
    now, ...l, levelName: COPY.levels[l.level].name,
    chips: { online: fill(COPY.chips.online, { n: raw.hands_online ?? 0 }), idle, busy: raw.busy_what ?? null },
    action: l.level === "err" && l.id !== undefined ? alerts.find((a) => a.live && a.id === l.id) ?? alerts.find((a) => a.live) ?? null : null,
    tiles: nowTiles(raw), today: todayCells(raw, now), since: l.level === "new" ? todaySince(raw, now) : null,
    alerts, firstRun: l.level === "new",
    checkup: checkupView(raw), rules: ruleRows(raw), trend: trend(raw, now),
    alertsFirst: alerts.length > 0,
    stale: !status,
  };
}
