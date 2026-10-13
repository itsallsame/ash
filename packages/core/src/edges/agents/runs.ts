/**
 * Declarations (HUB-MODULES §2.5): every agent, the primary one included, is a row of `agent_runs`. The code knows no
 * agent's name. The first start of an empty table plants the declaration from the `main` template (ash-skills).
 *
 * `spec` is JSON: the declaration, the opaque session handles the driver last reported, and a little bookkeeping.
 * `desired` is whether the agent should be running (`on`) or was stopped on purpose (`off`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WordError } from "../../../../sdk/src/message";
import type { ModelSettings, ModuleId, RuntimeSettings } from "../../../../sdk/src/driver";
import { AGENT_ID } from "../../../../sdk/src/ids";
import type { Ledger } from "../../kernel/ledger";

export interface LaneDecl {
  /** Who files into this lane: member ids, `wake`, `event`, or `*`. */
  from?: string[];
  /** `<lane>:turn.ended` or `<lane>:tool` of this agent's other lanes. */
  on?: string[];
  /** A file in the body (relative to its work directory) with this lane's guidance. */
  guide?: string;
  /** Does what the lane says go to the owner? Default: only a lane that takes the owner's words. */
  speak?: boolean;
}

export interface AgentDecl {
  /** `agent:<name>` */
  id: string;
  name: string;
  summary: string;
  brief: string;
  runtime: RuntimeSettings;
  native?: { on: string; cwd?: string; env?: Record<string, string> };
  tools?: string[];
  words?: string[];
  lanes?: Record<string, LaneDecl>;
  /** Prompt modules to load; absent = all. */
  modules?: ModuleId[];
  primary?: boolean;
  ephemeral?: boolean;
  /** Who declared it: a member id. */
  created_by: string;
  /** 0 for what the owner declared; one more than the creator for what an agent made. */
  depth: number;
}

export const DEFAULT_RUNTIME = "dsh";

const SETTING_KEYS = ["effort"] as const;
/** The settings of one model out of free JSON (`{effort}`); `null` (in a patch) means to forget the model's entry. */
function readModelSettings(raw: unknown, where: string, patch: boolean): ModelSettings | null {
  if (raw === null && patch) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WordError("bad_request", `${where} needs an object such as {"effort": "high"}`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new WordError("bad_request", `${where}: ${key} is not a setting of a model (${SETTING_KEYS.join(", ")})`);
    if (typeof value !== "string" || !value) throw new WordError("bad_request", `${where}.${key} must be a non-empty string`);
    out[key] = value;
  }
  return out;
}

/** What an `update` says about the runtime: like the settings, but `kind` may be left out and a model's entry may be `null` (forget it). */
export type RuntimePatch = Omit<Partial<RuntimeSettings>, "models"> & { models?: Record<string, ModelSettings | null> };

function parseRuntime(raw: unknown, patch: boolean): RuntimePatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new WordError("bad_request", 'runtime must be an object such as {"kind": "pi", "model": "deepseek/deepseek-flash"}');
  const r = raw as Record<string, any>;
  if (!patch && (typeof r.kind !== "string" || !r.kind)) throw new WordError("bad_request", "runtime needs a kind");
  if (r.kind !== undefined && (typeof r.kind !== "string" || !r.kind)) throw new WordError("bad_request", "runtime.kind must be a non-empty string");
  for (const k of ["model", "effort"]) if (r[k] !== undefined && (typeof r[k] !== "string" || !r[k])) throw new WordError("bad_request", `runtime.${k} must be a non-empty string`);
  let models: Record<string, ModelSettings | null> | undefined;
  if (r.models !== undefined) {
    if (!r.models || typeof r.models !== "object" || Array.isArray(r.models)) throw new WordError("bad_request", 'runtime.models must be an object keyed by model, such as {"deepseek/deepseek-flash": {"effort": "high"}}');
    models = {};
    for (const [model, value] of Object.entries(r.models)) models[model] = readModelSettings(value, `runtime.models[${model}]`, patch);
  }
  return { ...(r.kind ? { kind: r.kind } : {}), ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}), ...(models ? { models } : {}) };
}
/** The runtime settings out of free JSON (a declaration), or a `bad_request`: `{kind, model?, effort?, models?}`. */
export const readRuntime = (raw: unknown): RuntimeSettings => parseRuntime(raw, false) as RuntimeSettings;
/** The runtime part of an `update`. */
export const readRuntimePatch = (raw: unknown): RuntimePatch => parseRuntime(raw, true);

/**
 * An `update`'s runtime patch laid over the declared one. The same kind (or no kind): `model` and `effort` replace, and `models` is merged
 * model by model (an entry is merged with the model's earlier one; `null` forgets it). Another kind: the patch is the whole new runtime.
 */
export function mergeRuntime(before: RuntimeSettings, patch: RuntimePatch): RuntimeSettings {
  if (patch.kind && patch.kind !== before.kind) return readRuntime({ ...patch, models: Object.fromEntries(Object.entries(patch.models ?? {}).filter(([, v]) => v !== null)) });
  const models: Record<string, ModelSettings> = { ...(before.models ?? {}) };
  for (const [model, value] of Object.entries(patch.models ?? {})) {
    if (value === null) delete models[model];
    else models[model] = { ...(models[model] ?? {}), ...value };
  }
  return {
    kind: before.kind,
    ...((patch.model ?? before.model) ? { model: patch.model ?? before.model } : {}),
    ...((patch.effort ?? before.effort) ? { effort: patch.effort ?? before.effort } : {}),
    ...(Object.keys(models).length ? { models } : {}),
  };
}
export const DEFAULT_LANES: Readonly<Record<string, LaneDecl>> = Object.freeze({
  front: { from: ["person:owner"] },
  back: { from: ["wake", "event"] },
});
export const lanesOf = (decl: AgentDecl): Record<string, LaneDecl> => decl.lanes && Object.keys(decl.lanes).length ? decl.lanes : { ...DEFAULT_LANES };

export interface RunSpec {
  decl: AgentDecl;
  /** Session handles by session key, as the driver last reported. */
  sessions: Record<string, string>;
  /** Hash of the static modules each lane's session was opened with. */
  static_hash: Record<string, string>;
  /** Pull usage records finished after this (Unix ms). */
  usage_since: number;
}
export interface Run { id: string; spec: RunSpec; desired: "on" | "off"; updated_at: number }

const SQL = `
CREATE TABLE IF NOT EXISTS agent_runs (
  agent      TEXT PRIMARY KEY,
  spec       TEXT NOT NULL,
  desired    TEXT NOT NULL DEFAULT 'on',
  is_primary INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_primary ON agent_runs(is_primary) WHERE is_primary = 1;
`;

export interface Templates { read(name: string): unknown | null }
/** Templates are `<dir>/<name>.json` files (ash-skills/agents). */
export function fileTemplates(dir: string): Templates {
  return { read(name) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) return null;
    try { return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")); } catch { return null; }
  } };
}

/** A declaration out of free JSON (a template or a word body), or a `bad_request`. */
export function readDecl(raw: unknown, createdBy: string, depth: number): AgentDecl {
  const r = (raw ?? {}) as Record<string, any>;
  if (typeof r.id !== "string" || !AGENT_ID.test(r.id)) throw new WordError("bad_request", "a declaration needs an id such as agent:name");
  const runtime = r.runtime === undefined ? { kind: DEFAULT_RUNTIME } : readRuntime(r.runtime);
  const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : undefined);
  return {
    id: r.id, name: text(r.name, r.id.slice(6)), summary: text(r.summary), brief: text(r.brief),
    runtime,
    ...(r.native ? { native: r.native } : {}),
    ...(list(r.tools) ? { tools: list(r.tools) } : {}), ...(list(r.words) ? { words: list(r.words) } : {}),
    ...(r.lanes && typeof r.lanes === "object" ? { lanes: r.lanes } : {}),
    ...(list(r.modules) ? { modules: list(r.modules) as ModuleId[] } : {}),
    ...(r.primary ? { primary: true } : {}), ...(r.ephemeral ? { ephemeral: true } : {}),
    created_by: createdBy, depth,
  };
}

export class Runs {
  private readonly db;
  constructor(private readonly ledger: Pick<Ledger, "db" | "tx">, private readonly now: () => number) { this.db = ledger.db(); this.db.exec(SQL); }

  private row(r: Record<string, unknown>): Run {
    const spec = JSON.parse(String(r.spec)) as RunSpec;
    spec.decl.primary = Number(r.is_primary) === 1 ? true : undefined;
    if (!spec.decl.primary) delete spec.decl.primary;
    return { id: String(r.agent), spec, desired: r.desired === "off" ? "off" : "on", updated_at: Number(r.updated_at) };
  }
  get(id: string): Run | null {
    const r = this.db.prepare("SELECT * FROM agent_runs WHERE agent=?").get(id) as Record<string, unknown> | undefined;
    return r ? this.row(r) : null;
  }
  list(): Run[] { return (this.db.prepare("SELECT * FROM agent_runs ORDER BY is_primary DESC, agent").all() as Record<string, unknown>[]).map((r) => this.row(r)); }
  primary(): Run | null {
    const r = this.db.prepare("SELECT * FROM agent_runs WHERE is_primary=1").get() as Record<string, unknown> | undefined;
    return r ? this.row(r) : null;
  }
  count(): number { return Number((this.db.prepare("SELECT count(*) AS n FROM agent_runs").get() as { n: number }).n); }

  put(run: { id: string; spec: RunSpec; desired?: "on" | "off" }): void {
    const { decl } = run.spec;
    this.db.prepare(`INSERT INTO agent_runs(agent,spec,desired,is_primary,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(agent) DO UPDATE SET spec=excluded.spec, desired=excluded.desired, is_primary=excluded.is_primary, updated_at=excluded.updated_at`)
      .run(run.id, JSON.stringify({ ...run.spec, decl: { ...decl, primary: undefined } }), run.desired ?? "on", decl.primary ? 1 : 0, this.now());
  }
  /** Change the bookkeeping of one row without touching `desired` or the primary flag. */
  patch(id: string, change: (spec: RunSpec) => void): void {
    const run = this.get(id);
    if (!run) return;
    change(run.spec);
    this.put({ id, spec: run.spec, desired: run.desired });
  }
  setDesired(id: string, desired: "on" | "off"): void {
    this.db.prepare("UPDATE agent_runs SET desired=?, updated_at=? WHERE agent=?").run(desired, this.now(), id);
  }
  remove(id: string): void { this.db.prepare("DELETE FROM agent_runs WHERE agent=?").run(id); }
  /** The primary flag moves in one step: there is never none (but for an empty table) and never two. */
  setPrimary(id: string): void {
    this.ledger.tx(() => {
      this.db.prepare("UPDATE agent_runs SET is_primary=0 WHERE is_primary=1").run();
      this.db.prepare("UPDATE agent_runs SET is_primary=1, updated_at=? WHERE agent=?").run(this.now(), id);
    });
  }

  /** First start: an empty table gets the `main` template (primary). */
  seed(templates: Templates): void {
    if (this.count() > 0) return;
    const template = templates.read("main");
    if (!template) throw new Error("agents: the main template is missing, so there is no primary agent to plant");
    const decl = readDecl(template, "service:agents", 0);
    decl.primary = true;
    this.put({ id: decl.id, spec: { decl, sessions: {}, static_hash: {}, usage_since: 0 } });
  }
}
