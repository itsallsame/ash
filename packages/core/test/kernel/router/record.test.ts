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
  assert.equal(shouldRecord(m("person:owner", "service:cost"), read, owner), true);
  assert.equal(shouldRecord(m("person:owner", "service:widgets"), read, { ...owner, via: "service" }), false);
  assert.equal(shouldRecord(m("service:widgets", "person:owner"), read, service("widgets")), false);
  assert.equal(shouldRecord(m("service:gate", "person:owner"), word("person:owner", "ask", { effect: "act" }), service("gate")), true);
});

test("shouldRecord: an event only when the contract says record: true; sense.* is not", () => {
  const sense = word(DEVICE, "sense.location", { kind: "event", direction: "out", callers: ["kernel"] });
  assert.equal(shouldRecord(m(DEVICE, "service:senses", "event"), sense, hand), false);
  assert.equal(shouldRecord(m(DEVICE, null, "event"), sense, hand), false);
  const turn = word("agent:*", "turn.ended", { kind: "event", direction: "out", callers: ["kernel"], record: true });
  assert.equal(shouldRecord(m("agent:main", null, "event"), turn, service("agents")), true);
  assert.equal(shouldRecord(m("person:owner", "agent:main", "event"), word("agent:*", "typing", { kind: "event", callers: ["kernel"] }), owner), false);
});
