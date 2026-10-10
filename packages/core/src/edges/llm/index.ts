// edges/llm: the hub's own small-model exit. Approval review, the progress summary, the JEV judge, and whatever
// organs and agents ask through `service:llm/complete` all leave through `complete()` below, and nowhere else.
// Keys arrive through an injected function (the vault supplies it) and are used for one call only; usage goes out
// through an injected reporter (the cost service listens). Nothing here retries, and nothing records message content.
import { complete as piComplete, type Api, type AssistantMessage, type Context, type Message, type Model } from "@mariozechner/pi-ai";
import { KEY_REF, parseTarget, resolveModel, type Provider } from "./models";

export { DEFAULT_MODEL, KEY_REF, OPENROUTER_DEFAULT_MODEL, type Provider } from "./models";

export type LlmErrorCode = "bad_request" | "unavailable" | "unknown_model" | "timeout" | "failed";
/** Every failure out of `complete()` carries one of these codes; the message never contains a key. */
export class LlmError extends Error {
  constructor(readonly code: LlmErrorCode, message: string) { super(message); this.name = "LlmError"; }
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
/** What `report` receives after every call, successful or not. `cost` is USD when pi-ai could price the call. */
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
  clock?: { now(): number };
  /** For calls that give no timeout_ms. The reviewer's 5 s, the longest of the hub's own judgements except JEV. */
  default_timeout_ms?: number;
  /** For calls that give no max_tokens. */
  default_max_tokens?: number;
}
export interface Llm { complete(caller: string, request: LlmRequest): Promise<LlmResult> }

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_TOKENS = 400;
const MAX_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_CHARS = 200_000;

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The reason shown to callers: one short line, with the key (should a provider echo it) blanked out. */
function describe(error: unknown, key: string | null): string {
  let text = String((error as { message?: unknown } | null)?.message ?? error ?? "error");
  if (key) text = text.split(key).join("***");
  return text.replace(/\b(sk|or)-[A-Za-z0-9_\-]{8,}/g, "***").replace(/[\r\n]+/g, " ").slice(0, 300);
}

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
  for (const key of ["max_tokens", "timeout_ms"] as const) {
    const value = request[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new LlmError("bad_request", `${key} must be a positive integer`);
  }
}

export function createLlm(options: LlmOptions): Llm {
  const call = options.complete ?? (piComplete as unknown as Complete);
  const clock = options.clock ?? { now: () => Date.now() };
  const defaultTimeout = options.default_timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const defaultTokens = options.default_max_tokens ?? DEFAULT_MAX_TOKENS;

  return {
    async complete(caller, request) {
      const at = clock.now();
      let provider: Provider = "deepseek";
      let modelId = typeof request?.model === "string" ? request.model : "";
      let key: string | null = null;
      let reply: AssistantMessage | undefined;
      let failure: LlmError | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        validate(request);
        const target = parseTarget(request.model);
        if (!target) throw new LlmError("unknown_model", "model name is not valid");
        provider = target.provider; modelId = target.id;
        const model = resolveModel(target);
        if (!model) throw new LlmError("unknown_model", `unknown model: ${target.provider}:${target.id}`);
        // The key is fetched per call, so setting or removing it in the vault takes effect at once.
        key = options.key(KEY_REF[provider]);
        if (!key) throw new LlmError("unavailable", `no ${provider} key is set`);
        const timeoutMs = Math.min(request.timeout_ms ?? defaultTimeout, MAX_TIMEOUT_MS);
        const controller = new AbortController();
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new LlmError("timeout", `model call timed out after ${timeoutMs} ms`)); }, timeoutMs);
        });
        const answered = call(model, toContext(request.messages, model, at),
          { apiKey: key, signal: controller.signal, maxTokens: request.max_tokens ?? defaultTokens, temperature: 0 });
        answered.catch(() => {}); // a late failure after the timeout must not surface as an unhandled rejection
        reply = await Promise.race([answered, expired]);
        if (reply.stopReason !== "stop" && reply.stopReason !== "length")
          throw new LlmError("failed", `model call failed: ${describe(reply.errorMessage ?? reply.stopReason, key)}`);
      } catch (error) {
        failure = error instanceof LlmError ? error : new LlmError("failed", `model call failed: ${describe(error, key)}`);
      } finally { if (timer) clearTimeout(timer); }

      const usage = reply?.usage;
      const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      const price = usage?.cost?.total;
      const cost = typeof price === "number" && Number.isFinite(price) ? price : undefined;
      const report: LlmUsageReport = { caller, provider, model: modelId, input_tokens: count(usage?.input), output_tokens: count(usage?.output),
        ...(cost === undefined ? {} : { cost }), ok: !failure, at };
      try { options.report(report); } catch { /* accounting never changes the answer */ }
      if (failure) throw failure;
      const text = reply!.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("");
      return { text, usage: { input_tokens: report.input_tokens, output_tokens: report.output_tokens, ...(cost === undefined ? {} : { cost }) } };
    },
  };
}
