/**
 * Step 3 of `send` (SPEC-01 §5.2). First layer: the contract's `callers` and `local_only`. Then what the caller's own
 * declaration allows (agents). Then the few structural rules, each of which has a test. Returns the refusal or null.
 */
import { isAgentId, OWNER_ID } from "../../../../sdk/src/ids";
import { errorBody, type ErrorBody } from "../../../../sdk/src/message";
import { mayCall, type CallerKind } from "../../../../sdk/src/word";
import type { Caller, Message, WordContract } from "../types";

/** What an agent's declaration says it may use. `null` for a list means no limit. */
export interface AgentPolicy {
  /** Names of the fixed tools; each stands for some words (see `toolWords`). */
  tools?: string[] | null;
  /** `member/word` patterns; `*` matches anything (`service:clock/*`, or a lone `*` for everything). */
  words?: string[] | null;
}

export interface AuthDeps {
  /** The declaration of an agent, or null when there is no such agent (SPEC-08; the agents module owns it). */
  agentPolicy(agentId: string): AgentPolicy | null;
  /** The `member/word` patterns a fixed tool stands for. Meta tools stand for none: they reach what `words` allows. */
  toolWords?(tool: string): string[];
  /** Structural rule: a sub-agent speaks to the owner only in a turn where it was addressed directly. Default: yes. */
  mayTalkToOwner?(caller: Caller, word: string): boolean;
  /** Structural rule: `service:agents/answer` is for the agent that was asked, in the turn that took the question. Default: any turn of an agent. */
  mayAnswer?(caller: Caller, body: unknown): boolean;
  /** Structural rule: an app uses only what it was granted (`app-grants`, kept by the apps module). Default: nothing. */
  appGranted?(appId: string, to: string, word: string): boolean;
  /** May this caller read the attachment? Whoever may see a message that holds it may; see services/gate/attachments. */
  mayReadAttachment(caller: Caller, hash: string): boolean;
}

const forbid = (message: string, hint?: string): ErrorBody => errorBody("forbidden", message, hint ? { recovery_hint: hint } : {});

const KIND: Record<Caller["via"], CallerKind | null> = { human: "owner", agent: "agent", app: "app", service: "kernel", hand: null };

const glob = (pattern: string, text: string): boolean =>
  new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(text);

export function authorize(msg: Pick<Message, "to" | "word" | "kind" | "body">, contract: WordContract | null, caller: Caller, deps: AuthDeps): ErrorBody | null {
  // A hand sends events, and only those it declared in its manifest; the hands module checks that. It is not a caller of words.
  if (caller.via === "hand") return msg.kind === "event" ? null : forbid("a hand can only send events");

  if (contract) {
    const kind = KIND[caller.via]!;
    if (!mayCall(contract.callers, kind)) return forbid(`${msg.to}/${msg.word} is not for a ${kind}`);
    if (contract.local_only && caller.via === "human" && !caller.local) return forbid(`${msg.to}/${msg.word} can only be done from a channel on this machine`);
  }

  if (caller.via === "agent") {
    const policy = deps.agentPolicy(caller.member);
    if (!policy) return forbid(`${caller.member} is not a declared agent`);
    if (policy.tools || policy.words) {
      const allowed = [...(policy.words ?? []), ...(policy.tools ?? []).flatMap((t) => deps.toolWords?.(t) ?? [])];
      if (!allowed.some((pattern) => glob(pattern, `${msg.to}/${msg.word}`))) return forbid(`${caller.member} may not use ${msg.to}/${msg.word}`, "Its declaration does not include this word.");
    }
    // agents never say things to each other as if the owner spoke
    if (isAgentId(msg.to) && msg.word === "say") return forbid("agents cannot say to each other; use tell or ask");
    if (msg.to === OWNER_ID && deps.mayTalkToOwner && !deps.mayTalkToOwner(caller, msg.word)) return forbid("this agent may speak to the owner only in a turn where it was addressed directly");
    if (msg.to === "service:agents" && msg.word === "answer" && !(caller.turn && (deps.mayAnswer?.(caller, msg.body) ?? true))) return forbid("an answer comes from the agent that was asked, in the turn that took the question");
  }

  if (caller.via === "app" && !deps.appGranted?.(caller.member, msg.to ?? "", msg.word)) return forbid(`${caller.member} was not granted ${msg.to}/${msg.word}`, "The owner grants what an app may use when installing it.");

  // attachments follow the messages that hold them
  if (msg.to === "service:blobs" && caller.via !== "service") {
    const hash = (msg.body as { hash?: unknown } | null)?.hash;
    if (typeof hash === "string" && !deps.mayReadAttachment(caller, hash)) return forbid("this attachment belongs to messages you cannot see");
  }
  return null;
}
