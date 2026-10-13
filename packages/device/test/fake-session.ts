import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../sdk/src/driver";
import { createComputerDriver, type ComputerDriver } from "../src/agents/driver";
import { abilitiesOf, type Kind } from "../src/agents/info";
import type { AgentEvent as SessionEvent, AgentSession, OpenOptions } from "../src/agents/types";

/** The working directory of the drivers built here. */
export const WORK = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ash-driver-work-"));

/** A runtime that is a plain object, so the driver's own rules can be seen. */
export class FakeSession implements AgentSession {
  readonly sent: { turn: string; text: string }[] = [];
  readonly steered: string[] = [];
  readonly interrupted: string[] = [];
  readonly selected: unknown[][] = [];
  compacts = 0;
  closed = false;
  failSend = false;
  constructor(readonly options: OpenOptions, readonly seed: string) {}
  emit(e: SessionEvent) { this.options.onEvent(e); }
  async send(turn: string, text: string) { if (this.failSend) throw new Error("runtime did not accept"); this.sent.push({ turn, text }); this.emit({ type: "turn_started", turn }); }
  async steer(_turn: string, text: string) { this.steered.push(text); return true; }
  async interrupt(turn: string) { this.interrupted.push(turn); }
  async select(model?: string, effort?: string) { this.selected.push([model, effort]); }
  async compact() { this.compacts++; return { compacted: true, detail: "fake" }; }
  async close() { this.closed = true; }
  get turn() { return this.sent.at(-1)!.turn; }
  say(text: string, kind: "text" | "thinking" | "plan" = "text") { this.emit({ type: "note", turn: this.turn, kind, text }); }
  end(outcome: "ok" | "failed" | "interrupted" | "unknown" = "ok", extra: Partial<Extract<SessionEvent, { type: "turn_ended" }>> = {}) {
    this.emit({ type: "turn_ended", turn: this.turn, outcome, reply: "", ...extra });
  }
}

export interface Rig {
  driver: ComputerDriver;
  events: AgentEvent[];
  sessions: FakeSession[];
  outbound: unknown[];
  named(name: string): any[];
}
export function rig(kind: Kind = "codex", over: { open?: (o: OpenOptions, n: number) => Promise<void> | void } = {}): Rig {
  const events: AgentEvent[] = [], sessions: FakeSession[] = [], outbound: unknown[] = [];
  const driver = createComputerDriver({
    kind, workdir: WORK, startWaitMs: 50,
    info: () => ({ kind, models: [], abilities: abilitiesOf(kind) }),
    report: (e) => events.push(e),
    outbound: async (call) => { outbound.push(call); return { agents: [] }; },
    open: async (options) => {
      await over.open?.(options, sessions.length);
      const session = new FakeSession(options, options.seed ?? `handle-${sessions.length + 1}`);
      sessions.push(session);
      options.onEvent({ type: "seed_updated", seed: session.seed });
      return session;
    },
  });
  return { driver, events, sessions, outbound, named: (name) => events.filter((e) => e.event === name) };
}
