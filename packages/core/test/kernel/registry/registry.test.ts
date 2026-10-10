import assert from "node:assert/strict";
import test from "node:test";
import { wordsOf } from "../../../../sdk/src/words";
import { createRegistry } from "../../../src/kernel/registry";
import { DEVICE, fake, word } from "../router/world";

test("find: a member that is here and speaks the word; the two ways of not finding apart", () => {
  const r = createRegistry();
  r.add(fake("service:clock", [word("service:clock", "set")]));
  assert.equal(r.find("service:clock", "set")?.contract.word, "set");
  assert.equal(r.find("service:clock", "nope"), null);
  assert.ok(r.describe("service:clock"), "here, but without that word: the router answers not_found");
  assert.equal(r.find("service:gone", "set"), null);
  assert.equal(r.describe("service:gone"), null, "not here: the router answers offline");
});

test("a contract written for agent:* belongs to every agent", () => {
  const r = createRegistry();
  r.add(fake("agent:main", wordsOf("agent:main")));
  r.add(fake("agent:w-1", wordsOf("agent:w-1")));
  assert.equal(r.find("agent:main", "tell")?.contract.member, "agent:*");
  assert.ok(r.find("agent:w-1", "wake"));
  assert.equal(r.find("agent:other", "tell"), null);
  assert.ok(r.describe("agent:main")!.words.some((w) => w.word === "tell"));
});

test("the same id again replaces the member; remove takes it away; onChange tells", () => {
  const r = createRegistry();
  const seen: string[] = [];
  const off = r.onChange((id, change) => seen.push(`${change}:${id}`));
  r.add(fake(DEVICE, [word(DEVICE, "a")]));
  r.add(fake(DEVICE, [word(DEVICE, "b")]));
  assert.equal(r.find(DEVICE, "a"), null);
  assert.ok(r.find(DEVICE, "b"));
  assert.equal(r.list().length, 1);
  r.remove(DEVICE); r.remove(DEVICE);
  assert.deepEqual(seen, [`added:${DEVICE}`, `added:${DEVICE}`, `removed:${DEVICE}`]);
  off(); r.add(fake(DEVICE, [])); assert.equal(seen.length, 3);
});

test("findByWord: the preferred kind first, then local ones, then in the order they came", () => {
  const r = createRegistry();
  const a = fake("device:" + "B".repeat(22), [word("device:" + "B".repeat(22), "health.read")]);
  const b = Object.assign(fake("device:" + "C".repeat(22), [word("device:" + "C".repeat(22), "health.read")]), { local: true });
  const c = fake("app:fit", [word("app:fit", "health.read")]);
  const d = fake("device:" + "D".repeat(22), [word("device:" + "D".repeat(22), "other")]);
  for (const m of [a, b, c, d]) r.add(m);
  assert.deepEqual(r.findByWord("health.read").map((m) => m.id), [b.id, a.id, c.id]);
  assert.deepEqual(r.findByWord("health.read", { kind: "app" }).map((m) => m.id), [c.id, b.id, a.id]);
  assert.deepEqual(r.findByWord("nothing"), []);
  assert.deepEqual(r.list({ kind: "app" }).map((m) => m.id), ["app:fit"]);
});

test("listeners: an exact event name or a prefix", () => {
  const r = createRegistry();
  r.add(fake("app:a", [], undefined, { listens: ["sense.location"] }));
  r.add(fake("app:b", [], undefined, { listens: ["sense.*"] }));
  r.add(fake("app:c", [], undefined, { listens: ["widget.*"] }));
  assert.deepEqual(r.listeners("sense.location").map((m) => m.id), ["app:a", "app:b"]);
  assert.deepEqual(r.listeners("sense.health").map((m) => m.id), ["app:b"]);
  assert.deepEqual(r.listeners("typing"), []);
});
