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

const ok = (id, value, budget) => ({ id, ok: true, value, budget, window_s: 60 });
const invariants = (over = {}) => [
  ok("idle.msg_rate", 2, 30), ok("idle.ledger_growth", 0, 10), ok("idle.cpu", 1, 5), ok("link.reconnect_storm", 0, 5), ok("errors.rate", 0, 20), ok("loop.lag", 12, 200),
].map((x) => over[x.id] ?? x);

/** 过去 24 小时每分钟一行；做事和 CPU 有一点起伏。 */
function minutes(now, { hot = null } = {}) {
  return Array.from({ length: 1440 }, (_, i) => {
    const ts = now - (1439 - i) * MIN;
    const h = new Date(ts).getHours();
    const busy = h >= 9 && h <= 16;
    return { ts, cpu_pct: busy ? 4 + (i % 7) : 1 + (i % 3) * 0.4, rss_mb: 180 + (i % 5), msg: busy ? 6 + (i % 5) : (i % 4 === 0 ? 1 : 0), err: 0, link_opens: 0, ...(hot && ts >= hot ? { cpu_pct: 38, msg: 44 } : {}) };
  });
}

const base = () => ({
  now: NOW, paused: false, hands_online: 2, busy_what: null, turns_today: 12, devices: { "device:laptop": "我的电脑" },
  usage: { periods: { today: { calls: 86, cost_usd: 3.42 / 6.74 } } },
  checkup: { todo: 0, groups: ["brain", "alarm", "notify", "awake", "eyes", "files", "location"].map((id) => ({ id, todo: 0 })) },
  status: { uptime_s: 86_400, idle: true, proc: { cpu_pct: 2, rss_mb: 186, lag_p99_ms: 12 }, invariants: invariants() },
  events: [], minutes: minutes(NOW),
});

export const scenarios = {
  /** 正常：整页没有一处红色或琥珀色。 */
  ok: () => base(),
  /** 留意：刚出过事，已经好了。 */
  warn: () => ({
    ...base(),
    status: { uptime_s: 86_400, idle: true, proc: { cpu_pct: 3, rss_mb: 204, lag_p99_ms: 15 }, invariants: invariants({ "idle.cpu": ok("idle.cpu", 1, 5), "loop.lag": ok("loop.lag", 15, 200) }) },
    events: [
      { ts: at(13, 40), type: "breach", id: "idle.cpu", value: 38, budget: 5, window_s: 60, since: at(13, 40) },
      { ts: at(9, 15), type: "breach", id: "loop.lag", value: 860, budget: 200, window_s: 60, since: at(9, 15) },
      { ts: at(13, 41), type: "ok", id: "idle.cpu", since: at(13, 40) },
      { ts: at(9, 16), type: "ok", id: "loop.lag", since: at(9, 15) },
    ].map((e) => (e.id === "idle.cpu" ? { ...e, ts: e.type === "ok" ? at(13, 41) : e.ts } : e)),
    today_errors: 2,
  }),
  /** 有问题：闲着却在空转。 */
  err: () => ({
    ...base(),
    status: { uptime_s: 86_400, idle: true, proc: { cpu_pct: 38, rss_mb: 342, lag_p99_ms: 24 }, invariants: invariants({
      "idle.msg_rate": { id: "idle.msg_rate", ok: false, value: 44, budget: 30, window_s: 60, since: at(14, 2) },
      "idle.cpu": { id: "idle.cpu", ok: false, value: 38, budget: 5, window_s: 60, since: at(14, 2) },
    }) },
    events: [
      { ts: at(14, 2), type: "breach", id: "idle.msg_rate", value: 44, budget: 30, window_s: 60, since: at(14, 2) },
      { ts: at(9, 15), type: "breach", id: "loop.lag", value: 860, budget: 200, window_s: 60, since: at(9, 15) },
      { ts: at(9, 16), type: "ok", id: "loop.lag", since: at(9, 15) },
    ],
    minutes: minutes(NOW, { hot: at(14, 2) }),
  }),
  /** 体检有待办，她在忙（闲着才算的底线不算），重连越界。 */
  todo: () => ({
    ...base(),
    busy_what: "整理你的日程",
    status: { uptime_s: 86_400, idle: false, proc: { cpu_pct: 9, rss_mb: 210, lag_p99_ms: 12 }, invariants: invariants({
      "link.reconnect_storm": { id: "link.reconnect_storm", ok: false, value: 7, budget: 5, window_s: 300, since: at(14, 0), top: [{ hand: "device:laptop", n: 7 }] },
    }) },
    events: [{ ts: at(14, 0), type: "breach", id: "link.reconnect_storm", value: 7, budget: 5, window_s: 300, since: at(14, 0), top: [{ hand: "device:laptop", n: 7 }] }],
    checkup: { todo: 2, groups: ["brain", "alarm", "notify", "awake", "eyes", "files", "location"].map((id) => ({ id, todo: id === "awake" || id === "eyes" ? 1 : 0 })) },
    minutes: minutes(NOW).map((m, i) => (i === 1439 ? { ...m, link_opens: 7 } : m)),
  }),
  /** 刚装好：还没有 minute 行。 */
  fresh: () => ({
    ...base(), hands_online: 1, busy_what: "认识你", turns_today: 1, usage: { periods: { today: { calls: 3, cost_usd: 0.04 / 6.74 } } },
    status: { uptime_s: 45, idle: false, proc: { cpu_pct: 14, rss_mb: 158, lag_p99_ms: 9 }, invariants: invariants({ "loop.lag": ok("loop.lag", 9, 200) }) },
    minutes: [], events: [], checkup: null,
  }),
  /** 读不到状态：大脑没在运行。 */
  down: () => ({ ...base(), status: null }),
};

/**
 * 一个页面的假主机：把 [html] 放进 iframe（页面认为父窗口是主机），回握手、回 tools/call、记下 ui/open-link。
 * 在浏览器页面里跑；返回的对象在 page.evaluate 里用 window.__host 取。
 */
export const hostScript = (theme, raw, calls = {}) => `
  window.__host = { opened: [], called: [], theme: ${JSON.stringify(theme)}, raw: ${JSON.stringify(raw)}, fail: false };
  const frame = document.getElementById("f");
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || m.jsonrpc !== "2.0" || event.source !== frame.contentWindow) return;
    const send = (message) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...message }, "*");
    if (m.method === "ui/initialize") send({ id: m.id, result: { hostContext: { theme: window.__host.theme } } });
    else if (m.method === "tools/call") {
      window.__host.called.push(m.params.name);
      if (m.params.name === "vitals.snapshot") window.__host.fail ? send({ id: m.id, result: { isError: true, content: [{ type: "text", text: "读不到" }] } }) : send({ id: m.id, result: { structuredContent: window.__host.raw } });
      else send({ id: m.id, result: { structuredContent: { ok: true } } });
    } else if (m.method === "ui/open-link") { window.__host.opened.push(m.params.url); send({ id: m.id, result: {} }); }
  });
`;
