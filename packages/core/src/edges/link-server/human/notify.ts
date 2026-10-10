/**
 * Notifications (SPEC-03 §5.4, surface `notification`): what rings on the owner's phone, and when. The conversation
 * itself is `sync`; this only decides whether a message also rings (rules in ./delivery) and builds the presentation the
 * channel shows. It is sent only to channels that declared the surface.
 *
 * A reply whose turn is still running is shown quietly; when the turn ends and the last reply of it was only shown
 * quietly, and the owner is still not looking, that notification is raised again strongly (`alert`).
 */
import { isAgentId } from "../../../../../sdk/src/ids";
import type { Message } from "../../../../../sdk/src/message";
import type { Clients, LiveClient } from "./clients";
import { Delivery, rings as mayRing, rulesOf, type DeliveryKind } from "./delivery";
import type { PendingAsk } from "./ask";
import type { Presenter } from "./present";

const TEXT_MAX = 500;
const clip = (text: string) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text);
const TITLES: Record<string, string> = { reply: "Ash", due: "提醒", offer: "Ash", heads_up: "Ash" };

export interface NotifierDeps {
  clients: Clients;
  presenter: Presenter;
  settings(): Record<string, unknown>;
  now(): number;
  zone?: string;
  /** How long the island may take to say whether it is on screen. */
  islandMs: number;
  noted(askId: string, client: string): void;
  /** The primary agent: the one a reply on a notification goes to when the message did not come from an agent; null when there is no agent yet. */
  primary(): string | null;
  /** Whether the question is still waiting for an answer. */
  isOpen(askId: string): boolean;
}

export class Notifier {
  private readonly delivery: Delivery;
  private readonly running = new Set<string>();
  /** turn -> the reply that was shown quietly and is the turn's last so far. */
  private readonly quietReplies = new Map<string, string>();
  private readonly shown = new Map<string, Set<string>>();

  constructor(private readonly d: NotifierDeps) { this.delivery = new Delivery(d.zone); }

  /** The owner is looking at Ash: a channel is visible, or the task island is on screen. */
  async watching(): Promise<boolean> {
    if (this.d.clients.watching()) return true;
    const islands = this.d.clients.withSurface("island");
    const answers = await Promise.all(islands.map((c) => this.d.presenter.send(c, { surface: "island", op: "query", body: {} }, this.d.islandMs)));
    return answers.some((r) => r.ok && (r.data as { showing?: unknown } | undefined)?.showing === true);
  }

  private async rings(kind: DeliveryKind, dedupe_key: string | undefined): Promise<boolean> {
    const targets = this.d.clients.withSurface("notification");
    if (!targets.length) return false;
    const verdict = this.delivery.decide({ kind, ...(dedupe_key ? { dedupe_key } : {}) }, this.d.now(), await this.watching(), rulesOf(this.d.settings()));
    return verdict === "ring";
  }

  private async showTo(id: string, body: Record<string, unknown>, askId?: string): Promise<LiveClient[]> {
    const targets = this.d.clients.withSurface("notification");
    const results = await Promise.all(targets.map((c) => this.d.presenter.send(c, { surface: "notification", op: "show", body: body as never })));
    // A channel that says the notification is already past its time (`expired`) did not show it.
    const reached = targets.filter((_, i) => { const r = results[i]!; return r.ok && (r.data as { expired?: unknown } | undefined)?.expired !== true; });
    if (reached.length) this.shown.set(id, new Set(reached.map((c) => c.client)));
    if (askId) for (const c of reached) this.d.noted(askId, c.client);
    return reached;
  }

  /** `person:owner/say`. */
  async say(msg: Message): Promise<void> {
    const body = msg.body as { text: string; kind?: DeliveryKind; dedupe_key?: string };
    const kind: DeliveryKind = body.kind ?? "reply";
    if (!mayRing(kind)) return;
    const turn = msg.turn;
    const quiet = kind === "reply" && turn !== undefined && this.running.has(turn);
    // A notification says who a reply goes to; with no agent at all there is nobody to reply to.
    const target = isAgentId(msg.from) ? msg.from : this.d.primary();
    if (!target || !(await this.rings(kind, body.dedupe_key))) { if (turn) this.quietReplies.delete(turn); return; }
    const reached = await this.showTo(msg.id, {
      id: msg.id, kind, title: TITLES[kind] ?? "Ash", text: clip(body.text), reply_to: msg.id, reply_target: target, ...(kind === "reply" ? { alert: quiet ? "quiet" : "strong" } : {}),
    });
    if (turn && kind === "reply") { if (quiet && reached.length) this.quietReplies.set(turn, msg.id); else this.quietReplies.delete(turn); }
  }

  /** An open question or approval card. */
  async ask(ask: PendingAsk): Promise<void> {
    if (!(await this.rings("ask", undefined))) return;
    const approvalForm = ask.kind === "approval" && ask.options.some((o) => o.id === "deny") && ask.options.every((o) => ["once", "always", "deny"].includes(o.id));
    await this.showTo(ask.id, {
      id: ask.id, kind: "approval", title: ask.title, text: clip(ask.detail), options: ask.options, expires_at: ask.expires_at, reply_to: ask.id, reply_target: ask.from,
      ...(approvalForm ? {} : { human_kind: "question", ...(ask.allow_custom ? { allow_custom: true } : {}) }),
    }, ask.id);
    // It may have ended while the notification was on its way.
    if (!this.d.isOpen(ask.id)) this.hide(ask.id, this.shown.get(ask.id) ?? []);
  }

  /** Takes a notification down on the channels that were shown it (the question was answered or ended). */
  hide(id: string, clients: Iterable<string>): void {
    for (const client of clients) {
      const c = this.d.clients.get(client);
      if (c) void this.d.presenter.send(c, { surface: "notification", op: "hide", body: { id } });
    }
    this.shown.delete(id);
  }

  turnStarted(turn: string): void { this.running.add(turn); }

  async turnEnded(turn: string): Promise<void> {
    this.running.delete(turn);
    const id = this.quietReplies.get(turn);
    this.quietReplies.delete(turn);
    const clients = id ? this.shown.get(id) : undefined;
    if (!id || !clients || this.delivery.quiet(this.d.now(), rulesOf(this.d.settings())) || await this.watching()) return;
    for (const client of clients) {
      const c = this.d.clients.get(client);
      if (c) await this.d.presenter.send(c, { surface: "notification", op: "alert", body: { id } });
    }
  }
}
