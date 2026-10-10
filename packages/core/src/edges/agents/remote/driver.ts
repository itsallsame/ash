/**
 * The driver of one runtime kind whose agents run on a computer (SPEC-08 §1.2): the sdk's `AgentDriver`, with every
 * operation carried over that computer's `agent` channel. Which computer is the one the agent's `native.on` names.
 *
 * `session.get` is synchronous in the contract, so the handle of each lane is kept here from what the computer reports.
 */
import { WordError } from "../../../../../sdk/src/message";
import type {
  AgentDriver, AgentEvent, AgentStartSpec, AgentStatus, DriverMessage, PromptModule, RuntimeInfo,
} from "../../../../../sdk/src/driver";
import { DEFAULT_ABILITIES, type Computer, type Frame } from "./computer";
import type { Directory, Entry } from "./directory";

/** What a kind looks like while no computer offers it. */
const fallbackInfo = (kind: string): RuntimeInfo => ({ kind, models: [], abilities: DEFAULT_ABILITIES });

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export class RemoteDriver implements AgentDriver {
  constructor(private readonly dir: Directory, readonly kind: string, report: (event: AgentEvent) => void) {
    dir.reporters.set(kind, report);
  }

  /** The first connected computer's own account of this runtime, else a bare one. */
  get info(): RuntimeInfo { return this.dir.offering(this.kind)?.runtimes.get(this.kind) ?? fallbackInfo(this.kind); }

  // -- entries ---------------------------------------------------------------------------------------------------------

  private entry(agent: string): Entry {
    const entry = this.dir.entries.get(agent);
    if (!entry || entry.kind !== this.kind || entry.state !== "running") throw new WordError("offline", `${agent} is not running`);
    return entry;
  }

  private call(entry: Entry, op: string, fields: Frame = {}, ms = this.dir.opMs): Promise<Frame> {
    return entry.conn.request(op, { agent: entry.agent, ...fields }, ms);
  }

  private handle(entry: Entry, key: string, result: Frame): string {
    if (!str(result.handle)) throw new WordError("failed", `computer ${entry.conn.name} answered without a session handle`);
    entry.handles.set(key, result.handle);
    return result.handle;
  }

  // -- start and stop --------------------------------------------------------------------------------------------------

  async start(agent: string, spec: AgentStartSpec): Promise<void> {
    if (spec.runtime.kind !== this.kind) throw new WordError("bad_request", `this driver runs ${this.kind}, not ${spec.runtime.kind}`);
    const conn = await this.dir.computerFor(spec.native?.on, this.kind);
    // What the hub knew of this agent before its computer went away (kept for ten minutes) is where `session.get` starts from.
    const before = this.dir.entries.get(agent);
    const entry: Entry = { agent, kind: this.kind, conn, spec, state: "starting", handles: new Map(before?.kind === this.kind && before.conn.handId === conn.handId ? before.handles : []), stopping: false, ended: false, turns: new Map() };
    this.dir.entries.set(agent, entry);
    // What the computer kept while the hub was away comes first, in order. Whatever it says of an earlier incarnation's end is of no use now.
    const held = conn.held.get(agent) ?? [];
    conn.held.delete(agent);
    for (const f of held) if (f.event !== "ended" && f.event !== "agent.status") this.dir.deliver(entry, f);
    let result: Frame;
    try {
      result = await conn.request("agent.start", { agent, spec }, this.dir.startMs);
      if (entry.ended || conn.closed) throw new WordError("failed", entry.detail ?? `computer ${conn.name} lost ${agent} while it started`);
    } catch (error) {
      if (this.dir.entries.get(agent) === entry) this.dir.entries.delete(agent);
      entry.stopping = true;
      throw error;
    }
    // The answer is where every lane stands; report what the events did not already say.
    const sessions = result.sessions && typeof result.sessions === "object" ? (result.sessions as Frame) : {};
    for (const [key, handle] of Object.entries(sessions)) {
      if (!str(handle) || entry.handles.get(key) === handle) continue;
      entry.handles.set(key, handle);
      this.dir.report(this.kind, { event: "handle.updated", agent, key, handle });
    }
    entry.state = "running";
  }

  async stop(agent: string, reason: string): Promise<void> {
    const entry = this.dir.entries.get(agent);
    if (!entry || entry.kind !== this.kind) return;
    const asked = entry.state === "running" || entry.state === "starting";
    entry.stopping = true; // what the computer says on the way out is not passed on
    try {
      if (asked && !entry.conn.closed) await entry.conn.request("agent.stop", { agent, reason }, this.dir.opMs).catch((error) => this.dir.log(`agents: stopping ${agent} on ${entry.conn.name}`, error));
    } finally {
      if (this.dir.entries.get(agent) === entry) this.dir.entries.delete(agent);
      entry.state = "exited";
      entry.conn.held.delete(agent);
    }
  }

  status(agent: string): AgentStatus {
    const entry = this.dir.entries.get(agent);
    if (!entry || entry.kind !== this.kind) return { state: "exited" };
    return { state: entry.state, ...(entry.detail ? { detail: entry.detail } : {}) };
  }

  async restart(agent: string, key?: string): Promise<void> {
    await this.call(this.entry(agent), "restart", key ? { key } : {}, this.dir.startMs);
  }

  // -- sessions --------------------------------------------------------------------------------------------------------

  readonly session: AgentDriver["session"] = {
    get: (agent, key) => {
      const entry = this.dir.entries.get(agent);
      return entry && entry.kind === this.kind ? entry.handles.get(key) ?? null : null;
    },
    set: async (agent, key, handle) => {
      const entry = this.entry(agent);
      await this.call(entry, "session.set", { key, handle });
      entry.handles.set(key, handle);
    },
    new: async (agent, key) => {
      const entry = this.entry(agent);
      return { handle: this.handle(entry, key, await this.call(entry, "session.new", { key }, this.dir.startMs)) };
    },
    reload: async (agent, key, modules: { static: PromptModule[] }) => {
      const entry = this.entry(agent);
      return { handle: this.handle(entry, key, await this.call(entry, "session.reload", { key, modules }, this.dir.startMs)) };
    },
    compact: async (agent, key) => {
      const result = await this.call(this.entry(agent), "session.compact", { key }, this.dir.startMs);
      return { compacted: result.compacted === true, ...(str(result.detail) ? { detail: result.detail } : {}) };
    },
  };

  // -- turns -----------------------------------------------------------------------------------------------------------

  async send(agent: string, key: string, batch: DriverMessage[]): Promise<void> { await this.call(this.entry(agent), "send", { key, messages: batch }); }
  async followup(agent: string, key: string, batch: DriverMessage[]): Promise<void> { await this.call(this.entry(agent), "followup", { key, messages: batch }); }
  async steer(agent: string, key: string, text: string): Promise<boolean> { return (await this.call(this.entry(agent), "steer", { key, text })).accepted === true; }
  async inject(agent: string, key: string, content: { modules?: PromptModule[]; text?: string }): Promise<void> {
    await this.call(this.entry(agent), "inject", { key, ...(content.modules ? { modules: content.modules } : {}), ...(content.text !== undefined ? { text: content.text } : {}) });
  }
  async interrupt(agent: string, key: string): Promise<void> { await this.call(this.entry(agent), "interrupt", { key }); }

  // -- configuration ---------------------------------------------------------------------------------------------------

  async configure(agent: string, key: string | undefined, config?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call(this.entry(agent), config === undefined ? "config.get" : "configure", { ...(key ? { key } : {}), ...(config === undefined ? {} : { config }) });
  }
  async plugins(agent: string, op: "list" | "enable" | "disable", name?: string): Promise<Record<string, unknown>> {
    return this.call(this.entry(agent), "plugins", { action: op, ...(name ? { name } : {}) });
  }
}

export type { Computer };
