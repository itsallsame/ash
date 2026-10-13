/**
 * The entity (SPEC-10 §0, §4): what makes Ash one continuing someone out of the loops. Besides the static persona, the
 * daily review and the pulse, this member holds the two things that belong to no one of them:
 *
 *   - the first meeting: until the primary agent has really spoken to the owner, it is woken with `wake {reason:
 *     "first_meeting"}` when a hand with a channel for people connects (the link's event `connected`, `channels` include
 *     `human`, and a model key is configured, asked of the vault: with none the wake would only fail) and when a model key is saved (the vault's event `vault.changed`, `action: "saved"`; a new install has no key
 *     at the first connection, and the wake's turn fails). "Has spoken" is read from the ledger: any `say` or `show` an agent
 *     sent to the owner, outside a turn that ended in error (the failure notice is not a greeting), or the wake's own turn
 *     ended `completed`; then it is written to the layer's own table and never asked again. A wake whose turn has not ended
 *     is not repeated; a turn that failed is not retried by itself, the next trigger tries again.
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
import { ask, CLOCK_TIME, dataOf, listAgents, nextMoment, primaryAgent, readSetting, reconcileTimers, type SemanticKv, wakeAgent, type Sender } from "./shared";

export const ENTITY_ID = "service:semantic";
export const DEFAULT_RELOAD_TIME = "04:00";
export const RELOAD_SETTING = "semantic.reload_time";
const OWNER_ID = "person:owner";

export interface EntityOptions {
  ledger: Pick<Ledger, "db">;
  router: Sender;
  kv: SemanticKv;
  daily: DailyReview;
  /** Vault refs whose saving means the agents can think now: the list the agents module hands to its runtimes, given by the assembly. */
  modelKeys: readonly string[];
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export class Entity implements Member {
  readonly id = ENTITY_ID;
  readonly kind = "service" as const;
  readonly name = "Semantic layer";
  /** `connected` is the link's event for a hand that finished its handshake; `settings.changed` tells when a time was changed. */
  readonly listens = ["connected", "settings.changed", "vault.changed"];
  private readonly now: () => number;
  private meeting = false;
  /** When this process started the layer: a turn that began before it and never ended died with the old process. */
  private bootedAt = 0;

  constructor(private readonly options: EntityOptions) { this.now = options.now ?? Date.now; }

  words(): WordContract[] { return []; }

  /** Remember when the layer first ran (a review is only owed for days it was there for), and lay down the timers. */
  async start(): Promise<void> {
    this.bootedAt = this.now();
    this.options.kv.setOnce("installed_at", String(this.now()));
    await this.scheduleReload();
    await this.options.daily.schedule();
    await this.options.daily.catchUp();
  }

  async handle(msg: Message, _ctx: HandleContext): Promise<WordResult | void> {
    if (msg.kind !== "event") return;
    if (msg.word === "connected" && msg.from === "service:link") await this.connected(msg.body);
    else if (msg.word === "vault.changed") {
      const { ref, action } = (msg.body ?? {}) as { ref?: unknown; action?: unknown };
      if (action === "saved" && typeof ref === "string" && this.options.modelKeys.includes(ref)) await this.firstMeeting();
    } else if (msg.word === "settings.changed") {
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
    // With no model key saved the wake's turn can only fail, and every connection of a person's channel would add one more
    // failure: wait for `vault.changed` instead. When the vault cannot be asked, go on as if there were a key.
    if (!(await this.hasModelKey())) return;
    await this.firstMeeting();
  }

  /** Whether any of the model keys is configured, asked of the vault. An answer that does not come counts as yes: the turn will tell. */
  private async hasModelKey(): Promise<boolean> {
    const entries = dataOf<{ entries?: { ref?: unknown; configured?: unknown }[] }>(await ask(this.options.router, ENTITY_ID, "service:vault", "list"))?.entries;
    if (!Array.isArray(entries)) return true;
    return entries.some((entry) => entry.configured === true && typeof entry.ref === "string" && this.options.modelKeys.includes(entry.ref));
  }

  /** Wake the primary agent for the first meeting unless it is already held or the last such wake is still being worked on. */
  async firstMeeting(): Promise<boolean> {
    if (this.meeting || this.options.kv.get("first_meeting")) return false;
    this.meeting = true;
    try {
      const state = this.hasSpoken() ? "held" : this.lastWake();
      if (state === "held") { this.options.kv.set("first_meeting", String(this.now())); return false; }
      if (state === "running") return false;
      const agent = await primaryAgent(this.options.router, ENTITY_ID);
      if (!agent) return false;
      const sent = await wakeAgent(this.options.router, ENTITY_ID, agent, "first_meeting", {});
      // Not written down here: taking the wake is not the meeting; the agent speaking, or its turn ending well, is.
      if (!sent.ok) this.options.log?.(`first meeting wake failed: ${sent.error.message}`);
      return sent.ok;
    } finally { this.meeting = false; }
  }

  /**
   * An agent has said or shown something to the owner. A turn that ended in error does not count: the failure notice and its
   * retry card are sent by the agents module in the name of the agent that failed.
   */
  private hasSpoken(): boolean {
    return !!this.options.ledger.db().prepare(
      `SELECT 1 FROM messages m WHERE m.kind='request' AND m."to"=? AND m.word IN ('say','show') AND m."from" LIKE 'agent:%'
       AND NOT EXISTS (SELECT 1 FROM messages e WHERE e.kind='event' AND e.word='turn.ended' AND e."from"=m."from"
         AND e.turn=m.turn AND json_extract(e.body,'$.outcome')='error') LIMIT 1`).get(OWNER_ID);
  }

  /**
   * Where the last first-meeting wake an agent took has got to, read from the ledger so a restart does not forget it:
   *   held     the turn that had its id ended `completed` (a failed turn is `error`; without a key it always is);
   *   running  no turn has taken it yet, or its turn has not ended;
   *   open     nothing was sent, or its turn failed, was cancelled or was lost.
   * A wake or a turn from before this process started, and a turn that a later turn on the same lane of the same agent has
   * overtaken (its process died before it could end), is not waited for.
   */
  private lastWake(): "held" | "running" | "open" {
    const db = this.options.ledger.db();
    const wake = db.prepare(
      `SELECT w.id, w.ts FROM messages w WHERE w."from"=? AND w.kind='request' AND w.word='wake' AND json_extract(w.body,'$.reason')='first_meeting'
       AND EXISTS (SELECT 1 FROM messages r WHERE r.reply_to=w.id AND r.kind='response' AND json_extract(r.body,'$.ok')=1)
       ORDER BY w.seq DESC LIMIT 1`).get(ENTITY_ID) as { id: string; ts: number } | undefined;
    if (!wake) return "open";
    const turn = db.prepare(
      `SELECT s.seq, s."from" AS agent, s.ts, json_extract(s.body,'$.turn') AS turn, json_extract(s.body,'$.lane') AS lane
       FROM messages s, json_each(s.body,'$.ids') j
       WHERE s.kind='event' AND s.word='turn.started' AND j.value=? ORDER BY s.seq DESC LIMIT 1`).get(wake.id) as { seq: number; agent: string; ts: number; turn: string; lane: string | null } | undefined;
    if (!turn) return wake.ts >= this.bootedAt ? "running" : "open";
    const ended = db.prepare(`SELECT json_extract(e.body,'$.outcome') AS outcome FROM messages e WHERE e.kind='event' AND e.word='turn.ended' AND e."from"=? AND e.turn=? LIMIT 1`)
      .get(turn.agent, turn.turn) as { outcome: string } | undefined;
    if (ended) return ended.outcome === "completed" ? "held" : "open";
    if (turn.ts < this.bootedAt) return "open";
    const overtaken = db.prepare(
      `SELECT 1 FROM messages n WHERE n.kind='event' AND n.word='turn.started' AND n."from"=? AND n.seq>? AND json_extract(n.body,'$.lane') IS ? LIMIT 1`).get(turn.agent, turn.seq, turn.lane);
    return overtaken ? "open" : "running";
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
    const agents = (await listAgents(this.options.router, ENTITY_ID)).filter((agent) => !agent.ephemeral);
    const jobs: Promise<unknown>[] = [];
    for (const agent of agents) {
      for (const key of Object.keys(agent.lanes ?? {})) jobs.push(ask(this.options.router, ENTITY_ID, "service:agents", "session.reload", { agent: agent.id, key }));
    }
    await Promise.allSettled(jobs);
    await this.scheduleReload();
    return { asked: jobs.length };
  }
}
