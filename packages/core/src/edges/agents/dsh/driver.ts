/**
 * The DSH driver (SPEC-08 §2): one DSH process per agent, spoken to in ACP over stdio plus the `_ash/*` extensions of
 * the `dsh-ash-control` plugin. One ACP session per lane. The process is started through the injected `spawn` (the
 * main body's shell); files (the baseline instruction file) are written through the injected `writeFile`.
 *
 * How the contract's operations map (SPEC-08 §2.4):
 *   send / followup   session/prompt (a followup waits in the driver until the turn ends, then becomes the next turn)
 *   steer / inject    _ash/steer, _ash/inject          interrupt  session/cancel
 *   session.new       session/new                      session.reload  baseline file + session/new
 *   session.compact   _ash/compact                     configure  session/set_config_option
 *   session.get/set   session/resume                   plugins    _ash/plugins
 */
import { randomBytes } from "node:crypto";
import { localStamp } from "../../../../../sdk/src/time";
import { WordError } from "../../../../../sdk/src/message";
import {
  ASH_BUSY_CODE, ASH_METHODS, type AgentDriver, type AgentEvent, type AgentStartSpec, type AgentStatus, type DriverMessage, type DriverUsage,
  type PromptModule, type RuntimeInfo,
} from "../../../../../sdk/src/driver";
import { AcpClient, AcpError, type AcpUpdate, type DriverProcess, type SpawnFn } from "./acp";
import { toolSummary } from "./tool-label";

/** `dsh` is a name the main body resolves: its own binary on a development machine, /opt/dsh/... in the container. */
export const DEFAULT_ARGV = ["dsh", "--profile", "acp", "--patch", "/opt/ash/patch.yml"];
const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
/** The file DSH loads from the working directory as the base of every session. */
export const BASELINE_FILE = "AGENTS.md";

export interface DshDriverDeps {
  report(event: AgentEvent): void;
  spawn: SpawnFn;
  /** Write a file on the main body (the baseline instruction file). */
  writeFile(path: string, content: string): Promise<void>;
  /** An attachment's bytes (`ledger.blob.get`); without it attachments are only named in the message. */
  readBlob?(ref: string): { bytes: Uint8Array; mime: string } | null;
  argv?: string[];
  /** The place a body path is for the runtime itself (the session's cwd). Absent: the path as it is (the container). */
  runtimePath?(cwd: string): string;
  /** The owner's time zone (IANA), asked at every message; absent: the zone this process runs in. */
  timeZone?(): string;
  log?(...args: unknown[]): void;
}

export const DSH_INFO: RuntimeInfo = {
  kind: "dsh", version: "0.2",
  models: [{ id: "deepseek-flash", efforts: ["low", "high"] }],
  abilities: { resume: true, steer: true, inject_live: true, images: true, compact: true, configure: ["model", "effort", "*"], plugins: true, mcp: true, system_prompt: "file", credentials: true, usage: true },
};

interface Session {
  key: string;
  /** The ACP session id: the handle the hub stores. */
  id: string;
  running: boolean;
  turn?: string;
  /** Followups waiting for the turn to end. */
  queue: DriverMessage[];
  speech: string;
  speechId?: string;
  /** The open tool calls: ACP call id to the tool's name and the one line the owner sees. */
  tools: Map<string, { name: string; summary: string }>;
  cancelled: boolean;
  options: unknown[];
  /** Modules the runtime could not take mid-session (no `_ash/inject`): they go in front of the next turn. */
  held: PromptModule[];
}
interface Proc {
  client: AcpClient;
  spec: AgentStartSpec;
  cwd: string;
  sessions: Map<string, Session>;
  status: AgentStatus;
  stopping: boolean;
}

const text = (t: string) => ({ type: "text", text: t });
const errorText = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
const dirOf = (cwd: string) => cwd.replace(/\/+$/, "");

export function createDshDriver(deps: DshDriverDeps): AgentDriver {
  const procs = new Map<string, Proc>();
  const bySession = new Map<string, { agent: string; sess: Session }>();
  /** The start in flight for each agent. A stop (or a start over) takes it away: the boot that finds it gone does not go on. */
  const starting = new Map<string, object>();
  const log = deps.log ?? (() => {});
  const report = deps.report;

  const proc = (agent: string): Proc => {
    const p = procs.get(agent);
    if (!p || p.status.state !== "running") throw new WordError("offline", `${agent} is not running`);
    return p;
  };
  const sessionOf = (agent: string, key: string): { p: Proc; sess: Session } => {
    const p = proc(agent);
    const sess = p.sessions.get(key);
    if (!sess) throw new WordError("not_found", `${agent} has no session ${key}`);
    return { p, sess };
  };
  const ask = async <T>(p: Proc, method: string, params: unknown): Promise<T> => {
    try { return await p.client.request<T>(method, params); } catch (error) {
      if (error instanceof AcpError && error.code === ASH_BUSY_CODE) throw new WordError("conflict", "busy: the session is in a turn");
      if (error instanceof AcpError && error.code === -32602) throw new WordError("bad_request", error.message);
      if (error instanceof AcpError && error.code === -32601) throw new WordError("unavailable", `${method} is not offered by this runtime`);
      throw new WordError("failed", errorText(error));
    }
  };

  // -- the message in the agent's words ----------------------------------------------------------------------------

  const envelope = (m: DriverMessage) =>
    `[ash] ${localStamp(m.at, deps.timeZone?.())} · ${m.origin?.label ?? m.from} · lane ${m.lane} · ${m.word} · id ${m.id}${m.thread ? ` · thread ${m.thread}` : ""}`;

  function content(batch: DriverMessage[]): unknown[] {
    const blocks: unknown[] = [];
    for (const m of batch) {
      const notes: string[] = [];
      const images: unknown[] = [];
      for (const a of m.attachments ?? []) {
        const blob = IMAGE.test(a.mime_type) ? deps.readBlob?.(a.ref) : null;
        if (blob) images.push({ type: "image", mimeType: blob.mime, data: Buffer.from(blob.bytes).toString("base64") });
        notes.push(`[attachment name=${JSON.stringify(a.name)} type=${a.mime_type} ref=${a.ref}]`);
      }
      blocks.push(text([envelope(m), m.text, ...notes].join("\n")), ...images);
    }
    return blocks;
  }
  const moduleBlocks = (modules: PromptModule[]) => modules.map((m) => text(m.content));

  // -- turns -------------------------------------------------------------------------------------------------------

  function flush(agent: string, sess: Session): void {
    const said = sess.speech.trim();
    sess.speech = "";
    sess.speechId = undefined;
    if (said && sess.turn) report({ event: "output", agent, key: sess.key, turn: sess.turn, text: said });
  }

  function onUpdate(sessionId: string, update: AcpUpdate): void {
    const hit = bySession.get(sessionId);
    if (!hit || !hit.sess.turn) return;
    const { agent, sess } = hit;
    const turn = sess.turn!;
    const chunk = update.content?.type === "text" ? update.content.text ?? "" : "";
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.messageId && sess.speechId && update.messageId !== sess.speechId) flush(agent, sess);
        sess.speechId = update.messageId ?? sess.speechId;
        sess.speech += chunk;
        return;
      case "agent_thought_chunk":
        flush(agent, sess);
        if (chunk) report({ event: "thought", agent, key: sess.key, turn, text: chunk });
        return;
      case "tool_call": {
        flush(agent, sess);
        const name = String(update.title ?? update.toolCallId ?? "tool");
        const summary = toolSummary(update.title, update.kind, update.rawInput);
        if (update.toolCallId) sess.tools.set(update.toolCallId, { name, summary });
        report({ event: "tool", agent, key: sess.key, turn, phase: "start", name, summary });
        return;
      }
      case "tool_call_update": {
        if (update.status !== "completed" && update.status !== "failed") return;
        const open = update.toolCallId ? sess.tools.get(update.toolCallId) : undefined;
        const name = open?.name ?? String(update.title ?? "tool");
        const summary = open?.summary ?? toolSummary(update.title, update.kind, update.rawInput);
        report({ event: "tool", agent, key: sess.key, turn, phase: "end", name, summary, ok: update.status === "completed" });
        return;
      }
      default:
    }
  }

  function begin(agent: string, p: Proc, sess: Session, batch: DriverMessage[]): void {
    sess.running = true;
    sess.cancelled = false;
    sess.turn = `t_${randomBytes(6).toString("base64url")}`;
    const turn = sess.turn;
    report({ event: "turn.started", agent, key: sess.key, turn, ids: batch.map((m) => m.id) });
    const prompt = [...moduleBlocks(sess.held.splice(0)), ...content(batch)];
    p.client.request<{ stopReason?: string }>("session/prompt", { sessionId: sess.id, prompt }).then(
      (result) => end(agent, p, sess, turn, result?.stopReason === "cancelled" || sess.cancelled ? "cancelled" : "completed"),
      (error) => end(agent, p, sess, turn, "error", errorText(error)),
    );
  }

  function end(agent: string, p: Proc, sess: Session, turn: string, outcome: "completed" | "cancelled" | "error", error?: string): void {
    if (sess.turn !== turn || !p.client.alive) return; // a process that died is `ended`, not a turn that ended
    flush(agent, sess);
    sess.running = false;
    sess.turn = undefined;
    sess.tools.clear();
    report({ event: "turn.ended", agent, key: sess.key, turn, outcome, ...(error ? { error } : {}) });
    // What was queued behind the turn becomes the next turn. After a cancel it waits for the next send instead.
    if (sess.queue.length && outcome !== "cancelled") begin(agent, p, sess, sess.queue.splice(0));
  }

  // -- sessions ----------------------------------------------------------------------------------------------------

  /** The tool surface for one lane's session: that lane's own token, so the hub knows which lane a call comes from. */
  const servers = (spec: AgentStartSpec, key: string) => {
    const token = spec.tools.tokens[key];
    if (!token) throw new Error(`the spec has no tool token for lane ${key}`);
    return [{ type: "http", name: "ash", url: spec.tools.mcp_url, headers: [{ name: "authorization", value: `Bearer ${token}` }] }];
  };

  /** Resume the handle, or open a new session when there is none or the runtime no longer knows it. */
  async function open(agent: string, p: Proc, key: string, handle?: string): Promise<Session> {
    let id: string | undefined;
    let options: unknown[] = [];
    let created = false;
    if (handle) {
      try {
        const resumed = await p.client.request<{ configOptions?: unknown[] }>("session/resume", { sessionId: handle, cwd: deps.runtimePath?.(p.cwd) ?? p.cwd, mcpServers: servers(p.spec, key) });
        id = handle;
        options = resumed?.configOptions ?? [];
      } catch (error) {
        if (!(error instanceof AcpError) || !(error.code === -32601 || /not resumable|does not match|not found|unknown/i.test(error.message))) throw error;
        log(`dsh: session ${key} of ${agent} could not be resumed (${error.message}); a new one is opened`);
      }
    }
    if (!id) {
      const made = await p.client.request<{ sessionId: string; configOptions?: unknown[] }>("session/new", { cwd: deps.runtimePath?.(p.cwd) ?? p.cwd, mcpServers: servers(p.spec, key) });
      if (typeof made?.sessionId !== "string") throw new Error("the runtime gave no session id");
      id = made.sessionId;
      options = made.configOptions ?? [];
      created = true;
    }
    const sess: Session = p.sessions.get(key) ?? { key, id, running: false, queue: [], speech: "", tools: new Map(), cancelled: false, options, held: [] };
    if (sess.id !== id) bySession.delete(sess.id);
    Object.assign(sess, { id, options });
    p.sessions.set(key, sess);
    bySession.set(id, { agent, sess });
    report({ event: "handle.updated", agent, key, handle: id });
    if (created) await applyRuntime(agent, p, sess);
    return sess;
  }

  /** The declaration's model and effort go onto a new session. DSH's `dsh-ash-control` plugin writes the choice into the session log when the set succeeds, so it outlives a restart that comes before the first turn. */
  async function applyRuntime(agent: string, p: Proc, sess: Session): Promise<void> {
    const { model, effort } = p.spec.runtime;
    const wanted: Record<string, unknown> = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    if (!Object.keys(wanted).length) return;
    await configureSession(p, sess, wanted).catch((error) => report({ event: "error", agent, message: `could not set ${Object.keys(wanted).join(", ")}: ${errorText(error)}` }));
  }

  /** The model option's value is a JSON [provider, model] pair; a bare model name is looked up among the offered values (DSH offers them in provider groups). */
  function optionValue(sess: Session, id: string, value: unknown): string {
    const wanted = String(value);
    if (id !== "model" || wanted.startsWith("[")) return wanted;
    type Offer = { value?: string; options?: Offer[] };
    const flat = (offers: Offer[] = []): Offer[] => offers.flatMap((o) => (o.options ? flat(o.options) : [o]));
    const option = (sess.options as { id?: string; options?: Offer[] }[]).find((o) => o.id === "model");
    const hit = flat(option?.options).find((o) => { try { const pair = JSON.parse(String(o.value)); return Array.isArray(pair) && pair[1] === wanted; } catch { return o.value === wanted; } });
    return hit?.value ?? wanted;
  }

  /** Ash's names for a setting, and the id DSH calls it by. */
  const DSH_CONFIG_ID: Record<string, string> = { effort: "reasoning_effort" };

  async function configureSession(p: Proc, sess: Session, config: Record<string, unknown>): Promise<void> {
    for (const [id, value] of Object.entries(config)) {
      const answer = await ask<{ configOptions?: unknown[] }>(p, "session/set_config_option", { sessionId: sess.id, configId: DSH_CONFIG_ID[id] ?? id, value: optionValue(sess, id, value) });
      if (answer?.configOptions) sess.options = answer.configOptions;
    }
  }

  // -- process -----------------------------------------------------------------------------------------------------

  const cancelled = (agent: string) => new WordError("cancelled", `${agent} was stopped while it started`);

  async function boot(agent: string, spec: AgentStartSpec): Promise<void> {
    const ticket = {};
    starting.set(agent, ticket);
    try { await run(agent, spec, ticket); } finally { if (starting.get(agent) === ticket) starting.delete(agent); }
  }

  async function run(agent: string, spec: AgentStartSpec, ticket: object): Promise<void> {
    const cwd = spec.native?.cwd ?? `/root/agents/${agent.slice("agent:".length)}`;
    if (spec.modules.static.length) await deps.writeFile(`${dirOf(cwd)}/${BASELINE_FILE}`, spec.modules.static.map((m) => m.content).join("\n\n---\n\n") + "\n");
    if (starting.get(agent) !== ticket) throw cancelled(agent); // stopped while the file was being written: no process
    const child: DriverProcess = deps.spawn(deps.argv ?? DEFAULT_ARGV, { ...(spec.native?.env ? { env: spec.native.env } : {}), cwd });
    const client = new AcpClient(child, log);
    const p: Proc = { client, spec, cwd, sessions: new Map(), status: { state: "starting" }, stopping: false };
    procs.set(agent, p);
    client.onUpdate(onUpdate);
    client.onExit((reason) => {
      p.status = { state: p.stopping ? "exited" : "failed", detail: reason };
      for (const sess of p.sessions.values()) { sess.running = false; sess.turn = undefined; sess.queue = []; bySession.delete(sess.id); }
      if (!p.stopping && procs.get(agent) === p) report({ event: "ended", agent, reason });
    });
    try {
      await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "ash", version: "4" } });
      for (const key of spec.lanes) await open(agent, p, key, spec.sessions[key]);
      if (starting.get(agent) !== ticket) throw cancelled(agent);
    } catch (error) {
      p.stopping = true;
      p.status = { state: "failed", detail: errorText(error) };
      client.close();
      throw new WordError("failed", `${agent} did not start: ${errorText(error)}`);
    }
    p.status = { state: "running" };
  }

  async function halt(agent: string): Promise<void> {
    starting.delete(agent); // a start still in flight is void: it stops where it is, or its process is the one closed below
    const p = procs.get(agent);
    if (!p) return;
    p.stopping = true;
    procs.delete(agent);
    for (const sess of p.sessions.values()) bySession.delete(sess.id);
    if (!p.client.alive) return;
    const gone = new Promise<void>((resolve) => { p.client.onExit(() => resolve()); setTimeout(resolve, 5000).unref(); });
    p.client.close();
    await gone;
  }

  const driver: AgentDriver = {
    info: DSH_INFO,

    async start(agent, spec) {
      if (procs.get(agent)?.client.alive) return;
      await boot(agent, spec);
    },
    async stop(agent) { await halt(agent); },
    status(agent) { return procs.get(agent)?.status ?? { state: "exited", detail: "not started" }; },
    async restart(agent) {
      const p = procs.get(agent);
      if (!p) throw new WordError("not_found", `${agent} was never started`);
      const sessions = Object.fromEntries([...p.sessions].map(([key, s]) => [key, s.id]));
      await halt(agent);
      await boot(agent, { ...p.spec, sessions });
    },

    session: {
      get(agent, key) { return procs.get(agent)?.sessions.get(key)?.id ?? null; },
      async set(agent, key, handle) {
        const p = proc(agent);
        if (p.sessions.get(key)?.running) throw new WordError("conflict", "busy: the session is in a turn");
        await open(agent, p, key, handle);
      },
      async new(agent, key) {
        const { p, sess } = sessionOf(agent, key);
        if (sess.running) throw new WordError("conflict", "busy: the session is in a turn");
        return { handle: (await open(agent, p, key)).id };
      },
      async reload(agent, key, modules) {
        const { p, sess } = sessionOf(agent, key);
        if (sess.running) throw new WordError("conflict", "busy: the session is in a turn");
        if (modules.static.length) await deps.writeFile(`${dirOf(p.cwd)}/${BASELINE_FILE}`, modules.static.map((m) => m.content).join("\n\n---\n\n") + "\n");
        p.spec = { ...p.spec, modules };
        return { handle: (await open(agent, p, key)).id };
      },
      async compact(agent, key) {
        const { p, sess } = sessionOf(agent, key);
        if (sess.running) throw new WordError("conflict", "busy: the session is in a turn");
        const out = await ask<{ compacted?: boolean; detail?: string }>(p, ASH_METHODS.compact, { sessionId: sess.id });
        return { compacted: out?.compacted === true, ...(out?.detail ? { detail: out.detail } : {}) };
      },
    },

    async send(agent, key, batch) {
      const { p, sess } = sessionOf(agent, key);
      if (sess.running) throw new WordError("conflict", "busy: the session is in a turn");
      begin(agent, p, sess, [...sess.queue.splice(0), ...batch]);
    },
    async followup(agent, key, batch) {
      const { p, sess } = sessionOf(agent, key);
      if (sess.running) sess.queue.push(...batch);
      else begin(agent, p, sess, [...sess.queue.splice(0), ...batch]);
    },
    async steer(agent, key, words) {
      const { p, sess } = sessionOf(agent, key);
      if (!sess.running) return false;
      // A runtime without `_ash/steer` cannot take words mid-turn: false, and the hub queues them for the next turn.
      const out = await ask<{ steered?: boolean }>(p, ASH_METHODS.steer, { sessionId: sess.id, content: [text(words)] }).catch((e) => { if (e instanceof WordError && e.code === "unavailable") return null; throw e; });
      return out?.steered === true;
    },
    async inject(agent, key, what) {
      const { p, sess } = sessionOf(agent, key);
      const blocks = [...moduleBlocks(what.modules ?? []), ...(what.text ? [text(what.text)] : [])];
      if (!blocks.length) return;
      // A runtime without `_ash/inject` gets it in front of the next turn instead.
      await ask(p, ASH_METHODS.inject, { sessionId: sess.id, content: blocks }).catch((e) => {
        if (!(e instanceof WordError && e.code === "unavailable")) throw e;
        sess.held.push(...(what.modules ?? []), ...(what.text ? [{ id: "lane" as const, version: "text", content: what.text }] : []));
      });
    },
    async interrupt(agent, key) {
      const { p, sess } = sessionOf(agent, key);
      if (!sess.running) return;
      sess.cancelled = true;
      p.client.notify("session/cancel", { sessionId: sess.id });
    },

    async configure(agent, key, config) {
      const p = proc(agent);
      const targets = key ? [sessionOf(agent, key).sess] : [...p.sessions.values()];
      if (config && Object.keys(config).length) for (const sess of targets) await configureSession(p, sess, config);
      const first = targets[0];
      const out: Record<string, unknown> = {};
      for (const o of (first?.options ?? []) as { id?: string; currentValue?: unknown }[]) if (o.id) out[o.id] = o.currentValue;
      if ("reasoning_effort" in out) out["effort"] = out["reasoning_effort"];
      return out;
    },
    async plugins(agent, op, name) {
      return (await ask<Record<string, unknown>>(proc(agent), ASH_METHODS.plugins, { op, ...(name ? { name } : {}) })) ?? {};
    },

    async credentialsHas(agent, ref) {
      return (await ask<{ has?: boolean }>(proc(agent), ASH_METHODS.credentialsHas, { ref }))?.has === true;
    },
    async credentialsSet(agent, ref, value) {
      await ask(proc(agent), ASH_METHODS.credentialsSet, { ref, value });
    },
    async usage(agent, since): Promise<DriverUsage> {
      const out = await ask<{ records?: unknown[]; balance?: unknown }>(proc(agent), ASH_METHODS.usage, { since });
      return { records: out?.records ?? [], ...(out?.balance ? { balance: out.balance } : {}) };
    },
  };
  return driver;
}
