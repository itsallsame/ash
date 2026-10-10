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
import type { ModuleId } from "../../../../sdk/src/driver";
import { AGENT_ID } from "../../../../sdk/src/ids";
import type { Ledger } from "../../kernel/ledger";

export interface LaneDecl {
  /** Who files into this lane: member ids, `wake`, `timer`, `event`, or `*`. */
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
  runtime: { kind: string; model?: string; effort?: string };
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
export const DEFAULT_LANES: Readonly<Record<string, LaneDecl>> = Object.freeze({
  front: { from: ["person:owner"] },
  back: { from: ["wake", "timer", "event"] },
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
  if (r.runtime !== undefined && (typeof r.runtime?.kind !== "string" || !r.runtime.kind)) throw new WordError("bad_request", "runtime needs a kind");
  const runtime = r.runtime ?? { kind: DEFAULT_RUNTIME };
  const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : undefined);
  return {
    id: r.id, name: text(r.name, r.id.slice(6)), summary: text(r.summary), brief: text(r.brief),
    runtime: { kind: runtime.kind, ...(runtime.model ? { model: String(runtime.model) } : {}), ...(runtime.effort ? { effort: String(runtime.effort) } : {}) },
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
