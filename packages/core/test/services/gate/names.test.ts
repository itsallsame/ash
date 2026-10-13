import assert from "node:assert/strict";
import test from "node:test";
import { createNameOf } from "../../../src/services/gate/names";

const names = (over: Partial<Parameters<typeof createNameOf>[0]> = {}) => createNameOf({
  memberName: (id) => ({ "agent:main": "Ash", "service:gate": "gate", "body:main": "main body", "device:LIVE": "平板" })[id],
  handName: (hand) => ({ OFFLINE: "手机 · Xiaomi M2006J10C" })[hand],
  mainAgentName: () => "Ash", ...over,
});

test("a service has no name a person would know", () => {
  assert.equal(names()("service:gate"), null);
  assert.equal(names()("service:apps"), null);
});

test("the main container is the main agent's container, not its code name", () => {
  assert.equal(names()("body:main"), "Ash 的容器");
  assert.equal(names({ mainAgentName: () => null })("body:main"), "Ash 的容器");
  assert.equal(names({ mainAgentName: () => "小艾" })("body:main"), "小艾 的容器");
});

test("a member in the registry shows its name; one that is offline shows the name it was paired with; then the id", () => {
  assert.equal(names()("agent:main"), "Ash");
  assert.equal(names()("device:LIVE"), "平板");
  assert.equal(names()("device:OFFLINE"), "手机 · Xiaomi M2006J10C");
  assert.equal(names()("body:OFFLINE"), "手机 · Xiaomi M2006J10C");
  assert.equal(names()("device:UNKNOWN"), "device:UNKNOWN");
  assert.equal(names()("agent:gone"), "agent:gone");
  assert.equal(names({ handName: () => { throw new Error("db closed"); } })("device:OFFLINE"), "device:OFFLINE");
});
