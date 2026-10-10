// The files apps.scaffold writes: a small app that runs as it is and needs nothing but the node already in the container.
// The server speaks MCP over stdio by hand (newline-delimited JSON-RPC 2.0). The generated code avoids backticks and
// dollar-brace so it can sit in these template strings untouched; placeholders are replaced by plain string substitution.

export interface ScaffoldTool { name: string; title?: string; description?: string; read_only?: boolean }
export interface ScaffoldSurface { id: string; title: string }
export interface ScaffoldInput { id: string; name: string; summary?: string; role?: string; surfaces?: ScaffoldSurface[]; tools?: ScaffoldTool[]; publisher: string }

export const APP_JS = `// The page and the hub talk through the host (MCP Apps, JSON-RPC 2.0). Pages use window.app:
//   await app.call("tool", {args})   call one of this app's own tools; returns its structuredContent, throws with the tool's message
//   app.show("view")                 switch <section data-view="..."> inside the page
//   app.el("div", {class: "card"}, "text", child...)   make an element
(() => {
  let next = 0;
  const waiting = new Map();
  const post = (message) => window.parent.postMessage(message, "*");
  const theme = (context) => { if (context && (context.theme === "dark" || context.theme === "light")) document.documentElement.dataset.theme = context.theme; };
  window.addEventListener("message", (event) => {
    let message = event.data;
    if (typeof message === "string") { try { message = JSON.parse(message); } catch { return; } }
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && !message.method && waiting.has(message.id)) {
      const item = waiting.get(message.id); waiting.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || "failed")); else item.resolve(message.result);
    } else if (message.method === "ui/notifications/host-context-changed") theme(message.params);
  });
  const request = (method, params, ms) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error("no answer from the host")); }, ms);
    post({ jsonrpc: "2.0", id, method, params });
  });
  const ready = request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: document.title, version: "1" }, appCapabilities: {} }, 10000)
    .then((result) => { theme(result && result.hostContext); post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }); return (result && result.hostContext) || {}; });
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (key === "class") node.className = value; else node.setAttribute(key, value);
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  };
  window.app = {
    ready, el,
    async call(name, args = {}) {
      await ready;
      const result = await request("tools/call", { name, arguments: args }, 120000);
      if (!result || result.isError) throw new Error((result && result.content && result.content[0] && result.content[0].text) || "failed");
      return result.structuredContent || {};
    },
    show(view) { for (const node of document.querySelectorAll("[data-view]")) node.hidden = node.dataset.view !== view; },
  };
})();
`;

export const APP_CSS = `:root{color-scheme:light dark;--bg:#fff;--card:#f6f6f8;--ink:#1c1c1e;--muted:#6e6e73;--line:#e5e5ea;--accent:#ff7a3d;--radius:14px;font-family:system-ui,-apple-system,sans-serif}
:root[data-theme=dark]{--bg:#000;--card:#1c1c1e;--ink:#f2f2f2;--muted:#a0a0a6;--line:#2c2c2e;--accent:#ff8a50}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.5}
h1{font-size:20px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px;margin:0 0 12px}
.muted{color:var(--muted);font-size:13px}
.row{display:flex;gap:8px;align-items:center}
button,input{font:inherit;color:inherit}
button{border:0;background:var(--accent);color:#fff;border-radius:999px;padding:8px 16px;white-space:nowrap}
input{border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:8px 10px;width:100%}
.list{list-style:none;margin:0 0 12px;padding:0}
.item{display:flex;align-items:center;gap:8px;padding:10px 2px;border-bottom:1px solid var(--line)}
.item.done span{color:var(--muted);text-decoration:line-through}
`;

const SERVER = `// __NAME__ (ash-app/1). No npm packages: the hub runs "node server.mjs" and speaks MCP on stdin/stdout, one JSON-RPC 2.0
// message per line. Change TOOLS and handle() to what the app does; pages are ui/<surface id>.html (shared ui/app.css, ui/app.js).
// The owner's data lives in app.json's data_dir. stdout is for the protocol only: log with console.error.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

console.log = (...args) => console.error(...args);
const DIR = process.env.ASH_APP_DIR || process.cwd();
const APP = JSON.parse(readFileSync(join(DIR, "app.json"), "utf8"));
const UI_MIME = "text/html;profile=mcp-app";

const DATA_DIR = join(DIR, APP.data_dir || "data");
const DATA = join(DATA_DIR, "data.json");
const load = () => { try { return existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : { items: [] }; } catch { return { items: [] }; } };
const save = (data) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(DATA + ".tmp", JSON.stringify(data, null, 1)); renameSync(DATA + ".tmp", DATA); };

// Calling the hub back (ASH_MCP_URL), within what the owner approved at install:
//   await ash("capability_call", { member: "service:llm", word: "complete", body: { messages: [...] } })
async function ash(tool, args) {
  const url = process.env.ASH_MCP_URL, token = process.env.ASH_MCP_TOKEN;
  if (!url || !token) return { ok: false, error: { code: "unavailable", message: "not started by the hub" } };
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
    const body = await response.text();
    const json = body.trim().startsWith("{") ? body : body.split("\\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop();
    const message = JSON.parse(json || "{}");
    return message.result && message.result.structuredContent ? message.result.structuredContent : { ok: false, error: { code: "failed", message: "no answer" } };
  } catch (error) { return { ok: false, error: { code: "failed", message: String(error && error.message || error) } }; }
}

const TOOLS = __TOOLS__;
const SURFACES = __SURFACES__;

function handle(name, args) {
  const data = load();
  switch (name) {
    case "__ID__.list": return { items: data.items };
    case "__ID__.add": {
      const text = String(args.text || "").trim();
      if (!text) throw new Error("text is required");
      const item = { id: String(Date.now()), text, done: false };
      data.items.push(item); save(data);
      return { item };
    }
    case "__ID__.done": {
      const item = data.items.find((entry) => entry.id === args.id);
      if (!item) throw new Error("no such item");
      item.done = args.done !== false; save(data);
      return { item };
    }
    case "__ID__.remove": {
      const before = data.items.length;
      data.items = data.items.filter((entry) => entry.id !== args.id); save(data);
      return { removed: before - data.items.length };
    }
    default: return { note: "not written yet: " + name };
  }
}

function page(surface) {
  const read = (file) => readFileSync(join(DIR, "ui", file), "utf8");
  return "<!doctype html><html lang=\\"en\\"><head><meta charset=\\"utf-8\\"><meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\"><title>" + APP.name + "</title><style>" + read("app.css") + "</style></head><body>" + read(surface + ".html") + "<script>" + read("app.js") + "</script></body></html>";
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return;
  try {
    if (method === "initialize") reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: APP.id, version: APP.version } });
    else if (method === "ping") reply(id, {});
    else if (method === "tools/list") reply(id, { tools: TOOLS });
    else if (method === "tools/call") {
      try {
        const data = handle(params.name, params.arguments || {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
      } catch (error) { reply(id, { content: [{ type: "text", text: String(error && error.message || error) }], isError: true }); }
    } else if (method === "resources/list") reply(id, { resources: SURFACES.map((surface) => ({ uri: surface.resource, name: surface.title, mimeType: UI_MIME })) });
    else if (method === "resources/read") {
      const surface = SURFACES.find((item) => item.resource === params.uri);
      if (!surface) fail(id, -32602, "unknown resource");
      else reply(id, { contents: [{ uri: surface.resource, mimeType: UI_MIME, text: page(surface.id) }] });
    } else fail(id, -32601, "unknown method " + method);
  } catch (error) { fail(id, -32603, String(error && error.message || error)); }
});
`;

const PAGE = `<h1>__TITLE__</h1>
<section class="card">
  <ul class="list" id="list"></ul>
  <div class="row"><input id="text" placeholder="..."><button id="add">+</button></div>
</section>
<script>
  const list = document.getElementById("list");
  async function draw() {
    const { items } = await app.call("__ID__.list");
    list.replaceChildren(...items.map((item) => app.el("li", { class: "item" + (item.done ? " done" : "") },
      Object.assign(app.el("input", { type: "checkbox" }), { checked: item.done, onchange: async (event) => { await app.call("__ID__.done", { id: item.id, done: event.target.checked }); draw(); } }),
      app.el("span", {}, item.text))));
  }
  document.getElementById("add").onclick = async () => {
    const box = document.getElementById("text");
    if (box.value.trim()) { await app.call("__ID__.add", { text: box.value }); box.value = ""; draw(); }
  };
  draw();
</script>
`;

const fill = (template: string, values: Record<string, string>): string => template.replace(/__([A-Z]+)__/g, (_, key: string) => values[key] ?? "");

/** The input schema of a scaffolded tool: the generic list tools take what they use, anything else takes an open object. */
function schemaFor(id: string, name: string): Record<string, unknown> {
  if (name === `${id}.add`) return { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
  if (name === `${id}.done`) return { type: "object", properties: { id: { type: "string" }, done: { type: "boolean" } }, required: ["id"], additionalProperties: false };
  if (name === `${id}.remove`) return { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
  return { type: "object", properties: {}, additionalProperties: true };
}

export function scaffoldFiles(input: ScaffoldInput): Record<string, string> {
  const id = input.id;
  const surfaces = input.surfaces?.length ? input.surfaces : [{ id: "home", title: input.name.slice(0, 20) }];
  const base: ScaffoldTool[] = [
    { name: `${id}.list`, title: "看清单", description: `List the items in ${input.name}.`, read_only: true },
    { name: `${id}.add`, title: "加一条", description: `Add an item to ${input.name}.` },
    { name: `${id}.done`, title: "勾选", description: `Mark an item of ${input.name} done or not done.` },
    { name: `${id}.remove`, title: "删一条", description: `Remove an item from ${input.name}.` },
  ];
  const extra = (input.tools ?? []).filter((tool) => !base.some((known) => known.name === tool.name));
  const tools = [...base, ...extra].map((tool) => ({
    name: tool.name, title: tool.title ?? tool.name, description: tool.description ?? tool.title ?? tool.name, inputSchema: schemaFor(id, tool.name),
    annotations: tool.read_only ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }));
  const resources = surfaces.map((surface) => ({ id: surface.id, title: surface.title, resource: `ui://${id}/${surface.id}` }));
  const manifest = {
    contract: "ash-app/1", id, name: input.name, version: "0.1.0", summary: input.summary ?? input.name, role: input.role ?? input.summary ?? input.name,
    publisher: input.publisher, server: { command: "node", args: ["server.mjs"] },
    surfaces: resources.map((surface) => ({ id: surface.id, title: surface.title, resource: surface.resource })), data_dir: "data",
  };
  const files: Record<string, string> = {
    "app.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "server.mjs": fill(SERVER, { NAME: input.name, ID: id, TOOLS: JSON.stringify(tools, null, 2), SURFACES: JSON.stringify(resources, null, 2) }),
    "ui/app.css": APP_CSS,
    "ui/app.js": APP_JS,
    "data/.keep": "",
  };
  for (const surface of surfaces) files[`ui/${surface.id}.html`] = fill(PAGE, { ID: id, TITLE: surface.title });
  return files;
}
