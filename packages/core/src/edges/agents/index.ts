/**
 * edges/agents: the agent members and `service:agents`.
 *
 * Assembly: `createAgents(deps)` gives the module; add `agents.service` to the registry, call `startAll()` once the
 * router, body and persona are up, and `stopAll()` at shutdown. Drivers come in by runtime kind (`deps.drivers`).
 */
import { AgentManager, type AgentsDeps } from "./manager";
import { createAgentsService } from "./service";
import { SERVICE_CALLER } from "./modules";
import type { Router } from "../../kernel/types";
import type { Member } from "../../../../sdk/src/word";

export interface Agents {
  service: Member;
  manager: AgentManager;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  /** The primary agent's id: where the owner's words, notifications' replies and the semantic layer's wake-ups go. */
  primary(): string | null;
  /** Put changed files and environment into a running agent now (e.g. after MEMORY.md was written). */
  refreshModules(agent: string, lane?: string): Promise<void>;
}

export function createAgents(deps: AgentsDeps): Agents {
  const manager = new AgentManager(deps);
  const service = createAgentsService(manager);
  return { service, manager, startAll: () => manager.startAll(), stopAll: () => manager.stopAll(), primary: () => manager.runs.primary()?.id ?? null,
    refreshModules: (agent, lane) => manager.refreshModules(agent, lane) };
}

/** The DSH driver's `writeFile`: a file in the main body through `workspace.write` (the hub's own call, not an agent's). */
export function bodyFileWriter(router: Router): (path: string, content: string) => Promise<void> {
  return async (path, content) => {
    const reply = await router.send({ to: "body:main", kind: "request", word: "workspace.write", body: { path, content } }, SERVICE_CALLER);
    if (!reply.ok) throw new Error(`could not write ${path}: ${reply.error.code}`);
  };
}

export { AgentManager, type AgentsDeps } from "./manager";
export { fileTemplates, type AgentDecl, type LaneDecl, type Templates } from "./runs";
