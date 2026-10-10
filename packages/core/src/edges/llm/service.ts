// `service:llm`: the hub's small model for the owner, agents and apps (HUB-MODULES §2.9). One word, `complete`, that
// calls `edges/llm`'s `complete` in the name of whoever asked, so the cost service counts the use against the caller.
import { WordError, type ErrorCode, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { DEFAULT_MODEL, LlmError, type Llm, type LlmMessage, type LlmErrorCode } from "./index";

export const LLM_ID = "service:llm";
/** A completion asked for through the word may take longer than the hub's own quick judgements (5 s), within the word's 60 s. */
export const SERVICE_TIMEOUT_MS = 30_000;

const CODES: Record<LlmErrorCode, ErrorCode> = {
  bad_request: "bad_request", unknown_model: "bad_request", unavailable: "unavailable", timeout: "timeout", failed: "failed",
};
const HINTS: Partial<Record<LlmErrorCode, string>> = {
  unavailable: "No key for that model is set. The owner can set it; do not retry until then.",
  unknown_model: "Leave model out for the default, or name deepseek-flash, deepseek:<id> or openrouter:<id>.",
};

export function createLlmService(llm: Pick<Llm, "complete">): Member {
  return {
    id: LLM_ID,
    kind: "service",
    name: "llm",
    words: (): WordContract[] => wordsOf(LLM_ID),
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
      if (msg.word !== "complete") throw new WordError("not_found", `${LLM_ID} has no word ${msg.word}`);
      const body = msg.body && typeof msg.body === "object" ? msg.body as { model?: string; messages: LlmMessage[]; max_tokens?: number } : null;
      if (!body) throw new WordError("bad_request", "body must be an object");
      try {
        const out = await llm.complete(ctx.caller.member, {
          ...(body.model === undefined ? {} : { model: body.model }), messages: body.messages,
          ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }), timeout_ms: SERVICE_TIMEOUT_MS,
        });
        return { data: { text: out.text, model: body.model ?? DEFAULT_MODEL, usage: { input_tokens: out.usage.input_tokens, output_tokens: out.usage.output_tokens } } };
      } catch (error) {
        if (error instanceof LlmError) throw new WordError(CODES[error.code], error.message, HINTS[error.code] ? { recovery_hint: HINTS[error.code] } : {});
        throw error;
      }
    },
  };
}
