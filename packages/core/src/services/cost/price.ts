/**
 * What a model call is worth, for the models whose rates are known. Source: DeepSeek's published price list
 * (api-docs.deepseek.com/quick_start/pricing, checked 2026-10-11), US dollars per million tokens. A model that is not
 * listed here has no price: its calls are counted as unpriced, never as free.
 *
 * Two rules from that page matter to the arithmetic:
 *  - Off-peak rates are half the peak rates. Peak is 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday, except Chinese
 *    public holidays. This table has no holiday calendar, so a call on a holiday inside those hours is priced as peak:
 *    the estimate can only err high.
 *  - The legacy name `deepseek-v4-flash` is served by, and billed as, `deepseek-flash`.
 *
 * Token counts are disjoint, as DSH reports them: `input` is the uncached input only, cache reads are priced apart.
 */
export interface Rates { cacheHit: number; input: number; output: number }
interface Tier { peak: Rates; offPeak: Rates }

const half = (r: Rates): Rates => ({ cacheHit: r.cacheHit / 2, input: r.input / 2, output: r.output / 2 });
const tier = (peak: Rates): Tier => ({ peak, offPeak: half(peak) });

const FLASH = tier({ cacheHit: 0.006, input: 0.3, output: 1.2 });
const PRO = tier({ cacheHit: 0.044, input: 1.32, output: 3.96 });

/** Rates by model id, for the DeepSeek providers. */
const DEEPSEEK: Record<string, Tier> = { "deepseek-flash": FLASH, "deepseek-v4-flash": FLASH, "deepseek-v4-pro": PRO };
/** `deepseek` is the hub's own name for the provider, `deepseek-official` is DSH's. */
const DEEPSEEK_PROVIDERS = new Set(["deepseek", "deepseek-official"]);

/** Whether the instant falls in DeepSeek's peak hours (UTC, weekdays; no holiday calendar). */
export function isPeak(at: number): boolean {
  const d = new Date(at);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export interface PriceInput { provider: string; model: string; at: number; input_tokens: number; output_tokens: number; cache_read_tokens?: number }

/** The cost in US dollars, or undefined when the model has no known price. */
export function priceOf(call: PriceInput): number | undefined {
  if (!DEEPSEEK_PROVIDERS.has(call.provider)) return undefined;
  const rates = DEEPSEEK[call.model];
  if (!rates) return undefined;
  const r = isPeak(call.at) ? rates.peak : rates.offPeak;
  return (call.input_tokens * r.input + (call.cache_read_tokens ?? 0) * r.cacheHit + call.output_tokens * r.output) / 1_000_000;
}
