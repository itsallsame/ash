/**
 * What an agent's declaration lets it call. One function, used by the router's authorization and by the tool surface's
 * catalog, so what an agent is shown is what it can reach.
 */

/** What an agent's declaration lets it use; absent or null = no limit. `tools` are tool names (or patterns of them), `words` are `member/word` patterns. */
export interface AgentPolicy {
  tools?: readonly string[] | null;
  words?: readonly string[] | null;
}

/** `*` matches any run of characters; everything else matches itself. */
export const glob = (pattern: string, text: string): boolean =>
  new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(text);

/** The pending words work only on the agent's own requests, so every agent may use them. */
const alwaysOpen = (to: string, word: string): boolean => to === "service:gate" && word.startsWith("pending.");

/**
 * May the agent call `to/word`? Without limits, yes. Otherwise it needs a match among the declaration's `words` and
 * the words the declaration's fixed tools stand for (`toolWords`; a meta tool stands for none).
 */
export function agentMay(policy: AgentPolicy, to: string, word: string, toolWords: (toolOrPattern: string) => string[]): boolean {
  if (alwaysOpen(to, word)) return true;
  if (!policy.tools && !policy.words) return true;
  const patterns = [...(policy.words ?? []), ...(policy.tools ?? []).flatMap(toolWords)];
  return patterns.some((pattern) => glob(pattern, `${to}/${word}`));
}
