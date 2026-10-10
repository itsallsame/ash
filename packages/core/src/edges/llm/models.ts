import { getModel, type Api, type Model } from "@mariozechner/pi-ai";

/** The two providers the hub's own small-model calls go to, and the vault entry holding each one's key. */
export type Provider = "deepseek" | "openrouter";
export const KEY_REF: Record<Provider, string> = { deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY" };

/** Used when a caller names no model: DeepSeek's Flash model, which the approval reviewer and the progress summary run on. */
export const DEFAULT_MODEL = "deepseek-flash";
/** Used when a caller names the OpenRouter provider but no model: the JEV judge. */
export const OPENROUTER_DEFAULT_MODEL = "typesafe/jev-1.13";

/**
 * DeepSeek models newer than pi-ai's bundled catalog, on the same OpenAI-compatible endpoint with the same request
 * rules as the catalog's DeepSeek entries. Rates are the Flash rates (USD per million tokens).
 */
const DEEPSEEK_ADDED: Record<string, Model<"openai-completions">> = {
  "deepseek-flash": {
    id: "deepseek-flash", name: "DeepSeek V4.1 Flash", api: "openai-completions", provider: "deepseek", baseUrl: "https://api.deepseek.com",
    compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
    reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
    input: ["text", "image"], cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    contextWindow: 1_000_000, maxTokens: 384_000,
  },
};

/** A model OpenRouter serves that pi-ai's catalog does not list: the same OpenAI-compatible route, rates unknown. */
function openrouterGeneric(id: string): Model<"openai-completions"> {
  return { id, name: id, api: "openai-completions", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_000 };
}

export interface Target { provider: Provider; id: string }

/**
 * `model` is an id, optionally prefixed with its provider (`deepseek:deepseek-flash`, `openrouter:vendor/model`).
 * A bare id means DeepSeek; nothing at all means the default DeepSeek model.
 */
export function parseTarget(model: string | undefined): Target | null {
  const text = (model ?? "").trim();
  if (!text) return { provider: "deepseek", id: DEFAULT_MODEL };
  const prefixed = /^(deepseek|openrouter):(.*)$/.exec(text);
  if (prefixed) {
    const provider = prefixed[1] as Provider;
    const id = prefixed[2]!.trim();
    return { provider, id: id || (provider === "openrouter" ? OPENROUTER_DEFAULT_MODEL : DEFAULT_MODEL) };
  }
  return /^[\w.\-/:@+]+$/.test(text) ? { provider: "deepseek", id: text } : null;
}

/** The pi-ai model for a target: the bundled catalog first, then the DeepSeek and OpenRouter models it does not list. */
export function resolveModel(target: Target): Model<Api> | undefined {
  const known = getModel(target.provider as "deepseek", target.id as "deepseek-v4-flash") as Model<Api> | undefined;
  if (known) return known;
  if (target.provider === "deepseek") return Object.hasOwn(DEEPSEEK_ADDED, target.id) ? structuredClone(DEEPSEEK_ADDED[target.id]!) as Model<Api> : undefined;
  return openrouterGeneric(target.id) as Model<Api>;
}
