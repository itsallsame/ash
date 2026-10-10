/**
 * The router (HUB-MODULES §1.4, SPEC-01 §5): the one way a word reaches a member. `send` is seven fixed steps in a fixed
 * order; there is no branch that skips one.
 *
 *   1 validate   2 stamp   3 authorize   4 find the endpoint   5 gate   6 record   7 deliver
 *
 * Step 3 needs the word's contract, so the endpoint is looked up first; what that lookup finds (offline, no such word)
 * is answered in step 4, after authorization. Events go through 1 to 4 and 6, never the gate.
 */
import { randomBytes } from "node:crypto";
import { idKind, isAgentId, isMemberId } from "../../../../sdk/src/ids";
import { CALLER_VIAS, errorBody, WordError, type ErrorBody, type HumanOrigin, type Outgoing, type Reply, type WordResult } from "../../../../sdk/src/message";
import { compileSchema, WORD_NAME_PATTERN, type Member, type WordContract } from "../../../../sdk/src/word";
import { DEFAULT_TTL_MINUTES, type GateStore, type PendingRecord } from "../gate";
import type { Ledger } from "../ledger";
import type { Caller, Gate, Message, Redact, Registry, Router, SendOptions, SendReply } from "../types";
import { authorize, type AuthDeps } from "./authorize";
import { shouldRecord } from "./record";

export interface RouterDeps extends AuthDeps {
  ledger: Ledger;
  registry: Registry;
  gate: Gate;
  redact: Redact;
  /** The pending requests the gate keeps (kernel/gate/store). */
  store: GateStore;
  /** A request was parked for the owner; `service:gate` sends the card. */
  onParked(pending: PendingRecord): void;
  /** Something went wrong that the sender is not told about (a failed notification, an event nobody could take). */
  onError?(where: string, error: unknown): void;
  now?: () => number;
}

/** What `waiting_owner` looks like as a reply. */
export const waitingOwner = (pendingId: string, expiresAt: number): Reply => ({ ok: true, result: { data: { status: "waiting_owner", pending_id: pendingId, expires_at: expiresAt } } });

const READ_TIMEOUT_MS = 60_000;
const OTHER_TIMEOUT_MS = 600_000;
/** The caller of the messages the router itself sends (a restart note). */
const ROUTER_CALLER: Caller = { member: "service:router", via: "service", local: true };
const OUTGOING_KEYS = new Set(["to", "kind", "word", "body", "reply_to", "thread"]);

const fail = (error: ErrorBody): Reply => ({ ok: false, error });
const newId = () => `m_${randomBytes(9).toString("base64url")}`;

/** A caller as the edges may give it: the human edge can also hand over where the owner came from. */
export type RouterCaller = Caller & { origin?: HumanOrigin };

function validate(msg: Outgoing, caller: RouterCaller): ErrorBody | null {
  if (!msg || typeof msg !== "object") return errorBody("bad_request", "the message must be an object");
  const extra = Object.keys(msg).filter((k) => !OUTGOING_KEYS.has(k));
  if (extra.length) return errorBody("bad_request", `unknown keys: ${extra.join(", ")}`);
  if (msg.kind !== "request" && msg.kind !== "event") return errorBody("bad_request", "kind must be request or event");
  if (typeof msg.word !== "string" || !WORD_NAME_PATTERN.test(msg.word)) return errorBody("bad_request", "word must be lower-case dotted segments");
  if (msg.to === null ? msg.kind === "request" : !isMemberId(msg.to)) return errorBody("bad_request", msg.to === null ? "a request needs a recipient" : `to is not a member id: ${String(msg.to)}`);
  for (const key of ["reply_to", "thread"] as const) if (msg[key] !== undefined && (typeof msg[key] !== "string" || !msg[key])) return errorBody("bad_request", `${key} must be a non-empty string`);

  if (!caller || typeof caller !== "object" || !(CALLER_VIAS as readonly string[]).includes(caller.via) || typeof caller.local !== "boolean") return errorBody("unauthorized", "the caller is not valid");
  const kind = idKind(caller.member);
  const wanted = { human: "person", agent: "agent", hand: "device", app: "app", service: "service" }[caller.via];
  if (kind !== wanted) return errorBody("unauthorized", `${String(caller.member)} cannot call as ${caller.via}`);
  return null;
}

const validators = new WeakMap<object, ReturnType<typeof compileSchema>>();
function checkInput(contract: WordContract, body: unknown): ErrorBody | null {
  let check = validators.get(contract);
  if (!check) {
    try { check = compileSchema(contract.input_schema); } catch (error) { return errorBody("internal", `the schema of ${contract.member}/${contract.word} does not compile: ${(error as Error).message}`); }
    validators.set(contract, check);
  }
  if (check(body)) return null;
  const problems = (check.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
  return errorBody("bad_request", `the input does not match ${contract.member}/${contract.word}: ${problems}`, { detail: check.errors });
}

function toError(error: unknown): ErrorBody {
  if (error instanceof WordError) return errorBody(error.code, error.message, { detail: error.detail, recovery_hint: error.recovery_hint });
  return errorBody("internal", "the hub failed while handling this request");
}

interface Located { member: Member | null; contract: WordContract | null; problem: ErrorBody | null }

interface Resume { pending: PendingRecord; raw: unknown }

export class HubRouter implements Router {
  private readonly now: () => number;
  private readonly subscribers = new Set<{ filter: Parameters<Router["subscribe"]>[0]; cb: (m: Message) => void }>();
  /** Bodies that held a secret, kept while their request waits for the owner. Never on disk. */
  private readonly held = new Map<string, unknown>();

  constructor(private readonly deps: RouterDeps) { this.now = deps.now ?? Date.now; }

  send(msg: Outgoing, caller: Caller, opts: SendOptions = {}): Promise<SendReply> { return this.run(msg, caller, opts, null); }

  /** The internal door of `service:gate/pending.redeem`: run the stored request again, approved, once. */
  async redeem(pendingId: string, redeemer: Caller, opts: SendOptions = {}): Promise<SendReply> {
    const pending = this.deps.store.getPending(pendingId);
    if (!pending) return fail(errorBody("not_found", "no such pending request"));
    if (pending.state !== "approved") return fail(errorBody("conflict", pending.state === "redeemed" ? "this approval was already used" : `this request is ${pending.state}, not approved`));
    const raw = pending.has_secret ? this.held.get(pendingId) : pending.body;
    if (pending.has_secret && raw === undefined) return fail(errorBody("conflict", "the hub restarted and no longer holds the secret this request carried; make the request again"));
    const msg: Outgoing = { to: pending.to, kind: "request", word: pending.word, body: raw, ...(pending.thread ? { thread: pending.thread } : {}) };
    return this.run(msg, { ...pending.caller, turn: redeemer.turn }, opts, { pending, raw });
  }

  subscribe(filter: Parameters<Router["subscribe"]>[0], cb: (m: Message) => void): () => void {
    const entry = { filter, cb };
    this.subscribers.add(entry);
    return () => { this.subscribers.delete(entry); };
  }

  recover(): void {
    const { ledger } = this.deps;
    for (const r of ledger.unfinished()) {
      if (r.state !== "dispatched") continue;
      ledger.setRequest(r.id, "interrupted");
      const error = errorBody("result_unknown", "内核重启，结果不确定，请先查再决定要不要重做");
      ledger.append({ from: r.to, to: r.from, kind: "response", word: r.word, body: { ok: false, error }, reply_to: r.id });
      if (isAgentId(r.from)) {
        const text = `内核重启，你之前发给 ${r.to} 的 ${r.word} 请求（${r.id}）结果不确定，没有重放。请先查一下现状，再决定要不要重做。`;
        void this.send({ to: r.from, kind: "request", word: "tell", body: { text }, reply_to: r.id }, ROUTER_CALLER).catch((e) => this.deps.onError?.("recover", e));
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------

  private locate(msg: Message): Located {
    const { registry } = this.deps;
    if (msg.kind === "request") {
      if (!registry.describe(msg.to!)) return { member: null, contract: null, problem: errorBody("offline", `${msg.to} is not connected`) };
      const found = registry.find(msg.to!, msg.word);
      if (!found) return { member: null, contract: null, problem: errorBody("not_found", `${msg.to} has no word ${msg.word}`) };
      if (found.contract.kind !== "request") return { member: found.member, contract: found.contract, problem: errorBody("bad_request", `${msg.word} is an event, not a request`) };
      return { member: found.member, contract: found.contract, problem: null };
    }
    // An event is described by the member it goes to, else by the member that sends it, else by whoever declares it:
    // the hub's own modules send events on behalf of others (the agents module sends `turn.ended`, which `agent:*` declares).
    const to = msg.to === null ? null : registry.find(msg.to, msg.word);
    if (msg.to !== null && !registry.describe(msg.to)) return { member: null, contract: null, problem: errorBody("offline", `${msg.to} is not connected`) };
    const declarer = registry.findByWord(msg.word)[0];
    const contract = to?.contract ?? registry.find(msg.from, msg.word)?.contract ?? (declarer && registry.find(declarer.id, msg.word)?.contract) ?? null;
    if (!contract) return { member: null, contract: null, problem: errorBody("not_found", `no member declares the event ${msg.word}`) };
    if (contract.kind !== "event") return { member: null, contract, problem: errorBody("bad_request", `${msg.word} is a request, not an event`) };
    return { member: to?.member ?? null, contract, problem: null };
  }

  private async run(out: Outgoing, caller: RouterCaller, opts: SendOptions, resume: Resume | null): Promise<SendReply> {
    const { ledger, registry, gate, redact, store } = this.deps;

    // 1. validate
    const bad = validate(out, caller);
    if (bad) return fail(bad);

    // 2. stamp: the sender and the origin come from the caller, never from the message
    const raw = out.body === undefined ? {} : out.body;
    const stamped: Message = {
      seq: 0, id: resume ? resume.pending.id : newId(), ts: resume ? resume.pending.created_at : this.now(), from: caller.member, to: out.to, kind: out.kind, word: out.word, body: raw,
      ...(out.reply_to ? { reply_to: out.reply_to } : {}), ...(out.thread ? { thread: out.thread } : {}), ...(caller.turn ? { turn: caller.turn } : {}),
      ...(caller.via === "human" && (caller.origin || caller.client) ? { origin: caller.origin ?? { channel: caller.local ? "app" : "web", client: caller.client!, label: caller.local ? "本机" : "远程" } } : {}),
    };

    // 3. authorize
    const located = this.locate(stamped);
    const refused = authorize(stamped, located.contract, caller, this.deps);
    if (refused) return fail(refused);

    // 4. find the endpoint; check the input; let the member refuse first
    if (located.problem || !located.contract) return fail(located.problem!);
    const contract = located.contract;
    const invalid = checkInput(contract, raw);
    if (invalid) return fail(invalid);
    // The gate, the ledger and the handler's message see the body with secrets masked; only `ctx.raw` has them.
    const view = redact.forLedger(stamped, contract);
    const early = located.member?.precheck?.(view);
    if (early) return early;

    if (stamped.kind === "event") return this.deliverEvent(stamped, view, contract, caller, located.member);
    const member = located.member!;

    // 5. the gate
    if (resume) {
      if (!store.setState(resume.pending.id, ["approved"], "redeemed")) return fail(errorBody("conflict", "this approval was already used"));
      store.amend(resume.pending.id, { executed: this.now() });
      this.held.delete(resume.pending.id);
    } else {
      const decision = await gate.decide(view, contract, caller);
      if (decision.verdict === "deny") {
        return fail(caller.via === "app" ? errorBody("forbidden", decision.reason ?? "an app cannot do this", { recovery_hint: "An app cannot ask the owner. Leave it to an agent or the owner." })
          : errorBody("denied", decision.reason ?? "the gate refused"));
      }
      if (decision.verdict === "ask") return this.park(stamped, view, raw, contract, caller, decision.offer_always, opts, member);
    }

    // 6. record
    const timeout = contract.timeout_ms ?? (contract.effect === "read" ? READ_TIMEOUT_MS : OTHER_TIMEOUT_MS);
    const record = resume !== null || shouldRecord(stamped, contract, caller);
    let recorded: Message = view;
    try {
      if (resume) ledger.setRequest(stamped.id, "dispatched");
      else if (record) recorded = { ...view, seq: ledger.append(view, { request: { state: "dispatched", deadline: stamped.ts + timeout } }).seq };
    } catch (error) { this.deps.onError?.("record", error); return fail(errorBody("internal", "the request could not be recorded")); }
    this.publish(recorded);

    // 7. deliver
    const reply = await this.deliver(recorded, member, caller, raw, timeout, opts.signal);
    const shown: SendReply = this.forCaller(reply, contract, caller);
    if (record) {
      try {
        const response = redact.forLedger({ seq: 0, id: newId(), ts: this.now(), from: stamped.to!, to: stamped.from, kind: "response", word: stamped.word, body: reply, reply_to: stamped.id, ...(stamped.thread ? { thread: stamped.thread } : {}) }, contract);
        const done = ledger.append(response);
        ledger.setRequest(stamped.id, "done");
        this.publish({ ...response, seq: done.seq });
        shown.ref = done.id;
      } catch (error) { this.deps.onError?.("record", error); }
    }
    return shown;
  }

  private park(stamped: Message, view: Message, raw: unknown, contract: WordContract, caller: Caller, offerAlways: boolean, opts: SendOptions, member: Member): Reply {
    const ttl = Math.min(Math.max(Math.trunc(opts.approval?.ttl_minutes ?? DEFAULT_TTL_MINUTES) || DEFAULT_TTL_MINUTES, 1), 10_080);
    const expires = stamped.ts + ttl * 60_000;
    // The member may say more about what this request will do (an app install: the permissions it takes); the card carries it.
    let detail: string | null = null;
    try { detail = member.cardDetail?.(view) ?? null; } catch (error) { this.deps.onError?.("cardDetail", error); }
    try {
      this.deps.ledger.tx(() => {
        this.deps.ledger.append(view, { request: { state: "waiting_owner", deadline: expires } });
        const hasSecret = JSON.stringify(view.body) !== JSON.stringify(raw);
        const pending = this.deps.store.park({
          id: stamped.id, originator: caller.member, caller, to: stamped.to!, word: stamped.word, body: view.body, has_secret: hasSecret,
          ...(stamped.thread ? { thread: stamped.thread } : {}), label: contract.label.doing, expires_at: expires, offer_always: offerAlways,
          ...(opts.approval?.purpose ? { purpose: opts.approval.purpose } : {}), ...(detail ? { detail } : {}),
        });
        if (hasSecret) this.held.set(pending.id, raw);
        queueMicrotask(() => { try { this.deps.onParked(pending); } catch (error) { this.deps.onError?.("onParked", error); } });
      });
    } catch (error) { this.deps.onError?.("park", error); return fail(errorBody("internal", "the request could not be parked")); }
    return waitingOwner(stamped.id, expires);
  }

  private deliver(msg: Message, member: Member, caller: Caller, raw: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      const controller = new AbortController();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (reply: Reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(reply);
      };
      const stop = (reply: Reply) => {
        if (settled) return;
        controller.abort();
        try { member.cancel?.(msg.id); } catch (error) { this.deps.onError?.("cancel", error); }
        finish(reply);
      };
      const onAbort = () => stop(fail(errorBody("cancelled", "the request was cancelled")));
      timer = setTimeout(() => stop(fail(errorBody("timeout", `no result within ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => member.handle(msg, { signal: controller.signal, caller, raw })).then(
        (result) => finish(result ? { ok: true, result } : { ok: true }),
        (error) => { if (!(error instanceof WordError)) this.deps.onError?.("handle", error); finish(fail(toError(error))); },
      );
    });
  }

  /** The reply the caller gets: sensitive fields masked for everyone but the owner. */
  private forCaller(reply: Reply, contract: WordContract, caller: Caller): Reply {
    if (!reply.ok || reply.result?.data === undefined) return reply;
    const data = this.deps.redact.forCaller(reply.result.data, contract, caller);
    return data === reply.result.data ? reply : { ok: true, result: { ...(reply.result as WordResult), data } };
  }

  /** Events: to the member named, and to every member that listens; nobody waits for the answer. */
  private deliverEvent(stamped: Message, view: Message, contract: WordContract, caller: Caller, to: Member | null): Reply {
    let recorded = view;
    if (shouldRecord(stamped, contract, caller)) {
      try { recorded = { ...view, seq: this.deps.ledger.append(view).seq }; } catch (error) { this.deps.onError?.("record", error); return fail(errorBody("internal", "the event could not be recorded")); }
    }
    this.publish(recorded);
    const targets = new Map<string, Member>();
    if (stamped.to !== null) {
      const named = to ?? this.deps.registry.find(stamped.to, stamped.word)?.member;
      if (named) targets.set(named.id, named);
    }
    for (const m of this.deps.registry.listeners(stamped.word)) targets.set(m.id, m);
    targets.delete(stamped.from);
    for (const m of targets.values()) {
      const controller = new AbortController();
      Promise.resolve().then(() => m.handle(recorded, { signal: controller.signal, caller, raw: stamped.body })).catch((e) => this.deps.onError?.(`event ${stamped.word} to ${m.id}`, e));
    }
    return { ok: true };
  }

  private publish(m: Message): void {
    for (const { filter, cb } of this.subscribers) {
      if (filter.to !== undefined && m.to !== filter.to) continue;
      if (filter.from !== undefined && m.from !== filter.from) continue;
      if (filter.involving !== undefined && m.from !== filter.involving && m.to !== filter.involving) continue;
      if (filter.word !== undefined && m.word !== filter.word) continue;
      try { cb(m); } catch (error) { this.deps.onError?.("subscriber", error); }
    }
  }
}

export function createRouter(deps: RouterDeps): HubRouter { return new HubRouter(deps); }
