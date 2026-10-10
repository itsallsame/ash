import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  AGENT_ID_PATTERN, HAND_ID_LENGTH, MEMBER_KINDS, base64url, bodyId, deviceId, handId, idKind, idName, isAgentId, isAppId, isBodyId, isClientId, isDeviceId, isMemberId, sha256,
} from "../src/ids";

const HAND = "lAhFeu_Qcc7BJ8H5hTmTCG";

test("every kind of id has legal and illegal examples", () => {
  const legal: Record<string, string[]> = {
    person: ["person:owner"],
    agent: ["agent:main", "agent:a", "agent:w-3f9a1c", "agent:ash_feishu", `agent:a${"b".repeat(31)}`],
    service: ["service:gate", "service:clock", "service:link-x"],
    device: [`device:${HAND}`],
    body: ["body:main", `body:${HAND}`],
    app: ["app:todo", "app:health-2"],
    client: ["client:abc123", "client:A_b-9"],
  };
  const illegal: Record<string, string[]> = {
    person: ["person:alice", "person:", "person:Owner"],
    agent: ["agent:", "agent:Main", "agent:1a", "agent:-a", `agent:a${"b".repeat(32)}`, "agent:a b", "agent:a.b", "agent:*"],
    service: ["service:", "service:Gate", "service:1x", "service:a b"],
    device: ["device:phone", "device:", `device:${HAND}x`, `device:${HAND.slice(1)}`, "device:*"],
    body: ["body:Main", "body:mainx", "body:", `body:${HAND}x`],
    app: ["app:", "app:Todo", "app:1x", "app:a_b"],
    client: ["client:", "client:a b", `client:${"x".repeat(65)}`],
  };
  for (const [kind, ids] of Object.entries(legal)) for (const id of ids) assert.equal(idKind(id), kind, id);
  for (const [kind, ids] of Object.entries(illegal)) for (const id of ids) assert.notEqual(idKind(id), kind, id);
  for (const id of ["", "owner", ":", "x:y", "screen:abc", "worker:extract"]) assert.equal(idKind(id), null, id);
  assert.equal(idKind(7), null);
  assert.equal(idKind(null), null);
});

test("the agent id has one pattern and a client is not a member", () => {
  assert.equal(AGENT_ID_PATTERN, "^agent:[a-z][a-z0-9_-]{0,31}$");
  assert.ok(isAgentId("agent:main") && !isAgentId("agent:Main"));
  assert.ok(isMemberId("service:gate") && isMemberId("person:owner") && !isMemberId("client:abc") && !isMemberId("nobody"));
  assert.ok(isDeviceId(`device:${HAND}`) && isBodyId("body:main") && isAppId("app:todo") && isClientId("client:s1"));
  assert.deepEqual([...MEMBER_KINDS], ["person", "agent", "service", "device", "body", "app"]);
  assert.equal(idName(`device:${HAND}`), HAND);
  assert.equal(deviceId(HAND), `device:${HAND}`);
  assert.equal(bodyId(HAND), `body:${HAND}`);
});

test("hand_id of a fixed key", () => {
  // An Ed25519 SubjectPublicKeyInfo: the 12-byte header, then the key bytes 0..31.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(Array.from({ length: 32 }, (_, i) => i))]);
  assert.equal(handId(spki), HAND);
  assert.equal(handId(spki).length, HAND_ID_LENGTH);
  assert.equal(idKind(deviceId(handId(spki))), "device");
});

test("the built-in sha256 and base64url agree with node:crypto, around every block boundary", () => {
  for (const length of [0, 1, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 1000]) {
    const bytes = randomBytes(length);
    assert.deepEqual(Buffer.from(sha256(bytes)), createHash("sha256").update(bytes).digest(), `sha256 of ${length} bytes`);
    assert.equal(base64url(bytes), bytes.toString("base64url"), `base64url of ${length} bytes`);
  }
  assert.equal(Buffer.from(sha256(new TextEncoder().encode("abc"))).toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
