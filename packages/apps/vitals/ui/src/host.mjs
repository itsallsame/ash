// 应用页面和主机的话（MCP Apps 的视图一侧）：JSON-RPC，主机是父窗口，或者它先递过来的一个 MessagePort（安卓 WebView）。
// 和 health 的页面是同一套话；主题跟主机给的 hostContext.theme 走（<html data-theme>）。
let port = null, next = 0;
const waiting = new Map(), listeners = [];
const post = (message) => (port ? port.postMessage(JSON.stringify(message)) : window.parent.postMessage(message, "*"));
const theme = (context) => { if (context && (context.theme === "dark" || context.theme === "light")) document.documentElement.dataset.theme = context.theme; };

function receive(raw) {
  let message = raw;
  if (typeof raw === "string") { try { message = JSON.parse(raw); } catch { return; } }
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id !== undefined && waiting.has(message.id) && !message.method) {
    const item = waiting.get(message.id); waiting.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message || "host error")); else item.resolve(message.result);
  } else if (message.method === "ui/notifications/host-context-changed") theme(message.params);
  else if (message.method) for (const listener of listeners) listener(message);
}

const request = (method, params, ms = 30000) => new Promise((resolve, reject) => {
  const id = ++next; waiting.set(id, { resolve, reject });
  setTimeout(() => { if (waiting.delete(id)) reject(new Error("host did not answer")); }, ms);
  post({ jsonrpc: "2.0", id, method, params });
});

window.addEventListener("message", (event) => {
  if (!port && event.ports && event.ports[0]) { port = event.ports[0]; port.onmessage = (inner) => receive(inner.data); return; }
  receive(event.data);
});

/** 握手：等一拍让端口先到，问主机要主题，告诉它我准备好了，之后页面高度变了就报给它。 */
export const ready = (async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  const result = await request("ui/initialize", { protocolVersion: "2026-01-26", capabilities: {}, clientInfo: { name: "vitals", version: "1.0.0" } }, 5000);
  theme(result && result.hostContext);
  post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  new ResizeObserver(() => post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } })).observe(document.body);
})();

/** 调这个应用自己的工具，返回 structuredContent；工具出错就抛。 */
export async function call(name, args = {}) {
  await ready;
  const result = await request("tools/call", { name, arguments: args }, 60000);
  if (!result || result.isError) throw new Error((result && result.content && result.content[0] && result.content[0].text) || "失败了");
  return result.structuredContent || {};
}

/** 请主机打开一个地址（`ash://checkup/<部位>` 之类，由主机决定怎么开）。 */
export async function openLink(url) { await ready; return request("ui/open-link", { url }, 10000); }

export const on = (listener) => { listeners.push(listener); };
