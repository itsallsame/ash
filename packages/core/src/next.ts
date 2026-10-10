/**
 * The new hub's assembly point. The modules are wired in here one by one as they land (kernel, edges, services); until
 * then `startHub` refuses to start, and the scenario tests in `test/scenarios/` fail at exactly this line. Every scenario
 * reaches the hub through `startHub` and the one port it opens (`/link`, `/mcp`), never through a module.
 */
import type { Readable } from "node:stream";
import type { HostClient } from "./edges/host";

// --- the agent driver contract (SPEC-08), the smallest form the scenarios need -------------------------------------
// T17 puts the real definition in `packages/sdk/src/driver.ts`; when it lands, delete this section and import from there.

/** One message of a batch, as the driver is given it. The driver builds the envelope (time, source, lane) from these fields. */
export interface DriverMessage {
  id: string;
  from: string;
  word: string;
  /** `front` (the owner's words) or `back` (wake-ups, timers, events, tell); more when the agent declares more lanes. */
  lane: string;
  at: number;
  body: unknown;
}

/** What the hub hands a driver when it starts an agent (SPEC-08 §1.4 `agent.start`). */
export interface AgentStartSpec {
  native?: { on: string; cwd?: string; env?: Record<string, string> };
  config?: Record<string, unknown>;
  /** The tool surface: this agent's own address and token on `<hub url>/mcp`. */
  tools: { mcp_url: string; token: string; allowed: string[] };
  /** Resumable session handles, by session key (lane). */
  sessions: Record<string, string>;
}

/** What a driver reports (SPEC-08 §2.4). `key` is the session key = the lane. */
export type AgentEvent =
  | { event: "turn.started"; agent: string; key: string; turn: string; ids?: string[] }
  | { event: "turn.ended"; agent: string; key: string; turn: string; outcome: "completed" | "cancelled" | "error" | "interrupted"; error?: string; usage?: { input_tokens: number; output_tokens: number } }
  | { event: "output"; agent: string; key: string; turn: string; text: string }
  | { event: "thought"; agent: string; key: string; turn: string; text: string }
  | { event: "tool"; agent: string; key: string; turn: string; phase: "start" | "end"; name: string; summary?: string }
  | { event: "handle.updated"; agent: string; key: string; handle: string }
  | { event: "error"; agent: string; message: string }
  | { event: "ended"; agent: string; reason?: string };

/** One runtime's driver. It serves every agent declared on that runtime; `agent` is the member id, e.g. `agent:main`. */
export interface AgentDriver {
  start(agent: string, spec: AgentStartSpec): Promise<void>;
  stop(agent: string, reason: string): Promise<void>;
  /** The agent is idle on `key`: open a turn with this batch. */
  send(agent: string, key: string, batch: DriverMessage[]): Promise<void>;
  /** Queue messages for the next turn on `key`. */
  followup(agent: string, key: string, batch: DriverMessage[]): Promise<void>;
  /** Say something into the running turn. */
  steer(agent: string, key: string, text: string): Promise<void>;
  /** Stop the running turn. */
  interrupt(agent: string, key: string): Promise<void>;
}
/** The hub calls this once per runtime kind and gives it the place to report events. */
export type AgentDriverFactory = (report: (event: AgentEvent) => void) => AgentDriver;

// --- the hub ---------------------------------------------------------------------------------------------------------

export interface HubOptions {
  /** The hub's state directory (ledger, blobs, vault file). The caller owns it; starting again on the same one is a restart. */
  dataDir: string;
  /** The one port the hub opens on 127.0.0.1. 0 or absent: any free port. */
  port?: number;
  /** The client of the host (SPEC-07). Absent: no host, the optional host capabilities are skipped. */
  host?: HostClient;
  /**
   * Where the host's events arrive (one JSON line each: `wake.fired`, `env.changed`, `lifecycle.stop`). Defaults to
   * `process.stdin`. Not in the first signature of this task; without it the scenarios cannot deliver `wake.fired`.
   */
  hostEvents?: Readable;
  /** Drivers by runtime kind (`dsh`, `codex`, ...). Absent: the real ones. */
  drivers?: Record<string, AgentDriverFactory>;
  /** The clock of everything that waits for a time (timers, approval expiry, pulse). Absent: the system clock. */
  now?: () => number;
}

export interface Hub {
  /** `http://127.0.0.1:<port>`. `/link` (WebSocket, `ash-link/1`) and `/mcp` hang off it. */
  url: string;
  stop(): Promise<void>;
}

export async function startHub(_opts: HubOptions): Promise<Hub> {
  throw new Error("hub not assembled yet");
}
