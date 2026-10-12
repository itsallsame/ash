// 她的状态 — an Ash app (contract ash-app/1): an MCP server over stdio with four tools and two screens. It also keeps the
// home-screen card up to date: drawn again when the lamp changes, and at least every 15 minutes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import copy from "../../../../design/vitals/copy.json" with { type: "json" };
import { ashClient } from "./ash.mjs";
import { Store, Vitals } from "./logic.mjs";
import { PAGES } from "./pages.mjs";
import { TOOLS, callTool, RESOURCES, readResource } from "./tools.mjs";

const dir = process.env.ASH_APP_DIR || "/root/apps/vitals";
mkdirSync(join(dir, "data"), { recursive: true });
const vitals = new Vitals({ ash: ashClient(process.env.ASH_MCP_URL, process.env.ASH_MCP_TOKEN), store: new Store(join(dir, "data", "data.json")) });
const server = new Server({ name: "vitals", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(vitals, request.params.name, request.params.arguments ?? {}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => readResource(request.params.uri, PAGES));
await server.connect(new StdioServerTransport());

// The card: looked at every minute (a few reads of the hub, remembered between), drawn again when the lamp changed or 15 minutes have gone.
if (process.env.ASH_TRIAL !== "1") {
  let drawn = { lamp: null, at: 0 };
  const draw = async () => {
    const { a2ui, lamp } = await vitals.card();
    if (lamp === drawn.lamp && Date.now() - drawn.at < 15 * 60_000) return;
    await vitals.ash.call("service:widgets", "widget.card.put", { id: "vitals.status", title: copy.widget.card_title, size: "4x2", a2ui });
    drawn = { lamp, at: Date.now() };
  };
  const tick = () => draw().catch((error) => process.stderr.write(`card failed: ${error instanceof Error ? error.message : error}\n`));
  setTimeout(tick, 20_000);
  setInterval(tick, 60_000);
}
