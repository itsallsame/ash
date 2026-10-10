// The progress summary: one short line about what the agent is doing, from the steps it has just taken. It is a
// courtesy, so the function below never throws: no model, no key or a bad answer is just no summary (null) and the
// tool's own line stays. The calls are reported as `service:summary`, apart from the owner's own and the reviewer's.
import type { Llm } from "./index";

export const SUMMARY_CALLER = "service:summary";

export interface SummaryOptions {
  llm: Pick<Llm, "complete">;
  /** Passed to `llm.complete`; omitted = the default model. */
  model?: string;
}

/** The request to hand to `llm.complete(caller, …)` for a summary of [steps]. */
export function summaryRequest(steps: string[]): { messages: { role: "system" | "user"; content: string }[]; max_tokens: number } {
  return {
    messages: [
      { role: "system", content: "你在给主人看一个助手正在做什么。根据下面的步骤，用不超过 20 个字写一句进行时的话（例如「在整理今天的日程」），不要标点结尾，不要解释。" },
      { role: "user", content: steps.join("\n") },
    ],
    max_tokens: 60,
  };
}

export function createSummarizer(options: SummaryOptions): (steps: string[]) => Promise<string | null> {
  return async (steps) => {
    try {
      const out = await options.llm.complete(SUMMARY_CALLER, { ...summaryRequest(steps), ...(options.model === undefined ? {} : { model: options.model }) });
      return out.text.trim() || null;
    } catch { return null; }
  };
}
