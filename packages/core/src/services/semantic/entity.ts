/**
 * The entity (SPEC-10 §0, §4): what makes Ash one continuing someone out of the loops. Besides the static persona, the
 * daily review and the pulse, this member holds the two things that belong to no one of them:
 *
 *   - the first meeting: the first time the owner connects through a channel for people, the primary agent gets one
 *     `wake {reason: "first_meeting"}`, and never another. It is remembered in the layer's own table. The hub tells it by the
 *     event `service:link/connected` (the member listens to the word `connected`) whose `channels` include `human`.
 *   - the daily new session: at `semantic.reload_time` (default 04:00) every agent's every lane gets
 *     `service:agents/session.reload`, so the persona and rules approved since are what the next session starts with
 *     (SPEC-08 §2.3.1). The agents list is asked each time; no agent is named here.
 *
 * It has no words of its own; the clock's timers come to `service:pulse/pulse.due` and are passed on by `createSemantic`.
 */
import type { HandleContext, Message, WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import type { Ledger } from "../../kernel/ledger";
import { DailyReview } from "./daily";
import { ask, CLOCK_TIME, listAgents, nextMoment, primaryAgent, readSetting, reconcileTimers, type SemanticKv, wakeAgent, type Sender } from "./shared";

export const ENTITY_ID = "service:semantic";
export const DEFAULT_RELOAD_TIME = "04:00";
export const RELOAD_SETTING = "semantic.reload_time";
/** The lanes of an agent that declares none (SPEC-08: the front and the back). */
const DEFAULT_LANES = ["front", "back"];

export interface EntityOptions {
  ledger: Pick<Ledger, "db">;
  router: Sender;
  kv: SemanticKv;
  daily: DailyReview;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export class Entity implements Member {
  readonly id = ENTITY_ID;
  readonly kind = "service" as const;
  readonly name = "Semantic layer";
  /** `connected` is the link's event for a hand that finished its handshake; `settings.changed` tells when a time was changed. */
  readonly listens = ["connected", "settings.changed"];
  private readonly now: () => number;
  private meeting = false;

  constructor(private readonly options: EntityOptions) { this.now = options.now ?? Date.now; }

  words(): WordContract[] { return []; }

  /** Remember when the layer first ran (a review is only owed for days it was there for), and lay down the timers. */
  async start(): Promise<void> {
    this.options.kv.setOnce("installed_at", String(this.now()));
    await this.scheduleReload();
    await this.options.daily.schedule();
    await this.options.daily.catchUp();
  }

  async handle(msg: Message, _ctx: HandleContext): Promise<WordResult | void> {
    if (msg.kind !== "event") return;
    if (msg.word === "connected" && msg.from === "service:link") await this.connected(msg.body);
    else if (msg.word === "settings.changed") {
      const keys = (msg.body as { keys?: unknown } | null)?.keys;
      if (Array.isArray(keys) && keys.some((key) => typeof key === "string" && key.startsWith("semantic."))) {
        await this.scheduleReload();
        await this.options.daily.schedule();
      }
    }
  }

  // ---- first meeting ----

  /** A hand connected. Only a connection that carries a channel for people counts; only the first one does. */
  private async connected(body: unknown): Promise<void> {
    const channels = (body as { channels?: unknown } | null)?.channels;
    if (!Array.isArray(channels) || !channels.includes("human")) return;
    await this.firstMeeting();
  }

  async firstMeeting(): Promise<boolean> {
    if (this.meeting || this.options.kv.get("first_meeting")) return false;
    this.meeting = true;
    try {
      const agent = await primaryAgent(this.options.router, ENTITY_ID);
      if (!agent) return false;
      const sent = await wakeAgent(this.options.router, ENTITY_ID, agent, "first_meeting", {});
      // Held only when the wake was taken; if the agent was away, the next connection tries again.
      if (!sent.ok) { this.options.log?.(`first meeting wake failed: ${sent.error.message}`); return false; }
      this.options.kv.set("first_meeting", String(this.now()));
      return true;
    } finally { this.meeting = false; }
  }

  // ---- the daily new session ----

  async reloadTime(): Promise<string> {
    const set = await readSetting(this.options.router, ENTITY_ID, RELOAD_SETTING);
    return typeof set === "string" && CLOCK_TIME.test(set) ? set : DEFAULT_RELOAD_TIME;
  }

  async scheduleReload(): Promise<void> {
    const at = nextMoment(this.now(), await this.reloadTime());
    const problem = await reconcileTimers(this.options.router, ENTITY_ID, "semantic:reload:", "service:pulse", "pulse.due",
      new Map([[`semantic:reload:${at}`, { at, body: { kind: "reload", at } }]]));
    if (problem) this.options.log?.(`reload timer: ${problem}`);
  }

  /** The clock reported the reload time: ask every agent to reload every lane, then lay down tomorrow's timer. */
  async reload(_at: number): Promise<{ asked: number }> {
    const agents = (await listAgents(this.options.router, ENTITY_ID)).filter((agent) => !(agent as { ephemeral?: boolean }).ephemeral);
    const jobs: Promise<unknown>[] = [];
    for (const agent of agents) {
      const lanes = agent.lanes && Object.keys(agent.lanes).length ? Object.keys(agent.lanes) : DEFAULT_LANES;
      for (const key of lanes) jobs.push(ask(this.options.router, ENTITY_ID, "service:agents", "session.reload", { agent: agent.id, key }));
    }
    await Promise.allSettled(jobs);
    await this.scheduleReload();
    return { asked: jobs.length };
  }
}
