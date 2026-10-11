// edges/llm: the hub's own model exit. Approval review, the progress summary, and whatever organs and agents ask
// through `service:llm/complete` leave through `complete()` below; the JEV judge, which has its own decision
// endpoint instead of a chat one, leaves through `post()`. Nowhere else calls a model API.
// Keys arrive through an injected function (the vault supplies it) and are used for one call only; usage goes out
// through an injected reporter (the cost service listens). Nothing here retries, and nothing records message content.
import { complete as piComplete, type Api, type AssistantMessage, type Context, type Message, type Model } from "@mariozechner/pi-ai";
import { KEY_REF, ORIGIN, parseTarget, resolveModel, type Provider } from "./models";

export { DEFAULT_MODEL, KEY_REF, type Provider } from "./models";

export type LlmErrorCode = "bad_request" | "unavailable" | "unknown_model" | "timeout" | "failed";
/** Every failure out of this module carries one of these codes; the message never contains a key. */
export class LlmError extends Error {
  /** `http`: set when the provider itself answered with an HTTP status (its own words, key blanked out). */
  constructor(readonly code: LlmErrorCode, message: string, readonly http?: { status: number; detail: string }) { super(message); this.name = "LlmError"; }
}

/**
 * What the hub knows about one model key's standing with its provider. `ok`: the provider accepted it (a check or a call).
 * `rejected`: the provider refused the key itself (a 401 on a call; 401 or 403 on the key check): `reason` is a short
 * Chinese label (已过期, 无效, ...) and `detail` the provider's own words. `low_balance`: the key is accepted but the
 * account has no balance left (DeepSeek's `is_available: false`), so calls will fail; it is not a bad key. `unknown`: not
 * checked yet, or the check could not reach the provider. Never holds the key.
 */
export interface KeyHealth {
  provider: Provider; ref: string; configured: boolean; status: "ok" | "rejected" | "low_balance" | "unknown";
  reason?: string; detail?: string; checked_at?: number;
}

export interface LlmMessage { role: "system" | "user" | "assistant"; content: string }
export interface LlmRequest {
  /** `deepseek-flash`, `deepseek:<id>` or `openrouter:<id>`. Omitted: the default DeepSeek model. */
  model?: string;
  messages: LlmMessage[];
  max_tokens?: number;
  timeout_ms?: number;
}
export interface LlmUsage { input_tokens: number; output_tokens: number; cost?: number }
export interface LlmResult { text: string; usage: LlmUsage }
/**
 * A request forwarded as it is to one provider's own API. `path` is a path on the provider's fixed host (never a URL);
 * `body` is sent as JSON and the JSON answer comes back untouched.
 */
export interface LlmPost { provider: Provider; path: string; body: unknown; timeout_ms?: number }
/** What `report` receives after every call, successful or not. `cost` is USD, present only when it is actually known. */
export interface LlmUsageReport {
  caller: string; provider: Provider; model: string;
  input_tokens: number; output_tokens: number; cost?: number; ok: boolean; at: number;
}

export type Complete = (model: Model<Api>, context: Context, options: Record<string, unknown>) => Promise<AssistantMessage>;
export interface LlmOptions {
  /** The plaintext key for a vault ref such as DEEPSEEK_API_KEY, or null when none is set. */
  key(ref: string): string | null;
  report(usage: LlmUsageReport): void;
  /** Tests only: a stand-in for pi-ai's complete(). */
  complete?: Complete;
  /** Tests only: a stand-in for fetch, used by post(). */
  fetch?: typeof fetch;
  clock?: { now(): number };
  /** Tests only: how long a key check may take (default 8 s). */
  verifyTimeoutMs?: number;
  /**
   * Send every call to this protocol, host and port instead of the providers' own (a model server of the owner's, a fake
   * in tests). Only the origin counts: each call keeps its own path (`/api/v1/...` for OpenRouter, none for DeepSeek).
   */
  baseUrl?: string;
}
export interface Llm {
  complete(caller: string, request: LlmRequest): Promise<LlmResult>;
  post(caller: string, request: LlmPost): Promise<unknown>;
  /** Both model keys, as last learned (no network). */
  keys(): KeyHealth[];
  /**
   * Asks the provider whether it accepts the key (a free authenticated GET) and remembers the answer. Calls in flight share
   * one check; with `maxAgeMs`, a check that was made that recently is not repeated (the last answer comes back).
   */
  verify(provider: Provider, options?: { maxAgeMs?: number }): Promise<KeyHealth>;
  /** The key was saved or removed: what was known about the old one no longer counts. */
  forget(provider: Provider): void;
}

/** The reviewer's budget, the longest of the hub's own judgements apart from JEV. */
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_TOKENS = 400;
const MAX_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_BODY_CHARS = 200_000;
const MAX_ANSWER_CHARS = 1_000_000;
/**
 * A call that comes back 403 or 402 says little about the key: OpenRouter also answers 403 for a guardrail, a moderation
 * block or a spent budget, and 402 is a payment problem. Such a call only makes the hub ask the key check, at most this often.
 */
const RECHECK_AFTER_MS = 30_000;
/** A free, authenticated GET on each provider (DeepSeek: account balance; OpenRouter: the key's own info). 401/403 means the key is refused. */
const VERIFY_PATH: Record<Provider, string> = { deepseek: "/user/balance", openrouter: "/api/v1/key" };
const VERIFY_TIMEOUT_MS = 8000;
const PATH = /^\/[\w.~\-/]*(\?[\w.~\-=&%]*)?$/;

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** The reason shown to callers: one short line, with the key (should a provider echo it) blanked out. */
function describe(error: unknown, key: string | null): string {
  let text = String((error as { message?: unknown } | null)?.message ?? error ?? "error");
  if (key) text = text.split(key).join("***");
  return text.replace(/\b(sk|or)-[A-Za-z0-9_\-]{8,}/g, "***").replace(/[\r\n]+/g, " ").slice(0, 300);
}

/** The provider's own words from an error body (`{error:{message}}` or `{message}`), one short line, key blanked out. */
function providerWords(text: string, key: string | null): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown } | null;
    const inner = body?.error;
    const said = typeof inner === "string" ? inner : (inner as { message?: unknown } | null)?.message ?? body?.message;
    if (typeof said === "string") return describe(said, key).slice(0, 160);
  } catch { /* not JSON: nothing worth showing */ }
  return "";
}
/** A short Chinese label for why a key was refused. */
function refusal(status: number, detail: string): string {
  if (/expire|过期/i.test(detail)) return "已过期";
  if (/revok|disabled|deactivat|suspend/i.test(detail)) return "已被停用";
  return status === 403 ? "没有权限" : "无效";
}
const httpStatus = (error: unknown): number | undefined => (error instanceof LlmError ? error.http?.status : undefined);

function toContext(messages: LlmMessage[], model: Model<Api>, at: number): Context {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest: Message[] = messages.filter((m) => m.role !== "system").map((m) => m.role === "user"
    ? { role: "user", content: m.content, timestamp: at }
    : { role: "assistant", content: [{ type: "text", text: m.content }], api: model.api, provider: model.provider, model: model.id,
      usage: zeroUsage, stopReason: "stop", timestamp: at });
  return { ...(system ? { systemPrompt: system } : {}), messages: rest };
}

function validate(request: LlmRequest): void {
  if (!request || typeof request !== "object" || !Array.isArray(request.messages) || !request.messages.length)
    throw new LlmError("bad_request", "messages must be a non-empty array");
  let size = 0;
  for (const m of request.messages) {
    if (!m || (m.role !== "system" && m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string")
      throw new LlmError("bad_request", "each message needs a role (system, user or assistant) and text content");
    size += m.content.length;
  }
  if (size > MAX_MESSAGE_CHARS) throw new LlmError("bad_request", "messages are too long");
  if (!request.messages.some((m) => m.role === "user")) throw new LlmError("bad_request", "at least one user message is required");
  checkNumbers(request);
}
function checkNumbers(request: { max_tokens?: number; timeout_ms?: number }): void {
  for (const key of ["max_tokens", "timeout_ms"] as const) {
    const value = request[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new LlmError("bad_request", `${key} must be a positive integer`);
  }
}

/** [address] with its protocol, host and port replaced by [origin]'s; its path is kept. */
function withOrigin(address: string, origin: string): string {
  const { pathname } = new URL(address);
  return `${origin}${pathname === "/" ? "" : pathname.replace(/\/+$/, "")}`;
}

/** What one call learns as it goes; whatever is known when it ends is what gets reported. */
interface Tally { provider: Provider; model: string; key: string | null; epoch: number; input: number; output: number; cost?: number }

export function createLlm(options: LlmOptions): Llm {
  const origin = options.baseUrl ? new URL(options.baseUrl).origin : null;
  const complete = options.complete ?? (piComplete as unknown as Complete);
  const call: Complete = origin ? (model, context, o) => complete({ ...model, baseUrl: withOrigin(model.baseUrl, origin) }, context, o) : complete;
  const doFetch = options.fetch ?? fetch;
  const clock = options.clock ?? { now: () => Date.now() };

  /** What was learned about each provider's key. Memory only: after a restart it is learned again. */
  const health = new Map<Provider, { status: KeyHealth["status"]; reason?: string; detail?: string; at: number }>();
  const checking = new Map<Provider, Promise<KeyHealth>>();
  const lastCheck = new Map<Provider, number>();
  /** Bumped when a provider's key is saved or removed (`forget`); an answer about an older key is dropped. */
  const epochs: Record<Provider, number> = { deepseek: 0, openrouter: 0 };
  /** Notes an answer, unless the key it was about has been replaced meanwhile. */
  function remember(provider: Provider, epoch: number, found: { status: KeyHealth["status"]; reason?: string; detail?: string }): void {
    if (epochs[provider] !== epoch) return;
    health.set(provider, { ...found, at: clock.now() });
  }
  function snapshot(provider: Provider): KeyHealth {
    const ref = KEY_REF[provider];
    const configured = !!options.key(ref);
    const known = configured ? health.get(provider) : undefined;
    return { provider, ref, configured, status: known?.status ?? "unknown",
      ...(known?.reason ? { reason: known.reason } : {}), ...(known?.detail ? { detail: known.detail } : {}), ...(known ? { checked_at: known.at } : {}) };
  }

  /** The shared frame: fetch the key, bound the time, turn any failure into an LlmError without the key, and report. */
  async function track<T>(caller: string, first: { provider: Provider; model: string }, work: (tally: Tally, at: number) => Promise<T>): Promise<T> {
    const at = clock.now();
    const tally: Tally = { ...first, key: null, epoch: epochs[first.provider], input: 0, output: 0 };
    let value: T | undefined;
    let failure: LlmError | undefined;
    try { value = await work(tally, at); } catch (error) {
      failure = error instanceof LlmError ? error : new LlmError("failed", `model call failed: ${describe(error, tally.key)}`);
    }
    const report: LlmUsageReport = { caller, provider: tally.provider, model: tally.model, input_tokens: tally.input, output_tokens: tally.output,
      ...(tally.cost === undefined ? {} : { cost: tally.cost }), ok: !failure, at };
    try { options.report(report); } catch { /* accounting never changes the answer */ }
    // What the provider said about the key: a 401 marks it, a success clears the mark, a 402 or 403 sends the key check to
    // find out whether the key itself is at fault (in the background), anything else changes nothing.
    if (tally.key) {
      const status = httpStatus(failure);
      if (status === 401) { const http = (failure as LlmError).http!; remember(tally.provider, tally.epoch, { status: "rejected", reason: refusal(401, http.detail), detail: http.detail }); }
      else if (!failure) remember(tally.provider, tally.epoch, { status: "ok" });
      else if (status === 402 || status === 403) void verifyNow(tally.provider, RECHECK_AFTER_MS).catch(() => {});
    }
    if (failure) throw failure;
    return value as T;
  }
  /** The key is fetched per call, so setting or removing it in the vault takes effect at once. */
  function need(tally: Tally): string {
    const key = options.key(KEY_REF[tally.provider]);
    if (!key) throw new LlmError("unavailable", `no ${tally.provider} key is set`);
    tally.key = key;
    tally.epoch = epochs[tally.provider];
    return key;
  }
  /** Runs `run` with an abort signal that fires after `ms`, and fails with `timeout` even if `run` ignores the signal. */
  async function bounded<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new LlmError("timeout", `model call timed out after ${ms} ms`)); }, ms);
    });
    const running = run(controller.signal);
    running.catch(() => {}); // a late failure after the timeout must not surface as an unhandled rejection
    try { return await Promise.race([running, expired]); } finally { if (timer) clearTimeout(timer); }
  }

  async function check(provider: Provider): Promise<KeyHealth> {
    const key = options.key(KEY_REF[provider]);
    if (!key) { health.delete(provider); return snapshot(provider); }
    const path = VERIFY_PATH[provider];
    const epoch = epochs[provider];
    let found: { status: KeyHealth["status"]; reason?: string; detail?: string };
    try {
      found = await bounded(options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS, async (signal) => {
        const response = await doFetch(origin ? `${origin}${path}` : `${ORIGIN[provider]}${path}`, { method: "GET", signal, redirect: "error",
          headers: { accept: "application/json", authorization: `Bearer ${key}` } });
        const text = (await response.text()).slice(0, 4000);
        if (response.ok) {
          // DeepSeek's balance answer says whether the account can still pay for calls.
          if (provider === "deepseek" && (() => { try { return (JSON.parse(text) as { is_available?: unknown }).is_available === false; } catch { return false; } })())
            return { status: "low_balance" as const, reason: "余额不足" };
          return { status: "ok" as const };
        }
        if (response.status === 401 || response.status === 403) {
          const detail = providerWords(text, key);
          return { status: "rejected" as const, reason: refusal(response.status, detail), ...(detail ? { detail } : {}) };
        }
        return { status: "unknown" as const, reason: `服务商暂时没有正常回答（HTTP ${response.status}）` };
      });
    } catch (error) {
      found = { status: "unknown", reason: error instanceof LlmError && error.code === "timeout" ? "连接服务商超时" : "连不上服务商" };
    }
    // Not being able to reach the provider says nothing about the key: it never replaces a verdict already known.
    if (found.status !== "unknown" || (health.get(provider)?.status ?? "unknown") === "unknown") remember(provider, epoch, found);
    return snapshot(provider);
  }

  function verifyNow(provider: Provider, maxAgeMs?: number): Promise<KeyHealth> {
    if (provider !== "deepseek" && provider !== "openrouter") return Promise.reject(new LlmError("bad_request", "provider must be deepseek or openrouter"));
    const running = checking.get(provider);
    if (running) return running;
    const last = lastCheck.get(provider);
    if (maxAgeMs !== undefined && last !== undefined && clock.now() - last < maxAgeMs) return Promise.resolve(snapshot(provider));
    const run = check(provider).finally(() => {
      if (checking.get(provider) === run) { checking.delete(provider); lastCheck.set(provider, clock.now()); }
    });
    checking.set(provider, run);
    return run;
  }

  return {
    keys: () => (Object.keys(KEY_REF) as Provider[]).map(snapshot),
    verify: (provider, o) => verifyNow(provider, o?.maxAgeMs),
    forget(provider) { epochs[provider]++; health.delete(provider); checking.delete(provider); lastCheck.delete(provider); },

    complete(caller, request) {
      return track(caller, { provider: "deepseek", model: typeof request?.model === "string" ? request.model : "" }, async (tally, at) => {
        validate(request);
        const target = parseTarget(request.model);
        if (!target) throw new LlmError("unknown_model", "model name is not valid");
        tally.provider = target.provider; tally.model = target.id;
        const model = resolveModel(target);
        if (!model) throw new LlmError("unknown_model", `unknown model: ${target.provider}:${target.id}`);
        const apiKey = need(tally);
        const timeoutMs = Math.min(request.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const reply = await bounded(timeoutMs, (signal) => call(model, toContext(request.messages, model, at),
          { apiKey, signal, maxTokens: request.max_tokens ?? DEFAULT_MAX_TOKENS, temperature: 0 }));
        tally.input = count(reply.usage?.input); tally.output = count(reply.usage?.output);
        // Rates all zero mean the price is unknown (not free), so no cost is reported.
        const priced = Object.values(model.cost).some((rate) => rate > 0);
        const price = reply.usage?.cost?.total;
        if (priced && typeof price === "number" && Number.isFinite(price)) tally.cost = price;
        if (reply.stopReason !== "stop" && reply.stopReason !== "length") {
          // The provider's SDK words an HTTP refusal as "<status> <message>" (for example "401 API key expired").
          const said = describe(reply.errorMessage ?? reply.stopReason, tally.key);
          const http = /^(\d{3})\b\s*(.*)$/.exec(said);
          throw new LlmError("failed", `model call failed: ${said}`, http ? { status: Number(http[1]), detail: http[2]!.slice(0, 160) } : undefined);
        }
        const text = reply.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("");
        return { text, usage: { input_tokens: tally.input, output_tokens: tally.output, ...(tally.cost === undefined ? {} : { cost: tally.cost }) } };
      });
    },

    post(caller, request) {
      const body = request?.body as { model?: unknown } | undefined;
      const label = typeof body?.model === "string" ? body.model : String(request?.path ?? "");
      return track(caller, { provider: request?.provider === "openrouter" ? "openrouter" : "deepseek", model: label }, async (tally) => {
        if (!request || (request.provider !== "deepseek" && request.provider !== "openrouter")) throw new LlmError("bad_request", "provider must be deepseek or openrouter");
        if (typeof request.path !== "string" || !PATH.test(request.path) || request.path.startsWith("//") || request.path.split(/[/?]/).includes(".."))
          throw new LlmError("bad_request", "path must be a plain path on the provider's host");
        let payload: string | undefined;
        try { payload = JSON.stringify(request.body); } catch { /* handled below */ }
        if (payload === undefined || payload.length > MAX_BODY_CHARS) throw new LlmError("bad_request", "body must be JSON of reasonable size");
        checkNumbers({ timeout_ms: request.timeout_ms });
        const url = new URL(request.path, ORIGIN[request.provider]);
        if (url.origin !== ORIGIN[request.provider]) throw new LlmError("bad_request", "path must be a plain path on the provider's host");
        const apiKey = need(tally);
        const timeoutMs = Math.min(request.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        return bounded(timeoutMs, async (signal) => {
          const response = await doFetch(origin ? `${origin}${url.pathname}${url.search}` : url, { method: "POST", signal, redirect: "error",
            headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` }, body: payload });
          const text = await response.text();
          if (!response.ok) throw new LlmError("failed", `the provider answered HTTP ${response.status}`, { status: response.status, detail: providerWords(text.slice(0, 4000), apiKey) });
          if (text.length > MAX_ANSWER_CHARS) throw new LlmError("failed", "the provider's answer is too large");
          let answer: unknown;
          try { answer = JSON.parse(text); } catch { throw new LlmError("failed", "the provider's answer is not JSON"); }
          const usage = (answer as { usage?: Record<string, unknown> } | null)?.usage;
          if (usage && typeof usage === "object") {
            tally.input = count(usage.prompt_tokens ?? usage.input_tokens);
            tally.output = count(usage.completion_tokens ?? usage.output_tokens);
            if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) tally.cost = usage.cost;
          }
          return answer;
        });
      });
    },
  };
}
