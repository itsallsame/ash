// ACP superset for ash: the official ACP bridge keeps every standard method; this plugin owns stdin/stdout,
// answers ash's extension methods (_ash/steer, _ash/inject, _ash/plugins, _ash/credentials.has, _ash/credentials.set,
// _ash/usage, _ash/compact) through the live Agent and DSH's own services, and passes everything else through.
// It also makes a model choice durable at once: DSH keeps the choice in memory until the next model request writes its
// `request/header`, so a restart in between would put the session back on the default model.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

export const name = "dsh-ash-control";
export const inject = ["agents", "llm", "sessionPersistence", "sessions", "acpAppStartup", "compaction"];

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SECRET = 8192;
const BALANCE_TIMEOUT_MS = 5000;
/** Answered to `_ash/compact` when the session is not idle; ash waits for the turn to end and asks again. */
const BUSY = -32002;

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = (message) => new RpcError(-32602, message);
const unavailable = (message) => new RpcError(-32603, message);

/**
 * The extension methods that need only DSH's services, not the ACP stream: ash asks whether DSH holds a key, hands it
 * one, and pulls the usage ash-cost recorded. Each takes the request params and returns the result, or throws RpcError.
 * No method ever returns a credential value, and none writes one to a log.
 * `_ash/compact` is the same path as DSH's own /compact command: its `compaction` service's compactNow, on an idle agent.
 */
export function createAshMethods(ctx) {
  // Looked up per call, like the plugin manager: a missing service fails that one method, never the ACP bridge.
  const store = () => {
    const service = ctx.get?.("credentials");
    if (!service) throw unavailable("credential service unavailable");
    return service;
  };
  const refOf = (params) => {
    const ref = params?.ref;
    if (typeof ref !== "string" || !CREDENTIAL_REF.test(ref)) throw invalid("ref must be a credential name such as DEEPSEEK_API_KEY");
    return ref;
  };
  return {
    // {sessionId} -> {compacted, shadowed?, tokens?, detail?}: compact an idle session once. A session in a turn answers
    // BUSY. Nothing worth compacting is a normal answer (compacted: false), not an error.
    "_ash/compact": async (params) => {
      const sessionId = params?.sessionId;
      if (typeof sessionId !== "string" || !sessionId) throw invalid("sessionId is required");
      const agent = ctx.agents?.get?.(sessionId);
      if (!agent) throw invalid(`unknown session: ${sessionId}`);
      const compaction = ctx.get?.("compaction") ?? ctx.compaction;
      if (!compaction || typeof compaction.compactNow !== "function") throw unavailable("compaction service unavailable");
      if (agent.status === "running") throw new RpcError(BUSY, "busy: the session is in a turn");
      let result;
      try { result = await compaction.compactNow(agent, new AbortController().signal); } catch (error) {
        if (error?.code === "busy") throw new RpcError(BUSY, "busy: compaction is already running or the agent is not idle");
        throw unavailable(`compaction failed: ${String(error?.code ?? error?.message ?? error).replace(/\s+/g, " ").slice(0, 120)}`);
      }
      if (!result) return { compacted: false, detail: "nothing to compact yet" };
      return { compacted: true, shadowed: result.shadowedSeqs?.length ?? 0, tokens: result.shadowedTokenCount ?? 0,
        detail: `compacted ${result.shadowedSeqs?.length ?? 0} history items (~${result.shadowedTokenCount ?? 0} tokens)` };
    },
    // {ref} -> {has, source?, writable?}: whether DSH has this key, which source supplies it, and whether ash may
    // replace it. DSH's describe() answers from metadata, so the value is never read.
    "_ash/credentials.has": async (params) => {
      const ref = refOf(params);
      const service = store();
      let info;
      try { info = await service.describe(ref); } catch { throw unavailable("credential lookup failed"); }
      if (!info?.configured) return { has: false, ...(typeof info?.writable === "boolean" ? { writable: info.writable } : {}) };
      return { has: true, ...(typeof info.source === "string" ? { source: info.source } : {}),
        ...(typeof info.writable === "boolean" ? { writable: info.writable } : {}) };
    },
    // {ref, value} -> {ok: true}: store the key in DSH's own credential file. The value is neither echoed nor logged.
    "_ash/credentials.set": async (params) => {
      const ref = refOf(params);
      const value = params?.value;
      if (typeof value !== "string" || !value || value.length > MAX_SECRET) throw invalid("value must be a non-empty string");
      const service = store();
      try { await service.set(ref, value); } catch (error) {
        throw unavailable(`credential could not be stored: ${String(error?.message ?? error).split(value).join("***").replace(/\s+/g, " ").slice(0, 200)}`);
      }
      return { ok: true };
    },
    // {since} -> {records, balance?}: what ash-cost recorded after `since` (ms), and the latest balance it has read.
    "_ash/usage": async (params) => {
      const since = params?.since ?? 0;
      if (typeof since !== "number" || !Number.isFinite(since) || since < 0) throw invalid("since must be a millisecond timestamp");
      const collector = ctx.get?.("ashCost");
      if (!collector || typeof collector.since !== "function") throw unavailable("ash-cost is not loaded");
      // Each pull asks the provider once; when it cannot answer, the reply simply carries no balance.
      let balance;
      try { balance = { ...(await collector.balance({ timeoutMs: BALANCE_TIMEOUT_MS })), at: Date.now() }; } catch { /* left out */ }
      return { records: collector.since(since), ...(balance ? { balance } : {}) };
    },
  };
}

// -- the model choice ------------------------------------------------------------------------------------------------
// ACP's `session/set_config_option` only changes the selection in memory; the session log learns it from the
// `request/header` of the next model request, and `session/resume` restores from that header (or the deployment
// default when the log has none). So after a successful set, the plugin appends DSH's own `model/selection` event (the
// same record DSH's web API writes for a pending choice) and flushes it; after a successful resume it reads the latest
// `model/selection` newer than the latest `request/header` and sets it back. Nothing lives outside DSH's session log.
const MODEL_OPTION = "model";
const EFFORT_OPTION = "reasoning_effort";

/** {provider, model, reasoningEffort?} read from an ACP configOptions list; the model option's value is a JSON [provider, model]. */
export function selectionOf(options) {
  if (!Array.isArray(options)) return undefined;
  let pair;
  try { pair = JSON.parse(options.find((o) => o?.id === MODEL_OPTION)?.currentValue); } catch { return undefined; }
  if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string" || !pair[0] || !pair[1]) return undefined;
  const effort = options.find((o) => o?.id === EFFORT_OPTION)?.currentValue;
  return { provider: pair[0], model: pair[1], ...(typeof effort === "string" && effort ? { reasoningEffort: effort } : {}) };
}

const sameRoute = (a, b) => a.provider === b.provider && a.model === b.model;
const sameSelection = (a, b, lenientEffort) => sameRoute(a, b) && (lenientEffort || a.reasoningEffort === b.reasoningEffort);

/** The newest of the log's two statements about the model: {kind: "selection" | "header", selection, lenientEffort}. */
export function latestModelIntent(session) {
  const events = session?.snapshotEvents?.() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "model/selection") return { kind: "selection", selection: event.data, lenientEffort: false };
    if (event.type === "request/header") {
      const config = event.data?.header?.config;
      if (!config) continue;
      // The header carries the effort the adapter picked as its default; that is not a choice anybody made.
      const lenientEffort = session.requestHeader?.()?.adapterDefaults?.reasoningEffort === true;
      return { kind: "header", selection: { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: String(config.reasoningEffort) } : {}) }, lenientEffort };
    }
  }
  return undefined;
}

/** Remember and restore the model choice of a session in DSH's own session log. Failures are logged, never thrown. */
export function createModelMemory(ctx, log = () => {}) {
  return {
    /** After a successful set: make the choice in `options` durable, unless the log already says so. */
    async remember(sessionId, options) {
      try {
        const agent = typeof sessionId === "string" ? ctx.agents?.get?.(sessionId) : undefined;
        const selection = selectionOf(options);
        if (!agent || !selection) return;
        const latest = latestModelIntent(agent.session);
        if (latest && sameSelection(latest.selection, selection, latest.lenientEffort)) return;
        agent.session.append("model/selection", selection);
        await ctx.sessions.flush(agent.session);
      } catch (error) { log(`dsh-ash-control: could not record the model choice: ${String(error?.message ?? error).slice(0, 200)}`); }
    },
    /**
     * After a successful resume: when the newest statement in the log is a choice no request has used yet, set it back
     * through `set(configId, value) -> result` and return the resume result with the options after that.
     */
    async restore(sessionId, result, set) {
      // Outside the try: when a later set fails, the earlier ones went through and DSH is already where `options` says.
      let options = result.configOptions;
      try {
        const agent = typeof sessionId === "string" ? ctx.agents?.get?.(sessionId) : undefined;
        const latest = agent && latestModelIntent(agent.session);
        if (!latest || latest.kind !== "selection") return result;
        const want = latest.selection;
        const have = selectionOf(options);
        if (!have || !sameRoute(have, want)) options = (await set(MODEL_OPTION, JSON.stringify([want.provider, want.model])))?.configOptions ?? options;
        if (want.reasoningEffort && selectionOf(options)?.reasoningEffort !== want.reasoningEffort)
          options = (await set(EFFORT_OPTION, want.reasoningEffort))?.configOptions ?? options;
        return { ...result, configOptions: options };
      } catch (error) {
        log(`dsh-ash-control: could not restore the model choice: ${String(error?.message ?? error).slice(0, 200)}`);
        return { ...result, configOptions: options };
      }
    },
  };
}

export async function apply(ctx, config) {
  const req = createRequire(realpathSync(process.argv[1]));
  const acpPath = req.resolve("@deepseek-ai/dsh-acp");
  const sdkPath = createRequire(acpPath).resolve("@agentclientprotocol/sdk");
  const acp = await import(pathToFileURL(acpPath).href);
  const { ndJsonStream } = await import(pathToFileURL(sdkPath).href);
  // DSH's own constructor gives each message the identity a stored session needs to load again.
  const { createUserMessage } = await import(pathToFileURL(createRequire(acpPath).resolve("@deepseek-ai/dsh-llm")).href);

  // One writer for stdout: ACP frames and our own replies never interleave mid-line.
  const out = (line) => process.stdout.write(line.endsWith("\n") ? line : line + "\n");
  let feed;
  const input = new ReadableStream({ start(controller) { feed = controller; } });
  // Replies the plugin wants to see (or hold, or swallow) before they reach ash: request id -> handler(reply), which
  // returns nothing (pass the reply on), a replacement line, or null (swallow). A handler that throws passes it on.
  const watching = new Map();
  const frame = (text) => {
    for (const line of text.split("\n")) {
      if (!line) continue;
      let msg;
      if (watching.size) try { msg = JSON.parse(line); } catch { /* sent as it is */ }
      const handler = msg && msg.method === undefined && msg.id !== undefined ? watching.get(msg.id) : undefined;
      if (!handler) { out(line); continue; }
      watching.delete(msg.id);
      Promise.resolve().then(() => handler(msg)).then((replacement) => { if (replacement !== null) out(replacement ?? line); }, () => out(line));
    }
  };
  const output = new WritableStream({ write(chunk) { frame(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); } });
  const encoder = new TextEncoder();

  const reply = (id, result, error) => out(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }));
  const extension = (msg) => {
    const { sessionId, content } = msg.params ?? {};
    const agent = typeof sessionId === "string" ? ctx.agents.get(sessionId) : undefined;
    if (!agent) return reply(msg.id, undefined, { code: -32602, message: `unknown session: ${sessionId}` });
    if (!Array.isArray(content) || !content.length) return reply(msg.id, undefined, { code: -32602, message: "content must be a non-empty array" });
    // A steer is the owner speaking; injected context is ash's own producer kind (DSH retired the generic "plugin" kind).
    const message = createUserMessage({ content, source: { kind: msg.method === "_ash/steer" ? "user" : "ash-context" } });
    // A steer only joins work in progress. An idle agent would start a turn nobody is watching, so ash keeps the words
    // for its next prompt instead.
    if (msg.method === "_ash/steer") {
      if (agent.status !== "running") return reply(msg.id, { steered: false });
      agent.steer(message);
      return reply(msg.id, { steered: true });
    }
    agent.inject(message);
    reply(msg.id, {});
  };

  // The owner's plugin page: list, and switch bundles or single plugins on and off (they apply on the next start).
  const plugins = async (msg) => {
    const manager = ctx.get?.("pluginManager");
    if (!manager) return reply(msg.id, undefined, { code: -32603, message: "plugin manager unavailable" });
    const { op, name: target, id, enabled } = msg.params ?? {};
    try {
      if (op === "list") {
        const [bundles, list] = await Promise.all([manager.listBundles(), manager.listPlugins()]);
        return reply(msg.id, { bundles, plugins: list });
      }
      if ((op === "enable" || op === "disable") && typeof target === "string" && target.trim())
        return reply(msg.id, await manager.setBundleEnabled(target.trim(), op === "enable"));
      if (op === "plugin" && typeof id === "string" && id.trim() && typeof enabled === "boolean")
        return reply(msg.id, await manager.setPluginEnabled(id.trim(), enabled));
      return reply(msg.id, undefined, { code: -32602, message: "unsupported plugin operation" });
    } catch (error) {
      return reply(msg.id, undefined, { code: -32603, message: String(error?.message ?? error).slice(0, 300) });
    }
  };

  const methods = createAshMethods(ctx);
  const callMethod = async (msg) => {
    try { reply(msg.id, await methods[msg.method](msg.params)); } catch (error) {
      reply(msg.id, undefined, error instanceof RpcError ? { code: error.code, message: error.message } : { code: -32603, message: "internal error" });
    }
  };

  // The plugin's own requests into the ACP stream; their replies come back through `watching` and never reach ash.
  let internalId = 0;
  const internal = (method, params) => new Promise((resolve, reject) => {
    const id = `ash-control-${++internalId}`;
    watching.set(id, (reply) => { if (reply.error) reject(new Error(reply.error.message ?? "request failed")); else resolve(reply.result); return null; });
    feed.enqueue(encoder.encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
  });
  const memory = createModelMemory(ctx, (text) => process.stderr.write(text + "\n"));
  const watchModel = (msg) => {
    const sessionId = msg.params?.sessionId;
    if (msg.method === "session/set_config_option")
      watching.set(msg.id, async (reply) => { if (reply.result) await memory.remember(sessionId, reply.result.configOptions); });
    else if (msg.method === "session/resume")
      watching.set(msg.id, async (reply) => {
        if (!reply.result) return undefined;
        const result = await memory.restore(sessionId, reply.result, (configId, value) => internal("session/set_config_option", { sessionId, configId, value }));
        return JSON.stringify({ ...reply, result });
      });
  };

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg?.method === "string" && (msg.method === "_ash/steer" || msg.method === "_ash/inject")) return extension(msg);
    if (msg?.method === "_ash/plugins") return void plugins(msg);
    if (typeof msg?.method === "string" && msg.id !== undefined && Object.hasOwn(methods, msg.method)) return void callMethod(msg);
    if ((msg?.method === "session/set_config_option" || msg?.method === "session/resume") && msg.id !== undefined) watchModel(msg);
    feed.enqueue(encoder.encode(line + "\n"));
  });
  lines.on("close", () => { try { feed.close(); } catch {} });

  acp.apply(ctx, { ...config, stream: ndJsonStream(output, input) });
}
