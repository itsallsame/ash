/**
 * The agents module's working part (HUB-MODULES §2.5, SPEC-08): declared agents, their lanes and inboxes, delivery
 * through a driver, the events a driver reports, keys and usage. `service.ts` and `member.ts` are the words on top.
 *
 * Everything here reaches other members through `router.send` and the registry; the driver of each runtime kind is
 * injected, so nothing here knows how an agent is started.
 */
import { createHash, randomBytes } from "node:crypto";
import { WordError, type Caller, type Message } from "../../../../sdk/src/message";
import type { AgentDriver, AgentDriverFactory, AgentEvent, DriverAttachment, ModuleId, PromptModule } from "../../../../sdk/src/driver";
import { OWNER_ID } from "../../../../sdk/src/ids";
import type { Member } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Registry, Router, Vault } from "../../kernel/types";
import { Inbox, toDriverMessage, type InboxRow } from "./inbox";
import { Modules, SERVICE_CALLER } from "./modules";
import { lanesOf, Runs, type AgentDecl, type LaneDecl, type Run, type Templates } from "./runs";

export interface Timers {
  every(ms: number, fn: () => void): () => void;
  after(ms: number, fn: () => void): () => void;
}
const realTimers: Timers = {
  every(ms, fn) { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); },
  after(ms, fn) { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); },
};

export interface AgentsDeps {
  router: Router;
  registry: Registry;
  ledger: Pick<Ledger, "db" | "tx" | "blob">;
  /** Only `use` is given: plaintext for DSH's first key set-up. */
  vault: Pick<Vault, "use">;
  /** One driver factory per runtime kind (`dsh`...). */
  drivers: Record<string, AgentDriverFactory>;
  /** `ash-skills/agents`: the `main` template that plants the first declaration, and the templates for `spawn`. */
  templates: Templates;
  /** The agent's own address and token on the tool surface; `allowed` is its declared tool list (already narrowed by delegation). */
  tools(agent: string, allowed?: string[]): { mcp_url: string; token: string; allowed: string[] };
  rules?(decl: AgentDecl): string | Promise<string>;
  channels?(): string[];
  now?(): number;
  timers?: Timers;
  newId?(): string;
  log?(...args: unknown[]): void;
  /** Vault refs the runtime may hold for itself. */
  credentialRefs?: string[];
}

export const DEFAULT_CREDENTIAL_REFS = ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"];
export const USAGE_POLL_MS = 10 * 60_000;
/** A process that ran at least this long before it died does not count against the three tries. */
export const STABLE_RUN_MS = 60_000;
export const MAX_FAILURES = 3;
/** Dynamic modules are put in again after this many turns even if unchanged. */
export const REINJECT_EVERY = 20;
const BATCH = 20;
const SPAWN_TIMEOUT_S = 600;

interface Lane {
  key: string;
  busy: boolean;
  /** A batch is being prepared or handed to the driver. */
  sending: boolean;
  turn?: string;
  /** Version of each dynamic module this lane's session has been given. */
  injected: Map<ModuleId, string>;
  turnsSince: number;
  reloadPending: boolean;
  compactPending: boolean;
  quotaNoticed: boolean;
  routing: Set<string>;
}
interface Live {
  id: string;
  driver: AgentDriver;
  state: "starting" | "running" | "failed";
  lanes: Map<string, Lane>;
  startedAt: number;
  failures: number;
  stopping: boolean;
}
interface Waiter { id: string; agent: string; from: string; since: number; resolve(answer: string): void; reject(error: WordError): void }

export const agentCaller = (agent: string, turn?: string): Caller => ({ member: agent, via: "agent", local: true, ...(turn ? { turn } : {}) });
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const errorText = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);

export class AgentManager {
  readonly runs: Runs;
  readonly inbox: Inbox;
  readonly modules: Modules;
  private readonly live = new Map<string, Live>();
  private readonly drivers = new Map<string, AgentDriver>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly outputs = new Map<string, string[]>();
  private readonly stoppers: (() => void)[] = [];
  private readonly timers: Timers;
  readonly now: () => number;
  private readonly log: (...args: unknown[]) => void;

  constructor(readonly deps: AgentsDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
    this.log = deps.log ?? (() => {});
    this.runs = new Runs(deps.ledger, this.now);
    this.inbox = new Inbox(deps.ledger.db());
    this.modules = new Modules({ router: deps.router, registry: deps.registry, now: this.now, rules: deps.rules, channels: deps.channels });
  }

  newId = (): string => this.deps.newId?.() ?? `m_${randomBytes(9).toString("base64url")}`;
  private bg(work: Promise<unknown>, what: string): void { work.catch((error) => this.log(`agents: ${what}: ${errorText(error)}`)); }

  // ----------------------------------------------------------------------------------------------------------------
  // start and stop of the module
  // ----------------------------------------------------------------------------------------------------------------

  async startAll(): Promise<void> {
    this.runs.seed(this.deps.templates);
    this.inbox.prune(this.now() - 7 * 86_400_000);
    this.stoppers.push(this.timers.every(USAGE_POLL_MS, () => this.bg(this.pollUsage(), "usage poll")));
    await Promise.allSettled(this.runs.list().filter((run) => run.desired === "on").map((run) => this.startAgent(run.id, "内核重启")));
  }

  async stopAll(): Promise<void> {
    for (const stop of this.stoppers.splice(0)) stop();
    await Promise.allSettled([...this.live.keys()].map((id) => this.stopAgent(id, "hub stopping")));
  }

  // ----------------------------------------------------------------------------------------------------------------
  // drivers
  // ----------------------------------------------------------------------------------------------------------------

  driver(kind: string): AgentDriver {
    let driver = this.drivers.get(kind);
    if (!driver) {
      const factory = this.deps.drivers[kind];
      if (!factory) throw new WordError("unavailable", `no driver for runtime ${kind}`);
      driver = factory((event) => this.onEvent(event));
      this.drivers.set(kind, driver);
    }
    return driver;
  }
  kinds(): string[] { return Object.keys(this.deps.drivers); }

  // ----------------------------------------------------------------------------------------------------------------
  // declarations -> running agents
  // ----------------------------------------------------------------------------------------------------------------

  run(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new WordError("not_found", `no such agent: ${id}`);
    return run;
  }
  liveOf(id: string): Live | undefined { return this.live.get(id); }
  running(id: string): Live {
    this.run(id);
    const live = this.live.get(id);
    if (!live || live.state !== "running") throw new WordError("offline", `${id} is not running`);
    return live;
  }
  stateOf(id: string): "idle" | "working" | "stopped" | "error" {
    const live = this.live.get(id);
    if (!live) return "stopped";
    if (live.state === "failed") return "error";
    return [...live.lanes.values()].some((l) => l.busy) ? "working" : live.state === "running" ? "idle" : "stopped";
  }

  /** Start an agent and keep trying (up to three failures in a row). `why` names the reason in the notice an interrupted turn leaves. */
  async startAgent(id: string, why = "内核重启", failures = 0): Promise<void> {
    const existing = this.live.get(id);
    if (existing && existing.state !== "failed") return;
    const run = this.run(id);
    const decl = run.spec.decl;
    const lanes = lanesOf(decl);
    const live: Live = { id, driver: this.driver(decl.runtime.kind), state: "starting", lanes: new Map(), startedAt: this.now(), failures, stopping: false };
    for (const key of Object.keys(lanes)) live.lanes.set(key, newLane(key));
    this.live.set(id, live);
    let statics: PromptModule[] = [];
    try {
      statics = await this.modules.static(decl);
      await live.driver.start(id, {
        runtime: decl.runtime, ...(decl.native ? { native: decl.native } : {}), tools: this.deps.tools(id, decl.tools),
        modules: { static: statics }, lanes: Object.keys(lanes), sessions: run.spec.sessions,
      });
    } catch (error) {
      this.live.delete(id);
      await live.driver.stop(id, "start failed").catch(() => {});
      this.log(`agents: ${id} did not start: ${errorText(error)}`);
      if (failures + 1 >= MAX_FAILURES) return this.giveUp(id, errorText(error), live);
      return this.startAgent(id, why, failures + 1);
    }
    live.state = "running";
    live.startedAt = this.now();
    const hash = staticHash(statics);
    this.runs.patch(id, (spec) => { for (const key of Object.keys(lanes)) if (!spec.sessions[key] || !spec.static_hash[key]) spec.static_hash[key] ??= hash; });
    this.deps.registry.add(this.memberFor(id));
    this.interruptedNotice(id, why);
    await this.syncCredentials(live);
    for (const lane of live.lanes.values()) this.bg(this.drain(live, lane), `drain ${id}/${lane.key}`);
  }

  private giveUp(id: string, reason: string, live: Live): void {
    live.state = "failed";
    live.stopping = true;
    this.live.set(id, live);
    this.deps.registry.remove(id);
    this.tellOwner(`${id} 起不来了：连着失败了三次（${reason}）。我先停下它，不再自动重试；你可以在设置里让它重启。`);
  }

  async stopAgent(id: string, reason: string, off = false): Promise<void> {
    const live = this.live.get(id);
    if (off) this.runs.setDesired(id, "off");
    if (!live) return;
    live.stopping = true;
    this.deps.registry.remove(id);
    this.rejectWaiters(id, new WordError("unavailable", `${id} stopped`));
    this.live.delete(id);
    if (live.state !== "failed") await live.driver.stop(id, reason).catch((error) => this.log(`agents: stopping ${id}: ${errorText(error)}`));
  }

  async restartAgent(id: string): Promise<void> {
    await this.stopAgent(id, "restart");
    this.runs.setDesired(id, "on");
    await this.startAgent(id, "重启");
  }

  /** What was in flight when the agent went away is not sent again; the agent hears that it was cut off and decides. */
  private interruptedNotice(id: string, why: string): void {
    const rows = this.inbox.unfinished(id);
    if (!rows.length) return;
    const cut = rows.filter((r) => r.turn);
    this.inbox.mark(rows.filter((r) => !r.turn).map((r) => r.id), "pending");
    this.inbox.mark(cut.map((r) => r.id), "interrupted");
    if (!cut.length) return;
    const doing = cut.slice(0, 3).map((r) => r.text.replace(/\s+/g, " ").slice(0, 80)).join("；");
    this.enqueue(id, { id: this.newId(), from: SERVICE_CALLER.member, word: "wake", text: `${why}，上一轮中断了（当时在处理：${doing}）。要不要接着做，你自己决定。`, attachments: [], at: this.now() });
  }

  // ----------------------------------------------------------------------------------------------------------------
  // members
  // ----------------------------------------------------------------------------------------------------------------

  memberFor(id: string): Member {
    const name = this.run(id).spec.decl.name;
    return {
      id, kind: "agent", name,
      words: () => wordsOf(id).filter((w) => w.direction === "in"),
      handle: (msg, ctx) => this.accept(id, msg, ctx.raw, ctx.signal),
    };
  }

  // ----------------------------------------------------------------------------------------------------------------
  // the inbox: filing, delivery
  // ----------------------------------------------------------------------------------------------------------------

  /** Which lane takes a message: the first one whose `from` names the sender or its kind of sender; else `back`. */
  laneFor(decl: AgentDecl, from: string, word: string, kind: string, wanted?: string): string {
    const lanes = lanesOf(decl);
    if (wanted && lanes[wanted]) return wanted;
    const category = word === "wake" ? "wake" : from === OWNER_ID ? OWNER_ID : from === "service:clock" ? "timer" : kind === "event" ? "event" : "";
    const pick = (match: (f: string) => boolean) => Object.entries(lanes).find(([, l]) => l.from?.some(match))?.[0];
    return pick((f) => f === "*" || (word !== "wake" && f === from) || f === category) ?? (lanes.back ? "back" : pick((f) => f === "wake")) ?? Object.keys(lanes)[0]!;
  }

  /** A request or event addressed to an agent. */
  async accept(id: string, msg: Message, raw: unknown, signal?: AbortSignal): Promise<{ data: unknown }> {
    if (msg.word === "typing") return { data: undefined };
    const body = (raw && typeof raw === "object" ? raw : msg.body) as Record<string, any>;
    const decl = this.run(id).spec.decl;
    const attachments = this.storeAttachments(body.attachments);
    let words = text(body.text);
    if (msg.word === "say" && body.in_reply_to) words = `[answers ${body.in_reply_to}, option ${body.option_id}] ${words}`.trim();
    if (msg.word === "wake") words = `Wake · ${text(body.reason)}${body.context === undefined ? "" : `\n${JSON.stringify(body.context)}`}`;
    if (!words && attachments.length) words = "(attachments)";
    const lane = this.laneFor(decl, msg.from, msg.word, msg.kind, msg.word === "wake" ? text(body.lane) : undefined);
    const row = { id: msg.id, from: msg.from, word: msg.word, text: words, attachments, at: msg.ts, ...(msg.thread ? { thread: msg.thread } : {}), ...(msg.origin ? { origin: msg.origin } : {}) };
    if (msg.word !== "ask") {
      this.enqueue(id, row, lane);
      return { data: { accepted: true } };
    }
    const answer = this.expect(id, msg.id, msg.from, signal);
    this.enqueue(id, row, lane);
    return { data: { answer: await answer } };
  }

  private storeAttachments(raw: unknown): DriverAttachment[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((a) => a && typeof a.data === "string").map((a) => ({
      name: String(a.name), mime_type: String(a.mime_type), ref: this.deps.ledger.blob.put(Buffer.from(a.data, "base64"), String(a.mime_type)),
    }));
  }

  /** File a message in an agent's inbox and see whether it can be delivered. */
  enqueue(id: string, item: Omit<InboxRow, "agent" | "lane" | "state" | "turn">, lane?: string): InboxRow {
    const decl = this.run(id).spec.decl;
    const key = lane ?? this.laneFor(decl, item.from, item.word, "request");
    const row = this.inbox.add({ ...item, agent: id, lane: key });
    const live = this.live.get(id);
    const l = live?.lanes.get(key);
    if (live && l && live.state === "running" && row.state === "pending") {
      if (l.busy) this.bg(this.busyRoute(live, l, row), `route ${row.id}`);
      else if (!l.sending) this.bg(this.drain(live, l), `drain ${id}/${key}`);
    }
    return row;
  }

  /** The agent is idle on this lane: give it what is waiting (one batch). */
  async drain(live: Live, lane: Lane): Promise<void> {
    if (live.state !== "running" || lane.busy || lane.sending) return;
    const rows = this.inbox.pending(live.id, lane.key, BATCH);
    if (!rows.length) return;
    lane.sending = true;
    try {
      if (!(await this.quotaAllows(live, lane))) return;
      if (lane.busy || live.stopping) return;
      await this.inject(live, lane);
      this.inbox.mark(rows.map((r) => r.id), "sent");
      try {
        await live.driver.send(live.id, lane.key, rows.map(toDriverMessage));
        lane.busy = true;
      } catch (error) {
        this.inbox.mark(rows.map((r) => r.id), "pending");
        if (error instanceof WordError && error.code === "conflict") lane.busy = true; // the driver is in a turn already
        else throw error;
      }
    } finally { lane.sending = false; }
    // What arrived while the batch was being handed over now meets a busy lane.
    if (lane.busy) for (const row of this.inbox.pending(live.id, lane.key)) this.bg(this.busyRoute(live, lane, row), `route ${row.id}`);
  }

  /** A message came while the lane is in a turn: the owner's words go to the reflex judgement, the rest queue for the next turn. */
  private async busyRoute(live: Live, lane: Lane, row: InboxRow): Promise<void> {
    if (lane.routing.has(row.id)) return;
    lane.routing.add(row.id);
    try {
      let action: "interrupt" | "steer" | "followup" = "followup";
      if (row.from === OWNER_ID) {
        const reply = await this.deps.router.send({ to: "service:reflex", kind: "request", word: "conversation.control", body: { message_id: row.id, agent: live.id, lane: lane.key } }, SERVICE_CALLER);
        const chosen = reply.ok ? (reply.result?.data as { action?: string } | undefined)?.action : undefined;
        if (chosen === "interrupt" || chosen === "steer") action = chosen;
      }
      if (!lane.busy) { this.bg(this.drain(live, lane), "drain"); return; } // the turn ended while we were asking
      if (this.inbox.get(row.id)?.state !== "pending") return;
      if (action === "interrupt") {
        await live.driver.interrupt(live.id, lane.key); // the message waits; the turn ending sends it
      } else if (action === "steer" && lane.turn && (await live.driver.steer(live.id, lane.key, row.text))) {
        this.inbox.mark([row.id], "sent", lane.turn);
      } else {
        this.inbox.mark([row.id], "sent");
        await live.driver.followup(live.id, lane.key, [toDriverMessage(row)]);
      }
    } catch (error) {
      this.inbox.mark([row.id], "pending");
      this.log(`agents: routing ${row.id}: ${errorText(error)}`);
    } finally { lane.routing.delete(row.id); }
  }

  /** Before a turn: ask `service:cost` whether the agent is within its quota. Offline or unsure: go ahead. */
  private async quotaAllows(live: Live, lane: Lane): Promise<boolean> {
    const reply = await this.deps.router.send({ to: "service:cost", kind: "request", word: "quota.check", body: { agent: live.id } }, SERVICE_CALLER);
    const data = reply.ok ? (reply.result?.data as { allowed?: boolean; reason?: string; used?: number; limit?: number } | undefined) : undefined;
    if (data?.allowed !== false) { lane.quotaNoticed = false; return true; }
    if (!lane.quotaNoticed) {
      lane.quotaNoticed = true;
      this.tellOwner(data.reason || `${live.id} 今天的额度用完了${data.limit ? `（${data.used ?? "?"}/${data.limit}）` : ""}，先不开新的一轮；你的消息我留着。`);
    }
    return false;
  }

  /** Put the dynamic modules whose content changed into the lane's session (all of them every REINJECT_EVERY turns). */
  private async inject(live: Live, lane: Lane, only?: ModuleId[]): Promise<void> {
    const decl = this.run(live.id).spec.decl;
    const all = (await this.modules.dynamic(decl, lane.key)).filter((m) => !only || only.includes(m.id));
    const force = lane.turnsSince >= REINJECT_EVERY || !!only;
    const changed = all.filter((m) => force || lane.injected.get(m.id) !== m.version);
    if (!changed.length) return;
    await live.driver.inject(live.id, lane.key, { modules: changed });
    for (const m of changed) lane.injected.set(m.id, m.version);
    if (force && !only) lane.turnsSince = 0;
  }

  /** Public: put what changed (files, environment) into a running agent's lanes now, between turns if need be. */
  async refreshModules(id: string, key?: string): Promise<void> {
    const live = this.running(id);
    for (const lane of live.lanes.values()) if (!key || key === lane.key) await this.inject(live, lane);
  }

  // ----------------------------------------------------------------------------------------------------------------
  // what a driver reports
  // ----------------------------------------------------------------------------------------------------------------

  onEvent(ev: AgentEvent): void {
    try { this.handleEvent(ev); } catch (error) { this.log(`agents: event ${ev.event} of ${ev.agent}: ${errorText(error)}`); }
  }

  private handleEvent(ev: AgentEvent): void {
    const live = this.live.get(ev.agent);
    switch (ev.event) {
      case "handle.updated":
        if (this.runs.get(ev.agent)) this.runs.patch(ev.agent, (spec) => { spec.sessions[ev.key] = ev.handle; });
        return;
      case "error": this.log(`agents: ${ev.agent}: ${ev.message}`); return;
      case "ended": this.onEnded(ev.agent, ev.reason); return;
      default:
    }
    if (!live) return;
    const lane = live.lanes.get(ev.key) ?? this.adoptLane(live, ev.key);
    switch (ev.event) {
      case "turn.started":
        lane.busy = true;
        lane.turn = ev.turn;
        lane.turnsSince++;
        this.outputs.set(ev.turn, []);
        if (ev.ids?.length) this.inbox.mark(ev.ids, "sent", ev.turn);
        this.emit(ev.agent, "turn.started", { turn: ev.turn, lane: ev.key, ...(ev.ids ? { ids: ev.ids } : {}) }, ev.turn);
        return;
      case "output": {
        this.outputs.get(ev.turn)?.push(ev.text);
        if (this.speaks(live.id, ev.key)) this.say(ev.agent, ev.text, ev.turn);
        return;
      }
      case "thought": return; // the activity page only; not on the ledger
      case "tool":
        this.emit(ev.agent, "agent.tool", { turn: ev.turn, name: ev.name, phase: ev.phase, ...(ev.summary ? { summary: ev.summary } : {}), ...(ev.ok === undefined ? {} : { ok: ev.ok }) }, ev.turn);
        if (ev.phase === "start") this.trigger(live, ev.key, `${ev.key}:tool`, `Lane ${ev.key} called the tool ${ev.name}${ev.summary ? ` (${ev.summary})` : ""}.`, ev.turn);
        return;
      case "turn.ended": this.finishTurn(live, lane, ev); return;
    }
  }

  private adoptLane(live: Live, key: string): Lane {
    const lane = newLane(key);
    live.lanes.set(key, lane);
    return lane;
  }

  private speaks(id: string, key: string): boolean {
    const lane: LaneDecl | undefined = lanesOf(this.run(id).spec.decl)[key];
    return lane?.speak ?? !!lane?.from?.includes(OWNER_ID);
  }

  private finishTurn(live: Live, lane: Lane, ev: Extract<AgentEvent, { event: "turn.ended" }>): void {
    lane.busy = false;
    lane.turn = undefined;
    const rows = this.inbox.byTurn(ev.turn);
    this.inbox.finish(ev.turn, ev.outcome === "interrupted" ? "interrupted" : "done");
    const said = (this.outputs.get(ev.turn) ?? []).join("\n\n");
    this.outputs.delete(ev.turn);
    for (const row of rows) {
      const waiter = this.waiters.get(row.id);
      if (!waiter) continue;
      this.waiters.delete(row.id);
      if (ev.outcome === "completed") waiter.resolve(said);
      else waiter.reject(new WordError(ev.outcome === "cancelled" ? "cancelled" : "failed", ev.error ?? `the turn ended: ${ev.outcome}`));
    }
    this.emit(live.id, "turn.ended", { turn: ev.turn, lane: ev.key, outcome: ev.outcome, ...(ev.error ? { error: ev.error } : {}) }, ev.turn);
    // A turn that another lane's `on` started does not start further lanes: that would loop.
    if (!(rows.length && rows.every((r) => r.word === "lane"))) this.trigger(live, ev.key, `${ev.key}:turn.ended`, `Lane ${ev.key} finished a turn (${ev.outcome}). Its turn id is ${ev.turn}; service:history/turn shows what happened in it.`, ev.turn);
    if (lane.reloadPending) { lane.reloadPending = false; this.bg(this.reloadLane(live, lane), "reload"); }
    if (lane.compactPending) { lane.compactPending = false; this.bg(live.driver.session.compact(live.id, lane.key), "compact"); }
    this.bg(this.drain(live, lane), `drain ${live.id}/${lane.key}`);
  }

  /** `on: ["<lane>:turn.ended"]` and `["<lane>:tool"]`: inside the module, no subscription. */
  private trigger(live: Live, from: string, event: string, textOf: string, turn: string): void {
    for (const [key, lane] of Object.entries(lanesOf(this.run(live.id).spec.decl))) {
      if (key === from || !lane.on?.includes(event)) continue;
      this.enqueue(live.id, { id: this.newId(), from: live.id, word: "lane", text: textOf, attachments: [], at: this.now() }, key);
    }
  }

  private onEnded(id: string, reason?: string): void {
    const live = this.live.get(id);
    if (!live || live.stopping || live.state !== "running") return;
    this.live.delete(id);
    this.deps.registry.remove(id);
    this.rejectWaiters(id, new WordError("failed", `${id} stopped unexpectedly`));
    this.log(`agents: ${id} ended: ${reason ?? "?"}`);
    const failures = this.now() - live.startedAt >= STABLE_RUN_MS ? 1 : live.failures + 1;
    if (failures >= MAX_FAILURES) { this.giveUp(id, reason ?? "the process ended", live); return; }
    this.bg(this.startAgent(id, "进程重启", failures), `restart ${id}`);
  }

  // ----------------------------------------------------------------------------------------------------------------
  // out to the router
  // ----------------------------------------------------------------------------------------------------------------

  private emit(agent: string, word: string, body: unknown, turn?: string): void {
    this.bg(this.deps.router.send({ to: null, kind: "event", word, body }, agentCaller(agent, turn)), `event ${word}`);
  }
  private say(agent: string, words: string, turn?: string): void {
    this.bg(this.deps.router.send({ to: OWNER_ID, kind: "request", word: "say", body: { text: words } }, agentCaller(agent, turn)).then((r) => { if (!r.ok) this.log(`agents: ${agent} could not say: ${r.error.code}`); }), "say");
  }
  /** The hub itself tells the owner something. */
  tellOwner(words: string): void {
    this.bg(this.deps.router.send({ to: OWNER_ID, kind: "request", word: "say", body: { text: words, kind: "heads_up" } }, SERVICE_CALLER), "tell owner");
  }

  // ----------------------------------------------------------------------------------------------------------------
  // asking an agent and waiting for its answer
  // ----------------------------------------------------------------------------------------------------------------

  /** Wait for the answer to a message: the words of the turn that took it, or an `answer` word. */
  expect(agent: string, id: string, from: string, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.waiters.set(id, { id, agent, from, since: this.now(), resolve, reject });
      signal?.addEventListener("abort", () => { if (this.waiters.delete(id)) reject(new WordError("cancelled", "the question was cancelled")); }, { once: true });
    });
  }
  waiter(id: string): Waiter | undefined { return this.waiters.get(id); }
  settle(id: string, answer: string): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    this.waiters.delete(id);
    w.resolve(answer);
    return true;
  }
  rejectWaiter(id: string, error: WordError): void {
    const w = this.waiters.get(id);
    if (w) { this.waiters.delete(id); w.reject(error); }
  }
  threads(): Waiter[] { return [...this.waiters.values()]; }
  private rejectWaiters(agent: string, error: WordError): void {
    for (const [id, w] of this.waiters) if (w.agent === agent) { this.waiters.delete(id); w.reject(error); }
  }

  // ----------------------------------------------------------------------------------------------------------------
  // sessions
  // ----------------------------------------------------------------------------------------------------------------

  lane(live: Live, key: string): Lane {
    const lane = live.lanes.get(key);
    if (!lane) throw new WordError("not_found", `${live.id} has no lane ${key}`);
    return lane;
  }

  /** The lane's session starts afresh: nothing has been injected into it yet. */
  forgetInjected(lane: Lane): void { lane.injected.clear(); lane.turnsSince = 0; }

  /** A new session with the current static modules. Skipped when they have not changed since this lane's session opened. */
  async reloadLane(live: Live, lane: Lane, force = false): Promise<{ handle: string | null; skipped: boolean }> {
    const statics = await this.modules.static(this.run(live.id).spec.decl);
    const hash = staticHash(statics);
    if (!force && this.run(live.id).spec.static_hash[lane.key] === hash) return { handle: live.driver.session.get(live.id, lane.key), skipped: true };
    const { handle } = await live.driver.session.reload(live.id, lane.key, { static: statics });
    this.runs.patch(live.id, (spec) => { spec.sessions[lane.key] = handle; spec.static_hash[lane.key] = hash; });
    this.forgetInjected(lane);
    return { handle, skipped: false };
  }

  // ----------------------------------------------------------------------------------------------------------------
  // keys and usage
  // ----------------------------------------------------------------------------------------------------------------

  /** Give the runtime the keys it lacks. It keeps and reads its own; a key it already has is left alone. */
  async syncCredentials(live: Live, refs = this.deps.credentialRefs ?? DEFAULT_CREDENTIAL_REFS): Promise<void> {
    const driver = live.driver;
    if (!driver.credentialsHas || !driver.credentialsSet) return;
    for (const ref of refs) {
      const value = this.deps.vault.use(ref);
      if (!value) continue;
      try {
        if (!(await driver.credentialsHas(live.id, ref))) await driver.credentialsSet(live.id, ref, value);
      } catch (error) { this.log(`agents: credential ${ref} for ${live.id}: ${(error as { code?: string }).code ?? "failed"}`); }
    }
  }

  async onVaultChanged(ref: string, action: string): Promise<void> {
    // Only the keys a runtime may hold for itself; the vault keeps others (gateway, cloud) to itself.
    if (action !== "saved" || !(this.deps.credentialRefs ?? DEFAULT_CREDENTIAL_REFS).includes(ref)) return;
    for (const live of this.live.values()) if (live.state === "running") await this.syncCredentials(live, [ref]);
  }

  /** Every ten minutes: what the runtimes recorded since last time goes to `service:cost`. If it is not there the records are dropped. */
  async pollUsage(): Promise<void> {
    for (const live of [...this.live.values()]) {
      if (live.state !== "running" || !live.driver.usage) continue;
      const since = this.run(live.id).spec.usage_since;
      let usage;
      try { usage = await live.driver.usage(live.id, since); } catch (error) { this.log(`agents: usage of ${live.id}: ${errorText(error)}`); continue; }
      let cursor = since;
      for (const r of usage.records as Record<string, any>[]) {
        cursor = Math.max(cursor, Number(r.done ?? r.at ?? 0));
        const reply = await this.deps.router.send({ to: "service:cost", kind: "event", word: "usage.recorded", body: {
          caller: live.id, provider: /openrouter/i.test(String(r.provider)) ? "openrouter" : "deepseek", model: String(r.model || "unknown"),
          input_tokens: Number(r.input) || 0, output_tokens: Number(r.output) || 0, ok: r.ok !== false, at: Number(r.at ?? r.done ?? this.now()),
        } }, SERVICE_CALLER);
        if (!reply.ok && reply.error.code === "offline") break;
      }
      this.runs.patch(live.id, (spec) => { spec.usage_since = cursor; });
    }
    for (const live of this.live.values()) for (const lane of live.lanes.values()) this.bg(this.drain(live, lane), "drain");
  }

  // ----------------------------------------------------------------------------------------------------------------
  // temporary workers
  // ----------------------------------------------------------------------------------------------------------------

  /** Run one task on a throwaway agent: declare it, ask it, collect the answer, delete it. */
  async runWorker(decl: AgentDecl, task: string, from: string, timeoutS: number): Promise<string> {
    this.runs.put({ id: decl.id, spec: { decl, sessions: {}, static_hash: {}, usage_since: this.now() } });
    let stop = () => {};
    try {
      await this.startAgent(decl.id);
      const live = this.live.get(decl.id);
      if (!live || live.state !== "running") throw new WordError("failed", "the temporary agent could not start");
      const id = this.newId();
      const answer = this.expect(decl.id, id, from);
      const timeout = new Promise<never>((_, reject) => { stop = this.timers.after(timeoutS * 1000, () => reject(new WordError("timeout", "the temporary agent did not finish in time"))); });
      this.enqueue(decl.id, { id, from, word: "ask", text: task, attachments: [], at: this.now() });
      return await Promise.race([answer, timeout]);
    } finally {
      stop();
      await this.stopAgent(decl.id, "done").catch(() => {});
      this.inbox.drop(decl.id);
      this.runs.remove(decl.id);
    }
  }
}

const newLane = (key: string): Lane => ({ key, busy: false, sending: false, injected: new Map(), turnsSince: 0, reloadPending: false, compactPending: false, quotaNoticed: false, routing: new Set() });

export const staticHash = (modules: PromptModule[]): string =>
  createHash("sha256").update(modules.map((m) => `${m.id}:${m.version}`).join("|")).digest("hex").slice(0, 12);

export type { Live, Lane, Waiter };
