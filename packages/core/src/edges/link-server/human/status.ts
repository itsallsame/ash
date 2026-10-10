/**
 * The task status (SPEC-03 §5.4, surface `status`): what the agent is doing on the owner's current request, as the
 * frames the island and the activity strip draw. It follows the front lane: the events of a turn (`turn.started`,
 * `agent.tool`, `turn.ended`), the agent's replies to the owner in that turn, and the questions that are open.
 *
 * The process summary (one short line while the agent works) comes from a small model, through the injected
 * `summarize`; without it, or while it has not answered, the line is the current tool's own summary.
 */
import { isAgentId, OWNER_ID } from "../../../../../sdk/src/ids";
import type { Message } from "../../../../../sdk/src/message";
import type { PendingAsk } from "./ask";

export interface TaskCard {
  id: string; pending_id: string; to: string; turn: string; kind: string; title: string; detail: string; original: string;
  options: { id: string; label: string }[]; expires_at: number; allow_custom: boolean; state: "waiting";
}
export interface TaskFrame {
  session: string; revision: number; turn: string | null; started_at: number;
  state: "idle" | "thinking" | "working" | "done" | "waiting_you";
  text: string; steps: string[]; can_stop: boolean; tool: string; step_started_at: number; outcome: string;
  reply: string; cards: TaskCard[]; agent: string;
}

/** What the summarizer is asked: the recent steps, oldest first. The assembly turns it into a call of edges/llm. */
export type Summarize = (steps: string[]) => Promise<string | null>;

/** The request to hand to `llm.complete(caller, …)` for a summary of [steps]. */
export function summaryRequest(steps: string[]): { messages: { role: "system" | "user"; content: string }[]; max_tokens: number } {
  return {
    messages: [
      { role: "system", content: "你在给主人看一个助手正在做什么。根据下面的步骤，用不超过 20 个字写一句进行时的话（例如「在整理今天的日程」），不要标点结尾，不要解释。" },
      { role: "user", content: steps.join("\n") },
    ],
    max_tokens: 60,
  };
}

const OUTCOME_TEXT: Record<string, string> = { completed: "本轮回复", cancelled: "已停止" };
const MAX_STEPS = 5;

interface Step { id: number; label: string; state: "running" | "ok" | "failed" }

export interface StatusOptions {
  emit(frame: TaskFrame): void;
  asks(): PendingAsk[];
  summarize?: Summarize;
  /** Wait after a tool event before asking for a summary, so a burst of tools asks once. */
  summaryDelayMs?: number;
  session: string;
}

export class TaskStatus {
  private revision = 0;
  private turn: string | null = null;
  private agent = "";
  private started = 0;
  private state: TaskFrame["state"] = "idle";
  private ended = false;
  private outcome = "";
  private steps: Step[] = [];
  private nextStep = 0;
  private replies: string[] = [];
  private summary = "";
  private summarizing: ReturnType<typeof setTimeout> | null = null;
  private queued = false;
  private closed = false;

  constructor(private readonly o: StatusOptions) {}

  /** Every message the hub records or passes. */
  observe(m: Message): void {
    if (this.closed) return;
    const body = (m.body ?? {}) as Record<string, any>;
    if (m.kind === "request" && m.to === OWNER_ID && m.word === "say" && this.turn && m.turn === this.turn && !this.ended && typeof body.text === "string") {
      this.replies.push(body.text);
      return this.changed();
    }
    if (m.kind !== "event" || typeof body.turn !== "string") return;
    const agent = isAgentId(m.to) ? m.to : isAgentId(m.from) ? m.from : "";
    if (m.word === "turn.started") {
      if (body.lane !== "front") return;
      Object.assign(this, { turn: body.turn, agent, started: m.ts, state: "thinking", ended: false, outcome: "", steps: [], replies: [], summary: "" });
    } else if (body.turn !== this.turn) return;
    else if (m.word === "turn.ended") {
      this.ended = true; this.state = "done"; this.outcome = String(body.outcome ?? "");
      if (this.summarizing) clearTimeout(this.summarizing);
    } else if (m.word === "agent.tool" && !this.ended) {
      const label = typeof body.summary === "string" && body.summary ? body.summary : String(body.name);
      if (body.phase === "start") this.steps.push({ id: this.nextStep++, label, state: "running" });
      else {
        const open = this.steps.find((s) => s.state === "running" && (s.label === label || s.label === String(body.name)));
        if (open) { open.state = body.ok === false ? "failed" : "ok"; if (typeof body.summary === "string" && body.summary) open.label = body.summary; }
        else this.steps.push({ id: this.nextStep++, label, state: body.ok === false ? "failed" : "ok" });
      }
      this.state = this.steps.some((s) => s.state === "running") ? "working" : "thinking";
      this.askForSummary();
    } else return;
    this.changed();
  }

  /** The open questions changed. */
  asksChanged(): void { this.changed(); }

  frame(): TaskFrame {
    const cards: TaskCard[] = this.o.asks().map((a) => ({
      id: a.id, pending_id: a.id, to: a.from, turn: a.turn ?? this.turn ?? "", kind: a.kind, title: a.title, detail: a.detail, original: a.original,
      options: a.options, expires_at: a.expires_at, allow_custom: a.allow_custom, state: "waiting" as const,
    }));
    const running = this.steps.find((s) => s.state === "running");
    const waiting = cards.length > 0;
    const state = waiting ? "waiting_you" : this.state;
    const text = waiting ? "等待你回应"
      : this.state === "idle" ? "在线"
      : this.ended ? OUTCOME_TEXT[this.outcome] ?? "本轮已结束"
      : running?.label ?? (this.summary || "等待模型响应");
    const visible = this.steps.slice(-MAX_STEPS).map((s) => `${s.state === "ok" ? "✓ " : s.state === "failed" ? "失败 · " : ""}${s.label}`);
    return {
      session: this.o.session, revision: ++this.revision, turn: this.turn, started_at: this.started, state, text, steps: visible,
      can_stop: this.turn !== null && !this.ended, tool: running?.label ?? "", step_started_at: this.started, outcome: this.outcome,
      reply: this.replies.join("\n\n"), cards, agent: this.agent,
    };
  }

  close(): void {
    this.closed = true;
    if (this.summarizing) clearTimeout(this.summarizing);
  }

  private askForSummary(): void {
    if (!this.o.summarize) return;
    if (this.summarizing) clearTimeout(this.summarizing);
    const turn = this.turn;
    this.summarizing = setTimeout(async () => {
      this.summarizing = null;
      const steps = this.steps.slice(-8).map((s) => s.label);
      try {
        const text = await this.o.summarize!(steps);
        if (!this.closed && !this.ended && this.turn === turn && text?.trim()) { this.summary = text.trim().slice(0, 40); this.changed(); }
      } catch { /* a summary is a courtesy; the tool's own line stays */ }
    }, this.o.summaryDelayMs ?? 3000);
    this.summarizing.unref?.();
  }

  /** Several events in one tick make one frame. */
  private changed(): void {
    if (this.queued || this.closed) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (!this.closed) this.o.emit(this.frame()); });
  }
}
