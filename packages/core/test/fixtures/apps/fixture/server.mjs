// A minimal app for tests (ash-app/1): MCP over stdio, written by hand, no packages.
//   fixture.list   (read)      the notes and the events heard through ash.on_event
//   fixture.add    (write)     add a note; declared harmless (not destructive, not open world)
//   fixture.emit   (no hints)  send an event through the hub's endpoint
//   fixture.ash    (no hints)  call a word through the hub's endpoint: {member, word, body}
//   fixture.await  (no hints)  await_result {request_id}
//   fixture.exit   (no hints)  exit the process (to test a crash)
//   ash.on_event               the reserved tool: remembers every event the hub delivers
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

console.log = (...args) => console.error(...args);
const DIR = process.env.ASH_APP_DIR || process.cwd();
const DATA = join(DIR, "data", "data.json");
const load = () => { try { return existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : { notes: [], events: [] }; } catch { return { notes: [], events: [] }; } };
const save = (data) => { mkdirSync(join(DIR, "data"), { recursive: true }); writeFileSync(DATA, JSON.stringify(data)); };

async function ash(tool, args) {
  const response = await fetch(process.env.ASH_MCP_URL, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + process.env.ASH_MCP_TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
  const body = await response.text();
  const json = body.trim().startsWith("{") ? body : body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop();
  return JSON.parse(json).result.structuredContent;
}

const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const TOOLS = [
  { name: "fixture.list", title: "List", description: "The notes and the events heard.", inputSchema: object(), annotations: { readOnlyHint: true } },
  { name: "fixture.add", title: "Add", description: "Add a note.", inputSchema: object({ text: { type: "string" } }, ["text"]), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "fixture.emit", title: "Emit", description: "Send an event.", inputSchema: object({ name: { type: "string" }, body: { type: "object" } }, ["name"]) },
  { name: "fixture.ash", title: "Ash", description: "Call a word through the hub.", inputSchema: object({ member: { type: "string" }, word: { type: "string" }, body: { type: "object" } }, ["member", "word"]) },
  { name: "fixture.await", title: "Await", description: "Collect a long call.", inputSchema: object({ request_id: { type: "string" } }, ["request_id"]) },
  { name: "fixture.exit", title: "Exit", description: "Exit the process.", inputSchema: object() },
  { name: "ash.on_event", title: "On event", description: "Reserved: the hub delivers listened events here.", inputSchema: object({ word: { type: "string" }, body: {}, from: { type: "string" }, at: { type: "number" } }, ["word"]) },
];

async function call(name, args) {
  switch (name) {
    case "fixture.list": return load();
    case "fixture.add": { const data = load(); data.notes.push(args.text); save(data); return { count: data.notes.length }; }
    case "fixture.emit": return ash("ash_event", { name: args.name, body: args.body ?? {} });
    case "fixture.ash": return ash("capability_call", args);
    case "fixture.await": return ash("await_result", args);
    case "fixture.exit": setTimeout(() => process.exit(3), 20); return { exiting: true };
    case "ash.on_event": { const data = load(); data.events.push({ word: args.word, body: args.body, from: args.from, at: args.at }); save(data); return { ok: true }; }
    default: throw new Error("unknown tool " + name);
  }
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
  else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
  else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  else if (method === "tools/call") {
    try {
      const data = await call(params.name, params.arguments || {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } });
    } catch (error) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(error.message || error) }], isError: true } }); }
  } else if (method === "resources/read" && params.uri === "ui://fixture/home")
    send({ jsonrpc: "2.0", id, result: { contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><html><body><h1>Fixture</h1><script>window.addEventListener('message',()=>{});</script></body></html>" }] } });
  else send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method " + method } });
});
