import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type HandleContext, type Message } from "../../../../sdk/src/message";
import type { Member } from "../../../../sdk/src/word";
import { eventually } from "../../fixtures/wait";
import { cap, connected, startHub, type Hub } from "./harness";

const ctx = (over: Partial<HandleContext> = {}): HandleContext =>
  ({ signal: new AbortController().signal, caller: { member: "agent:main", via: "agent", local: false, turn: "t1" }, raw: undefined, ...over });
let counter = 0;
const request = (to: string, word: string, body: unknown = {}): Message =>
  ({ seq: ++counter, id: `m${counter}`, ts: 0, from: "agent:main", to, kind: "request", word, body });

const member = (hub: Hub, id: string): Member => {
  const found = hub.registry.members.get(id);
  assert.ok(found, `${id} is registered`);
  return found;
};
const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { assert.ok(error instanceof WordError, String(error)); return error.code; }
  return "none";
};
const answer = (data: unknown) => async () => ({ ok: true as const, content: [{ type: "text" as const, text: "done" }], data });

test("a phone and a computer are the same kind of member: device:<id> with the words of their manifests", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const phone = await connected(hub, { kind: "phone", name: "Find X8", capabilities: [cap("location.get")], handlers: { call: answer({ lat: 1 }) } });
  const computer = await connected(hub, { kind: "computer", name: "Mac", capabilities: [cap("location.get")], handlers: { call: answer({ lat: 2 }) } });

  for (const [hand, lat] of [[phone, 1], [computer, 2]] as const) {
    const m = member(hub, hand.member);
    assert.equal(m.kind, "device");
    assert.deepEqual(m.words().map((w) => [w.member, w.word, w.kind, w.direction]), [[hand.member, "location.get", "request", "in"]]);
    const result = await m.handle(request(hand.member, "location.get"), ctx());
    assert.deepEqual(result, { content: [{ type: "text", text: "done" }], data: { lat } });
  }
  assert.deepEqual(hub.hands.list().map((h) => [h.kind, h.paired_by, h.tier]).sort(), [["computer", "local", "ask"], ["phone", "local", "ask"]]);
  assert.deepEqual(hub.hands.capabilities(phone.identity.handId), ["location.get"]);
});

test("the contract carries what the hand declared: effect, risk, foreground, callers, timeout, label", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const hand = await connected(hub, { capabilities: [cap("screen.tap", { effect: "act", risk: "outward", foreground: true, per_call_risk: true, callers: ["owner", "agent"], timeout_ms: 5000, label: "在点屏幕" }), cap("x.test.read")] });
  const [tap, plain] = member(hub, hand.member).words();
  assert.deepEqual([tap!.effect, tap!.risk, tap!.foreground, tap!.per_call_risk, tap!.callers, tap!.timeout_ms, tap!.label], ["act", "outward", true, true, ["owner", "agent"], 5000, { doing: "在点屏幕" }]);
  assert.deepEqual([plain!.callers, plain!.foreground], [["owner", "agent", "app"], undefined]);
});

test("a call carries who asked, and a refusal by the hand becomes a WordError with its code", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const seen: unknown[] = [];
  const hand = await connected(hub, {
    capabilities: [cap("screen.tap", { effect: "act", risk: "outward" })],
    handlers: { call: async (call) => { seen.push([call.capability, call.args, call.caller]); return { ok: false, error: { code: "unavailable", message: "no accessibility", detail: { why: 1 } } }; } },
  });
  const m = member(hub, hand.member);
  await assert.rejects(m.handle(request(hand.member, "screen.tap", { x: 1 }), ctx({ raw: { x: 1, secret: "s" } })), (error: WordError) => {
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, "no accessibility");
    assert.deepEqual(error.detail, { why: 1 });
    return true;
  });
  // the hand gets the original body, and the caller with the label the owner sees
  assert.deepEqual(seen, [["screen.tap", { x: 1, secret: "s" }, { member: "agent:main", label: "在screen.tap", turn: "t1" }]]);
});

test("a hand that is gone is offline; a call that was out when it dropped is result_unknown (a read: offline)", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const started: string[] = [];
  const hold = new Promise<never>(() => {});
  const hand = await connected(hub, {
    capabilities: [cap("x.test.act", { effect: "act", risk: "none" }), cap("x.test.read")],
    handlers: { call: async (call) => { started.push(call.capability); return hold; } },
  });
  const m = member(hub, hand.member);
  const act = code(m.handle(request(hand.member, "x.test.act"), ctx()));
  const read = code(m.handle(request(hand.member, "x.test.read"), ctx()));
  await eventually(() => started.length === 2, "both calls reaching the hand");
  hand.client.stop();
  assert.equal(await act, "result_unknown");
  assert.equal(await read, "offline");

  // not sent: the member is gone from the registry, and a handle that still holds it answers offline
  await eventually(() => !hub.registry.members.has(hand.member), "the member leaving the registry");
  assert.equal(await code(m.handle(request(hand.member, "x.test.act"), ctx())), "offline");
  assert.equal(hub.hands.online(hand.identity.handId), false);
});

test("cancel sends a cancel frame; the hand's answer ends the call as cancelled", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  let started = false;
  const hand = await connected(hub, {
    capabilities: [cap("x.test.act", { effect: "act", risk: "none" })],
    handlers: { call: (_call, { signal }) => new Promise((_, reject) => { started = true; signal.addEventListener("abort", () => reject(new Error("stopped"))); }) },
  });
  const m = member(hub, hand.member);
  const msg = request(hand.member, "x.test.act");
  const outcome = code(m.handle(msg, ctx()));
  await eventually(() => started, "the call reaching the hand");
  m.cancel!(msg.id);
  assert.equal(await outcome, "cancelled");
});

test("assess: the hand answers the risk of one call; a capability without per_call_risk is not asked", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const asked: string[] = [];
  const hand = await connected(hub, {
    capabilities: [cap("x.test.write", { effect: "write", risk: "outward", per_call_risk: true }), cap("x.test.act", { effect: "act", risk: "outward" })],
    handlers: { assess: async (capability, args) => { asked.push(capability); return { risk: args.path === "/work/a" ? "none" : "outward", why: "inside the work folder" }; } },
  });
  assert.equal(await hub.hands.assess({ ...request(hand.member, "x.test.write", { path: "/work/a" }) }), "none");
  assert.equal(await hub.hands.assess({ ...request(hand.member, "x.test.write", { path: "/etc/x" }) }), "outward");
  assert.equal(await hub.hands.assess({ ...request(hand.member, "x.test.act") }), null);
  assert.equal(await hub.hands.assess({ ...request("device:nobody", "workspace.write") }), null);
  assert.deepEqual(asked, ["x.test.write", "x.test.write"]);
});

test("a new manifest replaces the old whole: never a mix, rejected capabilities are only themselves", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const hand = await connected(hub, { capabilities: [cap("location.get"), cap("clipboard.read")] });
  const before = member(hub, hand.member);
  const changes: string[] = [];
  const registryAdd = hub.registry.add.bind(hub.registry);
  const registryRemove = hub.registry.remove.bind(hub.registry);
  hub.registry.add = (m) => { changes.push(`add ${m.id}`); registryAdd(m); };
  hub.registry.remove = (id) => { changes.push(`remove ${id}`); registryRemove(id); };

  const ack = await hand.client.setManifest([cap("calendar.list"), cap("Bad Name")]);
  assert.deepEqual(ack.rejected.map((r) => r.name), ["Bad Name"]);
  const after = member(hub, hand.member);
  assert.notEqual(after, before);
  assert.deepEqual(after.words().map((w) => w.word), ["calendar.list"]);
  assert.deepEqual(changes, [`add ${hand.member}`], "one add of the same id, no remove in between");
  assert.deepEqual(hub.hands.capabilities(hand.identity.handId), ["calendar.list"]);
  assert.equal(hub.hands.get(hand.identity.handId)!.manifest_rev, 2);
});

test("a bound computer gets a body:<id> member for workspace.* and body.info; an unbound one does not", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const workspace = [cap("workspace.read"), cap("workspace.write", { effect: "write", risk: "outward", per_call_risk: true }), cap("body.info")];
  const files: string[] = [];
  const handlers = { call: async (call: { capability: string }) => { files.push(call.capability); return { ok: true as const, content: [] }; } };
  const unbound = await connected(hub, { kind: "computer", capabilities: [cap("browser.open"), ...workspace], handlers });
  assert.deepEqual(member(hub, unbound.member).words().map((w) => w.word), ["browser.open"]);
  assert.ok(!hub.registry.members.has(`body:${unbound.identity.handId}`));

  const hand = await connected(hub, { kind: "computer", capabilities: [cap("browser.open"), ...workspace], handlers: { ...handlers, assess: async () => ({ risk: "none" }) } });
  const id = hand.identity.handId;
  hub.bodies.bound.add(id);
  hub.hands.rebind(id); // service:bodies bind
  const body = member(hub, `body:${id}`);
  assert.equal(body.kind, "body");
  assert.deepEqual(body.words().map((w) => [w.member, w.word]), workspace.map((c) => [`body:${id}`, c.name]));
  assert.deepEqual(member(hub, hand.member).words().map((w) => w.word), ["browser.open"]);

  await body.handle(request(`body:${id}`, "workspace.read"), ctx());
  assert.deepEqual(files, ["workspace.read"]);
  assert.equal(await hub.hands.assess(request(`body:${id}`, "workspace.write")), "none", "a body is assessed by the computer that lends it");

  hub.bodies.bound.delete(id);
  hub.hands.rebind(id); // unbind: the body goes, the hand stays
  assert.ok(!hub.registry.members.has(`body:${id}`));
  assert.ok(hub.registry.members.has(hand.member));

  // a manifest sent while bound registers the body too, and the body goes with the connection
  hub.bodies.bound.add(id);
  await hand.client.setManifest([cap("browser.open"), ...workspace]);
  assert.ok(hub.registry.members.has(`body:${id}`));
  hand.client.stop();
  await eventually(() => !hub.registry.members.has(`body:${id}`) && !hub.registry.members.has(hand.member), "both members leaving with the connection");
});

test("revoking closes the hand with 4003, forgets its body, and keeps the record so it is refused again", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const hand = await connected(hub, { capabilities: [cap("location.get")] });
  const id = hand.identity.handId;
  hub.hands.revoke(id);

  await eventually(() => hand.client.stoppedBy === 4003, "the hand told 4003");
  assert.deepEqual(hub.bodies.forgotten, [id]);
  assert.ok(!hub.registry.members.has(hand.member));
  assert.ok(hub.hands.get(id)!.revoked_at);
  assert.equal(hub.hands.view(id), null);

  const rows = hub.hands.list().length;
  const again = await (await import("./harness")).connect(hub, { identity: hand.identity });
  await eventually(() => again.closes.length > 0, "the second attempt refused");
  assert.equal(again.closes[0]!.code, 4003);
  assert.equal(hub.hands.list().length, rows, "no new row");
});

test("the human channel of a revoked hand closes too (a connection that carries no device channel)", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const { connect } = await import("./harness");
  hub.server.onChannel("human", () => ({}));
  const web = await connect(hub, { channels: { human: {} } });
  await web.client.ready();
  hub.hands.revoke(web.identity.handId);
  await eventually(() => web.client.stoppedBy === 4003, "the human-only connection told 4003");
});
