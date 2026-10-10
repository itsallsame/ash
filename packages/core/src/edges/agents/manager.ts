/**
 * The agents module's working part (HUB-MODULES §2.5, SPEC-08): declared agents, their lanes and inboxes, delivery
 * through a driver, the events a driver reports, keys and usage. `service.ts` is the words on top.
 *
 * Everything here reaches other members through `router.send` and the registry; the driver of each runtime kind is
 * injected, so nothing here knows how an agent is started.
 */
import { createHash, randomBytes } from "node:crypto";
import { WordError, type Caller, type Message } from "../../../../sdk/src/message";
import type { AgentDriver, AgentDriverFactory, AgentEvent, DriverAttachment, ModuleId, PromptModule } from "../../../../sdk/src/driver";
import type { HostNetwork } from "../../../../sdk/src/host";
import { OWNER_ID } from "../../../../sdk/src/ids";
import type { Member } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Registry, Router, Vault } from "../../kernel/types";
import { proxyEnv } from "../../../../sdk/src/proxy";
import { failureText, RETRY_OPTION } from "./failure";
import { Inbox, toDriverMessage, type InboxRow } from "./inbox";
import { Modules, SERVICE_CALLER, type OwnerChannel } from "./modules";
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
  /** The agent's own address on the tool surface and one token for each of its lanes (a new set on every call; the one before stops working); `allowed` is its declared tool list (already narrowed by delegation). */
  tools(agent: string, lanes: string[], allowed?: string[]): { mcp_url: string; tokens: Record<string, string>; allowed: string[] };
  /** The agent's tokens stop working (it was stopped, removed, or its process ended). */
  revokeTools?(agent: string): void;
  /** The agent's process is up (after every start, also after a crash): the tool surface tells it what it owes. */
  started?(agent: string): void;
  rules?(decl: AgentDecl): string | Promise<string>;
  /** The owner's open channels, for the environment's 「主人在哪」 line. */
  channels?(): OwnerChannel[];
  now?(): number;
  timers?: Timers;
  newId?(): string;
  log?(...args: unknown[]): void;
  /** Vault refs the runtime may hold for itself. */
  credentialRefs?: string[];
  /** The host's network when the module starts: what the running agents were given, to tell later whether the proxy changed. */
  network?: HostNetwork;
  /** The runtime kinds whose processes run on the main body, so a new proxy needs a new process (default `dsh`). Those on a computer are not the hub's to restart. */
  localKinds?: string[];
}

/** The proxy as the body gives it to a process: the same environment is the same proxy. */
const proxyKey = (network: HostNetwork | null | undefined): string => JSON.stringify(proxyEnv(network));

export const DEFAULT_CREDENTIAL_REFS = ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"];
export const USAGE_POLL_MS = 10 * 60_000;
/** After a turn ends the agent's usage is pulled once this much later; turns that end inside the wait share the one pull (ms). */
export const USAGE_DEBOUNCE_MS = 5000;
/** How long a worker may take when `spawn` names no limit (seconds). */
export const SPAWN_TIMEOUT_S = 600;
/** How long after the last `typing` the owner is taken to be still typing (ms). */
export const TYPING_MS = 5000;
/** A process that ran at least this long before it died does not count against the three tries. */
export const STABLE_RUN_MS = 60_000;
/**
 * How many crashes in a row (each too soon after the start, with no round finished in between) the module bears before it
 * gives up on an agent. The count starts again from nothing when a process stayed up for STABLE_RUN_MS, or when it
 * finished a round (a turn that ended `completed`): only a process that keeps dying right away adds up.
 */
export const MAX_FAILURES = 3;
/** Dynamic modules are put in again after this many turns even if unchanged. */
export const REINJECT_EVERY = 20;
const BATCH = 20;

interface Lane {
  key: string;
  /** A drain is already scheduled for when the owner stops typing. */
  typingTimer?: boolean;
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
  /** service:reflex looked at the screen before the turn on this lane, so it is asked to put things back when the turn ends. */
  screenPlanned: boolean;
  routing: Set<string>;
}
interface Live {
  id: string;
  driver: AgentDriver;
  state: "starting" | "running" | "failed";
  lanes: Map<string, Lane>;
  startedAt: number;
  /** Crashes in a row so far, this process's start included (see MAX_FAILURES). A completed turn clears it. */
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
  private readonly typingUntil = new Map<string, number>();
  private paused = false;
  private proxy: string;
  private readonly stoppers: (() => void)[] = [];
  /** Agents whose usage pull after a turn is waiting on the debounce, with the way to cancel it. */
  private readonly usageDue = new Map<string, () => void>();
  /** Pulls run one after another: two at once would send the same records twice. */
  private usageQueue: Promise<unknown> = Promise.resolve();
  private readonly timers: Timers;
  readonly now: () => number;
  private readonly log: (...args: unknown[]) => void;

  constructor(readonly deps: AgentsDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
    this.log = deps.log ?? (() => {});
    this.proxy = proxyKey(deps.network);
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
    // From here on the declared agents are members: what the owner says while their processes start waits in the inbox.
    for (const run of this.runs.list()) if (run.desired === "on") this.ensureMember(run.id);
    await this.refreshPaused();
    this.stoppers.push(this.timers.every(USAGE_POLL_MS, () => this.bg(this.pollUsage(), "usage poll")));
    await Promise.allSettled(this.runs.list().filter((run) => run.desired === "on").map((run) => this.startAgent(run.id, "内核重启")));
  }

  async stopAll(): Promise<void> {
    for (const stop of this.stoppers.splice(0)) stop();
    for (const stop of this.usageDue.values()) stop();
    this.usageDue.clear();
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
  stateOf(id: string): "idle" | "working" | "starting" | "stopped" | "error" {
    const live = this.live.get(id);
    if (!live) return "stopped";
    if (live.state === "failed") return "error";
    if (live.state === "starting") return "starting";
    return [...live.lanes.values()].some((l) => l.busy) ? "working" : "idle";
  }
  /**
   * Whether the agent takes messages: it is a member of the registry, and the inbox keeps what comes while its process starts
   * or is started again. Different from `available` (the process is up and can run a turn). False for an agent that is
   * off, was removed, or was given up on.
   */
  reachable(id: string): boolean { const state = this.live.get(id)?.state; return state === "starting" || state === "running"; }
  /** A member of the registry while the agent is meant to be on, process or not. */
  private ensureMember(id: string): void {
    if (!this.deps.registry.get(id)) this.deps.registry.add(this.memberFor(id));
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
    // A member from the moment it is meant to run, not from the moment its process answers: the router files what comes in the
    // inbox, and the drain at the end of this start delivers it. Only a stop or a give-up takes the member out.
    this.ensureMember(id);
    let statics: PromptModule[] = [];
    try {
      statics = await this.modules.static(decl);
      await live.driver.start(id, {
        runtime: decl.runtime, ...(decl.native ? { native: decl.native } : {}), tools: this.deps.tools(id, Object.keys(lanes), decl.tools),
        modules: { static: statics }, lanes: Object.keys(lanes), sessions: run.spec.sessions,
      });
    } catch (error) {
      if (live.stopping) return; // stopped while it was starting: stopAgent has done the rest
      if (this.live.get(id) === live) this.live.delete(id);
      await live.driver.stop(id, "start failed").catch(() => {});
      this.log(`agents: ${id} did not start: ${errorText(error)}`);
      if (failures + 1 >= MAX_FAILURES) return this.giveUp(id, errorText(error), live);
      return this.startAgent(id, why, failures + 1);
    }
    if (live.stopping || this.live.get(id) !== live) return; // stopped while it was starting (stopAgent has stopped the driver)
    live.state = "running";
    live.startedAt = this.now();
    const hash = staticHash(statics);
    this.runs.patch(id, (spec) => { for (const key of Object.keys(lanes)) if (!spec.sessions[key] || !spec.static_hash[key]) spec.static_hash[key] ??= hash; });
    this.deps.started?.(id);
    this.interruptedNotice(id, why);
    await this.syncCredentials(live);
    for (const lane of live.lanes.values()) this.bg(this.drain(live, lane), `drain ${id}/${lane.key}`);
  }

  private giveUp(id: string, reason: string, live: Live): void {
    live.state = "failed";
    live.stopping = true;
    this.live.set(id, live);
    this.deps.revokeTools?.(id);
    this.deps.registry.remove(id);
    this.rejectWaiters(id, new WordError("failed", `${id} could not be started: ${reason}`));
    this.tellOwner(`${id} 起不来了：连着失败了三次（${reason}）。我先停下它，不再自动重试；你可以在设置里让它重启。`);
  }

  async stopAgent(id: string, reason: string, off = false, keepWaiters = false): Promise<void> {
    const live = this.live.get(id);
    if (off) this.runs.setDesired(id, "off");
    this.deps.revokeTools?.(id);
    this.deps.registry.remove(id); // stopped for good (a restart puts it back at once): from now on the router answers offline
    if (!live) return;
    live.stopping = true;
    if (!keepWaiters) this.rejectWaiters(id, new WordError("unavailable", `${id} stopped`));
    this.live.delete(id);
    if (live.state !== "failed") await live.driver.stop(id, reason).catch((error) => this.log(`agents: stopping ${id}: ${errorText(error)}`));
  }

  /**
   * The host's network changed. When the proxy is not the one the agents were started with, the agents that run on the main
   * body are restarted at once, the way a process that ended is: a turn it was in is told as cut off, what waits in the inbox
   * goes to the new process, which answers those who asked and wait. Whoever asked in the turn that was cut is told result_unknown (as after a crash). Temporary workers, agents that are off, and
   * agents on a computer are left as they are.
   */
  onNetwork(network: HostNetwork): void {
    const next = proxyKey(network);
    if (next === this.proxy) return;
    this.proxy = next;
    const local = this.deps.localKinds ?? ["dsh"];
    for (const live of [...this.live.values()]) {
      const run = this.runs.get(live.id);
      if (!run || run.desired !== "on" || run.spec.decl.ephemeral || !local.includes(run.spec.decl.runtime.kind) || live.state !== "running" || live.stopping) continue;
      this.log(`agents: ${live.id}: the proxy changed, restarting its process`);
      this.bg(this.restartAgent(live.id, "代理换了", true), `restart ${live.id} for the new proxy`);
    }
  }

  /** `keepWaiters`: the new process answers those who ask and wait, not the old one's end (a planned restart). */
  async restartAgent(id: string, why = "重启", keepWaiters = false): Promise<void> {
    await this.stopAgent(id, "restart", false, keepWaiters);
    this.runs.setDesired(id, "on");
    await this.startAgent(id, why);
  }

  /** What was in flight when the agent went away is not sent again; the agent hears that it was cut off and decides. */
  private interruptedNotice(id: string, why: string): void {
    const rows = this.inbox.unfinished(id);
    if (!rows.length) return;
    const cut = rows.filter((r) => r.turn);
    this.inbox.mark(rows.filter((r) => !r.turn).map((r) => r.id), "pending");
    this.inbox.mark(cut.map((r) => r.id), "interrupted");
    // Whoever asked in the turn that was cut is told so now: nobody knows whether it was done. What still waits in the inbox is answered by the new process.
    for (const r of cut) this.rejectWaiter(r.id, new WordError("result_unknown", `${id} was restarted in the middle of the turn that took this question (${why}); it is not known whether it was done`));
    if (!cut.length) return;
    const doing = cut.slice(0, 3).map((r) => r.text.replace(/\s+/g, " ").slice(0, 80)).join("；");
    this.enqueue(id, { id: this.newId(), from: SERVICE_CALLER.member, word: "wake", text: `${why}，上一轮中断了（当时在处理：${doing}）。要不要接着做，你自己决定。`, attachments: [], at: this.now() });
  }

  // ----------------------------------------------------------------------------------------------------------------
  // the router's structural rules about turns (SPEC-01 §5.2). The turn in `caller.turn` is the one of the lane the tool
  // token was issued for (or the one the manager itself reported), so a lane is judged by its own turn.
  // ----------------------------------------------------------------------------------------------------------------

  /** A sub-agent (made by another agent) speaks to the owner only in a turn where the owner addressed it directly. The primary agent (even one that `primary.set` made from a sub-agent) and the top-level ones are not held to a turn here. */
  mayTalkToOwner(caller: Caller, _word: string): boolean {
    const run = this.runs.get(caller.member);
    if (!run || run.spec.decl.primary || run.spec.decl.depth === 0) return true;
    if (!caller.turn) return false;
    return this.inbox.byTurn(caller.turn).some((row) => row.agent === caller.member && row.from === OWNER_ID);
  }

  /** `service:agents/answer` is for the turn that took the message. A message that is not this agent's is left to the service to refuse. */
  mayAnswer(caller: Caller, body: unknown): boolean {
    const id = (body as { in_reply_to?: unknown } | null)?.in_reply_to;
    const row = typeof id === "string" ? this.inbox.get(id) : null;
    if (!row || row.agent !== caller.member) return true;
    return row.turn !== undefined && row.turn === caller.turn;
  }

  // ----------------------------------------------------------------------------------------------------------------
  // members
  // ----------------------------------------------------------------------------------------------------------------

  memberFor(id: string): Member {
    const name = this.run(id).spec.decl.name;
    return {
      id, kind: "agent", name,
      // What it hears (say, tell, ask, wake, typing) and what it emits (turn.started, turn.ended, agent.tool): the router lets a sender emit what its own words declare.
      words: () => wordsOf(id),
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
    // Only the owner's `say` is the owner speaking to the agent; their tell and ask are like anyone's.
    const asOwner = from === OWNER_ID && word === "say";
    const category = word === "wake" ? "wake" : asOwner ? OWNER_ID : kind === "event" ? "event" : "";
    const pick = (match: (f: string) => boolean) => Object.entries(lanes).find(([, l]) => l.from?.some(match))?.[0];
    return pick((f) => f === "*" || f === category || (word !== "wake" && from !== OWNER_ID && f === from)) ?? (lanes.back ? "back" : pick((f) => f === "wake")) ?? Object.keys(lanes)[0]!;
  }

  /** A request or event addressed to an agent. */
  async accept(id: string, msg: Message, raw: unknown, signal?: AbortSignal): Promise<{ data: unknown }> {
    if (msg.word === "typing") { this.typingUntil.set(id, this.now() + TYPING_MS); return { data: undefined }; }
    const body = (raw && typeof raw === "object" ? raw : msg.body) as Record<string, any>;
    const decl = this.run(id).spec.decl;
    const attachments = this.storeAttachments(body.attachments);
    let words = text(body.text);
    if (msg.word === "say" && body.in_reply_to) words = `[answers ${body.in_reply_to}, option ${body.option_id}] ${words}`.trim();
    if (msg.word === "wake") words = `Wake · ${text(body.reason)}${body.context === undefined ? "" : `\n${JSON.stringify(body.context)}`}`;
    if (!words && attachments.length) words = "(attachments)";
    const lane = this.laneFor(decl, msg.from, msg.word, msg.kind, msg.word === "wake" ? text(body.lane) : undefined);
    // The owner chose 「重试」 on a failure card: the batch that failed is delivered again, and the click is not a message of its own.
    const retry = msg.word === "say" && typeof body.option_id === "string" && body.option_id.startsWith(`${RETRY_OPTION}:`) ? body.option_id.slice(RETRY_OPTION.length + 1) : null;
    if (retry && this.retryFailed(id, lane, retry)) return { data: { accepted: true } };
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
    if (live && l && live.state === "running" && row.state === "pending" && !this.paused) {
      if (l.busy) this.bg(this.busyRoute(live, l, row), `route ${row.id}`);
      else if (!l.sending) this.bg(this.drain(live, l), `drain ${id}/${key}`);
    }
    return row;
  }

  /** The agent is idle on this lane: give it what is waiting (one batch). */
  async drain(live: Live, lane: Lane): Promise<void> {
    if (live.state !== "running" || lane.busy || lane.sending || this.paused) return;
    const rows = this.inbox.pending(live.id, lane.key, BATCH);
    if (!rows.length) return;
    // The owner is still typing to this agent: a lane that takes their words waits until they have had time to finish.
    const wait = (this.typingUntil.get(live.id) ?? 0) - this.now();
    if (wait > 0 && lanesOf(this.run(live.id).spec.decl)[lane.key]?.from?.includes(OWNER_ID)) {
      if (!lane.typingTimer) {
        lane.typingTimer = true;
        this.timers.after(wait, () => { lane.typingTimer = false; this.bg(this.drain(live, lane), `drain ${live.id}/${lane.key}`); });
      }
      return;
    }
    lane.sending = true;
    let sent = false;
    try {
      if (!(await this.quotaAllows(live, lane))) return;
      if (lane.busy || live.stopping) return;
      await this.inject(live, lane);
      const screen = await this.screenPlan(live, lane, rows);
      if (lane.busy || live.stopping) return;
      this.inbox.mark(rows.map((r) => r.id), "sent");
      try {
        lane.screenPlanned = screen.asked; // before the send: a turn can end before it returns
        if (screen.text) await live.driver.inject(live.id, lane.key, { text: screen.text }).catch((error) => this.log(`agents: screen text for ${live.id}/${lane.key}: ${errorText(error)}`));
        // The lane turns busy when the driver reports `turn.started`, not here: on a remote driver that report
        // (or even `turn.ended`) can arrive before this call returns.
        await live.driver.send(live.id, lane.key, rows.map(toDriverMessage));
        sent = true;
      } catch (error) {
        lane.screenPlanned = false;
        this.inbox.mark(rows.map((r) => r.id), "pending");
        if (!(error instanceof WordError && error.code === "conflict")) throw error; // conflict: the driver is in a turn already
      }
    } finally { lane.sending = false; }
    // What arrived while the batch was being handed over now meets a busy lane.
    if (lane.busy) for (const row of this.inbox.pending(live.id, lane.key)) this.bg(this.busyRoute(live, lane, row), `route ${row.id}`);
    else if (sent) this.bg(this.drain(live, lane), `drain ${live.id}/${lane.key}`); // the turn is over already: what came meanwhile goes next
  }

  /** A message came while the lane is in a turn: the owner's words go to the reflex judgement, the rest queue for the next turn. */
  private async busyRoute(live: Live, lane: Lane, row: InboxRow): Promise<void> {
    if (lane.routing.has(row.id) || this.paused) return;
    lane.routing.add(row.id);
    try {
      let action: "interrupt" | "steer" | "followup" = "followup";
      if (row.from === OWNER_ID) {
        const reply = await this.deps.router.send({ to: "service:reflex", kind: "request", word: "conversation.control", body: { message_id: row.id, agent: live.id, lane: lane.key } }, SERVICE_CALLER);
        const chosen = reply.ok ? (reply.result?.data as { action?: string } | undefined)?.action : undefined;
        if (chosen === "interrupt" || chosen === "steer") action = chosen;
        if (chosen === "pause") { // the switch is the admin service's; the message waits, and the pause interrupts the turn
          const paused = await this.deps.router.send({ to: "service:admin", kind: "request", word: "pause", body: { by: row.id } }, SERVICE_CALLER);
          if (paused.ok) return;
          action = "interrupt"; // admin is not there or refused: at least stop this turn
        }
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

  /**
   * Before a turn the owner started: ask `service:reflex` where the turn's phone-screen work belongs. `text` is what it
   * wants put into the session ahead of the turn; `asked` says reflex answered, so it is also asked to put things back
   * when the turn ends. Offline, refused or failing: nothing, and the turn goes on as if nobody had asked.
   */
  private async screenPlan(live: Live, lane: Lane, rows: InboxRow[]): Promise<{ text: string | null; asked: boolean }> {
    const ids = rows.filter((r) => r.from === OWNER_ID).map((r) => r.id);
    const nothing = { text: null, asked: false };
    if (!ids.length) return nothing;
    try {
      const reply = await this.deps.router.send({ to: "service:reflex", kind: "request", word: "screen.plan", body: { agent: live.id, lane: lane.key, ids } }, SERVICE_CALLER);
      if (!reply.ok) return nothing;
      const data = reply.result?.data as { mode?: string; inject?: unknown } | undefined;
      return { text: data?.mode !== "none" && typeof data?.inject === "string" && data.inject ? data.inject : null, asked: true };
    } catch (error) {
      this.log(`agents: screen.plan ${live.id}/${lane.key}: ${errorText(error)}`);
      return nothing;
    }
  }

  /** The turn is over: reflex puts the screen back if it looked at it before. */
  private async screenReconcile(live: Live, ev: { turn: string; key: string; outcome: string }): Promise<void> {
    const reply = await this.deps.router.send({ to: "service:reflex", kind: "request", word: "screen.reconcile", body: { turn: ev.turn, agent: live.id, lane: ev.key, outcome: ev.outcome } }, SERVICE_CALLER);
    if (!reply.ok && reply.error.code !== "offline") this.log(`agents: screen.reconcile ${ev.turn}: ${reply.error.code}`);
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
    const lane = live.lanes.get(ev.key);
    if (!lane) return; // a lane the declaration does not have
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

  /** Tell the owner in one line what went wrong, and offer a retry card. */
  private failureNotice(agent: string, turn: string, error?: string): void {
    const who = agentCaller(agent, turn);
    this.bg(this.deps.router.send({ to: OWNER_ID, kind: "request", word: "say", body: { text: failureText(error), kind: "reply" } }, who), "failure notice");
    this.bg(this.deps.router.send({ to: OWNER_ID, kind: "request", word: "show", body: { card: { type: "options", prompt: "要我再试一次吗？", options: [{ id: `${RETRY_OPTION}:${turn}`, text: "重试" }] } } }, who), "retry card");
  }

  /** Put the failed batch of that turn (the retry card carries its turn in the option id) back in the inbox. False when there is none. */
  private retryFailed(id: string, lane: string, turn: string): boolean {
    if (!this.inbox.requeue(id, turn)) return false;
    const live = this.live.get(id);
    const l = live?.lanes.get(lane);
    if (live && l && live.state === "running" && !this.paused) this.bg(l.busy ? Promise.resolve() : this.drain(live, l), `retry ${id}/${lane}`);
    return true;
  }

  private speaks(id: string, key: string): boolean {
    const lane: LaneDecl | undefined = lanesOf(this.run(id).spec.decl)[key];
    return lane?.speak ?? !!lane?.from?.includes(OWNER_ID);
  }

  private finishTurn(live: Live, lane: Lane, ev: Extract<AgentEvent, { event: "turn.ended" }>): void {
    if (ev.outcome === "completed") live.failures = 0; // a round done: earlier crashes no longer count
    lane.busy = false;
    lane.turn = undefined;
    const rows = this.inbox.byTurn(ev.turn);
    // A turn that was answering the owner and failed is kept as failed, so 「重试」 can deliver the same batch again.
    const failed = ev.outcome === "error" && this.speaks(live.id, ev.key) && rows.some((r) => r.from === OWNER_ID);
    this.inbox.finish(ev.turn, ev.outcome === "interrupted" ? "interrupted" : failed ? "failed" : "done");
    const said = (this.outputs.get(ev.turn) ?? []).join("\n\n");
    this.outputs.delete(ev.turn);
    for (const row of rows) {
      const waiter = this.waiters.get(row.id);
      if (!waiter) continue;
      this.waiters.delete(row.id);
      if (ev.outcome === "completed") waiter.resolve(said);
      else waiter.reject(new WordError(ev.outcome === "cancelled" ? "cancelled" : "failed", ev.error ?? `the turn ended: ${ev.outcome}`));
    }
    if (failed) this.failureNotice(live.id, ev.turn, ev.error);
    this.usageSoon(live.id);
    this.emit(live.id, "turn.ended", { turn: ev.turn, lane: ev.key, outcome: ev.outcome, ...(ev.error ? { error: ev.error } : {}) }, ev.turn);
    if (lane.screenPlanned) { lane.screenPlanned = false; this.bg(this.screenReconcile(live, ev), "screen reconcile"); }
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
    this.deps.revokeTools?.(id);
    // The member stays: the process is started again at once, and what the owner says in between goes to the inbox.
    this.log(`agents: ${id} ended: ${reason ?? "?"}`);
    // A process that stayed up for a while, or finished a round (`failures` is cleared then), has not been dying "in a row".
    const failures = (this.now() - live.startedAt >= STABLE_RUN_MS ? 0 : live.failures) + 1;
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

  // ----------------------------------------------------------------------------------------------------------------
  // pause (HUB-MODULES §2.5): the admin service holds the switch; here a pause stops turns, not the inbox
  // ----------------------------------------------------------------------------------------------------------------

  /** Read the switch. No admin service, or no answer, means not paused. */
  async refreshPaused(): Promise<void> {
    const reply = await this.deps.router.send({ to: "service:admin", kind: "request", word: "status", body: {} }, SERVICE_CALLER);
    const paused = reply.ok && (reply.result?.data as { paused?: boolean } | undefined)?.paused === true;
    if (paused === this.paused) return;
    this.paused = paused;
    for (const live of this.live.values()) for (const lane of live.lanes.values()) {
      if (paused) { if (lane.busy) this.bg(live.driver.interrupt(live.id, lane.key), "interrupt for pause"); }
      else this.bg(this.drain(live, lane), `drain ${live.id}/${lane.key}`);
    }
  }

  /** After a turn: pull this agent's usage in a few seconds, so the day's count is current without waiting for the ten-minute timer. */
  private usageSoon(id: string): void {
    if (this.usageDue.has(id)) return;
    this.usageDue.set(id, this.timers.after(USAGE_DEBOUNCE_MS, () => { this.usageDue.delete(id); this.bg(this.pollUsage(id), "usage poll"); }));
  }

  /** What the runtimes recorded since last time goes to `service:cost` (every ten minutes for all, and soon after a turn for the one that ran). If it is not there the records are dropped. */
  pollUsage(only?: string): Promise<void> {
    const run = this.usageQueue.then(() => this.pullUsage(only));
    this.usageQueue = run.catch(() => {});
    return run;
  }

  private async pullUsage(only?: string): Promise<void> {
    for (const live of [...this.live.values()]) {
      if (only && live.id !== only) continue;
      if (live.state !== "running" || !live.driver.usage) continue;
      const since = this.run(live.id).spec.usage_since;
      let usage;
      try { usage = await live.driver.usage(live.id, since); } catch (error) { this.log(`agents: usage of ${live.id}: ${errorText(error)}`); continue; }
      let cursor = since;
      for (const r of usage.records as Record<string, any>[]) {
        cursor = Math.max(cursor, Number(r.done ?? r.at ?? 0));
        const reply = await this.deps.router.send({ to: "service:cost", kind: "event", word: "usage.recorded", body: {
          caller: live.id, provider: String(r.provider || "unknown"), model: String(r.model || "unknown"),
          input_tokens: Number(r.input) || 0, output_tokens: Number(r.output) || 0, ...(Number(r.cacheRead) > 0 ? { cache_read_tokens: Number(r.cacheRead) } : {}), ok: r.ok !== false, at: Number(r.at ?? r.done ?? this.now()),
          ...(typeof r.cost === "number" && r.cost >= 0 ? { cost: r.cost } : {}), // no price known: no cost, never a made-up one
        } }, SERVICE_CALLER);
        if (!reply.ok && reply.error.code === "offline") break;
      }
      this.runs.patch(live.id, (spec) => { spec.usage_since = cursor; });
    }
    if (!only) for (const live of this.live.values()) for (const lane of live.lanes.values()) this.bg(this.drain(live, lane), "drain");
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

const newLane = (key: string): Lane => ({ key, busy: false, sending: false, injected: new Map(), turnsSince: 0, reloadPending: false, compactPending: false, quotaNoticed: false, screenPlanned: false, routing: new Set() });

export const staticHash = (modules: PromptModule[]): string =>
  createHash("sha256").update(modules.map((m) => `${m.id}:${m.version}`).join("|")).digest("hex").slice(0, 12);

export type { Live, Lane, Waiter };
