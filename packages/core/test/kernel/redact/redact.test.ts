import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../../../sdk/src/message";
import { secret, sensitive } from "../../../../sdk/src/word";
import { createRedact } from "../../../src/kernel/redact";
import { agent, owner, service, word } from "../router/world";

const redact = createRedact();
const pairing = word("service:devices", "pair_code", { result_schema: { type: "object", properties: {
  code: sensitive({ type: "string" }, "hidden"), email: sensitive({ type: "string" }, "email"), card: sensitive({ type: "string" }, "tail4"),
  ip: sensitive({ type: "string" }, "ip"), plain: { type: "string" },
  more: { type: "array", items: { type: "object", properties: { ip: sensitive({ type: "string" }, "ip") } } },
} } });
const data = { code: "123456", email: "alice@gmail.com", card: "4242424242424242", ip: "192.168.1.20", plain: "keep",
  more: [{ ip: "10.0.0.7" }, { ip: "fe80::1:2:3" }] };

test("the four masks", () => {
  const masked = redact.forCaller(data, pairing, agent()) as any;
  assert.equal(masked.code, "[仅主人可见]");
  assert.equal(masked.email, "a***@gmail.com");
  assert.equal(masked.card, "****4242");
  assert.equal(masked.ip, "192.168.*.*");
  assert.equal(masked.more[0].ip, "10.0.*.*");
  assert.equal(masked.more[1].ip, "fe80:*", "an IPv6 address keeps its first group");
  assert.equal(masked.plain, "keep");
  assert.equal(data.code, "123456", "the original is untouched");
});

test("only person:owner gets the original; agents, apps and services get the masked version", () => {
  assert.deepEqual(redact.forCaller(data, pairing, owner), data);
  for (const caller of [agent(), service("senses"), { member: "app:x", via: "app" as const, local: false }]) {
    assert.equal((redact.forCaller(data, pairing, caller) as any).code, "[仅主人可见]");
  }
});

test("a secret input becomes {set, length} in the ledger copy and the message is not changed", () => {
  const set = word("service:vault", "set", { input_schema: { type: "object", properties: { ref: { type: "string" }, value: secret({ type: "string" }) } } });
  const msg: Message = { seq: 0, id: "m1", ts: 1, from: "person:owner", to: "service:vault", kind: "request", word: "set", body: { ref: "deepseek", value: "sk-very-secret" } };
  const out = redact.forLedger(msg, set);
  assert.deepEqual(out.body, { ref: "deepseek", value: { set: true, length: 14 } });
  assert.equal((msg.body as any).value, "sk-very-secret");
  assert.ok(!JSON.stringify(out).includes("sk-very-secret"));
  const plain: Message = { ...msg, body: { ref: "x" } };
  assert.equal(redact.forLedger(plain, set), plain, "nothing to mask: the same object");
});

test("a response is masked in the ledger copy by the result schema", () => {
  const response: Message = { seq: 0, id: "m2", ts: 1, from: "service:devices", to: "agent:main", kind: "response", word: "pair_code", body: { ok: true, result: { data } }, reply_to: "m1" };
  const out = redact.forLedger(response, pairing);
  assert.ok(!JSON.stringify(out).includes("123456"));
  assert.equal((out.body as any).result.data.plain, "keep");
  const error: Message = { ...response, body: { ok: false, error: { code: "failed", message: "x" } } };
  assert.equal(redact.forLedger(error, pairing), error);
});
