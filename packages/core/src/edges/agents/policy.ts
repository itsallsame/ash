/**
 * Tool and word policies of an agent declaration, and the one delegation check (HUB-MODULES §2.5).
 *
 * A policy is a list of patterns, or absent (= not restricted). `*` matches any run of characters, so `service:agents/*`
 * and `device:*` are patterns; a plain name matches itself. `tools` are tool names of the tool surface; `words` are
 * `member/word` pairs.
 */
import type { Caller } from "../../../../sdk/src/message";

export type Policy = readonly string[] | undefined;

const regexOf = (pattern: string): RegExp => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/**
 * Is every entry of `child` covered by `parent`? A child pattern is covered when some parent pattern matches its text
 * (`device:*` covers `device:abc`, and also the pattern `device:ab*`). An absent child is unrestricted, so it is a subset
 * only of an absent parent.
 */
export function isSubset(child: Policy, parent: Policy): boolean {
  if (parent === undefined) return true;
  if (child === undefined) return false;
  return child.every((entry) => parent.some((pattern) => regexOf(pattern).test(entry)));
}

/** What the caller is allowed to hand on. `agent` is the caller's own declaration (its tools and words). */
export type CallerPower = { unrestricted: true } | { unrestricted: false; tools: Policy; words: Policy };

export function callerPower(caller: Caller, own: { tools?: string[]; words?: string[] } | null): CallerPower {
  // The owner and the hub's own code can give anything.
  if (caller.via === "human" || caller.via === "service") return { unrestricted: true };
  // An agent can give what it has itself; an app (or an agent we do not know) has nothing to give.
  if (caller.via === "agent" && own) return { unrestricted: false, tools: own.tools, words: own.words };
  return { unrestricted: false, tools: [], words: [] };
}

/** The one check behind declare, update and spawn: the new declaration's tools and words must be a subset of the caller's. */
export function withinPower(power: CallerPower, decl: { tools?: string[]; words?: string[] }): string | null {
  if (power.unrestricted) return null;
  if (!isSubset(decl.tools, power.tools)) return "the declaration's tools go beyond the caller's own tools";
  if (!isSubset(decl.words, power.words)) return "the declaration's words go beyond the caller's own words";
  return null;
}

/** Delegation goes at most this deep (main = 0, what it spawns = 1 ...). */
export const MAX_DEPTH = 3;

/** Can the agent see this member at all: does any word pattern of its policy reach the member? */
export function sees(words: Policy, memberId: string): boolean {
  return words === undefined || words.some((pattern) => regexOf(pattern.split("/")[0]!).test(memberId));
}
