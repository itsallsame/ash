/**
 * The script agent (debug builds only): `agent:script`, an agent that does not think. The owner's command line sends it a script
 * (JSON) as a message, and it makes the tool calls the script lists through the same tool surface, token and turn a real agent
 * has, so the router, the gate, the approvals, the host and the status see an ordinary agent. See `script-agent.mjs`.
 *
 * It is the DSH driver started on another program: the same ACP, the same session and turn events. Nothing here exists in a build
 * whose host does not say `dev.script_agent` (host.json): no driver for the runtime kind `script`, so nobody can declare such an agent.
 */
import { dirname } from "node:path";
import type { AgentDriverFactory } from "../../../../sdk/src/driver";
import { createDshDriver, type DshDriverDeps } from "./dsh";
import { readDecl, type Runs } from "./runs";
import { SCRIPT_AGENT_SOURCE } from "./script-agent.generated";

export const SCRIPT_AGENT_ID = "agent:script";
export const SCRIPT_RUNTIME = "script";
const PROGRAM = "script-agent.mjs";

/** The DSH driver of the main body, started on the script agent's program (written next to the agent's baseline file before each start). */
export function scriptDriver(deps: Pick<DshDriverDeps, "spawn" | "writeFile" | "runtimePath" | "readBlob" | "log">): AgentDriverFactory {
  return (report) => createDshDriver({
    ...deps, report, argv: ["node", PROGRAM],
    writeFile: async (path, content) => { await deps.writeFile(path, content); await deps.writeFile(`${dirname(path)}/${PROGRAM}`, SCRIPT_AGENT_SOURCE); },
  });
}

/** Declares `agent:script` when there is none yet (only called for a host that said `dev.script_agent`). */
export function declareScriptAgent(runs: Pick<Runs, "get" | "put">): void {
  if (runs.get(SCRIPT_AGENT_ID)) return;
  const decl = readDecl({
    id: SCRIPT_AGENT_ID, name: "script", runtime: { kind: SCRIPT_RUNTIME },
    summary: "A debug agent that carries out the script it is sent.",
    brief: "You are the script agent of a debug build: a message to you is a script, and you do what it lists, step by step. You do not think or choose.",
  }, "service:agents", 0);
  runs.put({ id: decl.id, spec: { decl, sessions: {}, static_hash: {}, usage_since: 0 } });
}
