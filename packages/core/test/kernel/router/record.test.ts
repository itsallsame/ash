import assert from "node:assert/strict";
import test from "node:test";
import { shouldRecord } from "../../../src/kernel/router";
import { agent, app, DEVICE, hand, owner, service, word } from "./world";

const m = (from: string, to: string | null, kind: "request" | "event" = "request") => ({ from, to, kind });
const read = word("service:cost", "usage.get");
const write = word("service:clock", "set", { effect: "write" });

test("shouldRecord: a service, hand or app only reading is not recorded", () => {
  assert.equal(shouldRecord(m("service:clock", "service:cost"), read, service()), false);
  assert.equal(shouldRecord(m(DEVICE, "service:cost"), read, hand), false);
  assert.equal(shouldRecord(m("app:todo", "service:cost"), read, app()), false);
});

test("shouldRecord: an agent's request is recorded, a read too", () => {
  assert.equal(shouldRecord(m("agent:main", "service:cost"), read, agent()), true);
  assert.equal(shouldRecord(m("agent:main", "service:clock"), write, agent()), true);
});

test("shouldRecord: whatever has an effect is, whoever asks", () => {
  for (const effect of ["write", "act", "execute"] as const) {
    const risk = effect === "execute" ? "structure" : "none";
    assert.equal(shouldRecord(m("service:clock", "agent:main"), word("agent:*", "wake", { effect, risk }), service()), true, effect);
    assert.equal(shouldRecord(m("app:todo", "service:x"), word("service:x", "w", { effect, risk }), app()), true, effect);
  }
});

test("shouldRecord: what the owner sends from a channel; a service reading on the owner's behalf is not", () => {
  assert.equal(shouldRecord(m("person:owner", "service:cost"), write, owner), true);
  assert.equal(shouldRecord(m("person:owner", "service:widgets"), read, { ...owner, via: "service" }), false);
  assert.equal(shouldRecord(m("service:widgets", "person:owner"), read, service("widgets")), false);
  assert.equal(shouldRecord(m("service:gate", "person:owner"), word("person:owner", "ask", { effect: "act" }), service("gate")), true);
});

test("shouldRecord: what the owner only reads is not kept, whatever service it reads from; what changes anything still is", () => {
  assert.equal(shouldRecord(m("person:owner", "service:history"), word("service:history", "current"), owner), false, "a read of the history");
  assert.equal(shouldRecord(m("person:owner", "service:cost"), read, owner), false, "a read of another service");
  assert.equal(shouldRecord(m("person:owner", "service:clock"), write, owner), true, "a write");
  assert.equal(shouldRecord(m("person:owner", "agent:main"), word("agent:*", "say", { effect: "act" }), owner), true, "something said");
  assert.equal(shouldRecord(m("agent:main", "service:history"), word("service:history", "current"), agent()), true, "an agent's read is still its own act");
});

test("shouldRecord: an event only when the contract says record: true; sense.* is not", () => {
  const sense = word(DEVICE, "sense.location", { kind: "event", direction: "out", callers: ["kernel"] });
  assert.equal(shouldRecord(m(DEVICE, "service:senses", "event"), sense, hand), false);
  assert.equal(shouldRecord(m(DEVICE, null, "event"), sense, hand), false);
  const turn = word("agent:*", "turn.ended", { kind: "event", direction: "out", callers: ["kernel"], record: true });
  assert.equal(shouldRecord(m("agent:main", null, "event"), turn, service("agents")), true);
  assert.equal(shouldRecord(m("person:owner", "agent:main", "event"), word("agent:*", "typing", { kind: "event", callers: ["kernel"] }), owner), false);
});

test("the word table keeps its read mark honest: no word the owner can call that changes something is marked read", async () => {
  const { WORD_CONTRACTS } = await import("../../../../sdk/src/words");
  const changes = /(^|\.|_)(set|put|remove|delete|revoke|install|enable|disable|restart|stop|start|cancel|approve|reject|bind|unbind|update|declare|configure|propose|scaffold|reset|tap|use|deploy|spawn|steer|inject|interrupt|compact|reload|fire|note|switch|pause|resume|new|send|followup|rename|restore|setup\.start|disconnect|reconnect)$/;
  const mismarked = WORD_CONTRACTS.filter((w) => w.kind === "request" && w.callers.includes("owner") && changes.test(w.word) && w.effect === "read").map((w) => `${w.member}/${w.word}`);
  assert.deepEqual(mismarked, []);
});
