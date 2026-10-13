/**
 * Screen leases (service:gate/lease.*): the owner lends the real phone screen to one agent for a while. The gate decides each screen
 * word by whether the agent holds a lease (kernel/gate/decide.ts); this keeps the leases: asking the owner, granting, the end
 * (time, the owner's recall, the agent handing it back, the end of a task), and what the end does: the fingers the agent holds
 * on the screen are let go, the requests it still has on the way are cancelled, and it is told why.
 *
 * The owner's click on the card is the grant itself; what follows is the owner saying so to the agent in the conversation
 * (a front turn, like an approval) so the agent goes on by itself. Only the time running out, or the owner not answering, is a
 * background message to the agent.
 */
import { OWNER_ID } from "../../../../sdk/src/ids";
import { WordError, type Caller, type Message, type Outgoing, type Reply } from "../../../../sdk/src/message";
import type { GateStore, LeaseKind, LeaseRecord } from "../../kernel/gate";
import type { SendOptions } from "../../kernel/types";

const SELF: Caller = { member: "service:gate", via: "service", local: true };
const MIN = 60_000;
/** A "this task" lease still ends by itself after this long. */
export const TASK_MAX_MS = 30 * MIN;
/** The card for a lease waits this long for the owner; no answer is a refusal. */
export const CARD_MS = 5 * MIN;
/** The agent is told this long before a timed lease runs out. */
export const WARN_MS = 90_000;
export const DEFAULT_MINUTES = 15;

const OPTIONS = [
  { id: "task", label: "本次任务（最长 30 分钟）" }, { id: "m15", label: "15 分钟" }, { id: "h1", label: "1 小时" }, { id: "deny", label: "不行" },
];

export interface LeaseView { id: string; agent: string; name: string; kind: LeaseKind; purpose: string; granted_at: number; expires_at: number; last_action_at: number | null }

export interface LeaseDeps {
  store: GateStore;
  now(): number;
  send(msg: Outgoing, caller: Caller, opts?: SendOptions): Promise<Reply & { id?: string }>;
  /** After the owner answered the card [askId], says [body] to [to] as the owner; false when the owner did not answer it. */
  ownerSay?(askId: string, to: string, body: Record<string, unknown>): Promise<boolean>;
  nameOf(id: string): string;
  /** Lets go of the fingers an agent holds on the phone's screen. */
  releaseScreen?(): Promise<void>;
  /** Cancels the screen requests the agent still has on the way; how many. */
  cancelScreen?(agent: string): number;
  onError?(where: string, error: unknown): void;
}

export interface Leases {
  request(agent: string, turn: string | undefined, minutes: number | undefined, purpose: string): { status: "waiting_owner" | "active"; lease_id: string; expires_at?: number };
  status(agent: string): { lease: LeaseView | null; asking: boolean };
  release(agent: string): boolean;
  /** The owner takes one lease (by id), or all, back. */
  revoke(id?: string): number;
  list(): LeaseView[];
  /** The agent's screen word went out under its lease just now: the phone shows it is operating (told at most once a second). */
  acted(agent: string): void;
  /** An agent's turn began or ended (`turn.started` / `turn.ended`). */
  turnStarted(agent: string, turn: string): void;
  turnEnded(agent: string, turn: string): void;
  /** Ends what has run out. */
  sweep(): void;
  /** Rearms the timers of the leases that were in force when the hub stopped. */
  start(): void;
  stop(): void;
}

export function createLeases(deps: LeaseDeps): Leases {
  const { store } = deps;
  const oops = (where: string) => (error: unknown) => deps.onError?.(where, error);
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  const running = new Map<string, Set<string>>();
  /** Leases whose card is out now; one that is asking without a card (the hub restarted) gets its card again. */
  const carded = new Set<string>();
  const cards = new Map<string, AbortController>();

  const view = (l: LeaseRecord): LeaseView => ({ id: l.id, agent: l.agent, name: deps.nameOf(l.agent), kind: l.kind ?? "timed", purpose: l.purpose,
    granted_at: l.granted_at ?? l.requested_at, expires_at: l.expires_at ?? l.requested_at, last_action_at: l.last_action_at ?? null });

  const tell = (agent: string, text: string) => { void deps.send({ to: agent, kind: "request", word: "tell", body: { text } }, SELF).catch(oops("tell")); };
  let lastPublished = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const publish = () => { lastPublished = deps.now(); void deps.send({ to: OWNER_ID, kind: "event", word: "lease.state", body: { leases: store.activeLeases().map(view) } }, SELF).catch(oops("lease.state")); };
  const clear = (id: string) => { for (const t of timers.get(id) ?? []) clearTimeout(t); timers.delete(id); };
  const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

  /** Ends a lease and does what the ending asks for. */
  function finish(lease: LeaseRecord, reason: "revoked" | "expired" | "released" | "turn_ended" | "denied" | "timeout"): void {
    clear(lease.id);
    // A card still out for a lease that ends is taken back from the owner.
    cards.get(lease.id)?.abort();
    const ended = store.endLease(lease.id, reason);
    if (!ended) return;
    if (lease.state === "active") {
      // Whatever the agent was doing on the screen stops with the lease.
      if (reason !== "released") {
        void Promise.resolve(deps.releaseScreen?.()).catch(oops("releaseScreen"));
        try { deps.cancelScreen?.(lease.agent); } catch (error) { oops("cancelScreen")(error); }
      } else void Promise.resolve(deps.releaseScreen?.()).catch(oops("releaseScreen"));
      const at = clock(deps.now());
      if (reason === "revoked") tell(lease.agent, `主人收回了屏幕操作权限（${at}），已停下。不要继续操作屏幕；需要的话先和主人说明，再调 service:gate/lease.request 重新申请。`);
      else if (reason === "expired") tell(lease.agent, `屏幕授权时间到了（${at}），权限已结束。要继续的话先和主人说明，再调 service:gate/lease.request 重新申请。`);
      publish();
    }
  }

  function arm(lease: LeaseRecord): void {
    clear(lease.id);
    if (!lease.expires_at) return;
    const list: ReturnType<typeof setTimeout>[] = [];
    const wait = lease.expires_at - deps.now();
    const end = setTimeout(() => { const l = store.getLease(lease.id); if (l?.state === "active") finish(l, "expired"); }, Math.max(0, wait));
    end.unref();
    list.push(end);
    if (lease.kind === "timed" && wait > WARN_MS + 60_000) {
      const warn = setTimeout(() => { if (store.getLease(lease.id)?.state === "active") tell(lease.agent, "屏幕授权还剩 1 分钟，请收尾；还要的话重新申请。"); }, wait - WARN_MS);
      warn.unref();
      list.push(warn);
    }
    timers.set(lease.id, list);
  }

  function ask(lease: LeaseRecord): void {
    carded.add(lease.id);
    const left = Math.max(1_000, lease.requested_at + CARD_MS - deps.now());
    const name = deps.nameOf(lease.agent);
    const body = {
      title: `${name} 想操作你的手机屏幕`,
      detail: `目的：${lease.purpose}\n批准后 ${name} 可以点按、输入、打开应用和按键，直到到期或你收回。付款类的事仍然每次问你。`,
      human_kind: "question", options: OPTIONS, expires_at: deps.now() + left,
    };
    const controller = new AbortController();
    cards.set(lease.id, controller);
    void deps.send({ to: OWNER_ID, kind: "request", word: "ask", body, reply_to: lease.id }, SELF, { signal: controller.signal })
      .then((reply) => answered(lease.id, reply))
      .catch(oops("lease card"));
  }

  function answered(id: string, reply: Reply & { id?: string }): void {
    carded.delete(id);
    cards.delete(id);
    const lease = store.getLease(id);
    if (!lease || lease.state !== "asking") return;     // withdrawn or taken back meanwhile
    if (!reply.ok) {
      finish(lease, "timeout");
      tell(lease.agent, "主人没有回答你的屏幕授权申请，按拒绝处理。需要的话先和主人说明，再重新申请。");
      return;
    }
    const choice = String((reply.result?.data as { choice?: unknown } | undefined)?.choice ?? "deny");
    const minutes = choice === "m15" ? 15 : choice === "h1" ? 60 : choice === "task" ? 30 : 0;
    if (!minutes) {
      finish(lease, "denied");
      say(reply.id, lease, "拒绝：操作屏幕");
      return;
    }
    const kind: LeaseKind = choice === "task" ? "task" : "timed";
    const granted = store.grantLease(id, kind, deps.now() + (kind === "task" ? TASK_MAX_MS : minutes * MIN));
    if (!granted) return;
    // A task lease belongs to the turn the work is done in: the asking turn if it is still running, else the next that starts.
    if (kind === "task" && lease.turn && running.get(lease.agent)?.has(lease.turn)) store.bindLeaseTurn(id, lease.turn);
    arm(granted);
    publish();
    say(reply.id, granted, kind === "task" ? "授权操作屏幕：本次任务" : `授权操作屏幕 ${minutes === 60 ? "1 小时" : `${minutes} 分钟`}`);
  }

  /** The owner's own message to the agent, in the conversation; a refusal of the channel falls back to a background message. */
  function say(askId: string | undefined, lease: LeaseRecord, text: string): void {
    const fallback = () => tell(lease.agent, `主人${text.startsWith("拒绝") ? "拒绝了" : "批准了"}你的屏幕授权申请。${text.startsWith("拒绝") ? "不要原样重复；需要的话先和主人说明。" : "可以开始了。"}`);
    if (!deps.ownerSay || !askId) { fallback(); return; }
    deps.ownerSay(askId, lease.agent, { text }).then((said) => { if (!said) fallback(); }, (error) => { oops("ownerSay")(error); fallback(); });
  }

  return {
    request(agent, turn, minutes, purpose) {
      const wanted = Math.min(Math.max(Math.trunc(minutes ?? DEFAULT_MINUTES) || DEFAULT_MINUTES, 1), 120);
      const active = store.activeLease(agent);
      if (active && active.expires_at! - deps.now() >= wanted * MIN) return { status: "active", lease_id: active.id, expires_at: active.expires_at! };
      const asking = store.askingLease(agent);
      if (asking) {
        if (deps.now() - asking.requested_at >= CARD_MS) finish(asking, "timeout");
        else { if (!carded.has(asking.id)) ask(asking); return { status: "waiting_owner", lease_id: asking.id }; }
      }
      const lease = store.askLease(agent, purpose, wanted, turn);
      ask(lease);
      return { status: "waiting_owner", lease_id: lease.id };
    },
    status(agent) {
      const lease = store.activeLease(agent);
      return { lease: lease ? view(lease) : null, asking: store.askingLease(agent) !== null };
    },
    release(agent) {
      const lease = store.activeLease(agent);
      if (!lease) return false;
      finish(lease, "released");
      return true;
    },
    revoke(id) {
      const leases = id ? [store.getLease(id)].filter((l): l is LeaseRecord => l !== null && l.state === "active") : store.activeLeases();
      if (id && !leases.length) throw new WordError("not_found", "no such lease in force");
      for (const l of leases) finish(l, "revoked");
      return leases.length;
    },
    list: () => store.activeLeases().map(view),
    acted(agent) {
      const lease = store.activeLease(agent);
      if (!lease) return;
      store.noteLeaseAction(lease.id, deps.now());
      const wait = 1_000 - (deps.now() - lastPublished);
      if (wait <= 0) publish();
      else if (!trailing) { trailing = setTimeout(() => { trailing = undefined; publish(); }, wait); trailing.unref(); }
    },
    turnStarted(agent, turn) {
      let set = running.get(agent);
      if (!set) running.set(agent, set = new Set());
      set.add(turn);
      const lease = store.activeLease(agent);
      if (lease && lease.kind === "task" && !lease.turn) store.bindLeaseTurn(lease.id, turn);
    },
    turnEnded(agent, turn) {
      running.get(agent)?.delete(turn);
      const lease = store.activeLease(agent);
      if (lease && lease.kind === "task" && lease.turn === turn) finish(lease, "turn_ended");
    },
    sweep() { for (const l of store.dueLeases()) finish(l, "expired"); },
    start() {
      for (const l of store.askingLeases()) { if (deps.now() - l.requested_at >= CARD_MS) finish(l, "timeout"); else ask(l); }
      for (const l of store.dueLeases()) finish(l, "expired");
      for (const l of store.activeLeases()) arm(l);
    },
    stop() { if (trailing) { clearTimeout(trailing); trailing = undefined; } for (const id of [...timers.keys()]) clear(id); for (const c of cards.values()) c.abort(); cards.clear(); carded.clear(); },
  };
}
