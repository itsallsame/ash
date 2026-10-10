import assert from "node:assert/strict";
import test from "node:test";
import { call, dataOf, stubMember, until, world, type World } from "./helpers";

const phone = () => stubMember("device:phone", "device", [
  { word: "location.get", description: "Where the phone is now." },
  { word: "screen.tap", effect: "act", risk: "outward", description: "Tap the screen of the phone." },
  { word: "screen.read", effect: "read", risk: "none", callers: ["owner", "agent"], description: "Read the screen; not for apps." },
  { word: "slow.read", description: "A read that takes a while." },
  { word: "app.edit", effect: "write", risk: "structure", per_call_risk: true, description: "Edit something; assessed for each call." },
], {
  "location.get": () => ({ lat: 31.2, lng: 121.5 }),
  "slow.read": async () => { await new Promise((resolve) => setTimeout(resolve, 500)); return { done: true }; },
});

async function setup(options: Parameters<typeof world>[0] = {}): Promise<{ w: World; phone: ReturnType<typeof phone> }> {
  const w = world({
    bridgeWaitMs: 150,
    fixture: (app) => { app.needs = [{ member: "device:*", words: ["location.get", "screen.tap", "slow.read", "app.edit", "screen.read"], why: "tests" }]; },
    ...options,
  });
  const p = phone();
  w.registry.add(p);
  await w.apps.start();
  const installed = await call(w, "service:apps", "apps.install", { id: "fixture" });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  return { w, phone: p };
}
const viaApp = async (w: World, member: string, word: string, body: unknown = {}) =>
  dataOf(await call(w, "app:fixture", "fixture.ash", { member, word, body }));

test("an app calls a granted read: it goes through the router as app:<id> via app", async () => {
  const { w, phone: p } = await setup();
  const out = await viaApp(w, "device:phone", "location.get");
  assert.deepEqual(out, { ok: true, result: { lat: 31.2, lng: 121.5 } });
  const sent = w.router.sent.find((s) => s.msg.to === "device:phone" && s.msg.word === "location.get")!;
  assert.deepEqual(sent.caller, { member: "app:fixture", via: "app", local: false });
  assert.equal(p.received.length, 1);
});

test("an app calls a word that carries risk: the gate answers forbidden, with the owner's sentence", async () => {
  const { w, phone: p } = await setup();
  const out = await viaApp(w, "device:phone", "screen.tap", { x: 1, y: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "forbidden");
  assert.ok(out.error.recovery_hint);
  assert.match(out.error.owner_text, /安装时没有批准|用不了/);
  assert.equal(p.received.length, 0, "it never reached the phone");
});

test("a word that is not in the app's grants is forbidden by the router; so is a word for owners and agents only", async () => {
  const { w, phone: p } = await setup({ fixture: (app) => { app.needs = [{ member: "device:*", words: ["location.get", "screen.read"], why: "tests" }]; } });
  const notGranted = await viaApp(w, "device:phone", "slow.read");
  assert.equal(notGranted.error.code, "forbidden");
  assert.equal(p.received.length, 0);
  const notForApps = await viaApp(w, "device:phone", "screen.read");
  assert.equal(notForApps.error.code, "forbidden", "its callers leave apps out");
  assert.equal(p.received.length, 0);
});

test("a member that is away: offline, with the owner's sentence; a hand that left is not called", async () => {
  const { w } = await setup();
  w.registry.remove("device:phone");
  const out = await viaApp(w, "device:phone", "location.get");
  assert.equal(out.error.code, "offline");
  assert.match(out.error.owner_text, /手机暂时没连上/);
});

test("when the phone is away the hub can add what it already recorded (recent)", async () => {
  const { w } = await setup({ recent: (member, word) => (member === "device:phone" && word === "location.get" ? { as_of: 123, source: "senses archive", rows: [1] } : null) });
  w.registry.remove("device:phone");
  const out = await viaApp(w, "device:phone", "location.get");
  assert.deepEqual(out.error.recent, { as_of: 123, source: "senses archive", rows: [1] });
});

test("the catalog lists every granted word, and marks the ones that need approval", async () => {
  const { w } = await setup();
  const listed = dataOf(await call(w, "app:fixture", "fixture.ash", { member: "service:apps", word: "x" })); // not granted
  assert.equal(listed.error.code, "forbidden");
  // the app lists through the endpoint directly
  const catalog = await w.apps.runtime.bridge.call("fixture", "capability_list", {});
  assert.ok(catalog.ok && "result" in catalog);
  const members = (catalog.result as { members: { id: string; capabilities: { word: string; needs_approval: unknown; effect: string }[] }[] }).members;
  const entry = Object.fromEntries(members.find((m) => m.id === "device:phone")!.capabilities.map((c) => [c.word, c]));
  assert.equal(entry["location.get"]!.needs_approval, false);
  assert.equal(entry["screen.tap"]!.needs_approval, true);
  assert.equal(entry["app.edit"]!.needs_approval, "per_call");
  assert.equal(entry["screen.tap"]!.effect, "act");
  assert.ok(!("screen.read" in entry), "a word that is not for apps is not listed");
  const described = await w.apps.runtime.bridge.call("fixture", "capability_describe", { member: "device:phone", word: "location.get" });
  assert.ok(described.ok && "result" in described);
  const first = (described.result as { capabilities: { input_schema: unknown; description: string }[] }).capabilities[0]!;
  assert.deepEqual(first.input_schema, { type: "object" });
});

test("services and agents are used the same way as hands: through needs, and nothing else", async () => {
  const { w } = await setup({ fixture: (app) => { app.needs = [{ member: "service:llm", words: ["complete"], why: "small model" }, { member: "agent:main", words: ["wake"], why: "wake the agent" }]; } });
  w.registry.add(stubMember("service:llm", "service", [{ word: "complete" }], { complete: () => ({ text: "hi" }) }));
  w.registry.add(stubMember("agent:main", "agent", [{ word: "wake", effect: "act", risk: "none" }]));
  w.registry.add(stubMember("service:vault", "service", [{ word: "list" }]));
  assert.deepEqual(await viaApp(w, "service:llm", "complete", { messages: [] }), { ok: true, result: { text: "hi" } });
  assert.equal((await viaApp(w, "agent:main", "wake", { reason: "x" })).ok, true);
  assert.equal((await viaApp(w, "service:vault", "list")).error.code, "forbidden", "not in needs");
  assert.equal((await viaApp(w, "service:llm", "other")).error.code, "forbidden", "another word of a granted member");
});

test("the runtime's granted(): needs for words, declared events for events, nothing for an app that is not running", async () => {
  const { w } = await setup();
  const granted = w.apps.runtime.granted.bind(w.apps.runtime);
  assert.equal(granted("app:fixture", "device:abc", "location.get"), true, "device:* stands for any hand");
  assert.equal(granted("app:fixture", "device:abc", "screen.nothing"), false);
  assert.equal(granted("app:fixture", "service:llm", "complete"), false);
  assert.equal(granted("app:fixture", null, "fixture.ping"), true);
  assert.equal(granted("app:fixture", null, "sense.location"), false);
  assert.equal(granted("app:nobody", "device:abc", "location.get"), false);
  await call(w, "service:apps", "apps.disable", { id: "fixture" });
  assert.equal(granted("app:fixture", "device:abc", "location.get"), false);
});

test("a long call answers accepted with a request_id after the wait; await_result brings the result, once", async () => {
  const { w } = await setup();
  const first = await viaApp(w, "device:phone", "slow.read");
  assert.equal(first.ok, true);
  assert.equal(first.status, "accepted");
  assert.match(first.request_id, /^job_/);
  const result = await until(async () => {
    const out = dataOf(await call(w, "app:fixture", "fixture.await", { request_id: first.request_id }));
    return out.status === "accepted" ? null : out;
  }, "the long call to finish");
  assert.deepEqual(result, { ok: true, result: { done: true } });
  const again = dataOf(await call(w, "app:fixture", "fixture.await", { request_id: first.request_id }));
  assert.equal(again.error.code, "not_found", "collected once");
  const unknown = dataOf(await call(w, "app:fixture", "fixture.await", { request_id: "job_nope" }));
  assert.equal(unknown.error.code, "not_found");
});

test("a request_id belongs to the app that got it; stopping the app drops its long calls", async () => {
  const { w } = await setup();
  const first = await viaApp(w, "device:phone", "slow.read");
  const other = await w.apps.runtime.bridge.call("someone-else", "await_result", { request_id: first.request_id });
  assert.ok(!other.ok && other.error.code === "not_found");
  await call(w, "service:apps", "apps.disable", { id: "fixture" });
  const gone = await w.apps.runtime.bridge.call("fixture", "await_result", { request_id: first.request_id });
  assert.ok(!gone.ok && gone.error.code === "not_found");
});

test("the endpoint wants the app's own credential and a body that is an object", async () => {
  const { w } = await setup();
  const url = w.apps.runtime.bridge.url;
  const call1 = (headers: Record<string, string>) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  assert.equal((await call1({})).status, 401);
  assert.equal((await call1({ authorization: "Bearer nope" })).status, 401);
  assert.equal((await call1({ origin: "http://evil.example" })).status, 403);
  const bad = await w.apps.runtime.bridge.call("fixture", "capability_call", { member: "device:phone", word: "location.get", body: [1] });
  assert.ok(!bad.ok && bad.error.code === "bad_request");
  const tools = await w.apps.runtime.bridge.call("fixture", "nonsense", {});
  assert.ok(!tools.ok && tools.error.code === "bad_request");
});
