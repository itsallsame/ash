// What the page's browser tests share: a page on a test kernel, and the other members' parts (an agent that answers,
// the gate that asks, the owner's other screen).
import { serveKernel } from "../kernel.js";
import { launchBrowser, newPage } from "./browser.js";

export const OWNER = "person:owner";
let turns = 0;

/** Runs [body] with a browser, or skips the test when there is none. */
export function withBrowser(name, body, options = {}) {
  return [name, async (t) => {
    const browser = await launchBrowser();
    if (!browser) return t.skip("no browser to drive");
    const kernel = await serveKernel(options);
    try { await body({ kernel, browser, t }); }
    finally { await browser.close(); kernel.close(); }
  }];
}

/** Opens the page on the kernel and waits until it is connected and has its first history. */
export async function openPage(browser, kernel, { width = 412, height = 915 } = {}) {
  const { page, context } = await newPage(browser);
  await page.setViewportSize({ width, height });
  await page.goto(kernel.url);
  await page.waitForFunction(() => document.querySelector("#connection")?.textContent.includes("已连接"));
  await page.waitForFunction(() => !document.querySelector("#log .hello")?.textContent.includes("正在载入"));
  return { page, context };
}

/** An agent that reads what the owner says, works a moment (a tool call) and answers `echo: <text>`. */
export function echoAgent(kernel, { agent = "agent:main", tool = true } = {}) {
  kernel.on(agent, "say", (body, _request, message) => {
    const turn = `turn_${++turns}`;
    const event = (word, extra) => kernel.append({ from: agent, kind: "event", word, turn, body: { turn, ...extra } });
    event("turn.started", { lane: "front", ids: [message.id] });
    if (tool) {
      event("agent.tool", { name: "web_search", phase: "start", summary: "在搜索 资料" });
      event("agent.tool", { name: "web_search", phase: "end", ok: true });
    }
    kernel.append({ from: agent, to: OWNER, kind: "request", word: "say", turn, body: { text: `echo: ${body.text ?? ""}`, kind: "reply" } });
    event("turn.ended", { lane: "front", outcome: "completed" });
    return { accepted: true };
  });
}

/** The gate asks the owner to approve something. */
export function gateAsk(kernel, { title = "要发消息给小李", detail = "内容：明天见", ts = kernel.now(), id } = {}) {
  return kernel.append({ ...(id ? { id } : {}), from: "service:gate", to: OWNER, kind: "request", word: "ask", ts, body: {
    title, detail, human_kind: "confirmation", expires_at: Date.now() + 3_600_000,
    options: [{ id: "once", label: "允许这一次" }, { id: "always", label: "以后都允许" }, { id: "deny", label: "不允许" }],
    source: { word: "message.send", to: "device:abcdefghijklmnopqrstuv", body_preview: detail, body_full: `${detail}\n（完整原文）` } } });
}

export const say = (kernel, text, extra = {}) => kernel.append({ from: "agent:main", to: OWNER, kind: "request", word: "say", body: { text, kind: "reply" }, ...extra });

/** Waits until the kernel has seen a request. */
export async function requested(kernel, test, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const found = kernel.requests.find(test); if (found) return found; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`the page never sent the request; it sent ${JSON.stringify(kernel.requests.map((r) => `${r.to}/${r.word}`))}`);
}

/** Waits until [condition] holds (polling), or fails with [what]. */
export async function eventually(condition, what = "the condition", ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`timed out waiting for ${what}`);
}
