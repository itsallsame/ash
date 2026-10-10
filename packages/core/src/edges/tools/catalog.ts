/**
 * What an agent can see and call: the words whose contract lets an agent call them (`callers`), cut down to what the
 * agent's own declaration allows. The contract never names an agent; the declaration is the agent's. The router's
 * authorization (step 3) decides the same way, so what the catalog lists is what a call can reach.
 */
import { mayCall, wordEffect, type WordContract } from "../../../../sdk/src/word";
import { agentMay, type AgentPolicy } from "../../kernel/router";
import type { Registry } from "../../kernel/types";
import { failure, plain, type Shaped } from "./result";
import { FIXED_TOOLS, glob, RECEIPT_TOOLS, toolWords } from "./tools";

export type { AgentPolicy };

export const limited = (policy: AgentPolicy): boolean => Boolean(policy.tools || policy.words);

/** The tools that stand for `service:gate/pending.*`: they work only on the agent's own requests, so every agent has them. */
const approvalTool = (tool: string): boolean => FIXED_TOOLS.some((t) => t.name === tool && t.member === "service:gate" && t.word.startsWith("pending."));

/** May the agent use this tool at all? The receipt tools and the tools of its own pending requests are always its own. */
export function toolAllowed(policy: AgentPolicy, tool: string): boolean {
  if ((RECEIPT_TOOLS as readonly string[]).includes(tool) || approvalTool(tool)) return true;
  return !policy.tools || policy.tools.some((pattern) => glob(pattern, tool));
}

/** The declaration's words, plus the words of its fixed tools (a meta tool adds none): the kernel's one rule. */
export function wordAllowed(policy: AgentPolicy, member: string, word: string): boolean {
  return agentMay(policy, member, word, toolWords);
}

/** Does the call put a question to the owner? An indication from the contract; the gate decides (SPEC-01 §6.4). */
export function needsApproval(contract: WordContract): boolean | "per_call" {
  if (contract.per_call_risk) return "per_call";
  return contract.risk !== "none";
}

const summaryOf = (description: string): string => description.split(/(?<=[.。])\s/u)[0]!.slice(0, 160);

export type CatalogRegistry = Pick<Registry, "list" | "describe">;

/** The words of a member that this agent may call: requests somebody can call, `callers` has agent, the declaration allows. */
function visibleWords(registry: CatalogRegistry, policy: AgentPolicy, member: string): WordContract[] {
  return (registry.describe(member)?.words ?? []).filter((c) => c.kind === "request" && c.direction === "in" && mayCall(c.callers, "agent") && wordAllowed(policy, member, c.word));
}

const approvalFlag = (contract: WordContract) => { const flag = needsApproval(contract); return flag ? { needs_approval: flag } : {}; };

export function capabilityList(registry: CatalogRegistry, policy: AgentPolicy, only?: string): Shaped {
  const members = registry.list().map((info) => ({ info, words: visibleWords(registry, policy, info.id) })).filter((m) => m.words.length)
    .map(({ info, words }) => ({ id: info.id, kind: info.kind, name: info.name,
      capabilities: words.map((c) => ({ word: c.word, label: c.label.doing, summary: summaryOf(c.description), effect: wordEffect(c), risk: c.risk, ...approvalFlag(c) })) }));
  if (only === undefined) return plain({ members });
  const chosen = members.filter((m) => m.id === only);
  const others = members.filter((m) => m.id !== only).map((m) => m.id);
  if (!chosen.length) return failure("not_found", `no member ${only} with words you may call; members are ${others.join(", ") || "none"}`, { recovery_hint: "Call capability_list without member to see what each member can do." });
  return plain({ members: chosen, other_members: others, note: "Only this member is listed. Call capability_list without member to see every member and its capabilities." });
}

export function capabilityDescribe(registry: CatalogRegistry, policy: AgentPolicy, member: string, word?: string): Shaped {
  const words = visibleWords(registry, policy, member);
  const chosen = word === undefined ? words : words.filter((c) => c.word === word);
  if (!chosen.length) {
    const known = registry.describe(member) !== null;
    return failure("not_found", known ? `${member} has no word ${word ?? ""} that you may call` : `no member ${member}`,
      { recovery_hint: "capability_list shows the members and words you can use; capability_describe without word lists a member's words." });
  }
  return plain({ member, capabilities: chosen.map((c) => ({ word: c.word, label: c.label.doing, description: c.description, input_schema: c.input_schema,
    result_schema: c.result_schema ?? null, effect: wordEffect(c), risk: c.risk, ...(c.per_call_risk ? { per_call_risk: true } : {}), ...approvalFlag(c), timeout_ms: c.timeout_ms ?? null })) });
}
