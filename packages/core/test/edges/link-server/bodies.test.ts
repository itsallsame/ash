import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WordError, type Message, type WordResult } from "../../../../sdk/src/message";
import { STANDARD_ACTIONS } from "../../../../sdk/src/namespaces";
import { lintWords } from "../../../../sdk/src/word";
import { Workspace } from "../../../../workspace/src";
import { createBodies, isBodyCapability, splitBodyCapabilities, type Bodies, type HandView } from "../../../src/edges/link-server/hands/bodies";

const COMPUTER = "c".repeat(22), PHONE = "p".repeat(22), SECOND = "d".repeat(22);
const ctx = { signal: new AbortController().signal, caller: { member: "person:owner", via: "human" as const, local: true }, raw: {} };
let seq = 0;
const send = (bodies: Bodies, word: string, body: Record<string, unknown> = {}) =>
  bodies.handle({ seq: ++seq, id: `m${seq}`, ts: 1, from: "person:owner", to: "service:bodies", kind: "request", word, body } as Message, ctx).then((result) => (result as WordResult).data as any);
const refused = (code: string) => (error: unknown) => error instanceof WordError && error.code === code;

/** A hand's manifest: the whole body contract plus two ordinary capabilities. */
const manifest = () => [...STANDARD_ACTIONS.filter((a) => isBodyCapability(a.name) || a.name === "browser.open").map((a) => ({ name: a.name })), { name: "x.demo.ping" }];

/** The registry side that T5 will write, reduced to what the split needs: who is registered, under which member id. */
class FakeHands {
  readonly hands = new Map<string, HandView>();
  readonly registered = new Map<string, string[]>();
  bodies!: Bodies;
  readonly workspaces = new Map<string, Workspace>();
  add(hand: HandView) { this.hands.set(hand.id, hand); this.register(hand.id); }
  register(handId: string) {
    const split = splitBodyCapabilities({ id: handId, bound: this.bodies.isBound(handId) }, manifest());
    this.registered.set(`device:${handId}`, split.hand.map((c) => c.name));
    if (split.bodyId) this.registered.set(split.bodyId, split.body.map((c) => c.name)); else this.registered.delete(`body:${handId}`);
  }
}

interface Fixture { db: DatabaseSync; hands: FakeHands; bodies: Bodies; calls: string[]; clock: { t: number }; dir: string }
async function fixture(opts: { call?: (to: string, word: string) => Promise<WordResult | void>; db?: DatabaseSync } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bodies-"));
  const db = opts.db ?? new DatabaseSync(":memory:");
  const hands = new FakeHands();
  const calls: string[] = [];
  const clock = { t: 1000 };
  hands.hands.set(COMPUTER, { id: COMPUTER, name: "MacBook", kind: "computer", online: true });
  hands.hands.set(PHONE, { id: PHONE, name: "Phone", kind: "phone", online: true });
  hands.hands.set(SECOND, { id: SECOND, name: "Desktop", kind: "computer", online: false });
  const bodies = createBodies({
    db, hands: { get: (id) => hands.hands.get(id) ?? null }, now: () => clock.t,
    rebind: (hand) => hands.register(hand),
    call: opts.call ?? (async (to, word) => { calls.push(`${to}/${word}`); throw new Error("no caller"); }),
  });
  hands.bodies = bodies;
  return { db, hands, bodies, calls, clock, dir };
}
const withFixture = (name: string, fn: (f: Fixture) => Promise<void>) => test(name, async () => {
  const f = await fixture();
  try { await fn(f); } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("splitBodyCapabilities: only a bound hand gets workspace.* and body.info as a body; an unbound one's are left out altogether", () => {
  const caps = manifest();
  const unbound = splitBodyCapabilities({ id: COMPUTER, bound: false }, caps);
  assert.deepEqual(unbound.hand.map((c) => c.name), ["browser.open", "x.demo.ping"]);
  assert.deepEqual(unbound.body, []);
  assert.equal(unbound.bodyId, null);
  const bound = splitBodyCapabilities({ id: COMPUTER, bound: true }, caps);
  assert.deepEqual(bound.hand.map((c) => c.name), ["browser.open", "x.demo.ping"]);
  assert.deepEqual(bound.body.map((c) => c.name).sort(), ["body.info", "workspace.bash", "workspace.edit", "workspace.find", "workspace.grep", "workspace.ls", "workspace.poll", "workspace.read", "workspace.signal", "workspace.write"]);
  assert.equal(bound.bodyId, `body:${COMPUTER}`);
  // a hand that declares no body capabilities has no body, bound or not
  assert.equal(splitBodyCapabilities({ id: COMPUTER, bound: true }, [{ name: "browser.open" }]).bodyId, null);
  // the capability objects pass through untouched
  const rich = [{ name: "workspace.ls", description: "d" }];
  assert.equal(splitBodyCapabilities({ id: COMPUTER, bound: true }, rich).body[0], rich[0]);
});

withFixture("the bodies table is created and body:main is bound from the start; reopening the same database keeps everything", async ({ db, hands, bodies }) => {
  const columns = (db.prepare("PRAGMA table_info(bodies)").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns, ["id", "kind", "ownership", "provider", "info", "bound_at", "unbound_at", "last_seen"]);
  assert.deepEqual(db.prepare("SELECT id, kind, ownership, provider, unbound_at FROM bodies").all().map((r) => ({ ...r })), [{ id: "body:main", kind: "proot-ubuntu", ownership: "own", provider: "kernel", unbound_at: null }]);
  await send(bodies, "bind", { hand: COMPUTER });
  const again = createBodies({ db, hands: { get: (id) => hands.hands.get(id) ?? null }, rebind: () => {}, call: async () => ({}) });
  assert.equal(again.isBound(COMPUTER), true);
  assert.deepEqual(again.boundHands(), [COMPUTER]);
  assert.equal((await send(again, "list")).bodies.length, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM bodies WHERE id = 'body:main'").get()!.n, 1);
});

withFixture("the words are the service:bodies contracts and pass the lint", async ({ bodies }) => {
  assert.equal(bodies.id, "service:bodies");
  assert.equal(bodies.kind, "service");
  assert.deepEqual(bodies.words().map((w) => w.word).sort(), ["bind", "describe", "list", "unbind"]);
  assert.deepEqual(lintWords(bodies.words()), []);
});

withFixture("list: the main body alone at first; a bound computer joins it, borrowed, with its online state", async ({ bodies, hands, clock }) => {
  assert.deepEqual((await send(bodies, "list")).bodies, [{ body: "body:main", name: "main body", ownership: "own", online: true, bound: true }]);
  clock.t = 2000;
  const bound = await send(bodies, "bind", { hand: COMPUTER });
  assert.deepEqual(bound, { body: `body:${COMPUTER}`, name: "MacBook", ownership: "borrowed", online: true, bound: true, hand: COMPUTER });
  await send(bodies, "bind", { hand: SECOND });
  const list = (await send(bodies, "list")).bodies;
  assert.deepEqual(list.map((b: any) => [b.body, b.ownership, b.online]), [["body:main", "own", true], [`body:${COMPUTER}`, "borrowed", true], [`body:${SECOND}`, "borrowed", false]]);
  hands.hands.get(COMPUTER)!.online = false;
  assert.equal((await send(bodies, "list")).bodies[1].online, false);
});

withFixture("SPEC-09 §7.2: binding registers the body next to the hand, unbinding takes it offline and leaves the hand", async ({ bodies, hands }) => {
  hands.add({ id: COMPUTER, name: "MacBook", kind: "computer", online: true });
  // paired but not bound: only the hand
  assert.deepEqual([...hands.registered.keys()], [`device:${COMPUTER}`]);
  assert.deepEqual(hands.registered.get(`device:${COMPUTER}`), ["browser.open", "x.demo.ping"]);
  await send(bodies, "bind", { hand: COMPUTER });
  assert.deepEqual([...hands.registered.keys()].sort(), [`body:${COMPUTER}`, `device:${COMPUTER}`].sort());
  assert.equal(hands.registered.get(`body:${COMPUTER}`)!.length, 10);
  assert.deepEqual(hands.registered.get(`device:${COMPUTER}`), ["browser.open", "x.demo.ping"]);
  const unbound = await send(bodies, "unbind", { body: `body:${COMPUTER}` });
  assert.deepEqual(unbound, { unbound: true });
  assert.deepEqual([...hands.registered.keys()], [`device:${COMPUTER}`]);
  assert.deepEqual(hands.registered.get(`device:${COMPUTER}`), ["browser.open", "x.demo.ping"]);
  assert.deepEqual((await send(bodies, "list")).bodies.map((b: any) => b.body), ["body:main"]);
  assert.equal(bodies.isBound(COMPUTER), false);
  // bound again later
  await send(bodies, "bind", { hand: COMPUTER });
  assert.ok(hands.registered.has(`body:${COMPUTER}`));
});

test("SPEC-09 §7.2: describe asks each body for body.info: own for the main body, borrowed for a bound computer", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bodies-"));
  const spaces = new Map<string, Workspace>([["body:main", new Workspace({ root: dir, ownership: "own" })], [`body:${COMPUTER}`, new Workspace({ root: dir, ownership: "borrowed" })]]);
  const f = await fixture({ call: async (to, word) => spaces.get(to)!.call(word, {}) });
  try {
    await send(f.bodies, "bind", { hand: COMPUTER });
    const main = await send(f.bodies, "describe", { body: "body:main" });
    const computer = await send(f.bodies, "describe", { body: `body:${COMPUTER}` });
    assert.equal(main.info.ownership, "own");
    assert.equal(computer.info.ownership, "borrowed");
    assert.equal(computer.info.name, "MacBook");
    assert.ok(computer.disk.total > 0);
    assert.equal(computer.info.workdir, dir);
    // unbound: the body is gone from the list and cannot be described
    await send(f.bodies, "unbind", { body: `body:${COMPUTER}` });
    await assert.rejects(send(f.bodies, "describe", { body: `body:${COMPUTER}` }), refused("not_found"));
  } finally {
    for (const space of spaces.values()) await space.close();
    await rm(f.dir, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true });
  }
});

withFixture("unbind: body:main is forbidden and stays bound; an unbound or unknown body is not_found; a bad id is bad_request", async ({ bodies, db }) => {
  await assert.rejects(send(bodies, "unbind", { body: "body:main" }), refused("forbidden"));
  assert.equal((await send(bodies, "list")).bodies[0].body, "body:main");
  assert.equal(db.prepare("SELECT unbound_at FROM bodies WHERE id = 'body:main'").get()!.unbound_at, null);
  await assert.rejects(send(bodies, "unbind", { body: `body:${COMPUTER}` }), refused("not_found"));
  await send(bodies, "bind", { hand: COMPUTER });
  await send(bodies, "unbind", { body: `body:${COMPUTER}` });
  await assert.rejects(send(bodies, "unbind", { body: `body:${COMPUTER}` }), refused("not_found"));
  await assert.rejects(send(bodies, "unbind", { body: "device:x" }), refused("bad_request"));
});

withFixture("bind: unknown hand is not_found, a phone cannot be a body, binding twice is harmless, a rebind records the new time", async ({ bodies, hands, db, clock }) => {
  await assert.rejects(send(bodies, "bind", { hand: "z".repeat(22) }), refused("not_found"));
  await assert.rejects(send(bodies, "bind", { hand: PHONE }), refused("bad_request"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM bodies").get()!.n, 1);
  let rebinds = 0;
  const counting = createBodies({ db, hands: { get: (id) => hands.hands.get(id) ?? null }, rebind: () => { rebinds++; }, call: async () => ({}), now: () => clock.t });
  clock.t = 5000;
  await send(counting, "bind", { hand: COMPUTER });
  const first = await send(counting, "bind", { hand: COMPUTER });
  assert.equal(rebinds, 1);
  assert.equal(first.body, `body:${COMPUTER}`);
  assert.equal(db.prepare("SELECT bound_at FROM bodies WHERE id = ?").get(`body:${COMPUTER}`)!.bound_at, 5000);
  await send(counting, "unbind", { body: `body:${COMPUTER}` });
  assert.equal(db.prepare("SELECT unbound_at FROM bodies WHERE id = ?").get(`body:${COMPUTER}`)!.unbound_at, 5000);
  clock.t = 6000;
  await send(counting, "bind", { hand: COMPUTER });
  assert.deepEqual({ ...db.prepare("SELECT bound_at, unbound_at, ownership, provider FROM bodies WHERE id = ?").get(`body:${COMPUTER}`)! }, { bound_at: 6000, unbound_at: null, ownership: "borrowed", provider: COMPUTER });
  assert.equal(rebinds, 3);
});

withFixture("forget: a revoked hand's body binding ends without a registry call", async ({ bodies, hands }) => {
  hands.add({ id: COMPUTER, name: "MacBook", kind: "computer", online: true });
  await send(bodies, "bind", { hand: COMPUTER });
  bodies.forget(COMPUTER);
  assert.equal(bodies.isBound(COMPUTER), false);
  assert.deepEqual(bodies.boundHands(), []);
  bodies.forget(COMPUTER);
});

test("describe: body.info from the body itself (from the WordResult), its disk, and the latest error; offline shows what was last known", async () => {
  const answers: (() => WordResult)[] = [];
  const f = await fixture({ call: async () => answers.shift()!() });
  try {
    const info = { system: "macOS 15", arch: "arm64", workdir: "/Users/o/work", ownership: "borrowed", full_linux: false, resources: { cpu: { count: 8 }, memory: { total: 1 }, disk: { total: 100, free: 40 } } };
    answers.push(() => ({ data: info, content: [{ type: "text", text: "{}" }] }));
    const main = await send(f.bodies, "describe", { body: "body:main" });
    assert.equal(main.info.system, "macOS 15");
    assert.equal(main.info.body, "body:main");
    assert.deepEqual(main.disk, { total: 100, free: 40 });
    assert.equal(main.last_error, undefined);

    await send(f.bodies, "bind", { hand: COMPUTER });
    answers.push(() => { throw new Error("hand did not answer"); });
    const failed = await send(f.bodies, "describe", { body: `body:${COMPUTER}` });
    assert.equal(failed.last_error, "hand did not answer");
    assert.equal(failed.info.ownership, "borrowed");
    answers.push(() => ({ data: info }));                        // content is optional
    const fine = await send(f.bodies, "describe", { body: `body:${COMPUTER}` });
    assert.equal(fine.last_error, undefined);
    assert.equal(fine.info.workdir, "/Users/o/work");
    // offline: no call, the cached info and a fresh summary
    f.hands.hands.get(COMPUTER)!.online = false;
    const offline = await send(f.bodies, "describe", { body: `body:${COMPUTER}` });
    assert.equal(offline.info.online, false);
    assert.equal(offline.info.workdir, "/Users/o/work");
    assert.equal(answers.length, 0);
    f.bodies.recordError(`body:${COMPUTER}`, "disk full");
    assert.equal((await send(f.bodies, "describe", { body: `body:${COMPUTER}` })).last_error, "disk full");
    await assert.rejects(send(f.bodies, "describe", { body: `body:${SECOND}` }), refused("not_found"));
    await assert.rejects(send(f.bodies, "describe", {}), refused("bad_request"));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

withFixture("an unknown word is not_found", async ({ bodies }) => {
  await assert.rejects(send(bodies, "nope"), refused("not_found"));
});
