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
  const sandbox = { AshNative: native, location: { origin: "https://appassets.androidplatform.net" }, atob, btoa,
    __ashNativeBoot(bridge) { booted.push(bridge); } };
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox);
  assert.deepEqual(sent.shift(), { type: "hello" });
  const deliver = (message) => native.onmessage({ data: JSON.stringify(message) });
  return { native, sent, booted, deliver, sandbox };
}

test("the page boots once the native layer says ready, with a bridge that carries no HTTP, endpoint or credential", () => {
  const { booted, deliver, sent } = page();
  assert.equal(booted.length, 0, "nothing runs before ready");
  deliver({ type: "ready" });
  deliver({ type: "ready" });
  assert.equal(booted.length, 1);
  assert.deepEqual(Object.keys(booted[0]).sort(), ["onFrame", "onLink", "post"]);
  assert.deepEqual(sent, []);
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

test("the state of the channel reaches a page that asks late, and every change after", () => {
  const { booted, deliver } = page();
  deliver({ type: "ready" });
  deliver({ type: "link", open: true, client: "client:abc", local: true });
  const links = [];
  booted[0].onLink((link) => links.push(link));
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
