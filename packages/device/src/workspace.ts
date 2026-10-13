/**
 * The computer's files and commands (SPEC-09): the workspace package, served as a borrowed body. The OS account is the
 * file system boundary; the hub decides who may call (the gate and the hand's tier), and a write inside the work
 * directory is judged harmless by `assess`, not by this program.
 */
import { homedir } from "node:os";
import { join, parse } from "node:path";
import type { CapabilitySpec } from "../../sdk/src/link";
import { STANDARD_NAMESPACES, type StandardAction } from "../../sdk/src/namespaces";
import { Workspace } from "../../workspace/src";

export const BODY_ACTIONS: readonly StandardAction[] = [...STANDARD_NAMESPACES.workspace!, ...STANDARD_NAMESPACES.body!];
export const isBodyCapability = (name: string): boolean => BODY_ACTIONS.some((action) => action.name === name);

/** A standard action as the capability a hand declares in its manifest. [risk] can only be raised, never lowered. */
export function capabilityOf(action: StandardAction, risk: CapabilitySpec["risk"] = action.risk): CapabilitySpec {
  return {
    name: action.name, description: action.description, label: action.label,
    input_schema: action.input_schema, result_schema: action.result_schema,
    effect: action.effect, risk, foreground: action.foreground,
    ...(action.per_call_risk ? { per_call_risk: true } : {}),
    ...(action.callers ? { callers: [...action.callers] } : {}),
  };
}

/**
 * `workspace.*` and `body.info`, always declared: whether they become `body:<id>` is the hub's decision, made when the
 * owner binds this computer (SPEC-03 §4.1).
 */
export const workspaceCapabilities = (): CapabilitySpec[] => BODY_ACTIONS.map((action) => capabilityOf(action));

export interface WorkspaceParts {
  workdir: string;
  stateDir: string;
  /** Sends a big file to the hub as a stream; returns its id (the link client's `sendStream`). */
  stream: (data: Uint8Array, mime: string) => string;
  home?: string;
}

export function createWorkspace(parts: WorkspaceParts): Workspace {
  return new Workspace({
    root: parse(parts.workdir).root || "/",
    workdir: parts.workdir,
    ownership: "borrowed",
    streams: (bytes, meta) => parts.stream(bytes, meta.mime),
    // A work directory that is, or holds, the home folder or this program's own state lends nothing for free.
    guard: [parts.home ?? homedir(), parts.stateDir],
    spillDir: join(parts.stateDir, "spill"),
  });
}

/** `~` and `~/x` mean the home folder (a convenience the old program had; the workspace package takes plain paths). */
export function expandHome(args: Record<string, unknown>, home = homedir()): Record<string, unknown> {
  const expand = (value: unknown) => (value === "~" ? home : typeof value === "string" && value.startsWith("~/") ? join(home, value.slice(2)) : value);
  const out = { ...args };
  for (const key of ["path", "workdir"]) if (key in out) out[key] = expand(out[key]);
  return out;
}
