import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../../../sdk/src/message";
import { SENSITIVE_KEYWORD } from "../../../../sdk/src/word";
import { createHistoryService } from "../../../src/services/history";
import { openLedger } from "../../kernel/ledger/helpers";
import { agent, call, code, owner } from "../support";

/** A conversation: the owner speaks, agent:main takes turn t_1 on the front lane, calls a hand and a native tool, and answers. */
function scene() {
  const { ledger } = openLedger();
  const say = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "查一下电量" }, thread: "th_1" });
  ledger.append({ from: "agent:main", to: null, kind: "event", word: "turn.started", body: { turn: "t_1", lane: "front", ids: [say.id] } });
  const call1 = ledger.append({ from: "agent:main", to: "device:phone", kind: "request", word: "device.status", body: { purpose: "电量" }, turn: "t_1" });
  // The answer holds a pairing code the contract marks sensitive; this row was (wrongly) written unmasked.
  const answer = ledger.append({ from: "device:phone", to: "agent:main", kind: "response", word: "device.status", reply_to: call1.id, turn: "t_1",
    body: { ok: true, result: { data: { battery: 80, pair_code: "123456" } } } });
  ledger.append({ from: "agent:main", to: null, kind: "event", word: "agent.tool", body: { turn: "t_1", name: "bash", phase: "end", summary: "ls", ok: true } });
  const reply = ledger.append({ from: "agent:main", to: "person:owner", kind: "request", word: "say", body: { text: "电量 80%" }, turn: "t_1" });
  ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "谢谢" } });
  return { ledger, say, call1, answer, reply };
}

const contract = { member: "device:phone", word: "device.status", kind: "request", result_schema: { type: "object", properties: { pair_code: { [SENSITIVE_KEYWORD]: { mask: "hidden" } } } } };
const redact = {
  forCaller: (result: any, _c: unknown, caller: { member: string }) =>
    caller.member === "person:owner" ? result : { ...result, pair_code: "[仅主人可见]" },
};
const registry = { find: (to: string, word: string) => (to === "device:phone" && word === "device.status" ? { member: {} as never, contract: contract as never } : null) };

function setup() {
  const s = scene();
  return { ...s, service: createHistoryService({ ledger: s.ledger, redact, registry }) };
}

test("query: newest first, by text, speaker, thread; pages with before", async () => {
  const { service } = setup();
  const all = await call(service, agent(), "query", { limit: 3 });
  assert.deepEqual(all.messages.map((m: any) => m.seq), [7, 6, 5]);
  assert.equal(all.next_before, 5);
  const more = await call(service, agent(), "query", { limit: 3, before: all.next_before });
  assert.deepEqual(more.messages.map((m: any) => m.seq), [4, 3, 2]);
  assert.deepEqual((await call(service, agent(), "query", { text: "电量" })).messages.map((m: any) => m.seq), [6, 3, 1]);
  assert.deepEqual((await call(service, agent(), "query", { speaker: "person:owner" })).messages.map((m: any) => m.seq), [7, 1]);
  assert.deepEqual((await call(service, agent(), "query", { thread: "th_1" })).messages.map((m: any) => m.seq), [1]);
  assert.equal((await call(service, agent(), "query", { text: "没有这句话" })).messages.length, 0);
});

test("query by lane finds the turns that ran on it and what they were given", async () => {
  const { service } = setup();
  assert.deepEqual((await call(service, agent(), "query", { lane: "front" })).messages.map((m: any) => m.seq), [6, 4, 3, 1]);
  assert.deepEqual((await call(service, agent(), "query", { lane: "back" })).messages, []);
});

test("read: a range of sequence numbers, at most 200", async () => {
  const { service } = setup();
  assert.deepEqual((await call(service, agent(), "read", { from_seq: 3, to_seq: 5 })).messages.map((m: any) => m.seq), [3, 4, 5]);
  assert.equal(await code(call(service, agent(), "read", { from_seq: 1, to_seq: 500 })), "too_large");
  assert.equal(await code(call(service, agent(), "read", { from_seq: 5, to_seq: 1 })), "bad_request");
});

test("turn: what was given, what was said, the tool calls with their results and the native tools", async () => {
  const { service, say, call1, reply } = setup();
  const t = await call(service, agent(), "turn", { turn: "t_1" });
  assert.deepEqual(t.messages.map((m: any) => m.id), [say.id, reply.id]);
  assert.deepEqual(t.tools.map((x: any) => x.native ? `native:${x.name}` : `${x.to}/${x.word}`), ["device:phone/device.status", "native:bash"]);
  assert.equal(t.tools[0].id, call1.id);
  assert.equal(t.tools[0].ok, true);
  assert.equal(await code(call(service, agent(), "turn", { turn: "t_nope" })), "not_found");
});

test("activity: one tool call, request and answer, paged by characters", async () => {
  const { service, call1, say } = setup();
  const a = await call(service, owner, "activity", { id: call1.id });
  assert.equal(a.next_offset, null);
  assert.match(a.items[0].text, /device\.status/);
  assert.equal(a.items[0].member, "device:phone");
  assert.equal(await code(call(service, owner, "activity", { id: "m_unknown" })), "not_found");
  // a message that is not an agent's tool call is no activity
  assert.equal(await code(call(service, owner, "activity", { id: say.id })), "not_found");
});

test("activity pages a long detail with offset and next_offset", async () => {
  const { ledger } = openLedger();
  const big = ledger.append({ from: "agent:main", to: "device:phone", kind: "request", word: "screen.read", body: { items: Array(600).fill("abcdefghij") }, turn: "t_1" });
  ledger.append({ from: "device:phone", to: "agent:main", kind: "response", word: "screen.read", reply_to: big.id, body: { ok: true, result: { data: { items: Array(600).fill("klmnopqrst") } } } });
  const service = createHistoryService({ ledger });
  const first = await call(service, agent(), "activity", { id: big.id });
  assert.equal(first.next_offset, 16_000);
  const second = await call(service, agent(), "activity", { id: big.id, offset: first.next_offset });
  assert.equal(second.items[0].text.length, Math.min(16_000, first.items[0].total - 16_000));
  assert.equal(second.next_offset, first.items[0].total > 32_000 ? 32_000 : null);
});

test("an agent gets answers masked, the owner gets the original", async () => {
  const { service, answer, call1 } = setup();
  const find = (data: any) => data.messages.find((m: Message) => m.id === answer.id);
  const asAgent = find(await call(service, agent(), "read", { from_seq: 4, to_seq: 4 }));
  const asOwner = find(await call(service, owner, "read", { from_seq: 4, to_seq: 4 }));
  assert.equal(asAgent.body.result.data.pair_code, "[仅主人可见]");
  assert.equal(asAgent.body.result.data.battery, 80);
  assert.equal(asOwner.body.result.data.pair_code, "123456");
  // the detail of the call is masked the same way
  assert.ok(!JSON.stringify(await call(service, agent(), "activity", { id: call1.id })).includes("123456"));
  assert.ok(JSON.stringify(await call(service, owner, "activity", { id: call1.id })).includes("123456"));
});
