import assert from "node:assert/strict";
import test from "node:test";
import { WordError } from "../../../../sdk/src/message";
import { secret, sensitive } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { agent, app, BODY, DEVICE, failure, fake, flush, hand, owner, service, success, word, world } from "./world";

const call = (w: ReturnType<typeof world>, to: string, wd: string, body: unknown = {}, caller: any = agent(), opts?: any) =>
  w.router.send({ to, kind: "request", word: wd, body }, caller, opts);

test("step 1: the shape of the message and the caller", async () => {
  const w = world();
  const bad = async (msg: any, caller: any = agent()) => failure(await w.router.send(msg, caller));
  assert.equal((await bad({ to: "service:x", kind: "response", word: "w", body: {} })).code, "bad_request");
  assert.equal((await bad({ to: null, kind: "request", word: "w", body: {} })).code, "bad_request");
  assert.equal((await bad({ to: "nobody", kind: "request", word: "w", body: {} })).code, "bad_request");
  assert.equal((await bad({ to: "service:x", kind: "request", word: "Bad Word", body: {} })).code, "bad_request");
  assert.equal((await bad({ to: "service:x", kind: "request", word: "w", body: {}, from: "person:owner" })).code, "bad_request", "extra keys are refused: `from` cannot be set");
  assert.equal((await bad({ to: "service:x", kind: "request", word: "w", body: {} }, { member: "person:owner", via: "agent", local: false })).code, "unauthorized");
  assert.equal((await bad({ to: "service:x", kind: "request", word: "w", body: {} }, { member: "agent:main", via: "robot", local: false })).code, "unauthorized");
});

test("step 2: the sender and the turn are the caller's; the origin is what the caller carries", async () => {
  const w = world();
  const t = fake("service:t", [word("service:t", "w", { effect: "write" })]);
  w.registry.add(t);
  await call(w, "service:t", "w", {}, agent("main", "t7"));
  assert.equal(t.calls[0]!.msg.from, "agent:main");
  assert.equal(t.calls[0]!.msg.turn, "t7");
  assert.equal(t.calls[0]!.ctx.caller.member, "agent:main");
  await call(w, "service:t", "w", {}, owner);
  assert.equal(t.calls[1]!.msg.origin, undefined, "the caller gave none, the router does not guess");
  const origin = { channel: "web" as const, client: "client:s1", label: "网页 · Mac Chrome" };
  await call(w, "service:t", "w", {}, { ...owner, origin });
  assert.deepEqual(t.calls[2]!.msg.origin, origin);
  assert.equal(t.calls[0]!.msg.origin, undefined);
});

test("step 4: offline, no such word, bad input, and a member that refuses first", async () => {
  const w = world();
  const t = fake("service:t", [word("service:t", "w", { input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } }),
    word("service:t", "ev", { kind: "event", callers: ["kernel"] })]);
  w.registry.add(t);
  assert.equal(failure(await call(w, "service:gone", "w")).code, "offline");
  assert.equal(failure(await call(w, "service:t", "nope")).code, "not_found");
  assert.equal(failure(await call(w, "service:t", "w", { n: "x" })).code, "bad_request");
  assert.equal(failure(await call(w, "service:t", "w", {})).code, "bad_request");
  assert.equal(failure(await call(w, "service:t", "ev", {}, service("clock"))).code, "bad_request", "an event word is not a request");
  assert.equal(t.calls.length, 0);
  assert.ok((await call(w, "service:t", "w", { n: 1 })).ok);
});

test("the caller may choose the id of a request; an id already in use is a conflict", async () => {
  const w = world();
  const t = fake("service:t", [word("service:t", "w", { effect: "write" }), word("service:t", "quiet")], () => new Promise((resolve) => setTimeout(() => resolve({ data: {} }), 30)));
  w.registry.add(t);
  const first = call(w, "service:t", "w", {}, agent(), { id: "m_chosen" });
  await flush();
  assert.equal(failure(await call(w, "service:t", "w", {}, agent(), { id: "m_chosen" })).code, "conflict", "while it is still running");
  const reply = await first;
  assert.equal((reply as { id?: string }).id, "m_chosen");
  assert.equal(t.calls[0]!.msg.id, "m_chosen");
  assert.equal(w.ledger.get("m_chosen")?.word, "w", "and it is the id in the ledger");
  assert.equal(failure(await call(w, "service:t", "w", {}, agent(), { id: "m_chosen" })).code, "conflict", "after it is recorded");
  // not recorded: still used once while it runs, free after
  assert.ok((await call(w, "service:t", "quiet", {}, service("clock"), { id: "m_quiet" })).ok);
  assert.ok((await call(w, "service:t", "quiet", {}, service("clock"), { id: "m_quiet" })).ok, "an unrecorded request leaves nothing behind");
  assert.equal(t.calls.length, 3);
});

test("step 4: the kind of the message must be the kind of the word", async () => {
  const w = world();
  w.registry.add(fake("service:t", [word("service:t", "w"), word("service:t", "ev", { kind: "event", callers: ["kernel"] })]));
  const asEvent = await w.router.send({ to: null, kind: "event", word: "w", body: {} }, service("t"));
  assert.equal(failure(asEvent).code, "bad_request");
  assert.match(failure(asEvent).message, /request, not an event/);
  const asRequest = await call(w, "service:t", "ev", {}, service("clock"));
  assert.equal(failure(asRequest).code, "bad_request");
  assert.match(failure(asRequest).message, /event, not a request/);
});

test("step 4: a precheck that refuses answers at once, asks nobody and leaves no record", async () => {
  const w = world();
  const cost = word(DEVICE, "message.send", { effect: "act", risk: "outward" });
  const t = fake(DEVICE, [cost], undefined, { precheck: () => ({ ok: false, error: { code: "conflict", message: "the app's needs changed" } }) });
  w.registry.add(t);
  const reply = await call(w, DEVICE, "message.send");
  assert.equal(failure(reply).code, "conflict");
  assert.equal(w.owner.cards.length, 0);
  assert.equal(w.store.waiting().length, 0);
  assert.equal(w.ledger.page({ limit: 10 }).length, 0);
  assert.equal(w.state.reviews, 0, "not even the review model");
});

test("step 5: the gate says no -> denied; an app refused -> forbidden", async () => {
  const w = world({ appGranted: () => true });
  w.registry.add(fake(DEVICE, [word(DEVICE, "message.send", { effect: "act", risk: "outward" })]));
  const forApp = await call(w, DEVICE, "message.send", {}, app());
  assert.equal(failure(forApp).code, "forbidden");
  assert.match(failure(forApp).message, /needs_approval/);
  const hand2 = world();
  hand2.registry.add(fake(DEVICE, [word(DEVICE, "message.send", { effect: "act", risk: "outward" })]));
  // an agent that is asked and then refused is `denied` on redeem; a deny verdict itself is for the human who is not the owner
  const stranger = { member: "person:owner", via: "human" as const, local: true };
  assert.ok((await call(hand2, DEVICE, "message.send", {}, stranger)).ok);
});

test("steps 6 and 7: an agent's request is recorded with its response, state done; the handler's result comes back", async () => {
  const w = world();
  const t = fake("service:t", [word("service:t", "look", { result_schema: { type: "object" } })], () => ({ data: { n: 1 }, content: [{ type: "text", text: "one" }] }));
  w.registry.add(t);
  const reply = await call(w, "service:t", "look", { q: 1 });
  assert.deepEqual(success(reply), { n: 1 });
  assert.equal((reply as any).result.content[0].text, "one");
  const rows = w.ledger.page({ limit: 10 });
  assert.deepEqual(rows.map((m) => [m.kind, m.from, m.to]), [["request", "agent:main", "service:t"], ["response", "service:t", "agent:main"]]);
  assert.equal(rows[1]!.reply_to, rows[0]!.id);
  assert.equal((reply as { ref?: string }).ref, rows[1]!.id, "ref is the id of the recorded response");
  assert.equal((reply as { id?: string }).id, rows[0]!.id, "id is the request's");
  const refused = await call(w, "service:gone", "x");
  assert.ok((refused as { id?: string }).id?.startsWith("m_"), "even a refusal says which request it was");
  assert.equal(w.ledger.request(rows[0]!.id)?.state, "done");
  assert.equal(t.calls[0]!.msg.id, rows[0]!.id, "the member sees the id the ledger has");
});

test("step 6: a service reading is not recorded, but is delivered and answered", async () => {
  const w = world();
  w.registry.add(fake("service:cost", [word("service:cost", "usage.get")]));
  const reply = await call(w, "service:cost", "usage.get", {}, service("clock"));
  assert.ok(reply.ok);
  assert.equal("ref" in reply, false, "nothing recorded, so no ref");
  assert.equal(w.ledger.page({ limit: 10 }).length, 0);
  const seen: string[] = [];
  w.router.subscribe({ word: "usage.get" }, (m) => seen.push(`${m.kind}:${m.seq}`));
  await call(w, "service:cost", "usage.get", {}, service("clock"));
  assert.deepEqual(seen, ["request:0"], "subscribers see it, with no ledger seq");
});

test("secrets: the ledger never holds them, the handler gets them in ctx.raw", async () => {
  const w = world();
  const set = word("service:vault", "set", { effect: "write", callers: ["owner"], input_schema: { type: "object", properties: { ref: { type: "string" }, value: secret({ type: "string" }) } } });
  const vault = fake("service:vault", [set], () => ({ data: {} }));
  w.registry.add(vault);
  await call(w, "service:vault", "set", { ref: "deepseek", value: "sk-top-secret" }, owner);
  const all = JSON.stringify(w.ledger.page({ limit: 50 }));
  assert.ok(!all.includes("sk-top-secret"), "not in the ledger");
  assert.ok(all.includes('"set":true'));
  assert.equal((vault.calls[0]!.ctx.raw as any).value, "sk-top-secret");
  assert.ok(!JSON.stringify(vault.calls[0]!.msg).includes("sk-top-secret"), "and not in the message object either");
});

test("sensitive results: the owner gets the original, an agent the masked version, the ledger the masked version", async () => {
  const w = world();
  const code = word("service:devices", "pair_code", { callers: ["owner", "agent"], result_schema: { type: "object", properties: { code: sensitive({ type: "string" }, "hidden") } } });
  w.registry.add(fake("service:devices", [code], () => ({ data: { code: "654321" } })));
  assert.equal(success(await call(w, "service:devices", "pair_code", {}, owner)).code, "654321");
  assert.notEqual(success(await call(w, "service:devices", "pair_code", {}, agent())).code, "654321");
  assert.ok(!JSON.stringify(w.ledger.page({ limit: 50 })).includes("654321"));
});

test("step 7: WordError becomes the reply's error, anything else becomes internal", async () => {
  const w = world();
  const t = fake("service:t", [word("service:t", "w")], () => { throw new WordError("conflict", "taken", { recovery_hint: "read again", detail: { x: 1 } }); });
  w.registry.add(t);
  const e = failure(await call(w, "service:t", "w"));
  assert.deepEqual([e.code, e.message, e.recovery_hint, e.detail], ["conflict", "taken", "read again", { x: 1 }]);
  t.handler = () => { throw new TypeError("secret internals"); };
  const internal = failure(await call(w, "service:t", "w"));
  assert.equal(internal.code, "internal");
  assert.ok(!internal.message.includes("secret internals"));
  assert.equal(w.errors.length, 1);
  t.handler = async () => { throw new Error("async boom"); };
  assert.equal(failure(await call(w, "service:t", "w")).code, "internal");
  const rows = w.ledger.page({ limit: 20 }).filter((m) => m.kind === "response");
  assert.equal(rows.length, 3, "failures are recorded as responses");
  assert.ok(w.ledger.unfinished().length === 0);
});

test("step 7: the timeout is the contract's, else 60 s for a read and 600 s for the rest", async () => {
  const w = world();
  w.registry.add(fake("service:t", [word("service:t", "slow", { timeout_ms: 20 })], () => new Promise(() => {})));
  assert.equal(failure(await call(w, "service:t", "slow")).code, "timeout");
  const real = global.setTimeout;
  const delays: number[] = [];
  (global as any).setTimeout = (fn: any, ms: number, ...rest: any[]) => { delays.push(ms); return real(fn, ms, ...rest); };
  try {
    w.registry.add(fake("service:u", [word("service:u", "r"), word("service:u", "w", { effect: "write" })]));
    await call(w, "service:u", "r"); await call(w, "service:u", "w");
  } finally { global.setTimeout = real; }
  assert.ok(delays.includes(60_000) && delays.includes(600_000), String(delays));
  const rows = w.ledger.page({ limit: 20 });
  assert.equal(w.ledger.request(rows[0]!.id)?.state, "done", "a timed-out request is closed");
});

test("cancel: an aborted signal calls member.cancel and answers cancelled", async () => {
  const w = world();
  const t = fake("service:t", [word("service:t", "w", { effect: "write" })], (_m, ctx) => new Promise((_r, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  w.registry.add(t);
  const controller = new AbortController();
  const pending = call(w, "service:t", "w", {}, agent(), { signal: controller.signal });
  await flush();
  controller.abort();
  assert.equal(failure(await pending).code, "cancelled");
  assert.equal(t.cancelled.length, 1);
  assert.equal(t.cancelled[0], t.calls[0]!.msg.id);
  const done = await call(w, "service:t", "w", {}, agent(), { signal: AbortSignal.abort() });
  assert.equal(failure(done).code, "cancelled");
  assert.equal(t.calls.length, 1, "already cancelled: never delivered");
});

test("subscribe is read-only and filters", async () => {
  const w = world();
  w.registry.add(fake("service:t", [word("service:t", "w", { effect: "write" })]));
  const a: string[] = []; const b: string[] = [];
  const off = w.router.subscribe({ involving: "service:t" }, (m) => a.push(m.kind));
  w.router.subscribe({ to: "service:other" }, (m) => b.push(m.kind));
  await call(w, "service:t", "w");
  assert.deepEqual(a, ["request", "response"]);
  assert.deepEqual(b, []);
  off(); await call(w, "service:t", "w"); assert.equal(a.length, 2);
});

// ---- events ------------------------------------------------------------------------------------------------------
test("an event goes to the member it names and to everyone who listens (a prefix too), not to the sender", async () => {
  const w = world();
  const ev = (member: string, name: string, over = {}) => word(member, name, { kind: "event", callers: ["kernel"], ...over });
  const senses = fake("service:senses", [ev("service:senses", "sense.location", { direction: "in" })]);
  const rules = fake("app:rules", [], undefined, { listens: ["sense.*"] });
  const other = fake("app:other", [], undefined, { listens: ["widget.*"] });
  const phone = fake(DEVICE, [ev(DEVICE, "sense.location", { direction: "out" })], undefined, { listens: ["sense.location"] });
  for (const m of [senses, rules, other, phone]) w.registry.add(m);
  const reply = await w.router.send({ to: "service:senses", kind: "event", word: "sense.location", body: { lat: 1 } }, hand);
  assert.ok(reply.ok);
  await flush();
  assert.equal(senses.calls.length, 1);
  assert.equal(rules.calls.length, 1);
  assert.equal(other.calls.length, 0);
  assert.equal(phone.calls.length, 0, "the sender does not hear itself");
  assert.deepEqual(rules.calls[0]!.msg.body, { lat: 1 });
  assert.equal(w.ledger.page({ limit: 10 }).length, 0, "sense.* is not recorded");
});

test("a named event is delivered to the member that is here, whether it declares the event or listens or not", async () => {
  const w = world();
  const quiet = fake("app:quiet", []);
  w.registry.add(quiet);
  w.registry.add(fake("service:clock", [word("service:clock", "tick.now", { kind: "event", callers: ["kernel"] })]));
  assert.ok((await w.router.send({ to: "app:quiet", kind: "event", word: "tick.now", body: {} }, service("clock"))).ok);
  await flush();
  assert.equal(quiet.calls.length, 1);
  assert.equal(failure(await w.router.send({ to: "app:gone", kind: "event", word: "tick.now", body: {} }, service("clock"))).code, "offline");
});

test("an event to nobody (to = null) goes to subscribers and listeners only; the sender's declaration describes it; record: true is recorded", async () => {
  const w = world();
  const listener = fake("service:history", [], undefined, { listens: ["turn.ended"] });
  const ended = (member: string) => ({ ...wordsOf("agent:main").find((c) => c.word === "turn.ended")!, member });
  w.registry.add(listener);
  w.registry.add(fake("service:agents", [ended("service:agents")]));
  const seen: string[] = [];
  w.router.subscribe({ word: "turn.ended" }, (m) => seen.push(m.from));
  const agents = service("agents");
  const body = { turn: "t1", lane: "front", outcome: "completed" };
  const first = await w.router.send({ to: null, kind: "event", word: "turn.ended", body }, agents);
  assert.ok(first.ok, JSON.stringify(first));
  await flush();
  assert.equal(listener.calls.length, 1);
  assert.equal(w.main.calls.length, 0, "to = null: only subscribers and listeners");
  assert.deepEqual(seen, ["service:agents"]);
  assert.deepEqual(w.ledger.page({ limit: 10 }).map((m) => [m.kind, m.word]), [["event", "turn.ended"]]);
  assert.equal(failure(await w.router.send({ to: null, kind: "event", word: "turn.ended", body: {} }, agents)).code, "bad_request");
  assert.equal(failure(await w.router.send({ to: null, kind: "event", word: "never.declared", body: {} }, agents)).code, "forbidden", "not among the sender's words");
  assert.equal(failure(await w.router.send({ to: "service:gone", kind: "event", word: "turn.ended", body }, agents)).code, "offline");
  assert.equal(failure(await w.router.send({ to: null, kind: "event", word: "turn.ended", body }, agent("other"))).code, "forbidden", "an agent that does not declare it");
});

test("a failing listener does not fail the sender", async () => {
  const w = world();
  w.registry.add(fake("service:human", [word("service:human", "typing", { kind: "event", callers: ["kernel"] })]));
  w.registry.add(fake("app:bad", [], () => { throw new Error("boom"); }, { listens: ["typing"] }));
  assert.ok((await w.router.send({ to: null, kind: "event", word: "typing", body: {} }, service("human"))).ok);
  await flush();
  assert.equal(w.errors.length, 1);
});

// ---- restart -------------------------------------------------------------------------------------------------------
test("recover: dispatched requests become interrupted and their agent is told, nothing is replayed; waiting_owner is left", async () => {
  const w = world();
  const t = fake("service:t", [word("service:t", "w", { effect: "write", timeout_ms: 5000 })], () => new Promise(() => {}));
  w.registry.add(t);
  void call(w, "service:t", "w", { a: 1 });
  await flush();
  const parked = w.ledger.append({ from: "agent:main", to: DEVICE, kind: "request", word: "message.send", body: {} }, { request: { state: "waiting_owner", deadline: 9e12 } });
  const open = w.ledger.unfinished();
  assert.deepEqual(open.map((r) => r.state).sort(), ["dispatched", "waiting_owner"]);
  w.router.recover();
  await flush();
  const after = w.ledger.unfinished();
  assert.deepEqual(after.map((r) => r.id), [parked.id], "only the waiting one is still open");
  const request = open.find((r) => r.state === "dispatched")!;
  assert.equal(w.ledger.request(request.id)?.state, "interrupted");
  assert.equal(t.calls.length, 1, "not replayed");
  assert.equal(w.main.inbox.length, 1);
  assert.match((w.main.inbox[0]!.body as any).text, /结果不确定/);
  assert.equal(w.main.inbox[0]!.reply_to, request.id);
  const response = w.ledger.page({ limit: 50 }).find((m) => m.kind === "response" && m.reply_to === request.id)!;
  assert.equal((response.body as any).error.code, "result_unknown");
  w.router.recover();
  await flush();
  assert.equal(w.main.inbox.length, 1, "a second call finds nothing to do");
});

test("recover: a requester that is not an agent is not messaged", async () => {
  const w = world();
  w.registry.add(fake("service:t", [word("service:t", "w", { effect: "write", timeout_ms: 5000 })], () => new Promise(() => {})));
  void call(w, "service:t", "w", {}, service("clock"));
  await flush();
  w.router.recover();
  await flush();
  assert.equal(w.main.inbox.length, 0);
  assert.equal(w.ledger.unfinished().length, 0);
});
void BODY;
