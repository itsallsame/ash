/**
 * `service:gate`: the words of the approval gate (HUB-MODULES §3). Rules, mode and audit are the owner's to read and
 * change (an agent that asks always goes through the owner). The `pending.*` words belong to the agent that made the
 * request: the owner's answer reaches it as a message, and it carries the request out with `pending.redeem`.
 *
 * It also does what the router cannot: when a request is parked it sends the owner the card (`person:owner/ask`),
 * turns the answer into the gate's `answered`, and has the owner's answer said to the originator in the conversation
 * (a front turn, with the pending id and the choice in it; the agent redeems or skips by itself).
 */
import { isAgentId, OWNER_ID } from "../../../../sdk/src/ids";
import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { ALWAYS_ASK, contractFingerprint, isPayment, RULE_DAYS, type GateStore, type PendingRecord, type Rule } from "../../kernel/gate";
import type { Gate, SendOptions } from "../../kernel/types";

export const GATE_ID = "service:gate";
/** What the service itself sends as: the hub's own code. */
const SELF: Caller = { member: GATE_ID, via: "service", local: true };
/** The decisions `history` lists (the others are in `audit`). */
const HISTORY_DECISIONS = ["once", "always", "deny", "timeout", "cancelled", "rule", "review", "carry", "hand_full", "declared_none", "assessed_none"] as const;
const DAY_MS = 86_400_000;

export interface GateServiceDeps {
  store: GateStore;
  gate: Gate;
  /** `router.send`. */
  send(msg: Outgoing, caller: Caller, opts?: SendOptions): Promise<Reply>;
  /** The router's internal door: run a parked request again, approved. */
  redeem(pendingId: string, redeemer: Caller, opts?: SendOptions): Promise<Reply>;
  /** The contract of a word, for rules (the registry's `find`). */
  contractOf(member: string, word: string): WordContract | null;
  /** The name a person reads for a member (see `names.ts`); null when there is none worth showing (a service): the card then leaves the object out. Without it the card shows ids. */
  nameOf?(id: string): string | null | undefined;
  onError?(where: string, error: unknown): void;
  /** How often waiting questions are checked for their time (ms). Default 30 s. */
  sweepMs?: number;
  /**
   * After the owner answered the card [askId], says [body] to the agent [to] as the owner (once). Resolves false when the owner did not
   * answer it (it ended by its time); a refusal rejects. Absent: the agent is not spoken to.
   */
  ownerSay?(askId: string, to: string, body: Record<string, unknown>): Promise<boolean>;
}

export interface GateService extends Member {
  /** Send the owner the cards of the questions that are still open (after a restart), and begin the periodic expiry check. */
  start(): void;
  stop(): void;
  /** Expire the questions whose time has come; the originators are told. */
  sweep(): void;
  /** Send the card for one parked request (the router's `onParked`). */
  issueCard(pending: PendingRecord): void;
}

const bad = (message: string) => new WordError("bad_request", message);
const asBody = (msg: Message): Record<string, any> => (msg.body && typeof msg.body === "object" ? msg.body as Record<string, any> : {});

const ruleView = (r: Rule) => ({ id: r.id, subject: r.subject, to: r.to, word: r.word, object_pattern: r.object_pattern, risk: r.risk,
  contract_fingerprint: r.contract_fingerprint, created_at: r.created_at, expires_at: r.expires_at, ...(r.revoked_at ? { revoked_at: r.revoked_at } : {}) });

const pendingView = (p: PendingRecord) => ({ id: p.id, to: p.to, word: p.word, label: p.label, state: p.state, created_at: p.created_at, expires_at: p.expires_at });

export function createGateService(deps: GateServiceDeps): GateService {
  const { store, gate } = deps;
  const now = store.now;
  const cards = new Map<string, AbortController>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const oops = (where: string) => (error: unknown) => deps.onError?.(where, error);

  const original = (p: PendingRecord): Message => ({ seq: 0, id: p.id, ts: p.created_at, from: p.originator, to: p.to, kind: "request", word: p.word, body: p.body });

  /** A background message to the agent that made the request. Nothing is sent to an app or a service. */
  function tellOriginator(p: PendingRecord, text: string): void {
    if (!isAgentId(p.originator)) return;
    void deps.send({ to: p.originator, kind: "request", word: "tell", body: { text }, reply_to: p.id }, SELF).catch(oops("tell"));
  }
  const what = (p: PendingRecord) => `「${p.label ?? p.word}」请求（${p.to}/${p.word}，pending ${p.id}）`;

  function answered(id: string, reply: Reply & { id?: string }): void {
    const current = store.getPending(id);
    cards.delete(id);
    if (!current || current.state !== "waiting" || !reply.ok) return;     // expired, withdrawn, or the card itself failed: it stays as it is
    const asked = (reply.result?.data as { choice?: unknown } | undefined)?.choice;
    const choice = asked === "once" || asked === "always" ? (asked === "always" && !current.offer_always ? "once" : asked) : "deny";
    // A call that holds for this answer (the fast path) is told by the state change and goes on by itself: no word to the agent.
    const held = store.isHeld(id);
    const record = store.setState(id, ["waiting"], choice === "deny" ? "denied" : "approved", { choice, at: now() });
    if (!record) return;
    try { gate.answered(original(record), choice); } catch (error) { oops("answered")(error); }
    if (!held) speak(record, choice, reply.id);
  }

  /**
   * The owner's click is the approval itself; what follows is the owner saying so to the agent, in the conversation, so that it
   * takes a front turn and goes on by itself: `[answers <pending id>, option <choice>] 批准：创建虚拟屏`. An approval that ended
   * by its time was no word of the owner's: the agent is told in the background, as for an expired one.
   */
  function speak(p: PendingRecord, choice: string, askId: string | undefined): void {
    if (!isAgentId(p.originator)) return;
    const timedOut = () => tellOriginator(p, `你的${what(p)}超时没有得到主人回答，按拒绝处理。需要的话请重新提出。`);
    if (!deps.ownerSay || !askId) return;
    const doing = (p.label ?? p.word).replace(/^在/, "");
    const text = `${choice === "deny" ? "拒绝" : choice === "always" ? "以后都可以" : "批准"}：${doing}`;
    deps.ownerSay(askId, p.originator, { text, in_reply_to: p.id, option_id: choice }).then(
      (said) => { if (!said) timedOut(); },
      (error) => {
        oops("ownerSay")(error);
        tellOriginator(p, `主人${choice === "deny" ? "拒绝" : "批准"}了你的${what(p)}。${choice === "deny" ? "不要原样重复这个请求。" : `需要的话调 service:gate/pending.redeem {"id":"${p.id}"}，不需要就调 pending.skip。`}`);
      },
    );
  }

  store.onExpired = (p) => {
    cards.get(p.id)?.abort();
    cards.delete(p.id);
    tellOriginator(p, `你的${what(p)}超时没有得到主人回答，按拒绝处理。需要的话请重新提出。`);
  };

  /** What the owner reads for a member: its name; the id only when nothing knows it. */
  function nameOf(id: string): string {
    try { return deps.nameOf ? deps.nameOf(id)?.trim() || id : id; } catch { return id; }
  }
  /** The target's name, or null when it has none a person would know (a service): the sentence then has no object. */
  function targetName(id: string): string | null {
    if (!deps.nameOf) return id;
    try { return deps.nameOf(id)?.trim() || null; } catch { return id; }
  }
  const sentence = (p: PendingRecord): string => {
    const target = targetName(p.to);
    const doing = `${p.label ?? p.word}。${p.purpose ? `目的：${p.purpose}` : ""}`;
    return `${nameOf(p.originator)} ${target ? `想对「${target}」做这件事：` : "想做这件事："}${doing}`.trim();
  };

  function issueCard(p: PendingRecord): void {
    if (p.state !== "waiting") return;
    const controller = new AbortController();
    cards.set(p.id, controller);
    const preview = JSON.stringify(p.body) ?? "";
    const options = [{ id: "once", label: "可以" }, ...(p.offer_always ? [{ id: "always", label: "以后都可以" }] : []), { id: "deny", label: "不行" }];
    const body = {
      title: `需要你确认：${p.label ?? p.word}`,
      // Only words a person reads: names, not ids; the contract's label, not the word. The effect and the risk are left out: their codes
      // mean nothing to the owner, and what matters (why it is risky) is the review's reason on the first line.
      detail: [p.review_reason ? `审核：${p.review_reason}` : "", sentence(p), p.detail].filter(Boolean).join("\n"),
      human_kind: "question", options, expires_at: p.expires_at,
      source: { word: p.word, to: p.to, body_preview: preview.slice(0, 300), ...(preview.length > 300 ? { body_full: preview } : {}) },
    };
    void deps.send({ to: OWNER_ID, kind: "request", word: "ask", body, reply_to: p.id }, SELF, { signal: controller.signal })
      .then((reply) => answered(p.id, reply))
      .catch(oops("card"));
  }

  function mine(ctx: HandleContext, id: unknown): PendingRecord {
    if (ctx.caller.via !== "agent") throw new WordError("forbidden", "pending requests belong to the agent that made them");
    const p = typeof id === "string" ? store.getPending(id) : null;
    if (!p || p.originator !== ctx.caller.member) throw new WordError("not_found", "no such pending request of yours");
    return p;
  }

  function ruleSet(body: Record<string, any>): WordResult {
    const contract = deps.contractOf(body.member, body.word);
    if (!contract) throw new WordError("not_found", `${body.member} has no word ${body.word}`);
    if (contract.effect === "execute" || isPayment(contract) || ALWAYS_ASK.has(`${body.member}/${body.word}`)) {
      throw new WordError("forbidden", "commands, payments and the words about the gate and the devices always ask the owner; no rule can cover them");
    }
    const rule = store.addRule({ subject: body.agent, to: body.member, word: body.word, object_pattern: body.target ?? "*", risk: contract.risk,
      contract_fingerprint: contractFingerprint(contract), expires_at: now() + (body.days ?? RULE_DAYS) * DAY_MS, created_by: OWNER_ID });
    return { data: { id: rule.id, expires_at: rule.expires_at } };
  }

  async function handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
    const body = asBody(msg);
    switch (msg.word) {
      case "rules.list": { const page = store.listRules({ before: body.before, limit: body.limit }); return { data: { rules: page.rules.map(ruleView), mode: store.mode(), ...(page.next_before ? { next_before: page.next_before } : {}) } }; }
      case "rules.set": return ruleSet(body);
      case "rules.revoke": return { data: { revoked: store.revokeRule(body.id) } };
      case "mode.set": store.setMode(body.mode); return { data: { mode: body.mode } };
      case "audit": return { data: store.audit({ request_id: body.request_id, requester: body.requester, word: body.word, decision: body.decision, before: body.before, limit: body.limit }) };
      case "history": {
        const page = store.audit({ decisions: HISTORY_DECISIONS, before: body.before, limit: body.limit });
        const items = page.entries.map((e) => ({ id: e.request_id, request_id: e.request_id, ask_id: e.request_id, subject: e.requester, to: e.member, word: e.word, risk: e.risk,
          decision: e.decision, at: e.answered_at ?? e.at, ...(e.rule_id ? { rule_id: e.rule_id } : {}), ...(e.reason ? { reason: e.reason } : {}), ...(e.label ? { label: e.label } : {}) }));
        return { data: { items, ...(page.next_before ? { next_before: page.next_before } : {}) } };
      }
      case "pending.list": {
        if (ctx.caller.via !== "agent") throw new WordError("forbidden", "pending requests belong to the agent that made them");
        return { data: { pending: store.listPending(ctx.caller.member).map(pendingView) } };
      }
      case "pending.get": {
        const p = mine(ctx, body.id);
        return { data: { ...pendingView(p), request: { to: p.to, word: p.word, body: p.body }, ...(p.answer ? { answer: { choice: p.answer.choice, at: p.answer.at } } : {}) } };
      }
      case "pending.redeem": {
        const p = mine(ctx, body.id);
        const reply = await deps.redeem(p.id, ctx.caller, { signal: ctx.signal });
        if (!reply.ok) throw new WordError(reply.error.code, reply.error.message, { detail: reply.error.detail, recovery_hint: reply.error.recovery_hint });
        return { data: { result: reply.result?.data ?? null }, ...(reply.result?.content ? { content: reply.result.content } : {}) };
      }
      case "pending.skip": {
        const p = mine(ctx, body.id);
        if (!store.setState(p.id, ["approved", "denied", "expired"], "skipped")) throw new WordError("conflict", `this request is ${p.state}; only an answered one can be skipped`);
        const why = typeof body.reason === "string" && body.reason ? `：${body.reason}` : "";
        void deps.send({ to: OWNER_ID, kind: "request", word: "say", body: { text: `${p.originator} 决定不再执行你${p.state === "approved" ? "批准" : "回答"}过的${what(p)}${why}` } }, SELF).catch(oops("skip"));
        return { data: { skipped: true } };
      }
      case "pending.withdraw": {
        // The hub's own code (the reflex service, for the owner) may take back anyone's open question; an agent only its own.
        const p = ctx.caller.via === "service" ? store.getPending(String(body.id)) : mine(ctx, body.id);
        if (!p) throw new WordError("not_found", "no such pending request");
        const done = store.setState(p.id, ["waiting"], "withdrawn") !== null;
        if (done) { cards.get(p.id)?.abort(); cards.delete(p.id); }
        return { data: { withdrawn: done } };
      }
    }
    throw bad(`service:gate has no word ${msg.word}`);
  }

  return {
    id: GATE_ID, kind: "service", name: "gate",
    words: (): WordContract[] => wordsOf(GATE_ID),
    handle,
    issueCard,
    sweep() { store.expireDue(); },
    start() {
      for (const p of store.waiting()) issueCard(p);
      timer = setInterval(() => this.sweep(), deps.sweepMs ?? 30_000);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); for (const c of cards.values()) c.abort(); cards.clear(); },
  };
}
