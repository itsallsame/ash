// The script agent: an ACP agent (the same protocol DSH speaks, see edges/agents/dsh) that does not think. A message to it is a
// script (JSON), and it carries the script out step by step through the tool surface it was given in `session/new`: the same
// door, token and path a real agent's calls take, so the router, the gate, the approvals, the host and the status all see an
// ordinary agent. Only a debug build of the hub declares it (`agent:script`, runtime kind `script`).
//
// A script is `{run, steps: [...], on_message?: [{match, steps}]}`. A step is one of
//   {call: {member, word, body?, purpose?, wait?, approval_ttl_minutes?}, id?}   a capability_call
//   {tool: "human_say", args: {...}, id?}                                       any tool of the surface
//   {say: "text", kind?}                                                        human_say: a word to the owner
//   {until: {call: {...}, path: "data.state", equals: "approved"}, timeout_ms?, every_ms?, id?}   poll a call until it holds
//   {checkpoint: "name", timeout_ms?}                                           show the owner's side where the agent is, and wait
//                                                                               until it releases it (a file the owner writes)
//   {sleep_ms: N}                                                               only a fallback: wait for state, not for time
// A string of a body may hold ${step.path} (a result of an earlier step: `${a1.data.pending_id}`), `${msg.pending}` (in a handler:
// the pending id of a message `[answers <id>, option <choice>] ...`), `${msg.option}`, `${msg.text}`, or `${run}`.
// After the steps (or a handler's) the agent says one line to the owner, `{"script_report": {...}}`: the result of every step, in
// order (ok, error code, status, data, ms), which the owner's command line asserts on.
import { createInterface } from "node:readline";

const out = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId, u) => out({ method: "session/update", params: { sessionId, update: u } });
const sessions = new Map();
let counter = 0;
let rpcId = 0;
let toolId = 0;
/** What the last script said to do about messages that come later (a slow approval's answer, for one). */
let handlers = [];

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});
const clip = (value, max = 3000) => {
  const text = JSON.stringify(value);
  return text === undefined || text.length <= max ? value : `${text.slice(0, max)}…`;
};

// ---- the tool surface (MCP over HTTP, stateless) ------------------------------------------------------------------------

function parseSse(text) {
  let last;
  for (const line of text.split("\n")) if (line.startsWith("data:")) { try { last = JSON.parse(line.slice(5).trim()); } catch { /* not JSON */ } }
  return last;
}

async function mcp(server, name, args, signal) {
  let res;
  try {
    res = await fetch(server.url, {
      method: "POST", signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value])) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch (error) { return { transport: String(error?.message ?? error) }; }
  const text = await res.text();
  if (!res.ok) return { transport: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  let message;
  try { message = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? parseSse(text) : JSON.parse(text); } catch { return { transport: `not JSON: ${text.slice(0, 200)}` }; }
  if (!message) return { transport: "no answer" };
  if (message.error) return { transport: `rpc ${message.error.code}: ${message.error.message}` };
  return { result: message.result };
}

/** What a step reports of a tool's answer: ok or the error code, the receipt's status, the data, how many images. */
function shape(answer) {
  if (answer.transport) return { ok: false, error: { code: "transport", message: answer.transport } };
  const r = answer.result ?? {};
  const parts = Array.isArray(r.content) ? r.content : [];
  const texts = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const images = parts.filter((p) => p.type === "image").length;
  if (r.isError) {
    const e = r.structuredContent?.error ?? {};
    return { ok: false, error: { code: e.code ?? "error", message: e.message ?? texts.slice(0, 300), ...(e.recovery_hint ? { recovery_hint: e.recovery_hint } : {}) } };
  }
  let data = r.structuredContent;
  if (data === undefined && texts) { try { data = JSON.parse(texts); } catch { data = texts; } }
  const status = data && typeof data === "object" && typeof data.status === "string" ? data.status : undefined;
  return { ok: true, ...(status ? { status } : {}), ...(data !== undefined ? { data: clip(data) } : {}), ...(images ? { images } : {}) };
}

// ---- variables ----------------------------------------------------------------------------------------------------------

function pathGet(value, path) {
  let v = value;
  for (const key of path.split(".")) { if (v === null || typeof v !== "object") return undefined; v = v[key]; }
  return v;
}
function subst(value, vars) {
  if (typeof value === "string") {
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole) { const v = pathGet(vars, whole[1]); return v === undefined ? value : v; }
    return value.replace(/\$\{([^}]+)\}/g, (all, p) => { const v = pathGet(vars, p); return v === undefined ? all : typeof v === "string" ? v : JSON.stringify(v); });
  }
  if (Array.isArray(value)) return value.map((x) => subst(x, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, subst(v, vars)]));
  return value;
}

// ---- steps --------------------------------------------------------------------------------------------------------------

/** One tool call of the surface, shown to the hub as an agent's tool call (a `tool` event of the turn). */
async function callTool(s, name, args, signal) {
  const id = `s${++toolId}`;
  update(s.id, { sessionUpdate: "tool_call", toolCallId: id, title: `mcp__ash__${name}`, kind: "other", status: "in_progress", rawInput: args });
  const started = Date.now();
  const shaped = shape(await mcp(s.mcp, name, args, signal));
  update(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: shaped.ok ? "completed" : "failed", content: [] });
  return { ...shaped, ms: Date.now() - started };
}

const envelope = (c) => ({ member: c.member, word: c.word, body: c.body ?? {}, ...(c.purpose ? { purpose: c.purpose } : {}), ...(c.wait !== undefined ? { wait: c.wait } : {}),
  ...(c.approval_ttl_minutes ? { approval_ttl_minutes: c.approval_ttl_minutes } : {}) });

const holds = (result, until) => {
  const v = pathGet(result, until.path);
  return "equals" in until ? JSON.stringify(v) === JSON.stringify(until.equals) : "exists" in until ? (v !== undefined) === until.exists : v !== undefined && v !== null && v !== false;
};

async function runStep(s, step, vars, signal) {
  if (step.call) return { kind: "call", ...(await callTool(s, "capability_call", envelope(step.call), signal)) };
  if (step.tool) return { kind: "tool", ...(await callTool(s, step.tool, step.args ?? {}, signal)) };
  if (step.say !== undefined) return { kind: "say", ...(await callTool(s, "human_say", { text: step.say, ...(step.kind ? { kind: step.kind } : {}) }, signal)) };
  if (step.sleep_ms !== undefined) { const t = Date.now(); await sleep(step.sleep_ms, signal); return { kind: "sleep", ok: true, ms: Date.now() - t }; }
  if (step.until) return { kind: "until", ...(await poll(s, step.until, step, signal)) };
  if (step.checkpoint) return { kind: "checkpoint", name: step.checkpoint, ...(await checkpoint(s, step, vars, signal)) };
  return { kind: "unknown", ok: false, error: { code: "bad_step", message: `not a step: ${JSON.stringify(step).slice(0, 120)}` }, ms: 0 };
}

/** Calls again every `every_ms` until the result holds (state, not time), at most `timeout_ms`. */
async function poll(s, until, step, signal) {
  const started = Date.now();
  const limit = step.timeout_ms ?? 30000;
  let last;
  for (;;) {
    last = await callTool(s, "capability_call", envelope(until.call), signal);
    if (holds(last, until)) return { ok: true, ms: Date.now() - started, ...(last.status ? { status: last.status } : {}), data: last.data, ...(last.images ? { images: last.images } : {}) };
    if (signal?.aborted) return { ok: false, error: { code: "cancelled", message: "cancelled" }, ms: Date.now() - started };
    if (Date.now() - started >= limit) return { ok: false, error: { code: "timeout", message: `did not hold in ${limit} ms` }, ms: Date.now() - started, data: last.data };
    await sleep(step.every_ms ?? 300, signal);
  }
}

/**
 * The owner's side learns where the agent is (a tool event named `script.checkpoint:<name>` in the ledger) and does what it has to
 * (look at the phone, say something), then writes the release file; the agent goes on once it reads it.
 */
async function checkpoint(s, step, vars, signal) {
  const id = `s${++toolId}`;
  update(s.id, { sessionUpdate: "tool_call", toolCallId: id, title: `script.checkpoint:${step.checkpoint}`, kind: "other", status: "in_progress", rawInput: { checkpoint: step.checkpoint } });
  update(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [] });
  const path = `/root/work/.script/${vars.run}/${step.checkpoint}.release`;
  const waited = await poll(s, { call: { member: "body:main", word: "workspace.read", body: { path } }, path: "ok", equals: true }, { timeout_ms: step.timeout_ms ?? 60000, every_ms: 300 }, signal);
  return { ...waited, data: undefined };
}

async function runSteps(s, steps, vars, signal) {
  const results = [];
  for (const raw of steps) {
    if (signal?.aborted) break;
    const step = subst(raw, vars);
    const r = await runStep(s, step, vars, signal);
    const entry = { i: results.length, ...(raw.id ? { id: raw.id } : {}), ...r };
    results.push(entry);
    if (raw.id) vars[raw.id] = entry;
  }
  return results;
}

// ---- a turn -------------------------------------------------------------------------------------------------------------

/** The messages of a prompt: each block is `[ash] <envelope>` and then the words. */
function messagesOf(prompt) {
  return (prompt ?? []).filter((b) => b.type === "text" && String(b.text).startsWith("[ash]")).map((b) => String(b.text).split("\n").slice(1).join("\n").trim());
}

async function turn(s, prompt, signal) {
  const messages = messagesOf(prompt);
  const script = messages.map((m) => { if (!m.startsWith("{")) return null; try { return JSON.parse(m); } catch { return null; } }).find((x) => x && Array.isArray(x.steps));
  let report;
  if (script) {
    handlers = Array.isArray(script.on_message) ? script.on_message : [];
    const vars = { run: script.run ?? "run" };
    const steps = await runSteps(s, script.steps, vars, signal);
    report = { run: vars.run, trigger: "script", completed: !signal?.aborted, steps };
  } else {
    const text = messages.join("\n");
    const handler = handlers.find((h) => text.includes(h.match));
    if (!handler) report = { run: null, trigger: "message", matched: null, text: text.slice(0, 300), steps: [] };
    else {
      const answer = /\[answers ([^,\]\s]+), option ([^\]\s]+)\]/.exec(text);
      const vars = { run: handler.run ?? "run", msg: { text, pending: answer?.[1], option: answer?.[2] } };
      const steps = await runSteps(s, handler.steps ?? [], vars, signal);
      report = { run: vars.run, trigger: "message", matched: handler.match, completed: !signal?.aborted, steps };
    }
  }
  update(s.id, { sessionUpdate: "agent_message_chunk", messageId: `r${++toolId}`, content: { type: "text", text: JSON.stringify({ script_report: report }) } });
  return signal?.aborted ? "cancelled" : "end_turn";
}

// ---- ACP ----------------------------------------------------------------------------------------------------------------

const methods = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } }),
  "session/new": (p) => {
    const id = `script-${++counter}-${process.pid}`;
    sessions.set(id, { id, mcp: (p.mcpServers ?? [])[0], abort: null });
    return { sessionId: id, configOptions: [] };
  },
  "session/resume": (p) => {
    const old = sessions.get(p.sessionId);
    if (!old) throw Object.assign(new Error("session not found"), { code: -32602 });
    old.mcp = (p.mcpServers ?? [])[0] ?? old.mcp;
    return { configOptions: [] };
  },
  "session/prompt": async (p) => {
    const s = sessions.get(p.sessionId);
    if (!s) throw Object.assign(new Error("session not found"), { code: -32602 });
    s.abort = new AbortController();
    try { return { stopReason: await turn(s, p.prompt, s.abort.signal) }; } finally { s.abort = null; }
  },
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "session/cancel") { sessions.get(message.params?.sessionId)?.abort?.abort(); return; }
  if (message.id === undefined || !message.method) return;
  const handler = methods[message.method];
  if (!handler) { out({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } }); return; }
  Promise.resolve().then(() => handler(message.params ?? {})).then(
    (result) => out({ id: message.id, result }),
    (error) => out({ id: message.id, error: { code: error?.code ?? -32000, message: String(error?.message ?? error) } }),
  );
});
rl.on("close", () => process.exit(0));
