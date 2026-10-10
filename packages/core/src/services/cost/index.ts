/**
 * `service:cost`: usage and quota (HUB-MODULES §3). Everything here is a periodic look, not a gate on single calls.
 *
 *   usage.recorded (event)   one model call, from the llm edge (the hub's small model) or from an agent driver, which
 *                            turns what DSH's `ash-cost` plugin reports every ten minutes into the same event
 *   usage.get {days?}        totals for today, 7 and 30 days, by caller and by day, and the latest calls
 *   balance.get              asks each provider that can be asked for the account balance (fails rather than say 0)
 *   quota.check {agent}      may the agent open another turn today? By the numbers recorded so far; a soft limit
 *
 * The daily limit and the balance lookup arrive by injection; the timer that runs `balance.get` is service:clock's.
 */
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import { createTables, insertUsage, summarize, tokensToday } from "./usage";

export const COST_ID = "service:cost";
export type BalanceProvider = "deepseek" | "openrouter";

export interface CostOptions {
  ledger: Pick<Ledger, "db">;
  /**
   * The account balance one provider reports, as the provider gives it (through edges/llm or the vault's key).
   * `null` or `undefined` means this one cannot be asked (no key, no balance endpoint): it is skipped. A throw is a failed lookup.
   */
  fetchBalance?: (provider: BalanceProvider) => Promise<unknown>;
  /** The agent's daily limit in tokens (in plus out, all its lanes), or nothing for no limit. Read on every check, so a changed setting applies at once. */
  dailyTokenLimit?: (agent: string) => number | null | undefined;
  timeZone?: string;
  now?: () => number;
}

const PROVIDERS: readonly BalanceProvider[] = ["deepseek", "openrouter"];
/** A provider that takes longer than this to report its balance counts as failed. */
const BALANCE_TIMEOUT_MS = 10_000;

const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function createCostService(options: CostOptions): Member {
  const db = options.ledger.db();
  createTables(db);
  const now = options.now ?? Date.now;
  const timeZone = () => options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  function record(body: Record<string, unknown>): void {
    const input = count(body.input_tokens), output = count(body.output_tokens), at = count(body.at);
    if (typeof body.caller !== "string" || !body.caller || typeof body.provider !== "string" || !body.provider || typeof body.model !== "string" || input === null || output === null || at === null || typeof body.ok !== "boolean")
      throw new WordError("bad_request", "usage.recorded needs caller, provider, model, input_tokens, output_tokens, ok and at");
    // A price that is not a number is a price that is not known; it is left out, never written as 0.
    const cost = typeof body.cost === "number" && Number.isFinite(body.cost) && body.cost >= 0 ? body.cost : undefined;
    insertUsage(db, { at, caller: body.caller, provider: body.provider, model: body.model, input_tokens: input, output_tokens: output, ok: body.ok, ...(cost === undefined ? {} : { cost }) });
  }

  async function lookup(provider: BalanceProvider): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), BALANCE_TIMEOUT_MS); });
    const work = Promise.resolve(options.fetchBalance!(provider));
    work.catch(() => {});
    try { return await Promise.race([work, expired]); } finally { if (timer) clearTimeout(timer); }
  }

  async function balances() {
    const found: { provider: BalanceProvider; at: number; balance: unknown }[] = [];
    const errors: Record<string, string> = {};
    for (const provider of PROVIDERS) {
      if (!options.fetchBalance) break;
      try {
        const balance = await lookup(provider);
        if (balance === null || balance === undefined) continue;
        const at = now();
        db.prepare("INSERT INTO cost_balance(provider,at,data) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET at=excluded.at, data=excluded.data").run(provider, at, JSON.stringify(balance));
        found.push({ provider, at, balance });
      } catch (error) {
        errors[provider] = String((error as { message?: unknown } | null)?.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 160);
      }
    }
    return { balances: found, errors };
  }

  function lastBalances() {
    return (db.prepare("SELECT provider,at,data FROM cost_balance ORDER BY provider").all() as { provider: string; at: number; data: string }[])
      .map((row) => ({ provider: row.provider, at: Number(row.at), balance: JSON.parse(row.data) as unknown }));
  }

  return {
    id: COST_ID,
    kind: "service",
    name: "cost",
    words: (): WordContract[] => wordsOf(COST_ID),
    async handle(msg: Message, _ctx: HandleContext): Promise<WordResult | void> {
      const body = msg.body && typeof msg.body === "object" && !Array.isArray(msg.body) ? msg.body as Record<string, unknown> : {};
      switch (msg.word) {
        case "usage.recorded": return void record(body);
        case "usage.get": {
          const days = body.days === undefined ? 7 : body.days;
          if (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > 90) throw new WordError("bad_request", "days must be an integer from 1 to 90");
          return { data: { ...summarize(db, days as number, now(), timeZone()), balances: lastBalances() } };
        }
        case "balance.get": {
          const result = await balances();
          if (!result.balances.length) {
            if (Object.keys(result.errors).length) throw new WordError("failed", "the balance could not be read", { detail: result.errors });
            throw new WordError("unavailable", "no provider balance can be read: no key is set or none is supported");
          }
          return { data: result };
        }
        case "quota.check": {
          const agent = body.agent;
          if (typeof agent !== "string" || !agent) throw new WordError("bad_request", "agent is required");
          const used = tokensToday(db, agent, now(), timeZone());
          const limit = options.dailyTokenLimit?.(agent);
          if (typeof limit !== "number" || !Number.isFinite(limit)) return { data: { allowed: true, used } };
          return used < limit
            ? { data: { allowed: true, used, limit } }
            : { data: { allowed: false, used, limit, reason: `${agent} has used ${used} tokens today, over its daily limit of ${limit}` } };
        }
        default: throw new WordError("not_found", `service:cost has no word ${msg.word}`);
      }
    },
  };
}
