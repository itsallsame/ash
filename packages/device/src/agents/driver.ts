/**
 * The driver of one runtime kind (Codex, Claude Code, WorkBuddy) on this computer: the sdk's `AgentDriver` (SPEC-08),
 * written over the session classes in `codex.ts`, `claude.ts` and `workbuddy.ts`.
 *
 * One runtime process serves one lane (session key) of one agent, so a lane can be reopened, resumed or replaced
 * without touching the others. The hub decides when and what to send; this decides how: it numbers the turns, puts
 * the envelope in front of each message, holds injected content for the next turn (these runtimes cannot take it
 * mid-turn), queues follow-ups behind a running turn, and maps the sessions' events to the contract's events.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentDriver, AgentEvent, AgentStartSpec, AgentState, AgentStatus, DriverMessage, PromptModule, RuntimeInfo, TurnOutcome } from "../../../sdk/src/driver";
import { WordError } from "../../../sdk/src/message";
import { localStamp } from "../../../sdk/src/time";
import { redactText } from "../redact";
import { TOOL_SURFACE, type Kind } from "./info";
import type { AgentEvent as SessionEvent, AgentSession, OpenOptions } from "./types";

/** What the driver adds to the contract for the channel that carries it. */
export interface ComputerDriver extends AgentDriver {
  /** The agents this driver holds and how they are. */
  list(): { agent: string; state: AgentState; detail?: string }[];
  /** The turns running now, so a hub that came back can learn of them. */
  running(agent: string): { key: string; turn: string; ids: string[] }[];
  /** The session handle of every lane. */
  handles(agent: string): Record<string, string>;
  /** Stops every agent; nothing is reported. */
  closeAll(): Promise<void>;
}

export interface DriverDeps {
  kind: Kind;
  /** What the runtime can do now (the model catalog fills in after discovery). */
  info(): RuntimeInfo;
  report(event: AgentEvent): void;
  /** Opens one runtime session (the session class of this kind). */
  open(options: OpenOptions): Promise<AgentSession>;
  /** An Ash tool the runtime called; resolves with the hub's answer. */
  outbound(call: { agent: string; key: string; turn: string; tool: string; args: Record<string, unknown> }): Promise<unknown>;
  /** Where a relative `native.cwd` starts, and the default working directory. */
  workdir: string;
  /** How long `send` waits for the runtime to say the turn started before it returns anyway. */
  startWaitMs?: number;
}

/** A single piece of speech can be this long (one frame holds 4 MiB). */
const OUTPUT_MAX = 1024 * 1024;
const THOUGHT_MAX = 64 * 1024;
const SUMMARY_MAX = 4096;

function clip(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
const errorText = (error: unknown): string => redactText(String((error as { message?: unknown } | null)?.message ?? error)).replace(/\s+/g, " ").slice(0, 300);

/** The runtimes' usage objects differ; take the two numbers the contract has. */
function usageOf(raw: unknown): { input_tokens: number; output_tokens: number } | undefined {
  const find = (o: any, ...keys: string[]): number | undefined => {
    for (const key of keys) if (Number.isFinite(o?.[key])) return o[key];
  };
  for (const level of [raw, (raw as any)?.total, (raw as any)?.last]) {
    const input = find(level, "input_tokens", "inputTokens"), output = find(level, "output_tokens", "outputTokens");
    if (input !== undefined || output !== undefined) return { input_tokens: input ?? 0, output_tokens: output ?? 0 };
  }
}

interface Lane {
  key: string;
  session?: AgentSession;
  handle: string | null;
  /** Bumped whenever the session is replaced: events of an older session are dropped. */
  gen: number;
  turn?: string;
  ids: string[];
  started: boolean;
  onStarted?: () => void;
  queue: DriverMessage[];
  /** Injected content waiting for the next turn. */
  held: string[];
  /** A turn the driver opened itself (compaction): its events are not the agent's. */
  internal?: (outcome: TurnOutcome, error?: string) => void;
}
interface Proc {
  agent: string;
  spec: AgentStartSpec;
  cwd: string;
  model?: string;
  effort?: string;
  system?: string;
  lanes: Map<string, Lane>;
  status: AgentStatus;
  /** A stop was asked for, or the process is being torn down: nothing it does is reported. */
  stopping: boolean;
}

const modulesText = (modules: PromptModule[]): string | undefined => (modules.length ? modules.map((m) => m.content).join("\n\n---\n\n") : undefined);
const envelope = (m: DriverMessage) =>
  `[ash] ${localStamp(m.at)} · ${m.origin?.label ?? m.from} · lane ${m.lane} · ${m.word} · id ${m.id}${m.thread ? ` · thread ${m.thread}` : ""}`;
/** These runtimes take text only: an attachment is named, with the ref that tells the owner's side what it is. */
const render = (held: string[], batch: DriverMessage[]): string => [
  ...held,
  ...batch.map((m) => [envelope(m), m.text, ...(m.attachments ?? []).map((a) => `[attachment name=${JSON.stringify(a.name)} type=${a.mime_type} ref=${a.ref}]`)].join("\n")),
].join("\n\n");

export function createComputerDriver(deps: DriverDeps): ComputerDriver {
  const procs = new Map<string, Proc>();
  const report = deps.report;
  const newTurn = () => `t_${randomBytes(6).toString("base64url")}`;

  const proc = (agent: string): Proc => {
    const p = procs.get(agent);
    if (!p || p.status.state !== "running") throw new WordError("offline", `${agent} is not running`);
    return p;
  };
  const laneOf = (agent: string, key: string): { p: Proc; lane: Lane } => {
    const p = proc(agent);
    const lane = p.lanes.get(key);
    if (!lane) throw new WordError("not_found", `${agent} has no session ${key}`);
    return { p, lane };
  };
  const idle = (lane: Lane) => { if (lane.turn) throw new WordError("conflict", "busy: the session is in a turn"); };

  // -- the sessions' events, as the contract's -----------------------------------------------------------------------

  function onSession(p: Proc, lane: Lane, gen: number, e: SessionEvent): void {
    if (lane.gen !== gen || p.stopping) return;
    const agent = p.agent;
    switch (e.type) {
      case "seed_updated":
        lane.handle = e.seed;
        report({ event: "handle.updated", agent, key: lane.key, handle: e.seed });
        return;
      case "turn_started":
        if (e.turn !== lane.turn || lane.started) return;
        lane.started = true;
        lane.onStarted?.();
        if (!lane.internal) report({ event: "turn.started", agent, key: lane.key, turn: e.turn, ids: lane.ids });
        return;
      case "note": {
        if (e.turn !== lane.turn || lane.internal) return;
        const text = clip(redactText(e.text), e.kind === "text" ? OUTPUT_MAX : THOUGHT_MAX);
        if (!text.trim()) return;
        report({ event: e.kind === "text" ? "output" : "thought", agent, key: lane.key, turn: e.turn, text });
        return;
      }
      case "tool":
        if (e.turn !== lane.turn || lane.internal) return;
        report({ event: "tool", agent, key: lane.key, turn: e.turn, phase: e.phase, name: e.name.slice(0, 200), ...(e.summary ? { summary: clip(redactText(e.summary), SUMMARY_MAX) } : {}) });
        return;
      case "turn_ended":
        if (e.turn === lane.turn) finish(p, lane, e);
        return;
      case "ended":
        die(p, e.reason);
        return;
    }
  }

  function finish(p: Proc, lane: Lane, e: Extract<SessionEvent, { type: "turn_ended" }>): void {
    const turn = lane.turn!;
    const internal = lane.internal;
    lane.turn = undefined; lane.internal = undefined; lane.started = false; lane.onStarted = undefined;
    const outcome: TurnOutcome = e.outcome === "ok" ? "completed" : e.outcome === "interrupted" ? "interrupted" : "error";
    const error = e.error ?? (e.outcome === "unknown" ? "the runtime exited before the turn finished" : e.outcome === "failed" ? "the runtime reported a failed turn" : undefined);
    const usage = usageOf(e.usage);
    if (internal) internal(outcome, error);
    else report({ event: "turn.ended", agent: p.agent, key: lane.key, turn, outcome, ...(error ? { error: clip(redactText(error), SUMMARY_MAX) } : {}), ...(usage ? { usage } : {}) });
    // What was queued behind the turn becomes the next one. After a stop or a crash it waits for the next send.
    if (lane.queue.length && outcome === "completed" && lane.session && !p.stopping) {
      begin(p, lane, lane.queue.splice(0)).catch((err) => report({ event: "error", agent: p.agent, message: `the queued messages were not sent: ${errorText(err)}` }));
    }
  }

  /** The process is gone without being asked: every lane of the agent is over, and the hub starts it again. */
  function die(p: Proc, reason?: string): void {
    if (p.stopping || procs.get(p.agent) !== p) return;
    p.stopping = true;
    p.status = { state: "failed", ...(reason ? { detail: reason } : {}) };
    for (const lane of p.lanes.values()) {
      endTurn(p, lane, "error", "the runtime exited before the turn finished");
      void closeLane(lane);
    }
    report({ event: "ended", agent: p.agent, ...(reason ? { reason } : {}) });
  }

  /** A turn that is cut off (not by its own end) still ends, so the hub does not wait for it. */
  function endTurn(p: Proc, lane: Lane, outcome: TurnOutcome, error?: string): void {
    const turn = lane.turn;
    const internal = lane.internal;
    lane.turn = undefined; lane.internal = undefined; lane.started = false; lane.onStarted = undefined;
    if (!turn) return;
    if (internal) internal(outcome, error);
    else report({ event: "turn.ended", agent: p.agent, key: lane.key, turn, outcome, ...(error ? { error } : {}) });
  }

  // -- turns ---------------------------------------------------------------------------------------------------------

  async function begin(p: Proc, lane: Lane, batch: DriverMessage[], raw?: string): Promise<void> {
    if (!lane.session) {
      await openLane(p, lane, lane.handle ?? undefined).catch((error) => { throw error instanceof WordError ? error : new WordError("failed", `the session could not be reopened: ${errorText(error)}`); });
    }
    const turn = newTurn();
    lane.turn = turn; lane.ids = batch.map((m) => m.id); lane.started = false;
    const started = new Promise<void>((done) => { lane.onStarted = done; });
    const text = raw ?? render(lane.held.splice(0), batch);
    try {
      await lane.session!.send(turn, text);
    } catch (error) {
      if (lane.turn === turn) { lane.turn = undefined; lane.internal = undefined; lane.onStarted = undefined; }
      // A refused or half-accepted turn leaves the session in doubt; it is reopened from its handle on the next send.
      void closeLane(lane);
      throw new WordError("failed", errorText(error));
    }
    if (!lane.started && lane.turn === turn) await Promise.race([started, delay(deps.startWaitMs ?? 5000)]);
  }

  // -- sessions ------------------------------------------------------------------------------------------------------

  async function openLane(p: Proc, lane: Lane, seed?: string): Promise<void> {
    const gen = ++lane.gen;
    const options: OpenOptions = {
      cwd: p.cwd, ...(p.spec.native?.env ? { env: p.spec.native.env } : {}), ...(seed ? { seed } : {}),
      ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}), ...(p.system ? { system: p.system } : {}),
      tools: TOOL_SURFACE,
      onEvent: (e) => onSession(p, lane, gen, e),
      onOutbound: async (call) => {
        if (lane.gen !== gen || lane.turn !== call.turn) throw new Error("turn no longer current");
        return deps.outbound({ agent: p.agent, key: lane.key, turn: call.turn, tool: call.tool, args: call.args });
      },
    };
    const session = await deps.open(options);
    if (lane.gen !== gen || p.stopping) { await session.close().catch(() => {}); throw new WordError("cancelled", `${p.agent} was stopped while its session opened`); }
    lane.session = session;
  }

  async function closeLane(lane: Lane): Promise<void> {
    lane.gen++;
    const session = lane.session;
    lane.session = undefined;
    await session?.close().catch(() => {});
  }

  /** Opens the lane from its handle; if the runtime no longer knows it, a new session takes its place. */
  async function openOrResume(p: Proc, lane: Lane, handle?: string): Promise<void> {
    try { await openLane(p, lane, handle); } catch (error) {
      if (!handle || p.stopping) throw error;
      report({ event: "error", agent: p.agent, message: `session ${lane.key} could not be resumed (${errorText(error)}); a new one is opened` });
      await openLane(p, lane);
    }
  }

  const newLane = (key: string): Lane => ({ key, handle: null, gen: 0, ids: [], started: false, queue: [], held: [] });

  async function boot(agent: string, spec: AgentStartSpec): Promise<void> {
    if (!Array.isArray(spec.lanes) || !spec.lanes.length || spec.lanes.some((k) => typeof k !== "string" || !k)) throw new WordError("bad_request", "spec.lanes must name at least one session");
    const cwd = resolve(deps.workdir, spec.native?.cwd ?? ".");
    mkdirSync(cwd, { recursive: true });
    const p: Proc = {
      agent, spec, cwd, model: spec.runtime.model, effort: spec.runtime.effort, system: modulesText(spec.modules?.static ?? []),
      lanes: new Map(spec.lanes.map((key) => [key, newLane(key)])), status: { state: "starting" }, stopping: false,
    };
    procs.set(agent, p);
    try {
      for (const lane of p.lanes.values()) await openOrResume(p, lane, spec.sessions?.[lane.key]);
    } catch (error) {
      p.stopping = true;
      p.status = { state: "failed", detail: errorText(error) };
      await Promise.all([...p.lanes.values()].map(closeLane));
      throw error instanceof WordError ? error : new WordError("failed", `${agent} did not start: ${errorText(error)}`);
    }
    p.status = { state: "running" };
  }

  async function halt(agent: string): Promise<void> {
    const p = procs.get(agent);
    if (!p) return;
    p.stopping = true;
    procs.delete(agent);
    await Promise.all([...p.lanes.values()].map(closeLane));
  }

  const driver: ComputerDriver = {
    get info() { return deps.info(); },

    async start(agent, spec) {
      if (typeof spec?.runtime?.kind !== "string") throw new WordError("bad_request", "spec.runtime.kind is required");
      const existing = procs.get(agent);
      // Already running: the hub has come back to an agent that kept running. It is attached, not started over.
      if (existing && (existing.status.state === "running" || existing.status.state === "starting")) return;
      if (existing) await halt(agent);
      await boot(agent, spec);
    },
    async stop(agent) { await halt(agent); },
    status(agent) { return procs.get(agent)?.status ?? { state: "exited", detail: "not started" }; },
    async restart(agent, key) {
      const p = procs.get(agent);
      if (!p) throw new WordError("not_found", `${agent} was never started`);
      if (key !== undefined && !p.lanes.has(key)) throw new WordError("not_found", `${agent} has no session ${key}`);
      const dead = p.status.state !== "running";
      if (dead) { p.stopping = false; p.status = { state: "starting" }; }
      try {
        for (const lane of p.lanes.values()) {
          if (key !== undefined && lane.key !== key && !dead) continue;
          endTurn(p, lane, "interrupted", "the session was restarted");
          lane.queue = [];
          await closeLane(lane);
          await openOrResume(p, lane, lane.handle ?? undefined);
        }
      } catch (error) {
        p.stopping = true;
        p.status = { state: "failed", detail: errorText(error) };
        await Promise.all([...p.lanes.values()].map(closeLane));
        throw error instanceof WordError ? error : new WordError("failed", `${agent} did not restart: ${errorText(error)}`);
      }
      p.status = { state: "running" };
    },

    session: {
      get(agent, key) { return procs.get(agent)?.lanes.get(key)?.handle ?? null; },
      async set(agent, key, handle) {
        const { p, lane } = laneOf(agent, key);
        idle(lane);
        await closeLane(lane);
        await openLane(p, lane, handle).catch((error) => { throw error instanceof WordError ? error : new WordError("failed", `session ${key} could not be resumed: ${errorText(error)}`); });
      },
      async "new"(agent, key) {
        const { p, lane } = laneOf(agent, key);
        idle(lane);
        await closeLane(lane);
        lane.handle = null; lane.queue = []; lane.held = [];
        await openLane(p, lane).catch((error) => { throw error instanceof WordError ? error : new WordError("failed", `a new session could not be opened: ${errorText(error)}`); });
        if (!lane.handle) throw new WordError("failed", "the runtime gave no session handle");
        return { handle: lane.handle };
      },
      async reload(agent, key, modules) {
        const { p, lane } = laneOf(agent, key);
        idle(lane);
        p.spec = { ...p.spec, modules };
        p.system = modulesText(modules.static);
        return driver.session["new"](agent, key);
      },
      async compact(agent, key) {
        const { p, lane } = laneOf(agent, key);
        idle(lane);
        if (!lane.session) await openLane(p, lane, lane.handle ?? undefined);
        try {
          if (deps.kind === "codex" && lane.session!.compact) return await lane.session!.compact();
          if (deps.kind === "claude") {
            // Claude Code compacts when it is sent its own `/compact` command as a turn.
            return await new Promise((done, fail) => {
              lane.internal = (outcome, error) => done({ compacted: outcome === "completed", ...(error ? { detail: error } : {}) });
              begin(p, lane, [], "/compact").catch((err) => { lane.internal = undefined; fail(err); });
            });
          }
        } catch (error) {
          throw error instanceof WordError ? error : new WordError("failed", `compaction failed: ${errorText(error)}`);
        }
        throw new WordError("unavailable", `${deps.kind} cannot compact its context`);
      },
    },

    async send(agent, key, batch) {
      const { p, lane } = laneOf(agent, key);
      idle(lane);
      await begin(p, lane, [...lane.queue.splice(0), ...batch]);
    },
    async followup(agent, key, batch) {
      const { p, lane } = laneOf(agent, key);
      if (lane.turn) lane.queue.push(...batch);
      else await begin(p, lane, [...lane.queue.splice(0), ...batch]);
    },
    async steer(agent, key, text) {
      const { lane } = laneOf(agent, key);
      if (!lane.turn || lane.internal || !lane.session) return false;
      try { return await lane.session.steer(lane.turn, text); } catch (error) { throw new WordError("failed", `the words were not taken: ${errorText(error)}`); }
    },
    async inject(agent, key, content) {
      const { lane } = laneOf(agent, key);
      // These runtimes take nothing between turns: it goes in front of the next one.
      lane.held.push(...(content.modules ?? []).map((m) => m.content), ...(content.text ? [content.text] : []));
    },
    async interrupt(agent, key) {
      const { lane } = laneOf(agent, key);
      if (!lane.turn || !lane.session) return;
      try { await lane.session.interrupt(lane.turn); } catch (error) { throw new WordError("failed", `the turn was not interrupted: ${errorText(error)}`); }
    },

    async configure(agent, key, config) {
      const p = proc(agent);
      const lanes = key === undefined ? [...p.lanes.values()] : [laneOf(agent, key).lane];
      if (config && Object.keys(config).length) {
        const bad = Object.keys(config).filter((k) => k !== "model" && k !== "effort");
        if (bad.length) throw new WordError("bad_request", `configure takes model and effort, not ${bad.join(", ")}`);
        for (const k of ["model", "effort"] as const) if (config[k] !== undefined && typeof config[k] !== "string") throw new WordError("bad_request", `${k} must be a string`);
        for (const lane of lanes) idle(lane);
        const model = (config.model as string | undefined) ?? p.model, effort = (config.effort as string | undefined) ?? p.effort;
        const effortChanged = effort !== p.effort;
        p.model = model; p.effort = effort;
        for (const lane of lanes) {
          // Claude Code takes the effort only at launch: the session is reopened from its handle with it.
          if (deps.kind === "claude" && effortChanged) { await closeLane(lane); await openLane(p, lane, lane.handle ?? undefined); }
          else if (lane.session) {
            try { await lane.session.select(model, effort); } catch (error) { throw new WordError("failed", `could not set ${Object.keys(config).join(", ")}: ${errorText(error)}`); }
          }
        }
      }
      return { ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) };
    },
    async plugins() { throw new WordError("unavailable", `${deps.kind} has no plugins to manage`); },

    list() { return [...procs.values()].map((p) => ({ agent: p.agent, state: p.status.state, ...(p.status.detail ? { detail: p.status.detail } : {}) })); },
    running(agent) {
      return [...(procs.get(agent)?.lanes.values() ?? [])].filter((l) => l.turn && !l.internal).map((l) => ({ key: l.key, turn: l.turn!, ids: l.ids }));
    },
    handles(agent) {
      return Object.fromEntries([...(procs.get(agent)?.lanes.values() ?? [])].filter((l) => l.handle).map((l) => [l.key, l.handle!]));
    },
    async closeAll() { await Promise.all([...procs.keys()].map(halt)); },
  };
  return driver;
}
