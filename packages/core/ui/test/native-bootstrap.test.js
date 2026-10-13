import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../js/native-bootstrap.js", import.meta.url), "utf8");
function page() {
  const sent = [];
  const native = { postMessage(wire) { sent.push(JSON.parse(wire)); } };
  let request;
  const events = new EventTarget();
  const sandbox = { AshNative: native, location: { origin: "https://appassets.androidplatform.net" },
    URL, Headers, Response, ReadableStream, DOMException, Uint8Array, TextEncoder, atob, setTimeout, clearTimeout,
    addEventListener: events.addEventListener.bind(events),
    __ashNativeBoot(fn, endpoint) { assert.equal(endpoint, "http://127.0.0.1:4700"); request = fn; } };
  runInNewContext(source, sandbox);
  assert.deepEqual(sent.shift(), { type: "hello" });
  native.onmessage({ data: JSON.stringify({ type: "ready", endpoint: "http://127.0.0.1:4700" }) });
  return { native, sent, request, gateway: sandbox.__ashGatewayConfig, picker: sandbox.__ashMaterialPicker, shares: sandbox.__ashShareText, events };
}

test("APK bridge keeps the gateway bootstrap secret off ordinary API requests and replies", async () => {
  const { native, sent, gateway } = page();
  const saving = gateway("save", "https://ash.example.test", "one-time-test-secret");
  const wire = sent.shift();
  assert.deepEqual(wire, { type: "gateway_config", id: "1", operation: "save", url: "https://ash.example.test", secret: "one-time-test-secret" });
  native.onmessage({ data: JSON.stringify({ type: "gateway_config_result", id: wire.id, ok: true,
    configured: true, url: "https://ash.example.test" }) });
  const saved = await saving;
  assert.equal(saved.url, "https://ash.example.test");
  assert.equal(JSON.stringify(saved).includes("one-time-test-secret"), false);
  const checking = gateway("status");
  assert.deepEqual(sent.shift(), { type: "gateway_config", id: "2", operation: "status" });
  native.onmessage({ data: JSON.stringify({ type: "gateway_config_result", id: "2", ok: true,
    configured: true, url: "https://ash.example.test" }) });
  assert.equal((await checking).configured, true);
});

test("APK bridge returns finite response bytes without an owner credential", async () => {
  const { native, sent, request } = page();
  const promise = request("send", "/api/send", { method: "POST", headers: { "Ash-Screen": "screen" }, body: "{}" });
  const wire = sent.shift();
  assert.equal(wire.type, "request");
  assert.equal(wire.operation, "send");
  assert.equal(wire.headers["ash-screen"], "screen");
  assert.equal(wire.body, "{}");
  assert.equal(JSON.stringify(wire).includes("Bearer"), false);
  native.onmessage({ data: JSON.stringify({ id: wire.id, type: "done", status: 200,
    content_type: "application/json", body: btoa('{"ok":true}') }) });
  assert.equal(await (await promise).text(), '{"ok":true}');
});

test("APK bridge streams SSE chunks and aborts the native request", async () => {
  const { native, sent, request } = page();
  const abort = new AbortController();
  const pending = request("stream", "/api/stream?follow=true", { signal: abort.signal });
  const wire = sent.shift();
  native.onmessage({ data: JSON.stringify({ id: wire.id, type: "started" }) });
  const stream = await pending;
  const reader = stream.body.getReader();
  native.onmessage({ data: JSON.stringify({ id: wire.id, type: "chunk", body: btoa("data: ready\n\n") }) });
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: ready\n\n");
  abort.abort();
  assert.deepEqual(sent.shift(), { type: "cancel", id: wire.id });
  await assert.rejects(reader.read(), /Aborted/);
});

test('shared text waits for the UI, is acknowledged once accepted, and never makes a request', () => {
  const { native, sent, shares } = page();
  const message = { type: 'share_text', id: 'share-one', text: '视频文案 https://example.test/video\n补充文字' };
  native.onmessage({ data: JSON.stringify(message) });
  assert.equal(sent.length, 0);
  const received = []; let available = false;
  shares.subscribe(value => { if (!available) return false; received.push(value); return true; });
  assert.equal(received.length, 0); assert.equal(sent.length, 0);
  available = true; shares.flush();
  assert.equal(received[0].text, message.text);
  assert.deepEqual(sent.shift(), { type: 'share_text_ack', id: message.id });
  native.onmessage({ data: JSON.stringify(message) });
  assert.equal(received.length, 1); assert.deepEqual(sent.shift(), { type: 'share_text_ack', id: message.id });
  native.onmessage({ data: JSON.stringify({ ...message, id: 'share-two' }) });
  assert.equal(received.length, 2); assert.equal(sent[0].type, 'share_text_ack');
  assert.equal(sent.some(x => x.type === 'request'), false);
});

test('invalid or oversized shares are not accepted and a pending draft is never overwritten', () => {
  const { native, sent, shares } = page();
  const emit = (id, text) => native.onmessage({ data: JSON.stringify({ type: 'share_text', id, text }) });
  emit('invalid', '<script>alert(1)</script>');
  emit('large', 'https://example.test/' + '中'.repeat(12000));
  emit('one', 'https://example.test/one');
  emit('two', 'https://example.test/two');
  const received = [];
  shares.subscribe(value => { received.push(value); return true; });
  assert.equal(received.length, 1); assert.equal(received[0].id, 'one');
  assert.deepEqual(sent, [{ type: 'share_text_ack', id: 'one' }]);
});

test('single image picker sends bounded native mode and survives hidden page', async () => {
  const { native, sent, picker, events } = page();
  const picking = picker.selectFiles({ max_files: 1, max_file_bytes: 4194304 });
  const wire = sent.shift();
  assert.deepEqual(wire, { type: 'material_select', id: wire.id, max_files: 1, max_file_bytes: 4194304 });
  events.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sent.length, 0);
  native.onmessage({ data: JSON.stringify({ type: 'material_select_result', id: wire.id, ok: true, cancelled: false,
    selections: [{ selection_id: 'image', media_type: 'image/png' }] }) });
  assert.equal((await picking).selections.length, 1);
});

test('picker preserves four file wire and rejects invalid limits or excess single selections', async () => {
  const { native, sent, picker } = page();
  await assert.rejects(picker.selectFiles({ max_files: 2, max_file_bytes: 4194304 }), { code: 'invalid' });
  await assert.rejects(picker.selectFiles({ max_files: 1, max_file_bytes: 4194305 }), { code: 'invalid' });
  assert.equal(sent.length, 0);
  const old = picker.selectFiles({ max_files: 4, max_file_bytes: 4194304 });
  const oldWire = sent.shift();
  assert.deepEqual(oldWire, { type: 'material_select', id: oldWire.id });
  native.onmessage({ data: JSON.stringify({ type: 'material_select_result', id: oldWire.id, ok: true, cancelled: true, selections: [] }) });
  assert.equal((await old).cancelled, true);
  const single = picker.selectFiles({ max_files: 1, max_file_bytes: 4194304 });
  const wire = sent.shift();
  native.onmessage({ data: JSON.stringify({ type: 'material_select_result', id: wire.id, ok: true, cancelled: false, selections: [{}, {}] }) });
  await assert.rejects(single, { code: 'invalid' });
});

test('picker unknown result retries the same mode and id; abort and pagehide cancel', async () => {
  const { native, sent, picker, events } = page();
  const limits = { max_files: 1, max_file_bytes: 4194304 };
  const first = picker.selectFiles(limits); const wire = sent.shift();
  native.onmessage({ data: JSON.stringify({ type: 'material_select_result', id: wire.id, ok: false, error: { code: 'result_unknown' } }) });
  await assert.rejects(first, { code: 'result_unknown' });
  await assert.rejects(picker.selectFiles({ ...limits, max_files: 4 }), { code: 'result_unknown' });
  assert.equal(sent.length, 0);
  const abort = new AbortController();
  const retry = picker.selectFiles(limits, abort.signal);
  assert.deepEqual(sent.shift(), wire);
  abort.abort();
  await assert.rejects(retry, { name: 'AbortError' });
  assert.deepEqual(sent.shift(), { type: 'material_cancel', id: wire.id });
  const final = picker.selectFiles(limits);
  sent.shift(); events.dispatchEvent(new Event('pagehide'));
  await assert.rejects(final, { code: 'permission_denied' });
  assert.equal(sent.shift().type, 'material_picker_close');
});

test('single image native precheck failures reject instead of reporting user cancellation', async () => {
  for (const code of ['invalid', 'unsupported', 'too_large', 'offline']) {
    const { native, sent, picker } = page();
    const selecting = picker.selectFiles({ max_files: 1, max_file_bytes: 4194304 });
    const wire = sent.shift();
    native.onmessage({ data: JSON.stringify({ type: 'material_select_result', id: wire.id, ok: false, error: { code } }) });
    await assert.rejects(selecting, { code });
  }
});
