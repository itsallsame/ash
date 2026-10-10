/** A small hub for the tests: a real ledger, registry, gate and router, with fake members. */
import { idKind } from "../../../../sdk/src/ids";
import { WordError, type HandleContext, type Message, type Reply, type WordResult } from "../../../../sdk/src/message";
import { DEFAULT_CALLERS, type Member, type WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { createGate, GateStore } from "../../../src/kernel/gate";
import { createRedact } from "../../../src/kernel/redact";
import { createRegistry } from "../../../src/kernel/registry";
import { createRouter } from "../../../src/kernel/router";
import { createGateService } from "../../../src/services/gate";
import type { Caller, GateDeps } from "../../../src/kernel/types";
import { after } from "node:test";
import { openLedger } from "../ledger/helpers";

// Cards nobody answered would keep their 600 s timers alive: stop every service when the file is done.
const services: { stop(): void }[] = [];
after(() => { for (const s of services) s.stop(); });

export const HAND = "A".repeat(22);
export const DEVICE = `device:${HAND}`;
export const BODY = `body:${HAND}`;

export const owner: Caller = { member: "person:owner", via: "human", local: true, client: "client:s1" };
export const remoteOwner: Caller = { ...owner, local: false };
export const agent = (name = "main", turn = "t1"): Caller => ({ member: `agent:${name}`, via: "agent", local: false, turn });
export const service = (name = "clock"): Caller => ({ member: `service:${name}`, via: "service", local: true });
export const app = (name = "todo"): Caller => ({ member: `app:${name}`, via: "app", local: false });
export const hand: Caller = { member: DEVICE, via: "hand", local: false };

export const word = (member: string, name: string, over: Partial<WordContract> = {}): WordContract => ({
  member, word: name, kind: "request", direction: "in", description: "a word made for a test, nothing more",
  input_schema: { type: "object", properties: {}, additionalProperties: true }, effect: "read", risk: "none",
  callers: [...DEFAULT_CALLERS], label: { doing: "在测试" }, ...over,
});

export type Handler = (msg: Message, ctx: HandleContext) => Promise<WordResult | void> | WordResult | void;
export interface Fake extends Member { calls: { msg: Message; ctx: HandleContext }[]; cancelled: string[]; handler: Handler }
export function fake(id: string, words: WordContract[], handler: Handler = () => ({ data: { ok: true } }), extra: Partial<Member> = {}): Fake {
  const calls: Fake["calls"] = [];
  const m: Fake = {
    id, kind: idKind(id) as Member["kind"], name: id, words: () => words, calls, cancelled: [], handler,
    async handle(msg, ctx) { calls.push({ msg, ctx }); return m.handler(msg, ctx); },
    cancel(requestId) { m.cancelled.push(requestId); },
    ...extra,
  };
  return m;
}

/** The owner: it answers cards when the test says so. */
export function fakeOwner() {
  const cards: { msg: Message; answer: (reply: WordResult) => void; fail: (e: Error) => void }[] = [];
  const said: Message[] = [];
  const m = fake("person:owner", wordsOf("person:owner"), (msg) => {
    if (msg.word === "say") { said.push(msg); return { data: { accepted: true } }; }
    if (msg.word === "ask") return new Promise<WordResult>((answer, fail) => { cards.push({ msg, answer, fail }); });
    return { data: { accepted: true } };
  });
  return Object.assign(m, { cards, said, answer(choice: string, index = cards.length - 1) { cards[index]!.answer({ data: { choice } }); } });
}

export function fakeAgent(name = "main") {
  const inbox: Message[] = [];
  const m = fake(`agent:${name}`, wordsOf(`agent:${name}`), (msg) => { inbox.push(msg); return { data: { accepted: true } }; });
  return Object.assign(m, { inbox });
}

export interface WorldOptions {
  review?: "allow" | "ask" | "hang";
  tiers?: Record<string, "ask" | "full">;
  assess?: (msg: Message) => Promise<"none" | "outward" | "structure" | null>;
  policies?: Record<string, { tools?: string[] | null; words?: string[] | null } | null>;
  toolWords?: (tool: string) => string[];
  appGranted?: (appId: string, to: string, word: string) => boolean;
  mayTalkToOwner?: (caller: Caller, word: string) => boolean;
  mayAnswer?: (caller: Caller, body: unknown) => boolean;
}

export function world(options: WorldOptions = {}) {
  const { ledger } = openLedger();
  const clock = { now: 1_000_000 };
  const registry = createRegistry();
  const redact = createRedact();
  const store = new GateStore(ledger, () => clock.now);
  const state = { review: options.review ?? "ask", reviews: 0 };
  const deps: GateDeps = {
    tier: (t) => options.tiers?.[t] ?? "ask",
    mode: () => store.mode(),
    ...(options.assess ? { assess: options.assess } : {}),
    review: async () => { state.reviews++; if (state.review === "hang") return new Promise(() => {}); return state.review; },
  };
  const gate = createGate(deps, store, { now: () => clock.now, reviewMs: 30, assessMs: 30 });
  const errors: { where: string; error: unknown }[] = [];
  const router = createRouter({
    ledger, registry, gate, redact, store, now: () => clock.now,
    agentPolicy: (id) => (options.policies && id in options.policies ? options.policies[id]! : {}),
    ...(options.toolWords ? { toolWords: options.toolWords } : {}),
    ...(options.appGranted ? { appGranted: options.appGranted } : {}),
    ...(options.mayTalkToOwner ? { mayTalkToOwner: options.mayTalkToOwner } : {}),
    ...(options.mayAnswer ? { mayAnswer: options.mayAnswer } : {}),
    onParked: (p) => svc.issueCard(p),
    onError: (where, error) => errors.push({ where, error }),
  });
  const svc = createGateService({
    store, gate, send: (m, c, o) => router.send(m, c, o), redeem: (id, c, o) => router.redeem(id, c, o),
    contractOf: (member, w) => registry.find(member, w)?.contract ?? null, onError: (where, error) => errors.push({ where, error }),
  });
  services.push(svc);
  const ownerMember = fakeOwner();
  const main = fakeAgent("main");
  registry.add(ownerMember); registry.add(main); registry.add(svc);
  return { ledger, registry, redact, store, gate, router, svc, clock, state, errors, owner: ownerMember, main };
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 15));
export const failure = (reply: Reply) => { if (reply.ok) throw new Error(`expected an error, got ${JSON.stringify(reply)}`); return reply.error; };
export const success = (reply: Reply) => { if (!reply.ok) throw new Error(`expected ok, got ${JSON.stringify(reply.error)}`); return reply.result?.data as any; };
export { WordError };
