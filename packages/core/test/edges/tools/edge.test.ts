import assert from "node:assert/strict";
import test from "node:test";
import type { Reply } from "../../../../sdk/src/message";
import { HELPER, MAIN, deferred, fakeRouter, openLedger, rawPost, startRig } from "./helpers";
import { createToolsEdge, type ToolsRouter } from "../../../src/edges/tools";
import type { Router } from "../../../src/kernel/types";

// the kernel router fits what the tool surface needs from it (a compile-time check)
const _fits: ToolsRouter = {} as Router;
void _fits;

const ok = (data?: unknown, content?: any[]): Reply => ({ ok: true, result: { ...(data !== undefined ? { data } : {}), ...(content ? { content } : {}) } });
const fail = (code: any, message = "no", extra: object = {}): Reply => ({ ok: false, error: { code, message, ...extra } });
const png = (extra = 8) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(extra, 1)]).toString("base64");

// ---- transport and identity ----------------------------------------------------------------------------------------

test("no token, a wrong token, a token that was replaced or revoked, and an Origin header are all refused", async () => {
  const rig = await startRig();
  const good = rig.token();
  assert.equal((await rawPost(rig.url, { authorization: `Bearer ${good}` })).status, 200, "the right token is let in");

  const none = await rawPost(rig.url, {});
  assert.equal(none.status, 401);
  assert.equal(JSON.parse(none.body).error.code, "unauthorized");
  assert.equal((await rawPost(rig.url, { authorization: "Bearer not-a-token" })).status, 401);
  assert.equal((await rawPost(rig.url, { authorization: good.slice(0, -1) })).status, 401, "not a Bearer header");

  const origin = await rawPost(rig.url, { authorization: `Bearer ${good}`, origin: "http://evil.example" });
  assert.equal(origin.status, 403, "a browser page may not talk here even with the token");
  assert.equal(JSON.parse(origin.body).error.code, "forbidden");

  const fresh = rig.edge.issueToken(MAIN);
  assert.notEqual(fresh, good);
  assert.equal((await rawPost(rig.url, { authorization: `Bearer ${good}` })).status, 401, "the old token stopped when a new one was issued");
  assert.equal((await rawPost(rig.url, { authorization: `Bearer ${fresh}` })).status, 200);
  rig.edge.revoke(MAIN);
  assert.equal((await rawPost(rig.url, { authorization: `Bearer ${fresh}` })).status, 401, "revoked");
  assert.equal((await rawPost(rig.url, { authorization: `Bearer ${fresh}` }, "not json")).status, 401);
});

test("the token decides who the agent is; a second agent has its own token and cannot act as the first", async () => {
  const rig = await startRig();
  const a = await rig.client(MAIN);
  const b = await rig.client(HELPER);
  await a.call("human_say", { text: "hi" });
  await b.call("human_say", { text: "hi" });
  assert.deepEqual(rig.router.sent.map((s) => [s.caller.member, s.caller.turn, s.caller.via, s.caller.local]), [[MAIN, "turn-1", "agent", true], [HELPER, "turn-h", "agent", true]]);
  // an `agent` argument is the word's own input, never an identity
  assert.equal((await a.call("timer_list", { as: HELPER })).isError, false, "the router decides about the body");
  assert.equal(rig.router.sent.at(-1)!.caller.member, MAIN);
});

test("a token for an agent that is no longer declared is refused", async () => {
  const rig = await startRig();
  const token = rig.token();
  rig.policies.set(MAIN, null);
  const res = await rawPost(rig.url, { authorization: `Bearer ${token}` });
  assert.equal(res.status, 403);
});

test("outside a turn every call is refused, the receipt tools and the tool list excepted", async () => {
  const rig = await startRig();
  const tools = await rig.client();
  rig.turns.set(MAIN, null);
  assert.ok((await tools.tools()).length > 30, "the agent runtime lists tools when it starts, before any turn");
  for (const [name, args] of [["human_say", { text: "x" }], ["capability_list", {}], ["capability_describe", { member: "service:clock" }], ["capability_call", { member: "service:clock", word: "list" }], ["timer_list", {}]] as const) {
    const res = await tools.call(name, args);
    assert.equal(res.isError, true, name);
    assert.equal(res.data.error.code, "forbidden", name);
    assert.ok(res.data.error.recovery_hint, name);
  }
  assert.equal(rig.router.sent.length, 0, "nothing reached the router");
  assert.deepEqual((await tools.call("list_pending")).data, { pending: [] });
  assert.equal((await tools.call("cancel", { request_id: "r_nothing" })).data.error.code, "not_found");
  assert.equal((await tools.call("await_result", { request_id: "r_nothing" })).data.error.code, "not_found");
  rig.turns.set(MAIN, "turn-2");
  assert.equal((await tools.call("timer_list")).isError, false);
  assert.equal(rig.router.sent[0]!.caller.turn, "turn-2", "the turn of the moment of the call");
});

test("tools/list and calls follow the declaration's tools; the receipt tools are always there", async () => {
  const rig = await startRig();
  rig.policies.set(MAIN, { tools: ["timer_*", "capability_list"] });
  const tools = await rig.client();
  const names = (await tools.tools()).map((t) => t.name).sort();
  assert.deepEqual(names, ["await_result", "cancel", "capability_list", "human_pending", "human_pending_get", "human_pending_redeem", "human_pending_skip", "human_withdraw", "list_pending", "timer_cancel", "timer_list", "timer_set"],
    "the receipt tools and the five tools of the agent's own pending requests are always there");
  const refused = await tools.call("human_say", { text: "x" });
  assert.equal(refused.data.error.code, "forbidden");
  assert.equal((await tools.call("no_such_tool")).data.error.code, "not_found");
  assert.equal(rig.router.sent.length, 0);
  assert.equal((await tools.call("timer_list")).isError, false);
});

// ---- the call envelope ---------------------------------------------------------------------------------------------

test("approval_ttl_minutes, purpose and wait are taken out first: the word gets only its own body", async () => {
  const rig = await startRig();
  const tools = await rig.client();
  await tools.call("capability_call", { member: "service:clock", word: "set", body: { to: "person:owner", word: "say", body: {}, label: "x" }, purpose: "remind", approval_ttl_minutes: 5, wait: true });
  let sent = rig.router.sent.at(-1)!;
  assert.deepEqual(sent.msg, { to: "service:clock", kind: "request", word: "set", body: { to: "person:owner", word: "say", body: {}, label: "x" } });
  assert.deepEqual(sent.opts?.approval, { ttl_minutes: 5, purpose: "remind" });
  assert.deepEqual(sent.caller, { member: MAIN, via: "agent", local: true, turn: "turn-1" });

  // a fixed tool that may ask the owner: same
  await tools.call("approval_rule_add", { agent: HELPER, member: "service:clock", word: "set", purpose: "to remind", approval_ttl_minutes: 30 });
  sent = rig.router.sent.at(-1)!;
  assert.deepEqual(sent.msg.body, { agent: HELPER, member: "service:clock", word: "set" });
  assert.deepEqual(sent.opts?.approval, { ttl_minutes: 30, purpose: "to remind" });

  // agent_ask has wait, and no approval fields
  await tools.call("agent_ask", { agent: HELPER, text: "q", wait: false });
  sent = rig.router.sent.at(-1)!;
  assert.deepEqual(sent.msg.body, { agent: HELPER, text: "q" });
  assert.equal(sent.opts?.approval, undefined);

  // no envelope given: no approval option at all
  await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(rig.router.sent.at(-1)!.opts?.approval, undefined);
  assert.deepEqual(rig.router.sent.at(-1)!.msg.body, {});

  // a tool that has no envelope does not eat the names: they stay in the body and the word refuses them
  await tools.call("timer_list", { purpose: "p" });
  assert.deepEqual(rig.router.sent.at(-1)!.msg.body, { purpose: "p" });
});

test("a bad envelope is bad_request and nothing is sent", async () => {
  const rig = await startRig();
  const tools = await rig.client();
  const before = rig.router.sent.length;
  for (const args of [{ approval_ttl_minutes: 0 }, { approval_ttl_minutes: 10081 }, { approval_ttl_minutes: 1.5 }, { purpose: "x".repeat(501) }, { wait: "yes" }]) {
    const res = await tools.call("capability_call", { member: "service:clock", word: "list", ...args });
    assert.equal(res.data.error.code, "bad_request", JSON.stringify(args));
  }
  for (const args of [{}, { member: "service:clock" }, { member: "service:clock", word: "list", body: [] }, { member: "service:clock", word: "list", extra: 1 }]) {
    assert.equal((await tools.call("capability_call", args)).data.error.code, "bad_request", JSON.stringify(args));
  }
  assert.equal(rig.router.sent.length, before);
});

test("human_confirm is person:owner/ask with human_kind confirmation; both tools fill expires_at from approval_ttl_minutes and nothing else", async () => {
  const rig = await startRig({ router: fakeRouter(() => new Promise<Reply>(() => {})), now: () => 1_000_000 });
  const tools = await rig.client();
  const options = [{ id: "a", label: "面" }, { id: "b", label: "饭" }];
  const asked = await tools.call("human_ask", { title: "晚饭?", options, purpose: "dinner", approval_ttl_minutes: 2 });
  assert.equal(asked.data.status, "waiting_owner");
  assert.deepEqual(rig.router.sent.at(-1)!.msg, { to: "person:owner", kind: "request", word: "ask", body: { title: "晚饭?", options, expires_at: 1_000_000 + 120_000 } });
  assert.equal(asked.data.expires_at, 1_000_000 + 120_000, "the receipt reads it from the body");
  assert.equal(rig.router.sent.at(-1)!.opts?.approval?.purpose, "dinner");

  const confirmed = await tools.call("human_confirm", { title: "删掉吗" });
  assert.deepEqual(rig.router.sent.at(-1)!.msg.body, { title: "删掉吗", human_kind: "confirmation", expires_at: 1_000_000 + 600_000 }, "no options are made up: the owner's side offers yes and no");
  assert.equal(confirmed.data.expires_at, 1_000_000 + 600_000);
  await tools.call("human_ask", { title: "删掉吗", human_kind: "confirmation", expires_at: 5 });
  assert.deepEqual(rig.router.sent.at(-1)!.msg.body, { title: "删掉吗", human_kind: "confirmation", expires_at: 5 }, "what the agent gave stays");
  assert.equal(((await tools.tools()).find((t) => t.name === "human_ask")!.description ?? "").includes("message later"), false);
});

// ---- receipts ------------------------------------------------------------------------------------------------------

test("a call that takes long gives accepted + request_id; await_result brings the result, and again", async () => {
  const gate = deferred<Reply>();
  const rig = await startRig({ router: fakeRouter(() => gate.promise) });
  const tools = await rig.client();
  const first = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(first.isError, false);
  assert.equal(first.data.status, "accepted");
  assert.match(first.data.request_id, /^r_/);
  assert.equal(first.data.member, "service:clock");
  assert.ok(first.data.guidance);

  assert.deepEqual((await tools.call("list_pending")).data.pending.map((p: any) => [p.request_id, p.member, p.word]), [[first.data.request_id, "service:clock", "list"]]);
  const waiting = await tools.call("await_result", { request_id: first.data.request_id, timeout_ms: 30 });
  assert.equal(waiting.data.status, "accepted", "still running: the receipt again");

  const later = tools.call("await_result", { request_id: first.data.request_id });
  gate.resolve(ok({ timers: [1, 2] }));
  const done = await later;
  assert.equal(done.isError, false);
  assert.deepEqual(done.data, { timers: [1, 2] });
  assert.deepEqual((await tools.call("await_result", { request_id: first.data.request_id })).data, { timers: [1, 2] }, "asking again gives the same");
  assert.deepEqual((await tools.call("list_pending")).data, { pending: [] });
});

test("a call that finishes inside the fast path is answered inline and leaves no receipt", async () => {
  const rig = await startRig({ router: fakeRouter(async () => { await new Promise((r) => setTimeout(r, 10)); return ok({ n: 1 }); }) });
  const tools = await rig.client();
  const count = () => (rig.ledger.db().prepare("SELECT COUNT(*) AS n FROM agent_jobs").get() as { n: number }).n;
  const before = count();
  const res = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.deepEqual(res.data, { n: 1 });
  assert.equal(count(), before);
});

test("wait: true waits longer than the fast path; wait: false gives the receipt at once", async () => {
  const slow = fakeRouter(async () => { await new Promise((r) => setTimeout(r, 150)); return ok({ n: 2 }); });
  const rig = await startRig({ router: slow });
  const tools = await rig.client();
  assert.equal((await tools.call("capability_call", { member: "service:clock", word: "list" })).data.status, "accepted", "fast path is 60 ms here");
  assert.deepEqual((await tools.call("capability_call", { member: "service:clock", word: "list", wait: true })).data, { n: 2 });
  const quick = fakeRouter(() => ok({ n: 3 }));
  rig.router.script = quick.script;
  assert.deepEqual((await tools.call("capability_call", { member: "service:clock", word: "list", wait: false })).data, { n: 3 }, "an answer that is already there is not hidden");
  rig.router.script = () => new Promise<Reply>(() => {});
  assert.equal((await tools.call("capability_call", { member: "service:clock", word: "list", wait: false })).data.status, "accepted");
});

test("an error that comes at once is returned as the error even for wait: false and for a question", async () => {
  const rig = await startRig({ router: fakeRouter(() => fail("bad_request", "title is required")) });
  const tools = await rig.client();
  assert.equal((await tools.call("capability_call", { member: "service:clock", word: "set", wait: false })).data.error.code, "bad_request");
  assert.equal((await tools.call("human_ask", { options: [] })).data.error.code, "bad_request");
});

test("a receipt belongs to the agent it was given to", async () => {
  const gate = deferred<Reply>();
  const rig = await startRig({ router: fakeRouter(() => gate.promise) });
  const a = await rig.client(MAIN);
  const b = await rig.client(HELPER);
  const receipt = (await a.call("capability_call", { member: "service:clock", word: "list" })).data;
  assert.equal((await b.call("await_result", { request_id: receipt.request_id })).data.error.code, "not_found");
  assert.equal((await b.call("cancel", { request_id: receipt.request_id })).data.error.code, "not_found");
  assert.deepEqual((await b.call("list_pending")).data, { pending: [] });
  assert.equal((await a.call("list_pending")).data.pending.length, 1);
  gate.resolve(ok({}));
});

test("cancel stops the call: the router is told through the signal and the receipt ends cancelled", async () => {
  let signal: AbortSignal | undefined;
  const rig = await startRig({ router: fakeRouter((_m, _c, opts) => { signal = opts.signal; return new Promise<Reply>((resolve) => opts.signal!.addEventListener("abort", () => resolve(fail("cancelled", "stopped")))); }) });
  const tools = await rig.client();
  const receipt = (await tools.call("capability_call", { member: "service:clock", word: "list" })).data;
  assert.equal(signal?.aborted, false);
  const cancelled = await tools.call("cancel", { request_id: receipt.request_id });
  assert.deepEqual(cancelled.data, { request_id: receipt.request_id, cancelled: true });
  assert.equal(signal?.aborted, true);
  const end = await tools.call("await_result", { request_id: receipt.request_id });
  assert.equal(end.isError, true);
  assert.equal(end.data.error.code, "cancelled");
  assert.equal((await tools.call("cancel", { request_id: receipt.request_id })).data.cancelled, false, "nothing left to cancel");
});

test("a call the gate parks for the owner answers waiting_owner with the pending_id (and a request_id); await_result gives the same, no waiting", async () => {
  const rig = await startRig({ router: fakeRouter(() => ok({ status: "waiting_owner", pending_id: "m_pending1", expires_at: 1234 })) });
  const tools = await rig.client();
  const res = await tools.call("capability_call", { member: PHONE_ID, word: "screen.tap", body: {}, purpose: "open the note", approval_ttl_minutes: 3 });
  assert.equal(res.isError, false);
  assert.equal(res.data.status, "waiting_owner");
  assert.equal(res.data.pending_id, "m_pending1");
  assert.equal(res.data.expires_at, 1234);
  assert.match(res.data.request_id, /^r_/);
  assert.ok(res.data.guidance);
  const t0 = Date.now();
  const again = await tools.call("await_result", { request_id: res.data.request_id });
  assert.ok(Date.now() - t0 < 200, "does not wait");
  assert.deepEqual(again.data, res.data);
  assert.deepEqual((await tools.call("list_pending")).data, { pending: [] }, "the card is the owner's now; human_pending lists it");
});
const PHONE_ID = "device:B-Rce0000000000000000";

test("human_ask returns waiting_owner + request_id at once; the owner's answer comes with await_result", async () => {
  const answer = deferred<Reply>();
  const rig = await startRig({ router: fakeRouter(() => answer.promise) });
  const tools = await rig.client();
  const t0 = Date.now();
  const receipt = await tools.call("human_ask", { title: "晚饭吃什么", options: [{ id: "noodle", label: "面" }, { id: "rice", label: "饭" }], approval_ttl_minutes: 2 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(receipt.data.status, "waiting_owner");
  assert.match(receipt.data.request_id, /^r_/);
  assert.ok(receipt.data.expires_at > Date.now() + 100_000 && receipt.data.expires_at < Date.now() + 130_000, "expires after approval_ttl_minutes");
  assert.equal(receipt.data.expires_at, (rig.router.sent.at(-1)!.msg.body as any).expires_at);
  answer.resolve(ok({ choice: "rice" }));
  const done = await tools.call("await_result", { request_id: receipt.data.request_id });
  assert.deepEqual(done.data, { choice: "rice" });
});

test("the receipts are in agent_jobs; after a restart a call that was running answers result_unknown, and a finished one its stored answer", async () => {
  const held = openLedger();
  const open = deferred<Reply>();
  const rigA = await startRig({ ledger: held.ledger, router: fakeRouter((msg) => (msg.word === "list" ? open.promise : new Promise<Reply>((r) => setTimeout(() => r(ok({ finished: true, image: "kept" }, [{ type: "text", text: "all done" }, { type: "image", mime: "image/png", b64: png() }])), 120)))) });
  const a = await rigA.client();
  const running = (await a.call("capability_call", { member: "service:clock", word: "list" })).data;
  const quick = (await a.call("capability_call", { member: "service:clock", word: "cancel", wait: false })).data;
  assert.equal(running.status, "accepted");
  assert.equal(quick.status, "accepted", "wait: false before the answer is there");
  await new Promise((r) => setTimeout(r, 250));
  let rows = held.ledger.db().prepare("SELECT id, state FROM agent_jobs WHERE agent=? ORDER BY at").all(MAIN) as { id: string; state: string }[];
  assert.deepEqual(rows.map((r) => r.state), ["running", "done"]);
  rigA.edge.close();
  held.ledger.close();

  // the hub starts again on the same database; the agent has a new process and a new token
  const reopened = held.reopen();
  const rigB = await startRig({ ledger: reopened });
  const b = await rigB.client();
  rows = reopened.db().prepare("SELECT id, state FROM agent_jobs WHERE agent=? ORDER BY at").all(MAIN) as typeof rows;
  assert.deepEqual(rows.map((r) => r.state), ["interrupted", "done"]);
  const unknown = await b.call("await_result", { request_id: running.request_id });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.data.error.code, "result_unknown");
  assert.ok(unknown.data.error.recovery_hint);
  const stored = await b.call("await_result", { request_id: quick.request_id });
  assert.equal(stored.isError, false);
  assert.deepEqual(stored.data, { finished: true, image: "kept" });
  assert.match(stored.text, /all done/);
  assert.equal(stored.content.some((p) => p.type === "image"), false, "images are not kept in the table");
  assert.deepEqual((await b.call("list_pending")).data, { pending: [] }, "nothing is running in the new process");
  open.resolve(ok({}));
});

// ---- results -------------------------------------------------------------------------------------------------------

test("a success is the word's content (or its data as JSON text) with the data as structuredContent", async () => {
  const rig = await startRig();
  const tools = await rig.client();
  rig.router.script = () => ok({ lat: 31.2, lon: 121.5 });
  const plain = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(plain.isError, false);
  assert.deepEqual(plain.data, { lat: 31.2, lon: 121.5 });
  assert.deepEqual(plain.content, [{ type: "text", text: JSON.stringify({ lat: 31.2, lon: 121.5 }) }]);

  rig.router.script = () => ok({ lat: 31.2 }, [{ type: "text", text: "lat 31.2" }]);
  const withContent = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.deepEqual(withContent.content, [{ type: "text", text: "lat 31.2" }]);
  assert.deepEqual(withContent.data, { lat: 31.2 });

  rig.router.script = () => ok(undefined, [{ type: "text", text: "just words" }]);
  const onlyContent = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(onlyContent.data, undefined);
  assert.equal(onlyContent.text, "just words");

  rig.router.script = () => ({ ok: true });
  const nothing = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(nothing.isError, false);
  assert.equal(nothing.text, "{}");

  rig.router.script = () => ok([1, 2, 3]);
  assert.deepEqual((await tools.call("capability_call", { member: "service:clock", word: "list" })).data, { value: [1, 2, 3] }, "structuredContent is always an object");
});

test("a failure is isError with structuredContent {error}, a code from the one set and a recovery_hint", async () => {
  const rig = await startRig();
  const tools = await rig.client();
  for (const code of ["bad_request", "forbidden", "not_found", "denied", "cancelled", "timeout", "offline", "result_unknown", "conflict", "too_large", "unavailable", "failed", "internal"] as const) {
    rig.router.script = () => fail(code, `because ${code}`, { detail: { x: 1 } });
    const res = await tools.call("capability_call", { member: "service:clock", word: "list" });
    assert.equal(res.isError, true, code);
    assert.equal(res.data.error.code, code);
    assert.equal(res.data.error.message, `because ${code}`);
    assert.deepEqual(res.data.error.detail, { x: 1 });
    assert.ok(res.data.error.recovery_hint.length > 10, `${code} has a hint`);
    assert.deepEqual(JSON.parse(res.text), { error: res.data.error });
  }
  rig.router.script = () => fail("offline", "gone", { recovery_hint: "ask again at noon" });
  assert.equal((await tools.call("capability_call", { member: "service:clock", word: "list" })).data.error.recovery_hint, "ask again at noon");
  rig.router.script = () => fail("made_up" as any, "weird");
  assert.equal((await tools.call("capability_call", { member: "service:clock", word: "list" })).data.error.code, "internal", "no code outside the set gets out");
  rig.router.script = () => { throw new Error("secret stack detail"); };
  const crashed = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(crashed.data.error.code, "internal");
  assert.equal(JSON.stringify(crashed.data).includes("secret stack detail"), false);
});

test("a result over 60000 characters: a 40000 character preview and the attachment the ledger made of the recorded response", async () => {
  const big = { text: "长".repeat(70_000), small: 1 };
  // what the router does: record the response, which the ledger moves out to an attachment, and name the message
  const router = fakeRouter(() => ({ ...ok(big), ref: recorded.id }));
  const rig = await startRig({ router });
  const recorded = rig.ledger.append({ from: "service:clock", to: MAIN, kind: "response", word: "list", body: { ok: true, result: { data: big } } });
  const tools = await rig.client();
  const res = await tools.call("capability_call", { member: "service:clock", word: "list", wait: true });
  assert.equal(res.isError, false);
  assert.equal(res.data.truncated, true);
  assert.equal(res.data.preview.length, 40_000);
  assert.ok(res.text.length < 60_000 && res.text.length > 1000);
  assert.equal(res.data.attachments.length, 1);
  const { hash, mime, size, path } = res.data.attachments[0];
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(mime, "text/plain");
  assert.equal(path, "/result/data/text");
  assert.equal(Buffer.from(rig.ledger.blob.get(hash)!.bytes).toString("utf8"), big.text);
  assert.equal(rig.ledger.blob.get(hash)!.bytes.byteLength, size);
  assert.match(res.data.note, /service:blobs\/read/);
  // nothing else was written to the ledger by the tool surface
  assert.equal((rig.ledger.db().prepare("SELECT COUNT(*) AS n FROM messages WHERE word='tool.result'").get() as { n: number }).n, 0);

  // not recorded (no ref): the preview alone
  rig.router.script = () => ok(big);
  const bare = await tools.call("capability_call", { member: "service:clock", word: "list", wait: true });
  assert.equal(bare.data.truncated, true);
  assert.equal(bare.data.attachments, undefined);
  assert.match(bare.data.note, /was not kept/);
  // a result just under the limit goes through whole
  rig.router.script = () => ok({ text: "x".repeat(59_000) });
  assert.equal((await tools.call("capability_call", { member: "service:clock", word: "list", wait: true })).data.text.length, 59_000);
});

test("a very long error detail is cut, not stored", async () => {
  const rig = await startRig({ router: fakeRouter(() => fail("failed", "broke", { detail: { log: "z".repeat(80_000) } })) });
  const tools = await rig.client();
  const res = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(res.isError, true);
  assert.equal(res.data.error.detail.truncated, true);
  assert.equal(res.data.error.detail.preview.length, 40_000);
  assert.equal(res.data.error.detail.attachment, undefined);
});

test("at most 8 images; the bytes must be an image; too big is left out; a failed call carries none", async () => {
  const parts = [{ type: "text", text: "shots" }, ...Array.from({ length: 10 }, () => ({ type: "image", mime: "image/png", b64: png() })), { type: "image", mime: "image/png", b64: Buffer.from("not an image at all").toString("base64") }];
  const rig = await startRig({ router: fakeRouter(() => ok({ n: 10 }, parts)) });
  const tools = await rig.client();
  const res = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(res.content.filter((p) => p.type === "image").length, 8);
  assert.ok(res.content.filter((p) => p.type === "image").every((p) => p.mimeType === "image/png"));
  const notes = res.content.filter((p) => p.type === "text").map((p) => p.text);
  assert.equal(notes.filter((t) => /only the first 8/.test(t)).length, 2);
  assert.equal(notes.filter((t) => /not a PNG, JPEG, GIF or WebP/.test(t)).length, 1);
  assert.deepEqual(res.data, { n: 10 });

  // the claim of the part does not decide the format: the bytes do
  rig.router.script = () => ok({}, [{ type: "image", mime: "image/jpeg", b64: png() }]);
  assert.equal((await tools.call("capability_call", { member: "service:clock", word: "list" })).content.find((p) => p.type === "image").mimeType, "image/png");

  // 10 MB each, 20 MB together
  const huge = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(10 * 1024 * 1024)]).toString("base64");
  rig.router.script = () => ok({}, [{ type: "image", mime: "image/png", b64: huge }, { type: "image", mime: "image/png", b64: png() }]);
  const big = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(big.content.filter((p) => p.type === "image").length, 1);
  assert.ok(big.text.includes("too large to show"));

  rig.router.script = () => fail("failed", "broke");
  const failed = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.equal(failed.content.filter((p) => p.type === "image").length, 0);
});

test("a resource part is named, not carried", async () => {
  const rig = await startRig({ router: fakeRouter(() => ok({}, [{ type: "resource", stream: "s1", mime: "video/mp4", size: 99 }])) });
  const tools = await rig.client();
  const res = await tools.call("capability_call", { member: "service:clock", word: "list" });
  assert.match(res.text, /stream s1.*video\/mp4.*99 bytes/);
});

test("createToolsEdge needs nothing from the router but send, and the table is created once", async () => {
  const { ledger } = openLedger();
  const twice = [1, 2].map(() => createToolsEdge({ router: fakeRouter(), registry: { list: () => [], describe: () => null }, ledger, agentPolicy: () => ({}), currentTurn: () => null }));
  assert.equal(twice.length, 2);
  const cols = (ledger.db().prepare("PRAGMA table_info(agent_jobs)").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols, ["id", "agent", "turn", "member", "word", "label", "at", "state", "outcome", "settled_at", "taken", "woken"]);
});

test("a sync tool that does not answer within the longest wait gives a receipt too, so no tool call outlives the runtime's 60 s", async () => {
  const gate = deferred<Reply>();
  const rig = await startRig({ router: fakeRouter(() => gate.promise), maxWaitMs: 120 });
  const tools = await rig.client();
  const t0 = Date.now();
  const res = await tools.call("timer_list");
  assert.ok(Date.now() - t0 >= 100);
  assert.equal(res.data.status, "accepted");
  gate.resolve(ok({ timers: [] }));
  assert.deepEqual((await tools.call("await_result", { request_id: res.data.request_id })).data, { timers: [] });
});
