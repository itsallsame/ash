/**
 * human (HUB-MODULES §2.2): the member `person:owner` and the owner's channels on the link. Every connection that opened
 * the `human` channel is one channel `client:<sid>`.
 *
 *   in    `send` -> `router.send` as the owner (./inbound); `presence` -> remembered; `sync` -> the ledger (./sync)
 *   out   conversation: nothing to do, it is in the ledger and every channel reads it with `sync`;
 *         notification / island / status / widget / chat pages: `present` frames to the channels that declared the surface
 *   words say, show, react, ask, open (the contracts of sdk/words.ts)
 *
 * Cards on the home screen: `service:widgets` sends the event `person:owner/widget.state` with the whole state; it is
 * presented to every channel that declared `widget`, and what a channel reports becomes `widget.rendered`. A channel that
 * has just connected is given the current state from `service:widgets/widget.list`.
 *
 * Assembly: `link.onChannel("human", human.attach)`, `registry.add(human.member)`; the small model goes in as
 * `summarize` (see `summaryRequest`).
 */
import { isAgentId, OWNER_ID } from "../../../../../sdk/src/ids";
import type { HelloFrame } from "../../../../../sdk/src/link";
import {
  WordError, type Caller, type HandleContext, type Message, type Outgoing, type WordResult,
} from "../../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../../sdk/src/word";
import { wordsOf } from "../../../../../sdk/src/words";
import type { Ledger } from "../../../kernel/ledger";
import type { Router } from "../../../kernel/types";
import type { ChannelAttach } from "../index";
import { Asks } from "./ask";
import { Clients, SURFACES, type ClientInfo, type LiveClient, type Surface } from "./clients";
import { Inbound, Recorded } from "./inbound";
import { Notifier } from "./notify";
import { Presenter, type PresentResult } from "./present";
import { TaskStatus, type Summarize } from "./status";
import { Syncs } from "./sync";

export { summaryRequest, type Summarize, type TaskFrame } from "./status";
export { isQuiet, QUIET_HOURS_KEY, DEDUPE_MINUTES_KEY } from "./delivery";
export type { ClientInfo, Surface } from "./clients";
export type { PresentResult } from "./present";

export interface HumanDeps {
  router: Pick<Router, "send" | "subscribe">;
  ledger: Pick<Ledger, "db" | "page" | "get">;
  /** The hub's settings by key (`service:admin`); here only `delivery.quiet_hours` and `delivery.dedupe_minutes` are read. */
  settings(): Record<string, unknown>;
  /** The primary agent's id, or null while there is no agent: then replies on notifications have nobody to go to and are not sent. */
  primary(): string | null;
  /** One short line about what the agent is doing, from the small model; null when there is none. */
  summarize?: Summarize;
  now?: () => number;
  /** IANA zone for quiet hours; default the host's local time. */
  timeZone?: string;
  log?: (message: string, error?: unknown) => void;
  timing?: Partial<{ presentMs: number; islandMs: number; recordMs: number; summaryDelayMs: number }>;
}

/** What the widgets service still uses directly. */
export interface WidgetSurface {
  /** The picture of a card as the home screen shows it, from the first channel that can draw one. (No word carries this yet.) */
  preview(card: unknown, size: unknown): Promise<PresentResult>;
}

export interface HumanEdge {
  /** `person:owner`: add it to the registry. */
  member: Member;
  /** For `link.onChannel("human", …)`. */
  attach: ChannelAttach;
  clients(): ClientInfo[];
  widgets: WidgetSurface;
  /** Brings a channel (default: the one the owner is on) to the front, e.g. after an authorization page. */
  focus(client?: string): Promise<PresentResult>;
  close(): void;
}

/** Who the human edge is when it speaks for itself (typing, widget.rendered): events the owner cannot send. */
const SELF: Caller = { member: "service:human", via: "service", local: true };

export function createHuman(deps: HumanDeps): HumanEdge {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message, error) => console.error(`[human] ${message}${error ? `: ${(error as Error).message}` : ""}`));
  const t = { presentMs: 10_000, islandMs: 1500, recordMs: 3000, ...deps.timing };
  const db = deps.ledger.db();

  const clients = new Clients(db, now);
  const presenter = new Presenter(t.presentMs);
  const recorded = new Recorded();
  const syncs = new Syncs(deps.ledger, log);

  const status = new TaskStatus({
    session: `ts_${now().toString(36)}`, primary: () => deps.primary(),
    asks: () => asks.list(),
    ...(deps.summarize ? { summarize: deps.summarize } : {}),
    ...(t.summaryDelayMs !== undefined ? { summaryDelayMs: t.summaryDelayMs } : {}),
    emit: (frame) => { for (const c of clients.withSurface("status")) void presenter.send(c, { surface: "status", op: "frame", body: frame as never }); },
  });
  const notifier: Notifier = new Notifier({
    clients, presenter, settings: deps.settings, now, islandMs: t.islandMs, ...(deps.timeZone ? { zone: deps.timeZone } : {}),
    primary: deps.primary,
    noted: (id, client) => asks.noted(id, client), isOpen: (id) => asks.has(id),
  });
  const asks: Asks = new Asks({
    now,
    ended: (ask, notified) => notifier.hide(ask.id, notified),
    changed: () => status.asksChanged(),
  });
  const inbound = new Inbound({ router: deps.router, ledger: deps.ledger, recorded, asks, now, recordMs: t.recordMs, log });

  const sendEvent = (out: Outgoing) => void deps.router.send(out, SELF).then((reply) => { if (!reply.ok) log(`${out.word} to ${out.to} refused: ${reply.error.message}`); }, (error) => log(`${out.word} to ${out.to} failed`, error));

  // Everything the router announces: following syncs, answers waiting to be recorded, the task status, the turns that make replies ring.
  const unsubscribe = deps.router.subscribe({}, (m: Message) => {
    syncs.publish(m);
    if (m.from === OWNER_ID) recorded.offer(m);
    status.observe(m);
    const turn = (m.body as { turn?: unknown } | null)?.turn;
    if (m.kind === "event" && typeof turn === "string") {
      if (m.word === "turn.started") notifier.turnStarted(turn);
      else if (m.word === "turn.ended") void notifier.turnEnded(turn).catch((error) => log("turn end notification failed", error));
    }
  });

  // ---- the member -----------------------------------------------------------------------------------------------------

  const member: Member = {
    id: OWNER_ID, kind: "person", name: "Owner",
    words: (): WordContract[] => wordsOf(OWNER_ID),
    cancel: (id) => asks.cancel(id),
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
      const body = (msg.body ?? {}) as Record<string, any>;
      switch (msg.word) {
        case "widget.state": void pushWidgets(body, clients.withSurface("widget")); return;
        case "say":
          void notifier.say(msg).catch((error) => log("notification failed", error));
          return { data: { accepted: true } };
        case "show":
          return { data: { accepted: true } };
        case "react":
          if (!deps.ledger.get(body.message_id)) throw new WordError("not_found", `no message ${body.message_id}`);
          return { data: { accepted: true } };
        case "ask": {
          const answer = asks.wait(msg, ctx.signal);
          const open = asks.list().find((a) => a.id === msg.id);
          if (open) void notifier.ask(open).catch((error) => log("notification failed", error));
          return answer;
        }
        case "open": return open(body as Parameters<typeof open>[0]);
        default: throw new WordError("not_found", `person:owner has no word ${msg.word}`);
      }
    },
  };

  /** `open`: a page on the named channel, else the one the owner is on. The body is `{target}` when that is all there is, else `{target: {target, id?, mode?}}` (the frame's `target` is open-ended). */
  async function open(body: { target: string; id?: string; mode?: string; client?: string }): Promise<WordResult> {
    const c = body.client ? clients.get(body.client) : clients.current();
    if (!c) throw new WordError("offline", body.client ? `${body.client} is not connected` : "the owner has no channel open");
    if (!c.surfaces.includes("chat")) throw new WordError("unavailable", `${c.client} does not show chat pages`);
    const detail = { target: body.target, ...(body.id !== undefined ? { id: body.id } : {}), ...(body.mode !== undefined ? { mode: body.mode } : {}) };
    const result = await presenter.send(c, { surface: "chat", op: "open", body: { target: Object.keys(detail).length === 1 ? body.target : detail } });
    if (!result.ok) throw new WordError(result.error.code, result.error.message);
    return { data: { opened: (result.data as { opened?: unknown } | undefined)?.opened !== false } };
  }

  // ---- the channels ---------------------------------------------------------------------------------------------------

  const attach: ChannelAttach = (session, ctx) => {
    const grant = session.channels.human;
    if (!grant || !("client" in grant)) return;
    const declared = (session.hello as HelloFrame).channels.human ?? {};
    const hand = session.hello.hand;
    const surfaces = (declared.surfaces ?? []).filter((s): s is Surface => (SURFACES as readonly string[]).includes(s));
    const at = now();
    const c: LiveClient = {
      client: grant.client, hand: `device:${ctx.handId}`, channel: hand.kind === "phone" ? "app" : hand.kind === "im" ? "im" : "web",
      ...(hand.kind === "im" ? { provider: hand.platform } : {}), label: declared.label ?? hand.name, local: ctx.local, surfaces,
      connected_at: at, last_seen: at, visible: false, visible_at: 0, active_at: at, session,
    };
    clients.add(c);
    // After the welcome, which the link server sends right after this returns.
    setImmediate(() => {
      if (surfaces.includes("status")) void presenter.send(c, { surface: "status", op: "frame", body: status.frame() as never });
      if (surfaces.includes("widget")) greetWidgets(c);
    });

    return {
      human(frame) {
        switch (frame.t) {
          case "send":
            clients.touch(c);
            void inbound.send(c, frame.request).then(
              (o) => session.send(o.ok ? { t: "send.result", id: frame.id, ok: true, message: o.message, ...(o.duplicate ? { duplicate: true } : {}), ...(o.response ? { response: o.response } : {}) } : { t: "send.result", id: frame.id, ok: false, error: o.error }),
              (error) => { log("send failed", error); session.send({ t: "send.result", id: frame.id, ok: false, error: { code: "internal", message: "the hub failed while handling this request" } }); },
            );
            return;
          case "sync": syncs.start(c, frame); return;
          case "sync.close": syncs.close(c, frame.sid); return;
          case "present.result": presenter.result(frame); return;
          case "presence":
            clients.touch(c);
            if (frame.visible !== undefined) { c.visible = frame.visible; if (frame.visible) c.visible_at = now(); }
            if (frame.typing === true && frame.agent && isAgentId(frame.agent)) sendEvent({ to: frame.agent, kind: "event", word: "typing", body: {} });
            return;
        }
      },
      closed() {
        syncs.closeAll(c);
        presenter.drop(c.client);
        clients.remove(c.client);
      },
    };
  };

  // ---- what other modules use -----------------------------------------------------------------------------------------

  /** Presents the whole widget state on [targets]; what each reports goes on as `widget.rendered`. */
  async function pushWidgets(state: unknown, targets: LiveClient[]): Promise<void> {
    const results = await Promise.all(targets.map((c) => presenter.send(c, { surface: "widget", op: "state", body: state as never })));
    for (const result of results) {
      if (!result.ok || !result.data || typeof result.data !== "object") continue;
      const data = result.data as { widgets?: unknown; rendered?: unknown };
      sendEvent({ to: "service:widgets", kind: "event", word: "widget.rendered", body: {
        ...(Array.isArray(data.widgets) ? { widgets: data.widgets } : {}), rendered: Array.isArray(data.rendered) ? data.rendered : [],
      } });
    }
  }

  /** A channel that just connected gets the current state. */
  function greetWidgets(c: LiveClient): void {
    void deps.router.send({ to: "service:widgets", kind: "request", word: "widget.list", body: {} }, SELF).then(
      (reply) => { if (reply.ok && reply.result?.data !== undefined) return pushWidgets(reply.result.data, [c]); },
      (error) => log("widget.list failed", error),
    );
  }

  const widgets: WidgetSurface = {
    async preview(card, size) {
      let last: PresentResult = { ok: false, error: { code: "offline", message: "no channel can draw a card" } };
      for (const c of clients.withSurface("widget")) {
        last = await presenter.send(c, { surface: "widget", op: "preview", body: { card, size } as never });
        if (last.ok) return last;
      }
      return last;
    },
  };

  return {
    member, attach, widgets,
    clients: () => clients.info(),
    async focus(client) {
      const c = client ? clients.get(client) : clients.current();
      return c ? presenter.send(c, { surface: "chat", op: "focus", body: {} }) : { ok: false, error: { code: "offline", message: "the owner has no channel open" } };
    },
    close() { unsubscribe(); status.close(); },
  };
}
