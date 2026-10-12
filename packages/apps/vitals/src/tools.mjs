// The tools and the two screens of 她的状态, as MCP shapes (screens follow MCP Apps: ui:// resources linked from tools).
export const UI_MIME = "text/html;profile=mcp-app";
const none = { type: "object", properties: {}, additionalProperties: false };
export const TOOLS = [
  { name: "vitals.status", title: "看她的状态", description: "How she is now: the lamp (ok, warn, err), what she says about it, CPU and memory, which of her behaviour checks are kept, the alerts of the last day (live or recovered) and the phone's checkup in counts. Use it when asked how she is, why she is slow or warm.",
    inputSchema: none, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://vitals/home" } } },
  { name: "vitals.day", title: "看她今天的情况", description: "Today in numbers (things done, model calls, cost in yuan, errors, reconnects) and how busy she was in each of the last 24 hours.",
    inputSchema: none, annotations: { readOnlyHint: true } },
  { name: "vitals.restart", title: "重启大脑", description: "Restart her brain (about ten seconds away, what she was doing is cut off). Only after the owner confirmed: pass confirmed true.",
    inputSchema: { type: "object", properties: { confirmed: { const: true } }, required: ["confirmed"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "vitals.card", title: "画她的状态卡片", description: "The home-screen card (A2UI) of her state, in three sizes. Ash calls it to redraw the card.",
    inputSchema: none, annotations: { readOnlyHint: true } },
];

export const RESOURCES = [
  { uri: "ui://vitals/home", name: "状态", mimeType: UI_MIME },
  { uri: "ui://vitals/alert", name: "告警", mimeType: UI_MIME },
];

const ok = (data, text) => ({ content: [{ type: "text", text: text ?? JSON.stringify(data) }], structuredContent: data });
const failed = (message) => ({ content: [{ type: "text", text: message }], isError: true });

export async function callTool(vitals, name, args) {
  try {
    switch (name) {
      case "vitals.status": return ok(await vitals.status());
      case "vitals.day": return ok(await vitals.day());
      case "vitals.restart": return ok(await vitals.restart(args.confirmed));
      case "vitals.card": return ok((await vitals.card()).a2ui);
      default: return failed(`unknown tool ${name}`);
    }
  } catch (error) { return failed(error instanceof Error ? error.message : String(error)); }
}

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">`;

/** pages: { home, alert } complete HTML documents (the page brings its own tokens and styles). The content security policy is put in by the app. */
export function readResource(uri, pages) {
  const id = { "ui://vitals/home": "home", "ui://vitals/alert": "alert" }[uri];
  if (!id) throw new Error(`unknown resource ${uri}`);
  const html = pages[id].includes("Content-Security-Policy") ? pages[id] : pages[id].replace(/<head[^>]*>/i, (head) => `${head}${CSP}`);
  return { contents: [{ uri, mimeType: UI_MIME, text: html, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } } }] };
}
