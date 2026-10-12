// 「她的状态」页面的测试用具：几种情况的原始数据（交接 §5 的形状），和一个假的主机（父窗口里的 JSON-RPC）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const pageHtml = (name) => readFileSync(join(here, "../vitals/ui", name), "utf8");

const MIN = 60_000, HOUR = 3_600_000;
/** 今天 14:08（测试里固定，页面的「现在」也固定成它）。 */
export const NOW = new Date(2026, 9, 12, 14, 8, 0).getTime();
const at = (h, m) => new Date(2026, 9, 12, h, m, 0).getTime();

const IDS = ["idle.msg_rate", "idle.msg_key_rate", "idle.cpu", "idle.ledger_growth", "link.reconnect_storm", "errors.rate", "errors.internal", "hand.part_flap", "loop.lag"];
const BUDGET = { "idle.msg_rate": 30, "idle.msg_key_rate": 6, "idle.cpu": 5, "idle.ledger_growth": 10, "link.reconnect_storm": 5, "errors.rate": 20, "errors.internal": 5, "hand.part_flap": 6, "loop.lag": 200 };
const READ = { "idle.msg_rate": 2, "idle.msg_key_rate": 1, "idle.cpu": 1, "idle.ledger_growth": 0, "link.reconnect_storm": 0, "errors.rate": 0, "errors.internal": 0, "hand.part_flap": 0, "loop.lag": 12 };
/** 九条检查，服务端判好的 state；over 里写哪几条是什么 state / 值。 */
const rules = (over = {}) => IDS.map((id) => ({ id, state: "ok", value: READ[id], budget: BUDGET[id], ...(over[id] ?? {}) }));
const alert = (id, state, since, value, minutes, extra = {}) => ({ id, state, since, ended: state === "live" ? null : since + minutes * MIN, minutes, value, budget: BUDGET[id], device: null, ...extra });
const groups = (todo = {}) => ["brain", "alarm", "notify", "awake", "eyes", "files", "location"].map((id) => ({ id, title: { brain: "大脑", alarm: "闹钟", notify: "叫你", awake: "在后台醒着", eyes: "眼睛和手", files: "照片和文件", location: "位置和健康" }[id], todo: todo[id] ?? 0, optional: id === "location", text: todo[id] ? "要处理" : "正常" }));

/** 最近 24 小时每小时一项（旧→新，最后一项是当前这一小时，部分）。 */
const hours = (hot = []) => Array.from({ length: 24 }, (_, i) => {
  const start = Math.floor(NOW / HOUR) * HOUR - (23 - i) * HOUR;
  const h = new Date(start).getHours();
  const busy = h >= 9 && h <= 16;
  const partial = i === 23 ? 8 / 60 : 1;
  return { at: start, act: Math.round((busy ? 600 : 30) * partial) + (hot.includes(i) ? 900 : 0), cpu_pct: hot.includes(i) ? 38 : busy ? 6 : 1.2 };
});

const status = (over = {}) => ({
  now: NOW, stale: false, lamp: "ok", say: { id: "ok" }, primary_alert: null, hands_online: 2, busy: false, uptime_s: 86_400,
  vitals: { cpu_pct: 2, rss_mb: 186, lag_p99_ms: 12, idle: true }, rules: rules(), alerts: [],
  checkup: { known: true, todo: 0, groups: groups(), at: NOW }, ...over,
});
const day = (over = {}) => ({ since: at(0, 0), today: { turns: 12, calls: 86, cost_cny: 3.42, errors: 0, reconnects: 0 }, has_data: true, hours: hours(), ...over });

export const scenarios = {
  /** 正常：整页没有一处红色或琥珀色。 */
  ok: () => ({ status: status(), day: day() }),
  /** 留意：刚出过事，已经好了。 */
  warn: () => ({
    status: status({ lamp: "warn", say: { id: "warn_recovered" }, vitals: { cpu_pct: 3, rss_mb: 204, lag_p99_ms: 15, idle: true },
      alerts: [alert("idle.cpu", "recovered", at(13, 40), 38, 1), alert("loop.lag", "recovered", at(9, 15), 860, 1)] }),
    day: day({ today: { turns: 12, calls: 86, cost_cny: 3.42, errors: 2, reconnects: 0 }, hours: hours([9, 19]) }),
  }),
  /** 有问题：闲着却在空转（两条同时越界，空转排在前）。 */
  err: () => ({
    status: status({ lamp: "err", say: { id: "idle.msg_rate" }, primary_alert: { id: "idle.msg_rate", since: at(14, 2) }, vitals: { cpu_pct: 38, rss_mb: 342, lag_p99_ms: 24, idle: true },
      rules: rules({ "idle.msg_rate": { state: "err", value: 44 }, "idle.cpu": { state: "err", value: 38 } }),
      alerts: [alert("idle.msg_rate", "live", at(14, 2), 44, 6), alert("idle.cpu", "live", at(14, 2), 38, 6), alert("loop.lag", "recovered", at(9, 15), 860, 1)] }),
    day: day({ hours: hours([23]) }),
  }),
  /** 体检有待办，她在忙（闲着才算的底线不算），重连越界。 */
  todo: () => ({
    status: status({ lamp: "err", say: { id: "link.reconnect_storm", args: { device: "我的电脑" } }, primary_alert: { id: "link.reconnect_storm", since: at(14, 0) }, busy: true, busy_what: "整理你的日程",
      vitals: { cpu_pct: 9, rss_mb: 210, lag_p99_ms: 12, idle: false },
      rules: rules({ "idle.msg_rate": { state: "busy" }, "idle.msg_key_rate": { state: "busy" }, "idle.cpu": { state: "busy" }, "idle.ledger_growth": { state: "busy" }, "link.reconnect_storm": { state: "err", value: 7 } }),
      alerts: [alert("link.reconnect_storm", "live", at(14, 0), 7, 8, { device: { id: "device:laptop", name: "我的电脑" } })],
      checkup: { known: true, todo: 2, groups: groups({ awake: 1, eyes: 1 }), at: NOW } }),
    day: day({ today: { turns: 12, calls: 86, cost_cny: 3.42, errors: 0, reconnects: 7 } }),
  }),
  /** 刚装好：还不满一分钟，没有数据。 */
  fresh: () => ({
    status: status({ lamp: "new", say: { id: "new" }, hands_online: 1, busy: true, busy_what: "认识你", uptime_s: 45, vitals: { cpu_pct: 14, rss_mb: 158, lag_p99_ms: 9, idle: false },
      rules: rules({ "idle.msg_rate": { state: "wait", value: null }, "idle.msg_key_rate": { state: "wait", value: null }, "idle.cpu": { state: "wait", value: null }, "idle.ledger_growth": { state: "wait", value: null }, "loop.lag": { value: 9 } }),
      checkup: { known: false, todo: 0, groups: [], at: 0 } }),
    day: day({ has_data: false, today: { turns: 1, calls: 3, cost_cny: 0.04, errors: 0, reconnects: 0 }, hours: hours() }),
  }),
  /** 大脑没在运行：读不到中枢。 */
  down: () => ({ status: status({ stale: true, lamp: "err", say: { id: "err_brain_down" }, vitals: null, rules: rules(), checkup: { known: false, todo: 0, groups: [], at: 0 } }), day: day() }),
};

/**
 * 一个页面的假主机：把 [html] 放进 iframe（页面认为父窗口是主机），回握手、回 tools/call、记下 ui/open-link。
 * 在浏览器页面里跑；返回的对象在 page.evaluate 里用 window.__host 取。
 */
export const hostScript = (theme, raw, calls = {}) => `
  window.__host = { opened: [], called: [], args: {}, theme: ${JSON.stringify(theme)}, data: ${JSON.stringify(raw)}, fail: false };
  const frame = document.getElementById("f");
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || m.jsonrpc !== "2.0" || event.source !== frame.contentWindow) return;
    const send = (message) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...message }, "*");
    if (m.method === "ui/initialize") send({ id: m.id, result: { hostContext: { theme: window.__host.theme } } });
    else if (m.method === "tools/call") {
      window.__host.called.push(m.params.name);
      window.__host.args[m.params.name] = m.params.arguments;
      const reads = { "vitals.status": window.__host.data.status, "vitals.day": window.__host.data.day };
      if (m.params.name in reads) window.__host.fail ? send({ id: m.id, result: { isError: true, content: [{ type: "text", text: "读不到" }] } }) : send({ id: m.id, result: { structuredContent: reads[m.params.name] } });
      else send({ id: m.id, result: { structuredContent: { restarting: true } } });
    } else if (m.method === "ui/open-link") { window.__host.opened.push(m.params.url); send({ id: m.id, result: {} }); }
  });
`;
