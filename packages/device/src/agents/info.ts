import type { RuntimeAbilities, RuntimeInfo } from "../../../sdk/src/driver";
import type { DetectedRuntime } from "./detect";
import type { Tool } from "./types";

export const KINDS = ["codex", "claude", "workbuddy"] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (value: unknown): value is Kind => typeof value === "string" && (KINDS as readonly string[]).includes(value);

/**
 * The Ash tools a runtime on this computer is given. The hub's own tool address is not reachable from here, so each call
 * travels back over the agent channel (`outbound`) and runs on the hub with the agent's identity (SPEC-08 §2.7).
 */
export const TOOL_SURFACE: Tool[] = [
  { name: "agent_list", description: "List agents registered with Ash.", inputSchema: { type: "object", additionalProperties: false } },
  ...["agent_ask", "agent_tell"].map((name) => ({
    name, description: name === "agent_ask" ? "Ask an Ash agent and wait for its answer." : "Tell an Ash agent something.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, text: { type: "string" } }, required: ["agent", "text"], additionalProperties: false },
  })),
];

/** What each runtime can do, as the hub should expect it (SPEC-08 §1.3). `compact` is unknown: the call is made, never assumed. */
const ABILITIES: Record<Kind, RuntimeAbilities> = {
  codex: { resume: true, steer: true, inject_live: false, images: false, compact: "unknown", configure: ["model", "effort"], plugins: false, mcp: true, system_prompt: "append", credentials: false, usage: false },
  claude: { resume: true, steer: true, inject_live: false, images: false, compact: "unknown", configure: ["model", "effort"], plugins: false, mcp: true, system_prompt: "append", credentials: false, usage: false },
  workbuddy: { resume: true, steer: true, inject_live: false, images: false, compact: false, configure: ["model", "effort"], plugins: false, mcp: true, system_prompt: "append", credentials: false, usage: false },
};

export const abilitiesOf = (kind: Kind): RuntimeAbilities => ABILITIES[kind];

/** The runtimes to offer in `hello.channels.agent.runtimes`: installed, and not known to be logged out. */
export function runtimeInfos(detected: DetectedRuntime[]): RuntimeInfo[] {
  return detected
    .filter((d) => d.installed && d.logged_in !== false)
    .map((d) => ({ kind: d.kind, models: d.models.map((m) => ({ id: m.id, ...(m.efforts?.length ? { efforts: m.efforts } : {}) })), abilities: ABILITIES[d.kind] }));
}
