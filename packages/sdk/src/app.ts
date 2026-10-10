/**
 * The app contract `ash-app/1`: the shape of `app.json`, and how an app tool's MCP annotations become its effect and
 * risk (SPEC-02 §5.3). The runtime that starts apps compiles each tool with `appToolContract`.
 */
import { APP_CONTRACT } from "./versions";
import type { Effect, JsonSchema, Risk, WordContract } from "./word";

// ---------------------------------------------------------------------------------------------------------------------
// app.json
// ---------------------------------------------------------------------------------------------------------------------

export interface AppServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface AppSurface {
  id: string;
  title: string;
  /** `ui://...` */
  resource: string;
}
export interface AppCard {
  id: string;
  title: string;
  size: "2x2" | "4x2" | "4x4";
  /** A read-only tool that returns the card. */
  tool: string;
  /** The tool a tap, toggle or choice on the card calls. */
  action?: string;
  refresh_min?: number;
}
/** What the app asks the owner to allow at install time. */
export type AppNeed =
  | { member: string; words: string[]; why: string }
  | { notify: true; why: string }
  | { widgets: true; why: string }
  | { card: true; why: string };
/** An event that wakes an agent at once. A plain name wakes the primary agent; `agent` names another one. */
export type AppWakeEvent = string | { event: string; agent?: string };

export interface AppJson {
  contract: typeof APP_CONTRACT;
  id: string;
  name: string;
  version: string;
  icon?: string;
  summary: string;
  role?: string;
  publisher: string;
  server: AppServer;
  surfaces?: AppSurface[];
  /** Events the app emits. */
  events?: string[];
  /** Events (each also in `events`) that wake an agent. */
  wake_events?: AppWakeEvent[];
  /** Events the app wants to hear in real time; the hub delivers each to the reserved tool `ash.on_event`. The owner approves them at install. */
  listens?: string[];
  data_dir?: string;
  cards?: AppCard[];
  needs?: AppNeed[];
}

/** The reserved tool the hub calls to deliver a `listens` event: `{word, body, from, at}`. */
export const ASH_ON_EVENT_TOOL = "ash.on_event";

/** Every wake event as `{event, agent?}`; no `agent` means the primary agent. */
export function wakeEvents(app: Pick<AppJson, "wake_events">): { event: string; agent?: string }[] {
  return (app.wake_events ?? []).map((item) => (typeof item === "string" ? { event: item } : { event: item.event, ...(item.agent ? { agent: item.agent } : {}) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// MCP annotations -> effect and risk
// ---------------------------------------------------------------------------------------------------------------------

/** The hints an MCP tool may carry (MCP specification, `ToolAnnotations`). */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * The first rule that matches wins. A missing hint counts as the MCP default: destructive and open-world, so a tool
 * with no annotations asks for approval. Only rules 1 and 4 make a tool safe, and the app has to say so itself.
 *   1. readOnlyHint === true               -> read / none   (other hints ignored)
 *   2. destructiveHint !== false           -> write / structure
 *   3. openWorldHint !== false             -> act / outward
 *   4. destructiveHint === false and openWorldHint === false -> write / none
 */
export function toolEffectRisk(annotations?: McpToolAnnotations | null): { effect: Effect; risk: Risk } {
  const a = annotations && typeof annotations === "object" ? annotations : {};
  if (a.readOnlyHint === true) return { effect: "read", risk: "none" };
  if (a.destructiveHint !== false) return { effect: "write", risk: "structure" };
  if (a.openWorldHint !== false) return { effect: "act", risk: "outward" };
  return { effect: "write", risk: "none" };
}

/** One tool as an app's MCP server lists it. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
}

/** The contract of one app tool. Runtime registration only checks the name and that the schema compiles. */
export function appToolContract(appId: string, tool: McpTool): WordContract {
  const { effect, risk } = toolEffectRisk(tool.annotations);
  const title = tool.title ?? tool.annotations?.title ?? tool.name;
  return {
    member: `app:${appId}`,
    word: tool.name,
    kind: "request",
    direction: "in",
    description: tool.description?.trim() || title,
    input_schema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" },
    effect,
    risk,
    callers: ["owner", "agent", "app"],
    label: { doing: `在用 ${title}` },
  };
}
