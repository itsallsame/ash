import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

// Objects made inside the page's own context have another Object prototype: compare them as data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const source = readFileSync(new URL("../js/native-bootstrap.js", import.meta.url), "utf8");
function page() {
  const sent = [];
  const native = { postMessage(wire) { sent.push(JSON.parse(wire)); } };
  const booted = [];
  // Timers are driven by hand: `tick()` runs what is due, in order.
  const timers = [];
  const sandbox = { AshNative: native, location: { origin: "https://appassets.androidplatform.net" }, atob, btoa,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    __ashNativeBoot(bridge) { booted.push(bridge); } };
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox);
  assert.equal(sent[0].type, "hello");
  assert.equal(typeof sent[0].doc, "string");
  const hello = sent.shift();
  const deliver = (message) => native.onmessage({ data: JSON.stringify(message) });
  const tick = () => { const due = timers.splice(0); for (const { fn } of due) fn(); };
  return { native, sent, booted, deliver, sandbox, hello, tick, timers };
}

test("the page boots once the native layer says ready, with a bridge that carries no HTTP, endpoint or credential", () => {
  const { booted, deliver, sent } = page();
  assert.equal(booted.length, 0, "nothing runs before ready");
  deliver({ type: "ready" });
  deliver({ type: "ready" });
  assert.equal(booted.length, 1);
  assert.deepEqual(Object.keys(booted[0]).sort(), ["onFrame", "onLink", "post", "requestLink"]);
  assert.deepEqual(sent, []);
});

test("a hello nobody answered is said again, always as the same page, until ready comes", () => {
  const { hello, sent, tick, deliver, booted } = page();
  tick(); tick();
  assert.deepEqual(plain(sent.map(({ type, doc }) => ({ type, doc }))), [{ type: "hello", doc: hello.doc }, { type: "hello", doc: hello.doc }]);
  assert.deepEqual(sent.map((m) => m.try), [1, 2]);
  deliver({ type: "ready" });
  assert.equal(booted.length, 1);
  sent.length = 0;
  tick(); tick();
  assert.deepEqual(sent, [], "no more hellos once it is ready");
});

test("a page that came after the state was told is given it, and may ask for it again", async () => {
  const { booted, deliver, sent, tick } = page();
  deliver({ type: "ready" });
  deliver({ type: "link", open: true, client: "client:abc", local: false });
  const links = [];
  booted[0].onLink((link) => links.push(plain(link)));
  assert.deepEqual(links, [], "not from inside the call that registers the listener");
  await Promise.resolve();
  assert.deepEqual(links.map((l) => l.client), ["client:abc"]);
  booted[0].requestLink();
  assert.deepEqual(sent.splice(0).map((m) => m.type), ["link_state"]);
  tick();
  assert.deepEqual(sent, [], "once told, it stops asking");
});

test("a page that has not been told yet keeps asking, then hears it once", () => {
  const { booted, deliver, sent, tick } = page();
  deliver({ type: "ready" });
  booted[0].requestLink();
  tick(); tick();
  assert.deepEqual(sent.map((m) => [m.type, m.try]), [["link_state", 0], ["link_state", 1], ["link_state", 2]]);
  const links = [];
  booted[0].onLink((link) => links.push(link.open));
  deliver({ type: "link", open: true, client: "client:x" });
  sent.length = 0;
  tick();
  assert.deepEqual([links, sent], [[true], []]);
});

test("frames of the human channel pass through unchanged, both ways", () => {
  const { booted, deliver, sent } = page();
  deliver({ type: "ready" });
  const [bridge] = booted;
  const received = [];
  bridge.onFrame((frame) => received.push(frame));
  bridge.post({ t: "send", ch: "human", id: "s_1", request: { to: "agent:main", kind: "request", word: "say", body: { text: "hi" } } });
  assert.deepEqual(sent.shift(), { type: "frame", frame: { t: "send", ch: "human", id: "s_1", request: { to: "agent:main", kind: "request", word: "say", body: { text: "hi" } } } });
  deliver({ type: "frame", frame: { t: "send.result", id: "s_1", ok: true, message: { id: "m1", seq: 1 } } });
  deliver({ type: "frame", frame: "not a frame" });
  deliver({ type: "something-else", id: "x" });
  assert.deepEqual(plain(received), [{ t: "send.result", id: "s_1", ok: true, message: { id: "m1", seq: 1 } }]);
});

test("the state of the channel reaches a page that asks late, and every change after", async () => {
  const { booted, deliver } = page();
  deliver({ type: "ready" });
  deliver({ type: "link", open: true, client: "client:abc", local: true });
  const links = [];
  booted[0].onLink((link) => links.push(link));
  await Promise.resolve();
  deliver({ type: "link", open: false });
  assert.deepEqual(plain(links).map(({ open, client, local }) => ({ open, client, local })), [
    { open: true, client: "client:abc", local: true }, { open: false, client: undefined, local: undefined }]);
});

test("saving a file hands the bytes across and answers with the picker's outcome; nothing else is answered twice", async () => {
  const { deliver, sent, sandbox } = page();
  await assert.rejects(sandbox.__ashFileSave({ name: "a.txt", b64: "YQ==" }), /unavailable/, "not before ready");
  deliver({ type: "ready" });
  const saving = sandbox.__ashFileSave({ name: "a.txt", mime: "text/plain", b64: "YQ==" });
  assert.deepEqual(sent.shift(), { type: "file_save", id: "1", name: "a.txt", mime: "text/plain", b64: "YQ==" });
  deliver({ type: "file_save_result", id: "1", ok: false, cancelled: true });
  deliver({ type: "file_save_result", id: "1", ok: true });
  assert.deepEqual(plain(await saving), { ok: false, cancelled: true });
});

test("clearing the browser's logins is asked of the native layer, which owns the browser", async () => {
  const { deliver, sent, sandbox } = page();
  deliver({ type: "ready" });
  const clearing = sandbox.__ashBrowserLogins();
  assert.deepEqual(sent.shift(), { type: "browser_logins", id: "1", operation: "clear" });
  deliver({ type: "browser_logins_result", id: "1", ok: true });
  assert.deepEqual(plain(await clearing), { ok: true });
  assert.equal(sandbox.__ashGatewayConfig, undefined, "the relay is the kernel's business now (service:link)");
  assert.equal(sandbox.__ashNativeRequest, undefined);
});

test("outside the app's own origin the bootstrap does nothing", () => {
  const sent = [];
  runInNewContext(source, { AshNative: { postMessage: (wire) => sent.push(wire) }, location: { origin: "https://example.com" } });
  assert.deepEqual(sent, []);
});
