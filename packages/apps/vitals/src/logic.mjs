// 她的状态: what the pages and the card show, made from what the hub reports about itself (service:health, admin, cost, history).
// The lamp is decided here (design/vitals/HANDOFF.md §3), once, so the pages only draw. Nothing here knows a word of Chinese: the
// sentences are ids into design/vitals/copy.json, and the card takes its texts from the same table.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stableMax, vitalsCard } from "../../../../design/vitals/card/card.mjs";
import copy from "../../../../design/vitals/copy.json" with { type: "json" };

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** The fixed display estimate the rest of Ash uses (packages/web/js/money.js). */
const CNY_PER_USD = 6.74;
const PRIORITY = copy.priority;
const IDLE_ONLY = new Set(copy.rules.filter((rule) => rule.idle).flatMap((rule) => rule.ids));
const rank = (id) => { const at = PRIORITY.indexOf(id); return at < 0 ? PRIORITY.length : at; };
const r1 = (n) => Math.round(n * 10) / 10;
const yuan = (usd) => `¥${(usd * CNY_PER_USD).toFixed(2)}`;
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

/** A result of a word ({data, content}) as its JSON object. */
export function dataOf(result) {
  if (result && typeof result === "object" && result.data && typeof result.data === "object") return result.data;
  const text = Array.isArray(result?.content) ? result.content.find((item) => item?.type === "text")?.text : undefined;
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

// ---- time in the hub's zone (the app's own process may run in another) ----
const parts = (ms, zone) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  .formatToParts(new Date(ms)).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
export const startOfHour = (ms, zone) => { const p = parts(ms, zone); return ms - ((p.minute * 60 + p.second) * 1000 + (ms % 1000)); };
export const startOfDay = (ms, zone) => { const p = parts(ms, zone); return ms - (((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (ms % 1000)); };
export const hhmm = (ms, zone) => { const p = parts(ms, zone); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };
const dayKey = (ms, zone) => new Intl.DateTimeFormat("sv-SE", { timeZone: zone }).format(new Date(ms));

/** What the app keeps: only the y-axis memory of the card's charts (design HANDOFF §6). */
export class Store {
  constructor(file) {
    this.file = file;
    try { this.data = JSON.parse(readFileSync(file, "utf8")); } catch { this.data = {}; }
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export class Vitals {
  /** ash: { call(member, word, body) → result }; store: Store. */
  constructor({ ash, store, now = Date.now }) { this.ash = ash; this.store = store; this.now = now; this.cache = new Map(); this.zone = undefined; }

  /** A read of the hub, remembered for `ttl` ms (the page asks often; the hub is not made to answer as often). Null when the hub could not answer. */
  async read(member, word, body, ttl) {
    const key = `${member}/${word}/${JSON.stringify(body)}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < ttl) return hit.promise;
    const promise = this.ash.call(member, word, body).then(dataOf, () => null);
    this.cache.set(key, { at: this.now(), promise });
    return promise;
  }

  // ---- the lamp and everything the pages show of her now ----
  async status() {
    const now = this.now();
    const [health, events, admin, checkup] = await Promise.all([
      this.read("service:health", "status", { window_s: 60 }, 15_000),
      this.read("service:health", "recent", { kind: "event", since: this.back(), limit: 100 }, 30_000),
      this.read("service:admin", "status", {}, 30_000),
      this.read("service:admin", "checkup", {}, 60_000),
    ]);
    if (admin?.time_zone) this.zone = admin.time_zone;
    const invariants = health?.invariants ?? [];
    const live = invariants.filter((item) => !item.ok).sort((a, b) => rank(a.id) - rank(b.id));
    const alerts = await this.alerts(live, events?.events ?? [], now);
    const known = checkup?.known === true;
    const todo = known ? checkup.todo : 0;
    const recent = (events?.events ?? []).filter((e) => e.type === "breach" && now - e.at < HOUR && !live.some((item) => item.id === e.id)).sort((a, b) => b.at - a.at);
    const fresh = health && health.uptime_s < 60 && (await this.read("service:health", "recent", { kind: "minute", limit: 1 }, 30_000))?.minutes?.length === 0;

    let lamp, say;
    if (!health) { lamp = "err"; say = { id: "err_brain_down" }; }
    else if (admin?.paused === true) { lamp = "paused"; say = { id: "paused" }; }
    else if (live.length) { lamp = "err"; say = { id: live[0].id, ...(live[0].id === "link.reconnect_storm" ? { args: { device: alerts.find((a) => a.id === live[0].id)?.device?.name ?? "" } } : {}) }; }
    else if (recent.length) { lamp = "warn"; say = { id: recent[0].id === "loop.lag" ? "warn_recovered_lag" : "warn_recovered" }; }
    else if (todo > 0) { lamp = "warn"; say = { id: "warn_hands", args: { n: todo } }; }
    else if (fresh) { lamp = "new"; say = { id: "new" }; }
    else { lamp = "ok"; say = { id: health.idle === false ? "ok_busy" : "ok" }; }
    const first = alerts.find((a) => a.state === "live");

    return {
      now, stale: !health, lamp, say, primary_alert: first ? { id: first.id, since: first.since } : null,
      hands_online: admin?.hands_online ?? 0, busy: health ? health.idle === false : false, uptime_s: health?.uptime_s ?? 0,
      vitals: health ? { cpu_pct: health.proc.cpu_pct, rss_mb: health.proc.rss_mb, lag_p99_ms: health.proc.lag_p99_ms, idle: health.idle } : null,
      rules: invariants.map((item) => ({
        id: item.id, value: item.value, budget: item.budget,
        state: !item.ok ? "err" : item.value !== null ? "ok" : IDLE_ONLY.has(item.id) && health.idle === false ? "busy" : "wait",
      })),
      alerts,
      checkup: known ? { known: true, todo: checkup.todo, groups: checkup.groups ?? [], at: checkup.at } : { known: false, todo: 0, groups: [], at: 0 },
    };
  }

  /** The breaches of the last day, five at most, those still on first. A breach and its `ok` are one alert (they share `since`). */
  async alerts(live, events, now) {
    const out = live.map((item) => ({ id: item.id, state: "live", since: item.since ?? now, ended: null, minutes: Math.max(1, Math.round((now - (item.since ?? now)) / MIN)), value: item.value, budget: item.budget, device: null }));
    const written = events.filter((e) => e.type === "breach").sort((a, b) => b.at - a.at);
    for (const e of written) {
      const since = e.since ?? e.at;
      const mine = out.find((a) => a.state === "live" && a.id === e.id && a.since === since);
      if (mine) { mine.device = await this.deviceOf(e); continue; }
      const end = events.find((o) => o.type === "ok" && o.id === e.id && o.since === since);
      const ended = end?.at ?? e.at;
      out.push({ id: e.id, state: "recovered", since, ended, minutes: Math.max(1, Math.round((ended - since) / MIN)), value: end?.peak ?? e.value ?? 0, budget: e.budget ?? 0, device: await this.deviceOf(e) });
    }
    out.sort((a, b) => (a.state === b.state ? (a.state === "live" ? rank(a.id) - rank(b.id) : b.ended - a.ended) : a.state === "live" ? -1 : 1));
    return out.slice(0, copy.alerts.max);
  }

  /** Which device a reconnect storm is about: the hand in the busiest key of the event. */
  async deviceOf(event) {
    if (event.id !== "link.reconnect_storm") return null;
    const hand = /^open:(.+)$/.exec(event.top?.[0]?.key ?? "")?.[1];
    if (!hand) return null;
    const id = hand.startsWith("device:") ? hand : `device:${hand}`;
    const list = await this.read("service:devices", "list", {}, 60_000);
    const found = (list?.devices ?? []).find((d) => d.device === id);
    return { id, name: found?.name ?? copy.unknown_device };
  }

  // ---- today and the last 24 hours ----
  /** A day ago, to the minute: the same question for a minute, so it is asked once. */
  back() { return Math.floor((this.now() - DAY) / MIN) * MIN; }
  async minutes() { return (await this.read("service:health", "recent", { kind: "minute", since: this.back(), limit: 1440 }, 60_000))?.minutes ?? []; }

  async day() {
    const now = this.now();
    const since = startOfDay(now, this.zone);
    const [rows, count, usage] = await Promise.all([
      this.minutes(),
      this.read("service:history", "activity.count", { since_ts: since, until_ts: since + DAY }, 60_000),
      this.read("service:cost", "usage.get", { days: 7 }, 60_000),
    ]);
    const today = rows.filter((row) => row.at >= since);
    const first = startOfHour(now, this.zone) - 23 * HOUR;
    const hours = Array.from({ length: 24 }, (_, i) => ({ at: first + i * HOUR, act: 0, cpu: [] }));
    for (const row of rows) {
      const slot = hours[Math.floor((row.at - first) / HOUR)];
      if (slot) { slot.act += row.msg; slot.cpu.push(row.cpu_pct); }
    }
    return {
      since,
      today: {
        turns: count?.total_count ?? null,
        calls: usage?.periods?.today?.calls ?? null,
        cost_cny: usage?.periods?.today ? Math.round(usage.periods.today.cost_usd * CNY_PER_USD * 100) / 100 : null,
        errors: today.reduce((n, row) => n + (row.err ?? 0), 0),
        reconnects: today.some((row) => typeof row.link_opens === "number") ? today.reduce((n, row) => n + (row.link_opens ?? 0), 0) : null,
      },
      has_data: rows.length >= 60,
      hours: hours.map((h) => ({ at: h.at, act: h.act, cpu_pct: h.cpu.length ? r1(h.cpu.reduce((a, b) => a + b, 0) / h.cpu.length) : null })),
    };
  }

  /** The brain restarts a moment after this answers. Only with the owner's confirmation (the page asks first). */
  async restart(confirmed) {
    if (confirmed !== true) throw new Error("restart needs confirmed: true, after the owner said yes");
    await this.ash.call("service:host", "restart", { reason: "restarted by the owner from the status page" });
    return { restarting: true };
  }

  // ---- the card ----
  /** The A2UI of the home-screen card (design/vitals/card/card.mjs), from the same readings as the pages. */
  async card() {
    const [st, day, rows, usage] = await Promise.all([this.status(), this.day(), this.minutes(), this.read("service:cost", "usage.get", { days: 7 }, 60_000)]);
    const now = this.now(), zone = this.zone;
    const hour = rows.slice(0, 60).reverse();
    const pad = (values, lead) => (values.length >= 60 ? values.slice(-60) : [...Array(60 - values.length).fill(values.length ? values[0] : lead), ...values]);
    const cpu = pad(hour.map((r) => r.cpu_pct), 0), mem = pad(hour.map((r) => r.rss_mb), st.vitals?.rss_mb ?? 0), load = pad(hour.map((r) => r.msg), 0);
    const offset = 60 - hour.length;
    const indexOf = (ms) => { const at = hour.findIndex((r) => r.at >= Math.floor(ms / MIN) * MIN); return at < 0 ? 59 : offset + at; };
    const live = st.alerts.filter((a) => a.state === "live"), past = st.alerts.filter((a) => a.state === "recovered" && now - a.ended < HOUR);
    const marks = {}, limits = {};
    const mark = (key, a, tone) => { marks[key] ??= { from: indexOf(a.since), ...(a.state === "recovered" ? { to: indexOf(a.ended) } : {}), tone }; };
    for (const a of [...live, ...past]) {
      const tone = a.state === "live" ? "err" : "warn";
      if (/^idle\.(cpu|msg_)/.test(a.id)) { mark("cpu", a, tone); }
      if (/^idle\.msg_/.test(a.id)) { mark("load", a, tone); if (a.state === "live") mark("mem", a, "warn"); }
    }
    if (live.length) { limits.cpu = 5; limits.load = 30; }

    const shown = live[0] ?? past[0] ?? null;
    const what = shown ? copy.invariants[shown.id]?.widget ?? copy.unknown.widget : "";
    const device = shown?.device?.name ?? "";
    const text = (s) => fill(s, { hhmm: shown ? hhmm(shown.since, zone) : "", what: fill(what, { device }), n: shown?.minutes ?? 0 });
    const alert = !shown ? null : shown.state === "live"
      ? { tone: "err", short: fill(copy.widget.alert_live, { hhmm: hhmm(shown.since, zone), what: `${shown.minutes} ${copy.widget.alert_live_long.split("{n} ")[1] ?? ""}`.trim() }), long: text(copy.widget.alert_live_long) }
      : { tone: "warn", short: text(copy.widget.alert_recovered).split("，")[0], long: text(copy.widget.alert_recovered) };

    const sayText = st.say.id in copy.say ? fill(copy.say[st.say.id], st.say.args ?? {}) : fill((copy.invariants[st.say.id] ?? copy.unknown).say, { device });
    const nice = (values, floor) => r1(Math.max(floor, Math.max(...values) * 1.25));
    const scale = this.store.data.scale ?? {};
    const next = {};
    const axis = (key, values, floor) => { const [max, state] = stableMax(scale[key], nice(values, floor), now); next[key] = state; return max; };
    const s = {
      level: st.lamp, say: sayText, at: hhmm(now, zone), online: st.hands_online, busy: st.busy ? copy.chips.busy.split(" · ")[0] : null,
      cpu, mem, load, cost7: this.cost7(usage, now, zone), marks, limits,
      now: { cpu: Math.round(st.vitals?.cpu_pct ?? cpu[59]), mem: Math.round(st.vitals?.rss_mb ?? mem[59]), load: Math.round(load[59]), cost: yuan(usage?.periods?.today?.cost_usd ?? 0) },
      today: Object.fromEntries(Object.entries({ turns: day.today.turns, calls: day.today.calls, errors: day.today.errors, reconnects: day.today.reconnects }).map(([k, v]) => [k, v ?? "—"])),
      alert,
    };
    s.scale = { cpu: axis("cpu", cpu, 15), load: axis("load", load, 20) };
    this.store.data.scale = next;
    this.store.save();
    return { a2ui: vitalsCard(s), lamp: st.lamp };
  }

  /** The cost of the last seven days in yuan, oldest first. */
  cost7(usage, now, zone) {
    const byDay = new Map((usage?.by_day ?? []).map((d) => [d.date, d.cost_usd]));
    return Array.from({ length: 7 }, (_, i) => Math.round((byDay.get(dayKey(now - (6 - i) * DAY, zone)) ?? 0) * CNY_PER_USD * 100) / 100);
  }
}
