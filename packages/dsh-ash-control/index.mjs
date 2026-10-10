// ACP superset for ash: the official ACP bridge keeps every standard method; this plugin owns stdin/stdout,
// answers ash's extension methods (_ash/steer, _ash/inject, _ash/plugins, _ash/credentials.has, _ash/credentials.set,
// _ash/usage) through the live Agent and DSH's own services, and passes everything else through.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

export const name = "dsh-ash-control";
export const inject = ["agents", "llm", "sessionPersistence", "sessions", "acpAppStartup"];

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SECRET = 8192;
const BALANCE_TIMEOUT_MS = 5000;

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = (message) => new RpcError(-32602, message);
const unavailable = (message) => new RpcError(-32603, message);

/**
 * The extension methods that need only DSH's services, not the ACP stream: ash asks whether DSH holds a key, hands it
 * one, and pulls the usage ash-cost recorded. Each takes the request params and returns the result, or throws RpcError.
 * No method ever returns a credential value, and none writes one to a log.
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
  const output = new WritableStream({ write(chunk) { out(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); } });
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

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg?.method === "string" && (msg.method === "_ash/steer" || msg.method === "_ash/inject")) return extension(msg);
    if (msg?.method === "_ash/plugins") return void plugins(msg);
    if (typeof msg?.method === "string" && msg.id !== undefined && Object.hasOwn(methods, msg.method)) return void callMethod(msg);
    feed.enqueue(encoder.encode(line + "\n"));
  });
  lines.on("close", () => { try { feed.close(); } catch {} });

  acp.apply(ctx, { ...config, stream: ndJsonStream(output, input) });
}
