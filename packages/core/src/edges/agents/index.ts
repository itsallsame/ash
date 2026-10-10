/**
 * edges/agents: the agent members and `service:agents`.
 *
 * Assembly: `createAgents(deps)` gives the module; add `agents.service` to the registry, call `startAll()` once the
 * router, body and persona are up, and `stopAll()` at shutdown. Drivers come in by runtime kind (`deps.drivers`).
 */
import { AgentManager, type AgentsDeps } from "./manager";
import { fileTemplates, type Templates } from "./runs";
import { createAgentsService } from "./service";
import { SERVICE_CALLER } from "./modules";
import type { AgentPolicy } from "../../kernel/router";
import type { Router } from "../../kernel/types";
import type { Member } from "../../../../sdk/src/word";

export interface Agents {
  service: Member;
  manager: AgentManager;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  /** The primary agent's id: where the owner's words, notifications' replies and the semantic layer's wake-ups go. */
  primary(): string | null;
  /** What the agent's declaration lets it use (for the router and the tool surface), or null when there is no such agent. */
  policyOf(id: string): AgentPolicy | null;
  /** The turn the agent is in now (on any of its lanes), or null. */
  currentTurn(id: string): string | null;
  /** Put changed files and environment into a running agent now (e.g. after MEMORY.md was written). */
  refreshModules(agent: string, lane?: string): Promise<void>;
}

/** What `createAgents` takes: the module's dependencies, with the templates given as the directory they are files in. */
export type AgentsOptions = Omit<AgentsDeps, "templates"> & {
  /** `ash-skills/agents`: `<name>.json` templates, read here. */
  templatesDir?: string;
  /** Tests: templates already in memory, instead of `templatesDir`. */
  templates?: Templates;
};

export function createAgents({ templatesDir, templates, ...rest }: AgentsOptions): Agents {
  const source = templates ?? (templatesDir ? fileTemplates(templatesDir) : null);
  if (!source) throw new Error("createAgents needs templatesDir");
  const manager = new AgentManager({ ...rest, templates: source });
  const service = createAgentsService(manager);
  return { service, manager, startAll: () => manager.startAll(), stopAll: () => manager.stopAll(), primary: () => manager.runs.primary()?.id ?? null,
    refreshModules: (agent, lane) => manager.refreshModules(agent, lane),
    policyOf(id) {
      const decl = manager.runs.get(id)?.spec.decl;
      return decl ? { tools: decl.tools ?? null, words: decl.words ?? null } : null;
    },
    currentTurn(id) {
      for (const lane of manager.liveOf(id)?.lanes.values() ?? []) if (lane.turn) return lane.turn;
      return null;
    } };
}

/** The DSH driver's `writeFile`: a file in the main body through `workspace.write` (the hub's own call, not an agent's). */
export function bodyFileWriter(router: Router): (path: string, content: string) => Promise<void> {
  return async (path, content) => {
    const reply = await router.send({ to: "body:main", kind: "request", word: "workspace.write", body: { path, content } }, SERVICE_CALLER);
    if (!reply.ok) throw new Error(`could not write ${path}: ${reply.error.code}`);
  };
}

export { AgentManager, type AgentsDeps } from "./manager";
export type { AgentDecl, LaneDecl, Templates } from "./runs";
