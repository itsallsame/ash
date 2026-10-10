import { randomBytes } from "node:crypto";
import { WordError, type Caller, type Message, type Outgoing, type Reply } from "../../../../sdk/src/message";
import type { AgentDriver, AgentDriverFactory, AgentEvent, AgentStartSpec, DriverMessage, DriverUsage, PromptModule } from "../../../../sdk/src/driver";
import type { Member } from "../../../../sdk/src/word";
import { createAgents, type Agents } from "../../../src/edges/agents";
import type { Ledger } from "../../../src/kernel/ledger";
import type { Registry, Router } from "../../../src/kernel/types";
import { openLedger } from "../../kernel/ledger/helpers";

export const OWNER: Caller = { member: "person:owner", via: "human", local: true, client: "client:a" };
export const caller = (member: string, via: Caller["via"] = "agent"): Caller => ({ member, via, local: true });
export const waitFor = async (pred: () => boolean, what = "condition") => {
  const until = Date.now() + 3000;
  while (!pred()) { if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setImmediate(r)); }
};
export const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

const offline = (): Reply => ({ ok: false, error: { code: "offline", message: "offline" } });

export class FakeRouter implements Router {
  sent: { msg: Outgoing; caller: Caller }[] = [];
  handlers = new Map<string, (msg: Outgoing, caller: Caller) => Reply | Promise<Reply>>();
  async send(msg: Outgoing, who: Caller): Promise<Reply> {
    this.sent.push({ msg, caller: who });
    const handler = this.handlers.get(`${msg.to}/${msg.word}`);
    if (handler) return handler(msg, who);
    return msg.to === null || msg.to === "person:owner" ? { ok: true } : offline();
  }
  subscribe() { return () => {}; }
  recover() {}
  to(to: string | null, word: string) { return this.sent.filter((s) => s.msg.to === to && s.msg.word === word); }
  says() { return this.to("person:owner", "say").map((s) => ({ from: s.caller.member, text: (s.msg.body as any).text as string })); }
  events(word: string) { return this.sent.filter((s) => s.msg.to === null && s.msg.word === word); }
  on(key: string, fn: (msg: Outgoing, caller: Caller) => Reply | Promise<Reply>) { this.handlers.set(key, fn); }
}

export class FakeRegistry implements Registry {
  members = new Map<string, Member>();
  watchers = new Set<(id: string, change: "added" | "removed") => void>();
  add(m: Member) { this.members.set(m.id, m); for (const l of this.watchers) l(m.id, "added"); }
  remove(id: string) { if (this.members.delete(id)) for (const l of this.watchers) l(id, "removed"); }
  find(to: string, word: string) {
    const member = this.members.get(to);
    const contract = member?.words().find((w) => w.word === word);
    return member && contract ? { member, contract } : null;
  }
  get(id: string) { return this.members.get(id) ?? null; }
  listeners(): Member[] { return []; }
  findByWord() { return []; }
  list(filter?: { kind?: Member["kind"] }) { return [...this.members.values()].filter((m) => !filter?.kind || m.kind === filter.kind).map((m) => ({ id: m.id, kind: m.kind, name: m.name })); }
  describe(id: string) { const m = this.members.get(id); return m ? { info: { id, kind: m.kind, name: m.name }, words: m.words() } : null; }
  onChange(cb: (id: string, change: "added" | "removed") => void) { this.watchers.add(cb); return () => this.watchers.delete(cb); }
}

/** A hand or app that is only there to be seen in the environment. */
export const dummy = (id: string, name: string, words: string[] = []): Member => ({
  id, kind: id.split(":")[0] as Member["kind"], name,
  words: () => words.map((word) => ({ member: id, word, kind: "request", direction: "in", description: "x".repeat(24), input_schema: { type: "object" }, effect: "read", risk: "none", callers: ["owner"], label: { doing: "x" } })),
  handle: async () => undefined,
});

interface Running { queue: DriverMessage[]; turn: string }
/** A driver whose turns the test finishes by hand. */
export class FakeDriver implements AgentDriver {
  info = { kind: "dsh", models: [], abilities: { resume: true, steer: true, inject_live: true, images: false, compact: true, configure: ["*"], plugins: true, mcp: true, system_prompt: "file" as const, credentials: true, usage: true } };
  calls: [string, ...unknown[]][] = [];
  running = new Map<string, Running>();
  handles = new Map<string, string>();
  statuses = new Map<string, AgentStatus0>();
  startFailures = 0;
  steerResult = true;
  /** A turn that starts and ends inside `send`, before it returns (what a remote driver can look like). */
  instantTurns = false;
  compactError: WordError | null = null;
  credentials = new Map<string, string>();
  usageRecords: unknown[] = [];
  private n = 0;
  constructor(readonly report: (e: AgentEvent) => void) {}
  private k = (agent: string, key: string) => `${agent}/${key}`;
  of(name: string) { return this.calls.filter((c) => c[0] === name); }

  async start(agent: string, spec: AgentStartSpec) {
    this.calls.push(["start", agent, spec]);
    if (this.startFailures > 0) { this.startFailures--; throw new WordError("failed", "no start"); }
    this.statuses.set(agent, { state: "running" });
    for (const key of spec.lanes) {
      const handle = spec.sessions[key] ?? `h${++this.n}`;
      this.handles.set(this.k(agent, key), handle);
      this.report({ event: "handle.updated", agent, key, handle });
    }
  }
  async stop(agent: string, reason: string) { this.calls.push(["stop", agent, reason]); this.statuses.set(agent, { state: "exited" }); for (const k of [...this.running.keys()]) if (k.startsWith(`${agent}/`)) this.running.delete(k); }
  status(agent: string) { return this.statuses.get(agent) ?? { state: "exited" as const }; }
  async restart(agent: string) { this.calls.push(["restart", agent]); }
  session = {
    get: (agent: string, key: string) => this.handles.get(this.k(agent, key)) ?? null,
    set: async (agent: string, key: string, handle: string) => { this.calls.push(["session.set", agent, key, handle]); this.handles.set(this.k(agent, key), handle); },
    new: async (agent: string, key: string) => { this.calls.push(["session.new", agent, key]); const handle = `h${++this.n}`; this.handles.set(this.k(agent, key), handle); return { handle }; },
    reload: async (agent: string, key: string, modules: { static: PromptModule[] }) => { this.calls.push(["session.reload", agent, key, modules]); const handle = `h${++this.n}`; this.handles.set(this.k(agent, key), handle); return { handle }; },
    compact: async (agent: string, key: string) => { this.calls.push(["session.compact", agent, key]); if (this.compactError) throw this.compactError; return { compacted: true }; },
  };
  private begin(agent: string, key: string, batch: DriverMessage[]) {
    const turn = `t${++this.n}`;
    this.running.set(this.k(agent, key), { queue: [], turn });
    this.report({ event: "turn.started", agent, key, turn, ids: batch.map((m) => m.id) });
  }
  async send(agent: string, key: string, batch: DriverMessage[]) {
    this.calls.push(["send", agent, key, batch]);
    if (this.running.has(this.k(agent, key))) throw new WordError("conflict", "busy");
    this.begin(agent, key, batch);
    if (this.instantTurns) this.finish(agent, key);
  }
  async followup(agent: string, key: string, batch: DriverMessage[]) {
    this.calls.push(["followup", agent, key, batch]);
    const run = this.running.get(this.k(agent, key));
    if (run) run.queue.push(...batch); else this.begin(agent, key, batch);
  }
  async steer(agent: string, key: string, text: string) { this.calls.push(["steer", agent, key, text]); return this.steerResult; }
  async inject(agent: string, key: string, content: { modules?: PromptModule[]; text?: string }) { this.calls.push(["inject", agent, key, content]); }
  async interrupt(agent: string, key: string) { this.calls.push(["interrupt", agent, key]); }
  async configure(agent: string, key: string | undefined, config?: Record<string, unknown>) { this.calls.push(["configure", agent, key, config]); return { model: "m", ...(config ?? {}) }; }
  async plugins(agent: string, op: string, name?: string) { this.calls.push(["plugins", agent, op, name]); return { plugins: [] }; }
  async credentialsHas(agent: string, ref: string) { this.calls.push(["credentialsHas", agent, ref]); return this.credentials.has(ref); }
  async credentialsSet(agent: string, ref: string, value: string) { this.calls.push(["credentialsSet", agent, ref]); this.credentials.set(ref, value); }
  async usage(agent: string, since: number): Promise<DriverUsage> { this.calls.push(["usage", agent, since]); return { records: this.usageRecords }; }

  // -- the test plays the agent --
  say(agent: string, key: string, text: string) { const run = this.running.get(this.k(agent, key)); this.report({ event: "output", agent, key, turn: run!.turn, text }); }
  tool(agent: string, key: string, name: string) { const run = this.running.get(this.k(agent, key)); this.report({ event: "tool", agent, key, turn: run!.turn, phase: "start", name, summary: "s" }); }
  finish(agent: string, key: string, outcome: "completed" | "cancelled" | "error" = "completed") {
    const run = this.running.get(this.k(agent, key))!;
    this.running.delete(this.k(agent, key));
    this.report({ event: "turn.ended", agent, key, turn: run.turn, outcome, ...(outcome === "error" ? { error: "boom" } : {}) });
    if (run.queue.length && outcome !== "cancelled") this.begin(agent, key, run.queue);
  }
  die(agent: string, reason = "killed") { this.statuses.set(agent, { state: "failed", detail: reason }); this.running.clear(); this.report({ event: "ended", agent, reason }); }
}
type AgentStatus0 = { state: "starting" | "running" | "exited" | "failed"; detail?: string };

export const MAIN_TEMPLATE = { id: "agent:main", name: "main", summary: "the main agent", brief: "You are main.", runtime: { kind: "dsh" }, native: { on: "body:main", cwd: "/root/work" },
  lanes: { front: { from: ["person:owner"] }, back: { from: ["wake", "timer", "event"], guide: "PULSE.md" } }, primary: true };

export interface Options {
  templates?: Record<string, unknown>;
  secrets?: Record<string, string>;
  files?: Record<string, string>;
  persona?: { file: string; content: string }[];
  /** Real drivers instead of the fake one. */
  drivers?: Record<string, AgentDriverFactory>;
  /** Keep the ledger and the clock of an earlier fixture (a kernel restart). */
  from?: { ledger: Ledger; clock: { t: number } };
}

export function fixture(opts: Options = {}) {
  const prior = opts.from;
  const ledger = prior?.ledger ?? openLedger().ledger;
  ledger.db().exec("PRAGMA synchronous=OFF"); // the tests do many small writes; durability is the ledger's own test
  const router = new FakeRouter();
  const registry = new FakeRegistry();
  const clock = prior?.clock ?? { t: 1_700_000_000_000 };
  const timers = { everies: [] as { ms: number; fn: () => void }[], afters: [] as { ms: number; fn: () => void; cancelled: boolean }[] };
  const drivers: FakeDriver[] = [];
  const secrets = { ...(opts.secrets ?? {}) };
  const files = { ...(opts.files ?? {}) };
  const persona = { files: opts.persona ?? [{ file: "SOUL.md", content: "soul v1" }] };
  const skills: { path: string; text: string }[] = [];
  const templates: Record<string, unknown> = { main: MAIN_TEMPLATE, ...(opts.templates ?? {}) };
  const logs: unknown[][] = [];

  router.on("body:main/workspace.read", (msg) => {
    const text = files[(msg.body as any).path];
    return text === undefined ? { ok: false, error: { code: "not_found", message: "no" } } : { ok: true, result: { data: { text } } };
  });
  router.on("body:main/workspace.grep", () => ({ ok: true, result: { data: { matches: skills } } }));
  router.on("service:persona/get", () => ({ ok: true, result: { data: { files: persona.files.map((f) => ({ ...f, version: "v" })) } } }));

  let ids = 0;
  const agents: Agents = createAgents({
    router, registry, ledger, vault: { use: (ref) => secrets[ref] ?? null },
    drivers: opts.drivers ?? { dsh: (report) => { const d = new FakeDriver(report); drivers.push(d); return d; } },
    templates: { read: (name) => templates[name] ?? null },
    tools: (agent, allowed) => ({ mcp_url: "http://hub/mcp", token: `tok-${agent}`, allowed: allowed ?? ["*"] }),
    rules: () => "rules v1", now: () => clock.t, newId: () => `n${++ids}-${randomBytes(2).toString("hex")}`, log: (...a) => logs.push(a),
    timers: {
      every: (ms, fn) => { const e = { ms, fn }; timers.everies.push(e); return () => { timers.everies.splice(timers.everies.indexOf(e), 1); }; },
      after: (ms, fn) => { const a = { ms, fn, cancelled: false }; timers.afters.push(a); return () => { a.cancelled = true; }; },
    },
  });
  const driver = () => drivers[0]!;
  let n = 0;
  /** A message as the router would hand it to a member. */
  const message = (from: string, to: string, word: string, body: unknown, extra: Partial<Message> = {}): Message =>
    ({ seq: ++n, id: `msg${++n}`, ts: clock.t, from, to, kind: "request", word, body, ...extra });
  const call = async (to: string, word: string, body: unknown, who: Caller = OWNER, extra: Partial<Message> = {}) => {
    const found = registry.find(to, word);
    if (!found) throw new Error(`${to} does not speak ${word}`);
    const msg = message(who.member, to, word, body, extra);
    return found.member.handle(msg, { signal: new AbortController().signal, caller: who, raw: body });
  };
  const service = (word: string, body: unknown, who: Caller = OWNER) => agents.service.handle(message(who.member, "service:agents", word, body), { signal: new AbortController().signal, caller: who, raw: body });
  return { ledger, router, registry, clock, timers, drivers, driver, secrets, files, persona, skills, templates, agents, logs, call, service, message,
    start: async () => { await agents.startAll(); registry.add(agents.service); await settle(); } };
}
