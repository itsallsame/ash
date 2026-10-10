// The app's way back into the hub: one loopback MCP endpoint, one credential per running app (SPEC-02 §5.2).
// Tools: capability_list, capability_describe, capability_call, await_result, ash_event. Every call is made as
// Caller{member: "app:<id>", via: "app"} through `router.send`; the app's grants are not checked here, and whether a word is
// harmless enough for an app (read or risk none) is the router's and gate's decision, not repeated here: the one place that
// checks an app's permissions is the router. An app has no approvals and no pending requests.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ContentPart } from "../../../../sdk/src/link";
import { DEFAULT_RECOVERY_HINTS, isErrorCode, type Caller, type ErrorCode, type Reply } from "../../../../sdk/src/message";
import { MCP_SERVER_VERSION } from "../../../../sdk/src/versions";
import { wordEffect, type WordContract } from "../../../../sdk/src/word";
import type { Registry, Router } from "../../kernel/types";

/**
 * What the hub itself already recorded for a word that cannot answer right now (the phone or its helper is away):
 * for example a health reading from the senses archive. Null when it has nothing.
 */
export type RecentFacts = (member: string, word: string, body: Record<string, unknown>) => { as_of: number | null; source: string; [key: string]: unknown } | null;

export interface AppBridgeOptions {
  router: Router;
  registry: Registry;
  /** May app:<id> use member/word? Only for the catalog: the router is the one place that enforces it. */
  granted: (app: string, member: string, word: string) => boolean;
  /** An event the app emitted; returns what to tell the app. */
  event: (id: string, name: string, body: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string }>;
  log?: (...args: unknown[]) => void;
  /** How long one capability_call (or await_result) waits before answering "accepted, still running" (default 50 s). */
  waitMs?: number;
  recent?: RecentFacts;
  clock?: { now(): number };
}

export interface BridgeFailure {
  code: ErrorCode;
  message: string;
  recovery_hint: string;
  /** One plain Chinese sentence for the owner; a page shows this instead of `message`. */
  owner_text: string;
  recent?: unknown;
  detail?: unknown;
}
export type BridgeResult =
  | { ok: true; result: unknown; content?: ContentPart[] }
  | { ok: true; status: "accepted"; request_id: string; guidance: string }
  | { ok: false; error: BridgeFailure };

/** Words served by the phone's senses helper, which Android may stop and restart on its own. */
const SENSES = /^(health|sensors|location|activity|sense)\./;
/** The error says the word is not there right now (helper disconnected, device away), not that the call was wrong. */
const away = (code: string) => code === "offline" || code === "not_found";

/** A failed call as the owner should read it on an app's page: plain words, no codes. */
export function ownerText(member: string, word: string, code: string): string {
  const thing = SENSES.test(word) && member.startsWith("device:") ? "感知" : member.startsWith("device:") ? "手机上的这项功能" : member.startsWith("app:") ? "这个应用" : "Ash";
  if (member.startsWith("device:") && code === "offline") return "手机暂时没连上 Ash，稍后再试";
  if (away(code)) return `${thing}暂时不在线，稍后再试`;
  switch (code) {
    case "forbidden": return "安装时没有批准这一项，用不了";
    case "denied": return "你没有同意这次操作";
    case "timeout": return `${thing}没有及时回应，稍后再试`;
    case "cancelled": return "这次操作取消了";
    case "unavailable": return `${thing}现在用不了，稍后再试`;
    case "bad_request": return "这次请求的内容不对";
    default: return "没办成，稍后再试";
  }
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
const text = (description: string) => ({ type: "string", description });
export const APP_BRIDGE_TOOLS = [
  { name: "capability_list", description: "What this app may use of the hub (granted by the owner at install): members and their words. A word marked needs_approval cannot be called by an app.", inputSchema: object({ member: text("Only this member") }) },
  { name: "capability_describe", description: "Full contract of one granted word (or all of a member's granted ones): input_schema, effect, risk, label.", inputSchema: object({ member: text("Member id, e.g. device:phone"), word: text("Word") }, ["member"]) },
  { name: "capability_call", description: "Call one granted word. Reads and harmless words run at once; anything that would need the owner's approval is refused (forbidden). Waits up to 50 seconds, then answers {status: accepted, request_id}.", inputSchema: object({ member: text("Member id"), word: text("Word"), body: { type: "object", description: "Input matching its input_schema" } }, ["member", "word"]) },
  { name: "await_result", description: "The result of a capability_call that answered accepted. Waits up to 50 seconds; still running answers accepted again.", inputSchema: object({ request_id: text("The request_id from the accepted answer") }, ["request_id"]) },
  { name: "ash_event", description: "Tell the hub something happened: one of the events in app.json, with a body object.", inputSchema: object({ name: text("Event name"), body: { type: "object" } }, ["name"]) },
] as const;

interface Job { app: string; settled: BridgeResult | null; promise: Promise<BridgeResult>; abort: AbortController; at: number }
/** A finished long call is kept this long for await_result; at most this many per app. */
const JOB_KEEP_MS = 10 * 60_000;
const JOBS_PER_APP = 32;

/** What the catalog says about a word an app cannot call: it needs the owner's approval (`per_call`: it is assessed for each call). */
export const needApproval = (contract: WordContract): false | true | "per_call" => (contract.risk === "none" ? false : contract.per_call_risk ? "per_call" : true);

export function mcpContent(parts: unknown): ContentPart[] {
  if (!Array.isArray(parts)) return [];
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (p.type === "text" && typeof p.text === "string") out.push({ type: "text", text: p.text });
    else if (p.type === "image" && typeof p.data === "string" && typeof p.mimeType === "string") out.push({ type: "image", mime: p.mimeType, b64: p.data });
    else out.push({ type: "text", text: JSON.stringify(part) });
  }
  return out;
}

export class AppBridge {
  private http: HttpServer | null = null;
  private readonly tokens = new Map<string, string>();
  private readonly jobs = new Map<string, Job>();
  url = "";
  constructor(private readonly options: AppBridgeOptions) {}

  private now(): number { return this.options.clock?.now() ?? Date.now(); }

  /** A fresh credential for app <id>; the previous one stops working. */
  bind(id: string): string {
    this.unbind(id);
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, id);
    return token;
  }
  /** The app stopped: its credential dies, and so do its long calls that are still running. */
  unbind(id: string): void {
    for (const [token, app] of this.tokens) if (app === id) this.tokens.delete(token);
    for (const [key, job] of this.jobs) if (job.app === `app:${id}`) { if (!job.settled) job.abort.abort(); this.jobs.delete(key); }
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => { void this.serve(request, response); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    this.http = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    return this.url;
  }

  async close(): Promise<void> {
    const server = this.http;
    this.http = null;
    this.tokens.clear();
    for (const job of this.jobs.values()) if (!job.settled) job.abort.abort();
    this.jobs.clear();
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private authenticate(request: IncomingMessage): string | null {
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const presented = Buffer.from(header.slice(7));
    for (const [token, id] of this.tokens) {
      const expected = Buffer.from(token);
      if (expected.length === presented.length && timingSafeEqual(expected, presented)) return id;
    }
    return null;
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // A web page could reach a loopback port; only an app's server process (no Origin) may talk here.
      if (request.headers.origin) { response.writeHead(403).end(); return; }
      if (!(request.url ?? "").startsWith("/mcp")) { response.writeHead(404).end(); return; }
      const id = this.authenticate(request);
      if (!id) { response.writeHead(401).end(); return; }
      let raw = "";
      for await (const chunk of request) { raw += chunk; if (raw.length > 1024 * 1024) { response.writeHead(413).end(); return; } }
      const server = new Server({ name: "ash", version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: APP_BRIDGE_TOOLS.map((tool) => ({ ...tool })) }));
      server.setRequestHandler(CallToolRequestSchema, async (call) => {
        const result = await this.call(id, call.params.name, (call.params.arguments ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as unknown as Record<string, unknown>, ...(result.ok ? {} : { isError: true }) };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
    } catch (error) {
      this.options.log?.("app bridge request failed", error);
      if (!response.headersSent) response.writeHead(500).end();
    }
  }

  private failure(member: string, word: string, body: Record<string, unknown>, code: ErrorCode, message: string, extra: { recovery_hint?: string; detail?: unknown } = {}): BridgeResult {
    let recent: unknown = null;
    if (away(code) || code === "timeout") {
      try { recent = this.options.recent?.(member, word, body) ?? null; } catch (error) { this.options.log?.("recent facts failed", error instanceof Error ? error.message : error); }
    }
    return { ok: false, error: { code, message, recovery_hint: extra.recovery_hint ?? DEFAULT_RECOVERY_HINTS[code], owner_text: ownerText(member, word, code),
      ...(recent ? { recent } : {}), ...(extra.detail === undefined ? {} : { detail: extra.detail }) } };
  }

  /** The words of a member this app may see: its contract lets apps call it, and it is granted. */
  private visible(app: string, memberId: string): WordContract[] {
    const described = this.options.registry.describe(memberId);
    if (!described) return [];
    return described.words.filter((word) => word.kind === "request" && word.callers.includes("app") && this.options.granted(app, memberId, word.word));
  }

  private entry(word: WordContract) {
    return { word: word.word, label: word.label.doing, summary: word.description.slice(0, 160), effect: wordEffect(word), risk: word.risk, needs_approval: needApproval(word) };
  }

  /** One tool call from app <id>. */
  async call(id: string, name: string, args: Record<string, unknown>): Promise<BridgeResult> {
    const app = `app:${id}`;
    const bad = (message: string): BridgeResult => this.failure("", name, {}, "bad_request", message);
    try {
      switch (name) {
        case "capability_list": {
          const only = typeof args.member === "string" ? args.member : null;
          const members = this.options.registry.list()
            .filter((member) => member.id !== app && (only === null || member.id === only))
            .map((member) => ({ id: member.id, name: member.name, capabilities: this.visible(app, member.id).map((word) => this.entry(word)) }))
            .filter((member) => member.capabilities.length);
          return { ok: true, result: { members } };
        }
        case "capability_describe": {
          const member = String(args.member ?? "");
          const words = this.visible(app, member).filter((word) => typeof args.word !== "string" || word.word === args.word);
          if (!words.length) return this.failure(member, String(args.word ?? ""), {}, "forbidden", "not granted or not found; capability_list shows what this app may use");
          return { ok: true, result: { member, capabilities: words.map((word) => ({ ...this.entry(word), description: word.description,
            input_schema: word.input_schema, result_schema: word.result_schema ?? null })) } };
        }
        case "capability_call": return await this.capabilityCall(app, args);
        case "await_result": return await this.awaitResult(app, args);
        case "ash_event": {
          if (typeof args.name !== "string") return bad("name is required");
          if (args.body !== undefined && (typeof args.body !== "object" || args.body === null || Array.isArray(args.body))) return bad("body must be an object");
          const done = await this.options.event(id, args.name, (args.body ?? {}) as Record<string, unknown>);
          return done.ok ? { ok: true, result: { recorded: true } } : this.failure(app, args.name, {}, done.code, done.message);
        }
        default: return bad(`unknown tool ${name}`);
      }
    } catch (error) {
      this.options.log?.("app bridge call failed", id, name, error instanceof Error ? error.message : error);
      return this.failure("", name, {}, "internal", error instanceof Error ? error.message : "tool failed");
    }
  }

  private async capabilityCall(app: string, args: Record<string, unknown>): Promise<BridgeResult> {
    if (typeof args.member !== "string" || typeof args.word !== "string") return this.failure("", "", {}, "bad_request", "member and word are required");
    if (args.body !== undefined && (typeof args.body !== "object" || args.body === null || Array.isArray(args.body))) return this.failure(args.member, args.word, {}, "bad_request", "body must be an object");
    const member = args.member, word = args.word, body = (args.body ?? {}) as Record<string, unknown>;
    this.sweep();
    const mine = [...this.jobs.values()].filter((job) => job.app === app);
    if (mine.length >= JOBS_PER_APP) return this.failure(member, word, body, "unavailable", "too many long calls are still running or uncollected");
    const abort = new AbortController();
    const caller: Caller = { member: app, via: "app", local: false };
    const job: Job = { app, settled: null, abort, at: this.now(), promise: Promise.resolve({ ok: true, result: null }) };
    job.promise = this.options.router.send({ to: member, kind: "request", word, body }, caller, { signal: abort.signal })
      .then((reply) => this.fromReply(member, word, body, reply), (error) => this.failure(member, word, body, "internal", error instanceof Error ? error.message : "send failed"))
      .then((result) => { job.settled = result; job.at = this.now(); return result; });
    const key = `job_${randomBytes(9).toString("base64url")}`;
    this.jobs.set(key, job);
    return this.collect(key, job);
  }

  private async awaitResult(app: string, args: Record<string, unknown>): Promise<BridgeResult> {
    const key = typeof args.request_id === "string" ? args.request_id : "";
    const job = this.jobs.get(key);
    if (!job || job.app !== app) return this.failure("", "", {}, "not_found", "no such request_id: it was never accepted, was already collected, or expired");
    return this.collect(key, job);
  }

  /** The result if the job ends within the wait; otherwise "accepted" with its id. A collected result is forgotten. */
  private async collect(key: string, job: Job): Promise<BridgeResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([job.promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.options.waitMs ?? 50_000); })]);
    clearTimeout(timer);
    if (waited === null) return { ok: true, status: "accepted", request_id: key, guidance: "still running; call await_result {request_id} to collect it (up to 50 seconds per wait)" };
    this.jobs.delete(key);
    return waited;
  }

  private sweep(): void {
    const cut = this.now() - JOB_KEEP_MS;
    for (const [key, job] of this.jobs) if (job.settled && job.at < cut) this.jobs.delete(key);
  }

  private fromReply(member: string, word: string, body: Record<string, unknown>, reply: Reply): BridgeResult {
    if (!reply.ok) {
      const code = isErrorCode(reply.error.code) ? reply.error.code : "failed";
      return this.failure(member, word, body, code, reply.error.message, { ...(reply.error.recovery_hint ? { recovery_hint: reply.error.recovery_hint } : {}), detail: reply.error.detail });
    }
    return { ok: true, result: reply.result?.data ?? {}, ...(reply.result?.content?.length ? { content: reply.result.content } : {}) };
  }
}
