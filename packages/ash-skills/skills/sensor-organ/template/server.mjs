// A sensing rule as an app (ash-app/1): MCP over stdio, by hand, no packages.
// The hub delivers every event listed in app.json "listens" to the reserved tool ash.on_event, one at a time,
// and wants the call back within 10 seconds: take the event, answer, and do the thinking afterwards (see enqueue).
import { createInterface } from "node:readline";

console.log = (...args) => console.error(...args);                 // stdout is the protocol; never print on it
const PLACE = "家";                                               // the named place this rule cares about (a geofence set with sense.configure)

// ---- the hub's way in: only what the owner approved in needs ----
async function ash(tool, args) {
  const response = await fetch(process.env.ASH_MCP_URL, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + process.env.ASH_MCP_TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
  const text = await response.text();
  const json = text.trim().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop();
  return JSON.parse(json).result.structuredContent;
}
/** Call a word of the hub: { ok, result } or { ok: false, code }. */
async function call(member, word, body = {}) {
  const out = await ash("capability_call", { member, word, body });
  return out.ok ? { ok: true, result: out.result } : { ok: false, code: out.error?.code ?? "failed" };
}
/** Ask the hub's small model; the answer text, or null when it cannot answer. */
async function llm(messages, max_tokens = 8) {
  const out = await call("service:llm", "complete", { messages, max_tokens });
  return out.ok ? String(out.result?.text ?? "") : null;
}
/** Wake the primary agent on its back lane with the facts it needs. The agent then decides what to do. */
async function wake(reason, context) {
  const list = await call("service:agents", "list");
  const primary = list.ok ? (list.result?.agents ?? []).find((agent) => agent.primary)?.id : null;
  return primary ? call(primary, "wake", { lane: "back", reason, context }) : { ok: false, code: "not_found" };
}

// ---- the rule: edit this part ----
let lastWake = 0;
const recent = [];                                                // the latest decisions, read with the tool "recent"
const note = (outcome, word) => { recent.push({ at: Date.now(), word, outcome }); recent.splice(0, recent.length - 50); };
async function onEvent({ word, body }) {
  if (word === "sense.geofence" && body.name === PLACE && body.transition === "enter") {
    note((await wake("arrived_" + PLACE, { place: body.name, at: body.ts })).ok ? "woke" : "failed", word);
  } else if (word === "sense.notification") {
    if (Date.now() - lastWake < 10 * 60_000) { note("too_soon", word); return; }   // at most one wake in ten minutes
    const answer = await llm([
      { role: "system", content: "Decide whether this phone notification needs the owner's attention right now. Answer one word: yes or no." },
      { role: "user", content: `${String(body.app).slice(0, 60)}: ${String(body.title).slice(0, 120)} ${String(body.text).slice(0, 300)}` }]);
    if (answer !== null && /^\s*yes/i.test(answer)) { lastWake = Date.now(); note((await wake("important_notification", { app: body.app, title: body.title })).ok ? "woke" : "failed", word); }
    else note("not_important", word);
  }
}

// events are taken at once and handled one after another, so the hub's call returns quickly
let queue = Promise.resolve();
const enqueue = (event) => { queue = queue.then(() => onEvent(event)).catch((error) => console.error("rule failed:", error)); };

// ---- MCP over stdio ----
const TOOLS = [{ name: "recent", title: "Recent decisions", description: "The latest decisions of the rule: woke, too_soon, not_important, failed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
{ name: "ash.on_event", title: "On event", description: "Reserved: the hub delivers listened events here.",
  inputSchema: { type: "object", properties: { word: { type: "string" }, body: {}, from: { type: "string" }, at: { type: "number" } }, required: ["word"], additionalProperties: false } }];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "my-sense-rule", version: "0.1.0" } } });
  else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
  else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  else if (method === "tools/call" && params.name === "recent") {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ recent }) }], structuredContent: { recent } } });
  } else if (method === "tools/call" && params.name === "ash.on_event") {
    enqueue({ word: params.arguments.word, body: params.arguments.body ?? {}, from: params.arguments.from, at: params.arguments.at });
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{\"ok\":true}" }], structuredContent: { ok: true } } });
  } else send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method " + method } });
});
