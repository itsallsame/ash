/**
 * The pi driver (SPEC-08 §2): pi (https://github.com/earendil-works/pi) as an agent runtime next to DSH. pi is spoken to in its
 * RPC mode (JSON lines on stdin/stdout, see `rpc.ts`). Everything pi-specific is in this folder; the agents module sees an
 * ordinary `AgentDriver`.
 *
 * Processes are held per turn, not per agent. A pi process has one session, and an agent has several lanes, so keeping one
 * process per lane would be a hundred and thirty megabytes each, for lanes that are idle nearly all the time:
 *   - the `front` lane (the owner's conversation) has a slot of its own: the process of the session being talked in, kept warm
 *     for `hotMs` after a turn and then ended;
 *   - every other lane of every agent shares one slot, a turn at a time, in the order they came. A new turn on a different
 *     session ends the process and starts one on that session (`--session-id` picks the session up again from its file); the
 *     same session twice in a row reuses the warm process.
 * So there are at most two pi processes, and none while nothing is going on. `start` starts nothing: it records the
 * agent's lanes, tokens and modules. A process that dies fails the turn it was in (`turn.ended` with `error`), never the agent
 * (no `ended`, which would make the agents module restart the whole agent).
 *
 * The way to the model is chosen when a process is taken (`route.ts`): v2rayA's proxy if it answers, else straight out (the phone's
 * VPN is on), else nothing, and then this turn goes to DeepSeek, which is always direct. A network error in a turn is checked the
 * same way and, when the way is really shut, the session goes on with DeepSeek (`set_model`: the history stays) and the owner is told;
 * while it is on DeepSeek the way is tried again every minute, and the session goes back when it is open. Codex's login is a
 * `configure` of the driver (see `configure`).
 *
 * How the contract's operations map:
 *   send / followup   prompt (a followup waits in the driver until the turn ends)   steer      steer
 *   interrupt         abort                                                         compact    compact (on the lane's slot, briefly)
 *   session.new       a new session id (--session-id)                              configure  set_model, set_thinking_level; login; read-back
 */
import { randomBytes } from "node:crypto";
import { localStamp } from "../../../../../sdk/src/time";
import { WordError } from "../../../../../sdk/src/message";
import type { AgentDriver, AgentEvent, AgentStartSpec, AgentStatus, DriverMessage, PromptModule, RuntimeInfo } from "../../../../../sdk/src/driver";
import type { DriverProcess, SpawnFn } from "../dsh/acp";
import { toolSummary } from "../dsh/tool-label";
import { PiRpc, type PiRecord } from "./rpc";
import { AUTH_ERROR, DEFAULT_PROXY_URL, NETWORK_ERROR, chooseRoute, probeDirect, probeProxy, type Route } from "./route";
import type { ProxyService } from "./v2raya";

/** `pi` is a name the main body resolves: /opt/pi/... in the container, the machine's own pi in development. */
export const PI_ARGV = ["pi", "--mode", "rpc", "--no-approve"];
/** Ash's helper for Codex's login (`packages/pi-login`), as the container carries it. */
export const LOGIN_ARGV = ["node", "/opt/ash/pi-login/index.mjs"];
export const BASELINE_FILE = "AGENTS.md";
/** The model of a fresh pi agent, and where a Codex model goes when the way to it is shut. */
export const DEFAULT_MODEL = "deepseek/deepseek-flash";
export const CODEX_PROVIDER = "openai-codex";
/** Providers that are reached directly, from anywhere the phone is. */
const DIRECT_PROVIDERS = new Set(["deepseek"]);
const DIRECT_HOSTS = "api.deepseek.com,.deepseek.com";
const LOOPBACK = "127.0.0.1,localhost,::1";
const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const KEY_ENV: Record<string, string> = { DEEPSEEK_API_KEY: "DEEPSEEK_API_KEY", OPENROUTER_API_KEY: "OPENROUTER_API_KEY" };

export const PI_INFO: RuntimeInfo = {
  kind: "pi", version: "1",
  models: [{ id: "deepseek/deepseek-flash" }, { id: "deepseek/deepseek-v4-pro" }, { id: "openai-codex/gpt-5.5" }, { id: "openai-codex/gpt-6-sol" }],
  abilities: { resume: true, steer: true, inject_live: false, images: true, compact: true, configure: ["model", "effort", "login", "*"], plugins: false, mcp: true, system_prompt: "file", credentials: true, usage: false },
};

export interface PiDriverDeps {
  report(event: AgentEvent): void;
  spawn: SpawnFn;
  /** Write a file on the main body (the baseline instruction file, pi's MCP configuration). */
  writeFile(path: string, content: string): Promise<void>;
  readBlob?(ref: string): { bytes: Uint8Array; mime: string } | null;
  argv?: string[];
  loginArgv?: string[];
  /** The place a body path is for the runtime itself. Absent: the path as it is (the container). */
  runtimePath?(cwd: string): string;
  timeZone?(): string;
  log?(...args: unknown[]): void;
  /** v2rayA's HTTP proxy. */
  proxyUrl?: string;
  /** The proxy service to start with the first agent (v2rayA). */
  proxyService?: ProxyService;
  /** Is this way open? (tests give their own; the default knocks on the proxy and on OpenAI's host). */
  probe?(route: "proxy" | "direct"): Promise<boolean>;
  /** The model a shut way falls back to. */
  fallbackModel?: string;
  /** How long a process stays warm after its turn. */
  hotMs?: number;
  /** How often a shut way is tried again while the session is on the fallback. */
  recoverMs?: number;
  /** How long a probe's answer is trusted. */
  routeTtlMs?: number;
}

type Fallback = { reason: "network" | "login" };
interface Lane { key: string; session: string; turn?: Turn; followups: DriverMessage[]; held: string[] }
interface Agent {
  id: string; spec: AgentStartSpec; cwd: string; lanes: Map<string, Lane>;
  /** The model the declaration or `configure` asked for: `provider/id`. */
  model: string; effort?: string; fallback: Fallback | null; recover?: NodeJS.Timeout;
}
interface Turn {
  id: string; ag: Agent; lane: Lane; batch: DriverMessage[]; state: "queued" | "running"; cancelled: boolean; dropped: boolean;
  /** A piece of work on the slot that is not a turn (compact): it reports nothing. */
  job?: (proc: Proc) => Promise<unknown>; done?: { resolve(v: unknown): void; reject(e: unknown): void };
  proc?: Proc;
}
interface Proc { rpc: PiRpc; agentId: string; laneKey: string; session: string; route: Route; model: string; effort?: string; busy: boolean; hot?: NodeJS.Timeout }
interface Slot { name: "front" | "shared"; queue: Turn[]; current?: Turn; proc?: Proc }

const errorText = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
const dirOf = (cwd: string) => cwd.replace(/\/+$/, "");
const sessionId = () => `s_${randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`;

/** `provider/id`, or a bare id: deepseek-* is DeepSeek, anything else Codex. */
export function normalizeModel(model?: string): string {
  const m = (model ?? "").trim();
  if (!m) return DEFAULT_MODEL;
  if (m.includes("/")) return m;
  return /^deepseek/i.test(m) ? `deepseek/${m}` : `${CODEX_PROVIDER}/${m}`;
}
const split = (model: string): { provider: string; id: string } => { const i = model.indexOf("/"); return { provider: model.slice(0, i), id: model.slice(i + 1) }; };
const needsRoute = (model: string): boolean => !DIRECT_PROVIDERS.has(split(model).provider);

export function createPiDriver(deps: PiDriverDeps): AgentDriver {
  const log = deps.log ?? (() => {});
  const report = deps.report;
  const argv = deps.argv ?? PI_ARGV;
  const loginArgv = deps.loginArgv ?? LOGIN_ARGV;
  const proxyUrl = deps.proxyUrl ?? DEFAULT_PROXY_URL;
  const fallbackModel = normalizeModel(deps.fallbackModel ?? DEFAULT_MODEL);
  const hotMs = deps.hotMs ?? 60_000;
  const recoverMs = deps.recoverMs ?? 60_000;
  const routeTtlMs = deps.routeTtlMs ?? 15_000;
  const probe = deps.probe ?? ((route: "proxy" | "direct") => (route === "proxy" ? probeProxy(proxyUrl) : probeDirect()));
  const runtimeDir = () => deps.runtimePath?.("/root/.pi/agent") ?? "/root/.pi/agent";

  const agents = new Map<string, Agent>();
  const slots: Record<"front" | "shared", Slot> = { front: { name: "front", queue: [] }, shared: { name: "shared", queue: [] } };
  /** The keys the hub gave (by name): they go to a process through its environment and are never written to a file. */
  const keys = new Map<string, string>();
  let routeCache: { at: number; route: Route } | null = null;
  let routeProbe: Promise<Route> | null = null;
  const login: { state: "none" | "pending" | "ready" | "unknown"; info?: Record<string, unknown>; child?: DriverProcess } = { state: "unknown" };

  // -- the way to the model ----------------------------------------------------------------------------------------

  /** Which way is open now. Probes are shared and trusted for a short while; `fresh` asks again. */
  function routeNow(fresh = false): Promise<Route> {
    if (!fresh && routeCache && Date.now() - routeCache.at < routeTtlMs) return Promise.resolve(routeCache.route);
    if (!routeProbe) {
      routeProbe = chooseRoute(probe).then((route) => { routeCache = { at: Date.now(), route }; return route; }).finally(() => { routeProbe = null; });
    }
    return routeProbe;
  }

  function notice(ag: Agent, words: string, key?: string): void { report({ event: "notice", agent: ag.id, ...(key ? { key } : {}), text: words }); }

  function enterFallback(ag: Agent, reason: Fallback["reason"]): void {
    if (ag.fallback?.reason === reason) return;
    ag.fallback = { reason };
    if (reason === "network") {
      notice(ag, `连不上 ${split(ag.model).provider === CODEX_PROVIDER ? "Codex" : "模型服务"}（代理或网络不通），先用 DeepSeek 接着做；通了会自动切回来。`);
      watchRecovery(ag);
    } else {
      notice(ag, "Codex 还没登录，或登录已失效，先用 DeepSeek 接着做。要用 Codex 的话，让我帮你登录。");
    }
  }

  function leaveFallback(ag: Agent, words: string): void {
    if (!ag.fallback) return;
    ag.fallback = null;
    if (ag.recover) { clearInterval(ag.recover); ag.recover = undefined; }
    notice(ag, words);
  }

  /** While the session is on the fallback because the way was shut, try the way again every `recoverMs`. */
  function watchRecovery(ag: Agent): void {
    if (ag.recover) return;
    ag.recover = setInterval(() => {
      if (ag.fallback?.reason !== "network") { if (ag.recover) { clearInterval(ag.recover); ag.recover = undefined; } return; }
      routeNow(true).then((route) => { if (route !== "none") leaveFallback(ag, "Codex 又连上了，已切回。"); }).catch(() => {});
    }, recoverMs);
    ag.recover.unref();
  }

  /** The model this agent's next turn runs on, and the way to it. */
  async function plan(ag: Agent): Promise<{ model: string; route: Route }> {
    let model = ag.model;
    let route: Route = "none";
    if (needsRoute(model)) {
      route = await routeNow();
      if (route === "none") enterFallback(ag, "network");
      else if (ag.fallback?.reason === "network") leaveFallback(ag, "Codex 又连上了，已切回。");
      if (ag.fallback) model = fallbackModel;
    }
    if (ag.fallback && !needsRoute(model)) route = "none";
    return { model, route };
  }

  // -- processes ---------------------------------------------------------------------------------------------------

  function envFor(ag: Agent, laneKey: string, route: Route): Record<string, string> {
    const env: Record<string, string> = {
      ...(ag.spec.native?.env ?? {}),
      PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: runtimeDir(),
      ASH_TOKEN: ag.spec.tools.tokens[laneKey] ?? "",
      NO_PROXY: `${LOOPBACK},${DIRECT_HOSTS}`, no_proxy: `${LOOPBACK},${DIRECT_HOSTS}`,
    };
    // Set in every case: what the hub puts in for the phone's own proxy must not reach pi.
    const proxy = route === "proxy" ? proxyUrl : "";
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) env[k] = proxy;
    for (const [ref, name] of Object.entries(KEY_ENV)) { const v = keys.get(ref); if (v) env[name] = v; }
    return env;
  }

  async function closeProc(slot: Slot): Promise<void> {
    const p = slot.proc;
    if (!p) return;
    slot.proc = undefined;
    if (p.hot) clearTimeout(p.hot);
    if (!p.rpc.alive) return;
    const gone = new Promise<void>((resolve) => { p.rpc.onExit(() => resolve()); setTimeout(resolve, 5000).unref(); });
    p.rpc.close();
    await gone;
  }

  async function spawnProc(slot: Slot, ag: Agent, lane: Lane, route: Route, model: string): Promise<Proc> {
    const { provider, id } = split(model);
    const args = [...argv, "--session-id", lane.session, "--provider", provider, "--model", id];
    const child = deps.spawn(args, { env: envFor(ag, lane.key, route), cwd: ag.cwd });
    const rpc = new PiRpc(child, log);
    const p: Proc = { rpc, agentId: ag.id, laneKey: lane.key, session: lane.session, route, model, busy: false };
    slot.proc = p;
    rpc.onExit((reason) => {
      if (slot.proc === p) { slot.proc = undefined; if (p.hot) clearTimeout(p.hot); }
      if (!p.busy) log(`pi: ${ag.id}/${lane.key}: process ended (${reason})`);
    });
    try {
      await rpc.request({ type: "get_state" }, 90_000);
      if (ag.effort) await rpc.request({ type: "set_thinking_level", level: ag.effort }).then(() => { p.effort = ag.effort; }).catch((e) => log(`pi: effort ${ag.effort}: ${errorText(e)}`));
    } catch (error) {
      rpc.close();
      if (slot.proc === p) slot.proc = undefined;
      throw new WordError("failed", `pi did not start: ${errorText(error)}`);
    }
    return p;
  }

  /** The process for this turn: the warm one when it is the same session and way, else a new one. */
  async function acquire(slot: Slot, t: Turn): Promise<Proc> {
    const { ag, lane } = t;
    const { model, route } = await plan(ag);
    let p = slot.proc;
    const reusable = p && p.rpc.alive && !p.busy && p.agentId === ag.id && p.laneKey === lane.key && p.session === lane.session && p.route === route;
    if (reusable) { clearTimeout(p!.hot); }
    else { await closeProc(slot); p = await spawnProc(slot, ag, lane, route, model); }
    p = p!;
    p.busy = true;
    try {
      if (p.model !== model) await switchModel(p, model);
      if (ag.effort && p.effort !== ag.effort) await p.rpc.request({ type: "set_thinking_level", level: ag.effort }).then(() => { p.effort = ag.effort; }).catch(() => {});
    } catch (error) { p.busy = false; throw error; }
    return p;
  }

  async function switchModel(p: Proc, model: string): Promise<void> {
    const { provider, id } = split(model);
    await p.rpc.request({ type: "set_model", provider, modelId: id });
    p.model = model;
  }

  function release(slot: Slot, p: Proc): void {
    p.busy = false;
    if (!p.rpc.alive || slot.proc !== p) return;
    p.hot = setTimeout(() => { if (slot.proc === p && !p.busy) closeProc(slot).catch(() => {}); }, hotMs);
    p.hot.unref();
  }

  // -- turns -------------------------------------------------------------------------------------------------------

  const envelope = (m: DriverMessage) =>
    `[ash] ${localStamp(m.at, deps.timeZone?.())} · ${m.origin?.label ?? m.from} · lane ${m.lane} · ${m.word} · id ${m.id}${m.thread ? ` · thread ${m.thread}` : ""}`;

  function promptOf(lane: Lane, batch: DriverMessage[]): { message: string; images: unknown[] } {
    const parts: string[] = lane.held.splice(0);
    const images: unknown[] = [];
    for (const m of batch) {
      const notes: string[] = [];
      for (const a of m.attachments ?? []) {
        const blob = IMAGE.test(a.mime_type) ? deps.readBlob?.(a.ref) : null;
        if (blob) images.push({ type: "image", data: Buffer.from(blob.bytes).toString("base64"), mimeType: blob.mime });
        notes.push(`[attachment name=${JSON.stringify(a.name)} type=${a.mime_type} ref=${a.ref}]`);
      }
      parts.push([envelope(m), m.text, ...notes].join("\n"));
    }
    return { message: parts.join("\n\n"), images };
  }

  function enqueue(t: Turn): void {
    const slot = t.lane.key === "front" ? slots.front : slots.shared;
    t.lane.turn = t;
    slot.queue.push(t);
    pump(slot);
  }

  function pump(slot: Slot): void {
    if (slot.current) return;
    const t = slot.queue.shift();
    if (!t) return;
    slot.current = t;
    runTurn(slot, t).catch((e) => log(`pi: turn ${t.id}: ${errorText(e)}`)).finally(() => { slot.current = undefined; pump(slot); });
  }

  const alive = (t: Turn) => !t.dropped && agents.get(t.ag.id) === t.ag;

  async function runTurn(slot: Slot, t: Turn): Promise<void> {
    const { ag, lane } = t;
    if (!alive(t)) { finishLane(t); t.done?.reject(new WordError("offline", `${ag.id} was stopped`)); return; }
    t.state = "running";
    if (t.job) {
      let p: Proc | undefined;
      try { p = await acquire(slot, t); t.proc = p; t.done?.resolve(await t.job(p)); }
      catch (error) { t.done?.reject(error instanceof WordError ? error : new WordError("failed", errorText(error))); }
      finally { if (p) release(slot, p); finishLane(t); }
      return;
    }
    report({ event: "turn.started", agent: ag.id, key: lane.key, turn: t.id, ids: t.batch.map((m) => m.id) });
    let outcome: "completed" | "cancelled" | "error" = "completed";
    let error: string | undefined;
    let p: Proc | undefined;
    try {
      if (t.cancelled) outcome = "cancelled";
      else {
        p = await acquire(slot, t);
        t.proc = p;
        if (t.cancelled) outcome = "cancelled";
        else {
          const result = await drive(slot, t, p);
          outcome = result.outcome;
          error = result.error;
        }
      }
    } catch (e) {
      outcome = "error";
      error = errorText(e);
    } finally {
      if (p) release(slot, p);
    }
    const next = lane.followups.splice(0);
    finishLane(t);
    if (!alive(t)) return; // the agent was stopped: the agents module cuts the turn itself
    report({ event: "turn.ended", agent: ag.id, key: lane.key, turn: t.id, outcome, ...(error ? { error } : {}) });
    if (next.length && outcome !== "cancelled") enqueue(newTurn(ag, lane, next));
  }

  function finishLane(t: Turn): void { if (t.lane.turn === t) t.lane.turn = undefined; }

  /** One prompt, to its settling. A network error that is real (the way is shut) is answered by a switch to the fallback and one more try. */
  async function drive(slot: Slot, t: Turn, p: Proc): Promise<{ outcome: "completed" | "cancelled" | "error"; error?: string }> {
    const { ag, lane } = t;
    let { message, images } = promptOf(lane, t.batch);
    let switched = false;
    for (;;) {
      const run = await promptOnce(t, p, message, images);
      if (run.outcome !== "error" || switched || !alive(t)) return run;
      // Which kind of failure was it? Only a Codex model's own trouble is answered with a switch.
      const reason = run.error ?? "";
      const model = p.model;
      if (!needsRoute(model) || model === fallbackModel) return run;
      const login = AUTH_ERROR.test(reason);
      const net = !login && NETWORK_ERROR.test(reason);
      if (!login && !net) return run;
      if (net && (await routeNow(true)) !== "none") return run; // the way is open: this was something else
      enterFallback(ag, login ? "login" : "network");
      try { await switchModel(p, fallbackModel); } catch (e) { return { outcome: "error", error: errorText(e) }; }
      switched = true;
      message = `[ash] The model you were using could not be reached, so this session now runs on ${fallbackModel}. Carry on with the message above where it stopped.`;
      images = [];
    }
  }

  async function promptOnce(t: Turn, p: Proc, message: string, images: unknown[]): Promise<{ outcome: "completed" | "cancelled" | "error"; error?: string }> {
    const { ag, lane } = t;
    const key = lane.key;
    const open = new Map<string, { name: string; summary: string }>();
    let lastError: string | undefined;
    let aborted = false;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    let died: string | undefined;
    const offExit = p.rpc.onExit((reason) => { died = reason; settle(); });
    const off = p.rpc.onEvent((ev: PiRecord) => {
      switch (ev.type) {
        case "message_end": {
          const m = ev.message;
          if (m?.role !== "assistant") return;
          const blocks: any[] = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
          for (const b of blocks) {
            if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) report({ event: "thought", agent: ag.id, key, turn: t.id, text: b.thinking });
          }
          const said = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim();
          if (said) report({ event: "output", agent: ag.id, key, turn: t.id, text: said });
          lastError = m.stopReason === "error" ? String(m.errorMessage ?? "the model failed") : undefined;
          return;
        }
        case "tool_execution_start": {
          const name = String(ev.toolName ?? "tool");
          const summary = toolSummary(name, undefined, ev.args);
          if (ev.toolCallId) open.set(String(ev.toolCallId), { name, summary });
          report({ event: "tool", agent: ag.id, key, turn: t.id, phase: "start", name, summary });
          return;
        }
        case "tool_execution_end": {
          const o = ev.toolCallId ? open.get(String(ev.toolCallId)) : undefined;
          const name = o?.name ?? String(ev.toolName ?? "tool");
          report({ event: "tool", agent: ag.id, key, turn: t.id, phase: "end", name, summary: o?.summary ?? toolSummary(name), ok: ev.isError !== true });
          return;
        }
        case "auto_retry_end":
          if (ev.success === false && typeof ev.finalError === "string") lastError = ev.finalError;
          return;
        case "agent_settled":
          aborted = ev.aborted === true;
          settle();
          return;
        default:
      }
    });
    try {
      await p.rpc.request({ type: "prompt", message, ...(images.length ? { images } : {}) }, 60_000);
      if (t.cancelled) p.rpc.request({ type: "abort" }, 15_000).catch(() => {});
      await settled;
    } catch (error) {
      return { outcome: "error", error: errorText(error) };
    } finally { off(); offExit(); }
    if (died) return { outcome: "error", error: died };
    if (aborted || t.cancelled) return { outcome: "cancelled" };
    return lastError ? { outcome: "error", error: lastError } : { outcome: "completed" };
  }

  const newTurn = (ag: Agent, lane: Lane, batch: DriverMessage[]): Turn =>
    ({ id: `t_${randomBytes(6).toString("base64url")}`, ag, lane, batch, state: "queued", cancelled: false, dropped: false });

  // -- the agent and its lanes -------------------------------------------------------------------------------------

  const agentOf = (id: string): Agent => { const ag = agents.get(id); if (!ag) throw new WordError("offline", `${id} is not running`); return ag; };
  const laneOf = (id: string, key: string): { ag: Agent; lane: Lane } => {
    const ag = agentOf(id);
    const lane = ag.lanes.get(key);
    if (!lane) throw new WordError("not_found", `${id} has no session ${key}`);
    return { ag, lane };
  };
  const busyLane = (lane: Lane) => new WordError("conflict", `busy: ${lane.key} is in a turn`);

  /** End the processes this agent is using, and drop its waiting turns. `drop`: the turns running in them end without a word (the agents module cuts them). */
  async function halt(id: string): Promise<void> {
    const ag = agents.get(id);
    if (ag?.recover) { clearInterval(ag.recover); ag.recover = undefined; }
    for (const slot of Object.values(slots)) {
      for (const t of slot.queue.filter((q) => q.ag.id === id)) { t.dropped = true; t.done?.reject(new WordError("offline", `${id} was stopped`)); finishLane(t); }
      slot.queue = slot.queue.filter((q) => q.ag.id !== id);
      if (slot.current?.ag.id === id) slot.current.dropped = true;
      if (slot.proc?.agentId === id) await closeProc(slot);
    }
  }

  async function writeConfig(ag: Agent): Promise<void> {
    if (ag.spec.modules.static.length) await deps.writeFile(`${dirOf(ag.cwd)}/${BASELINE_FILE}`, ag.spec.modules.static.map((m) => m.content).join("\n\n---\n\n") + "\n");
    // The tool surface: one server, `ash`. Each process puts its lane's token into ASH_TOKEN, and pi expands it in the header.
    const config = { mcpServers: { ash: { url: ag.spec.tools.mcp_url, headers: { Authorization: "Bearer ${ASH_TOKEN}" }, exposure: "direct", timeout: 900 } } };
    await deps.writeFile(`/root/.pi/agent/mcp.json`, JSON.stringify(config, null, 2) + "\n");
  }

  // -- Codex's login -----------------------------------------------------------------------------------------------

  /** One run of the login helper to its end; its last JSON line. */
  function runHelper(args: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<Record<string, any> | null> {
    return new Promise((resolve) => {
      let child: DriverProcess;
      try { child = deps.spawn([...loginArgv, ...args], { env, cwd }); } catch { resolve(null); return; }
      let out = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => { out += c; });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("exit", () => {
        clearTimeout(timer);
        const last = out.trim().split("\n").filter(Boolean).pop();
        try { resolve(last ? JSON.parse(last) : null); } catch { resolve(null); }
      });
    });
  }

  async function loginStatus(ag: Agent): Promise<"none" | "pending" | "ready" | "unknown"> {
    if (login.state === "pending") return "pending";
    const got = await runHelper(["status"], envFor(ag, "front", "none"), ag.cwd, 20_000);
    if (got && typeof got.ready === "boolean") login.state = got.ready ? "ready" : "none";
    else login.state = "unknown";
    return login.state;
  }

  /** Start Codex's device-code login: the link and code for the owner. The rest (the owner types the code, the token is stored) goes on in the background. */
  async function startLogin(ag: Agent, provider: string): Promise<Record<string, unknown>> {
    if (provider !== CODEX_PROVIDER) throw new WordError("bad_request", `only ${CODEX_PROVIDER} has a login here`);
    if (login.state === "pending" && login.info) return login.info;
    const route = await routeNow(true);
    if (route === "none") throw new WordError("unavailable", "OpenAI cannot be reached: turn on the phone's VPN for the time of the login, or set up v2rayA (open http://127.0.0.1:2017 on the phone)");
    const child = deps.spawn([...loginArgv, "login"], { env: envFor(ag, "front", route), cwd: ag.cwd });
    login.child = child;
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { for (const line of c.split("\n")) if (line.trim()) log("[pi-login]", line.slice(0, 300)); });
    child.stdout.setEncoding("utf8");
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = "";
      let first = true;
      const wait = setTimeout(() => { if (first) { first = false; try { child.kill("SIGKILL"); } catch { /* gone */ } login.state = "unknown"; reject(new WordError("failed", "the login did not give a code in time")); } }, 45_000);
      wait.unref();
      const finish = (ev: Record<string, any>) => {
        if (ev.event === "device_code" && first) {
          first = false;
          clearTimeout(wait);
          login.state = "pending";
          login.info = { verification_uri: ev.verification_uri, user_code: ev.user_code, expires_in: ev.expires_in, note: "The owner opens the link in the phone's browser and types the code; the browser must be able to reach OpenAI (the phone's VPN on). Read the state back with configure." };
          resolve(login.info);
        } else if (ev.event === "done") {
          login.state = "ready"; login.info = undefined;
          for (const slot of Object.values(slots)) if (slot.proc && !slot.proc.busy) closeProc(slot).catch(() => {}); // they read the login at start
          leaveFallback(ag, "Codex 登录成功，已切回 Codex。");
          if (!ag.fallback) notice(ag, "Codex 登录成功。");
        } else if (ev.event === "error") {
          login.state = "none"; login.info = undefined;
          if (first) { first = false; clearTimeout(wait); reject(new WordError("failed", String(ev.message ?? "the login failed"))); }
          else notice(ag, `Codex 登录没成功：${String(ev.message ?? "").slice(0, 120)}`);
        }
      };
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (!line) continue; try { finish(JSON.parse(line)); } catch { /* not ours */ } }
      });
      child.on("exit", () => {
        if (login.child === child) login.child = undefined;
        if (first) { first = false; clearTimeout(wait); login.state = "none"; reject(new WordError("failed", "the login helper ended before it gave a code")); }
        else if (login.state === "pending") { login.state = "none"; login.info = undefined; notice(ag, "Codex 登录没有完成（码过期或被中断）。需要的话再发起一次。"); }
      });
    });
  }

  function readBack(ag: Agent): Record<string, unknown> {
    const current = [slots.front.proc, slots.shared.proc].find((p) => p?.agentId === ag.id)?.model;
    return {
      model: ag.fallback ? fallbackModel : ag.model, model_wanted: ag.model, ...(current ? { model_running: current } : {}),
      ...(ag.effort ? { effort: ag.effort } : {}),
      route: routeCache?.route ?? "unknown", fallback: ag.fallback?.reason ?? null,
      codex_login: login.state, ...(login.info ? { login: login.info } : {}), proxy: proxyUrl,
    };
  }

  // -- the driver --------------------------------------------------------------------------------------------------

  const driver: AgentDriver = {
    info: PI_INFO,

    async start(id, spec) {
      if (agents.has(id)) return;
      deps.proxyService?.ensure();
      const cwd = spec.native?.cwd ?? `/root/agents/${id.slice("agent:".length)}`;
      const ag: Agent = { id, spec, cwd, lanes: new Map(), model: normalizeModel(spec.runtime.model), ...(spec.runtime.effort ? { effort: spec.runtime.effort } : {}), fallback: null };
      for (const key of spec.lanes) ag.lanes.set(key, { key, session: spec.sessions[key] ?? sessionId(), followups: [], held: [] });
      agents.set(id, ag);
      try { await writeConfig(ag); } catch (error) { agents.delete(id); throw new WordError("failed", `${id} did not start: ${errorText(error)}`); }
      for (const lane of ag.lanes.values()) report({ event: "handle.updated", agent: id, key: lane.key, handle: lane.session });
    },
    async stop(id) { await halt(id); agents.delete(id); },
    status(id): AgentStatus { return agents.has(id) ? { state: "running" } : { state: "exited", detail: "not started" }; },
    async restart(id) {
      const ag = agents.get(id);
      if (!ag) throw new WordError("not_found", `${id} was never started`);
      await halt(id);
      const live: Agent = { ...ag, lanes: new Map([...ag.lanes].map(([k, l]) => [k, { ...l, turn: undefined, followups: [] }])), fallback: null, recover: undefined };
      agents.set(id, live);
      await writeConfig(live);
    },

    session: {
      get(id, key) { return agents.get(id)?.lanes.get(key)?.session ?? null; },
      async set(id, key, handle) {
        const { lane } = laneOf(id, key);
        if (lane.turn) throw busyLane(lane);
        lane.session = handle;
        report({ event: "handle.updated", agent: id, key, handle });
      },
      async new(id, key) {
        const { lane } = laneOf(id, key);
        if (lane.turn) throw busyLane(lane);
        lane.session = sessionId();
        report({ event: "handle.updated", agent: id, key, handle: lane.session });
        return { handle: lane.session };
      },
      async reload(id, key, modules) {
        const { ag, lane } = laneOf(id, key);
        if (lane.turn) throw busyLane(lane);
        ag.spec = { ...ag.spec, modules };
        await writeConfig(ag);
        lane.session = sessionId();
        report({ event: "handle.updated", agent: id, key, handle: lane.session });
        return { handle: lane.session };
      },
      async compact(id, key) {
        const { ag, lane } = laneOf(id, key);
        if (lane.turn) throw busyLane(lane);
        const t = newTurn(ag, lane, []);
        const done = new Promise<unknown>((resolve, reject) => { t.done = { resolve, reject }; });
        t.job = async (p) => {
          try { await p.rpc.request({ type: "compact" }, 180_000); return { compacted: true }; }
          catch (error) { return { compacted: false, detail: errorText(error) }; }
        };
        enqueue(t);
        return (await done) as { compacted: boolean; detail?: string };
      },
    },

    async send(id, key, batch) {
      const { ag, lane } = laneOf(id, key);
      if (lane.turn) throw busyLane(lane);
      enqueue(newTurn(ag, lane, [...lane.followups.splice(0), ...batch]));
    },
    async followup(id, key, batch) {
      const { ag, lane } = laneOf(id, key);
      if (lane.turn) lane.followups.push(...batch);
      else enqueue(newTurn(ag, lane, [...lane.followups.splice(0), ...batch]));
    },
    async steer(id, key, words) {
      const { lane } = laneOf(id, key);
      const t = lane.turn;
      if (!t || t.state !== "running" || !t.proc) return false;
      try { await t.proc.rpc.request({ type: "steer", message: words }); return true; } catch { return false; }
    },
    async inject(id, key, what) {
      const { lane } = laneOf(id, key);
      const parts = [...(what.modules ?? []).map((m: PromptModule) => m.content), ...(what.text ? [what.text] : [])];
      lane.held.push(...parts);
    },
    async interrupt(id, key) {
      const { lane } = laneOf(id, key);
      const t = lane.turn;
      if (!t) return;
      t.cancelled = true;
      if (t.state === "running" && t.proc) { t.proc.rpc.request({ type: "abort" }, 15_000).catch(() => {}); return; }
      // Still waiting for the slot: it ends where it stands, and says so.
      for (const slot of Object.values(slots)) {
        const i = slot.queue.indexOf(t);
        if (i < 0) continue;
        slot.queue.splice(i, 1);
        finishLane(t);
        report({ event: "turn.started", agent: id, key, turn: t.id, ids: t.batch.map((m) => m.id) });
        report({ event: "turn.ended", agent: id, key, turn: t.id, outcome: "cancelled" });
      }
    },

    async configure(id, _key, config) {
      const ag = agentOf(id);
      if (config && Object.keys(config).length) {
        if (typeof config.model === "string" && config.model) { ag.model = normalizeModel(config.model); ag.fallback = null; if (ag.recover) { clearInterval(ag.recover); ag.recover = undefined; } }
        if (typeof config.effort === "string" && config.effort) ag.effort = config.effort;
        if (typeof config.login === "string" && config.login) { const card = await startLogin(ag, config.login); return { ...readBack(ag), ...card }; }
      } else {
        await loginStatus(ag);
        if (!routeCache) await routeNow().catch(() => {});
      }
      return readBack(ag);
    },
    async plugins() { throw new WordError("unavailable", "pi has no plugins here"); },

    async credentialsHas(_id, ref) { return keys.has(ref); },
    async credentialsSet(_id, ref, value) {
      if (!(ref in KEY_ENV)) throw new WordError("bad_request", `pi does not take the key ${ref}`);
      const changed = keys.get(ref) !== value;
      keys.set(ref, value);
      // A process that is only being kept warm has the old key in its environment: end it, the next turn starts one with the new.
      if (changed) for (const slot of Object.values(slots)) if (slot.proc && !slot.proc.busy) await closeProc(slot);
    },
  };
  return driver;
}
