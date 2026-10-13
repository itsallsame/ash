import assert from "node:assert/strict";
import test from "node:test";
import { ProactivePreferences } from "../js/home-preferences.js";
import { startKernel } from "./kernel.js";
import { connect } from "./support.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.value = ""; this.disabled = false; }
  append(...items) { this.children.push(...items); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this[name] = value; }
  click() { this.listeners.get("click")?.(); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const ok = (data) => ({ ok: true, result: { data } });
const fail = (code, message = code) => ({ ok: false, error: { code, message } });

/** A net that answers the body's file words from a one-file disk and records every call. */
function fixture({ disk = { text: null }, write = null } = {}) {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  const calls = [];
  const state = { session: "s1", generation: 1 };
  const net = {
    local: true,
    get session() { return state.session; },
    binding: () => ({ session: state.session, generation: state.generation }),
    same: (binding) => binding.session === state.session && binding.generation === state.generation,
    async call(to, word, body, options) {
      calls.push({ to, word, body, options });
      if (word === "workspace.read") return disk.text === null ? fail("not_found") : ok({ path: body.path, text: disk.text, truncated: disk.truncated === true });
      if (word === "workspace.write") {
        if (write) { const reply = await write(body, options, disk); if (reply) return reply; }
        disk.text = body.content;
        return ok({ path: body.path, bytes: body.content.length });
      }
      return fail("not_found");
    },
  };
  const editor = new ProactivePreferences(new Element("section"), net, () => true);
  return { net, editor, calls, disk, state, writes: () => calls.filter((call) => call.word === "workspace.write") };
}

test("a missing PROACTIVE.md is created only after a write and a matching read back", async () => {
  const f = fixture();
  try {
    await f.editor.save();
    assert.equal(f.calls.length, 0, "an unread file cannot be overwritten");
    await f.editor.load();
    assert.match(f.editor.status.textContent, /还没有写过/);
    f.editor.editor.value = "Only important updates.\n";
    await f.editor.save();
    assert.equal(f.editor.status.textContent, "已保存。");
    assert.deepEqual(f.writes().map((call) => [call.to, call.body]), [["body:main", { path: "PROACTIVE.md", content: "Only important updates.\n" }]]);
    assert.equal(f.calls.at(-1).word, "workspace.read", "the write is checked by reading it back");
    assert.equal(f.disk.text, "Only important updates.\n");
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("a file changed elsewhere since it was read is not overwritten and the draft stays", async () => {
  const f = fixture({ disk: { text: "prior" } });
  try {
    await f.editor.load();
    assert.equal(f.editor.editor.value, "prior");
    f.disk.text = "changed on another screen";
    f.editor.editor.value = "new draft";
    await f.editor.save();
    assert.equal(f.writes().length, 0);
    assert.equal(f.disk.text, "changed on another screen");
    assert.equal(f.editor.editor.value, "new draft");
    assert.match(f.editor.status.textContent, /未覆盖/);
    assert.equal(f.editor.pending, null);
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("a write whose answer was lost keeps the editor locked, and the retry uses the same client id and content", async () => {
  let tries = 0;
  const f = fixture({ disk: { text: "prior" }, write: async () => (++tries === 1 ? fail("timeout", "no answer") : null) });
  try {
    await f.editor.load();
    f.editor.editor.value = "new draft";
    await f.editor.save();
    assert.match(f.editor.status.textContent, /未确认/);
    assert.equal(f.editor.editor.disabled, true);
    assert.equal(f.editor.loadButton.disabled, true);
    await f.editor.save();
    const sent = f.writes();
    assert.equal(sent.length, 2);
    assert.ok(sent[0].options.clientId);
    assert.equal(sent[0].options.clientId, sent[1].options.clientId);
    assert.deepEqual(sent[0].body, sent[1].body);
    assert.equal(f.editor.status.textContent, "已保存。");
    assert.equal(f.editor.pending, null);
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("a lost answer for a write that did land is recognised on the retry and not written twice", async () => {
  const f = fixture({ disk: { text: "prior" }, write: async (body, _options, disk) => { disk.text = body.content; return fail("result_unknown", "lost"); } });
  try {
    await f.editor.load();
    f.editor.editor.value = "new draft";
    await f.editor.save();
    assert.match(f.editor.status.textContent, /未确认/);
    await f.editor.save();
    assert.equal(f.writes().length, 1);
    assert.equal(f.editor.status.textContent, "已保存。");
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("a refused write is reported as refused and unlocks the editor", async () => {
  const f = fixture({ disk: { text: "prior" }, write: async () => fail("forbidden", "no") });
  try {
    await f.editor.load();
    f.editor.editor.value = "draft";
    await f.editor.save();
    assert.equal(f.editor.status.textContent, "保存被拒绝了。");
    assert.equal(f.editor.pending, null);
    assert.equal(f.editor.editor.disabled, false);
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("a read back that differs is never shown as saved", async () => {
  const f = fixture({ disk: { text: "prior" }, write: async (body, _options, disk) => { disk.text = `${body.content} (altered)`; return ok({ path: "PROACTIVE.md" }); } });
  try {
    await f.editor.load();
    f.editor.editor.value = "draft";
    await f.editor.save();
    assert.match(f.editor.status.textContent, /未确认/);
    assert.notEqual(f.editor.status.textContent, "已保存。");
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("a file too long to read whole is not offered for editing", async () => {
  const f = fixture({ disk: { text: "partial", truncated: true } });
  try {
    await f.editor.load();
    assert.match(f.editor.status.textContent, /太长/);
    assert.equal(f.editor.editor.value, "");
    f.editor.editor.value = "typed";
    await f.editor.save();
    assert.equal(f.writes().length, 0);
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("another connection, a hub that is no longer local, and late answers fail closed", async () => {
  let release;
  const f = fixture({ disk: { text: "private" } });
  const call = f.net.call;
  f.net.call = (...args) => new Promise((resolve) => { release = () => resolve(call.apply(f.net, args)); });
  try {
    const loading = f.editor.load();
    await tick();
    f.state.generation = 2;
    release();
    await loading;
    assert.equal(f.editor.editor.value, "", "an answer for a connection that is gone is dropped");
    f.net.call = call;
    const before = f.calls.length;
    await f.editor.load();
    assert.equal(f.calls.length, before, "the editor of a replaced connection does nothing");
    f.state.generation = 1;
    f.net.local = false;
    await f.editor.save();
    assert.equal(f.calls.length, before);
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("through the kernel: the text lives in PROACTIVE.md of the main body and nothing else is touched", async () => {
  const kernel = startKernel();
  const files = new Map();
  kernel.on("body:main", "workspace.read", (body) => files.has(body.path) ? { path: body.path, text: files.get(body.path), truncated: false } : fail("not_found"));
  kernel.on("body:main", "workspace.write", (body) => { files.set(body.path, body.content); return { path: body.path, bytes: body.content.length }; });
  const { net } = await connect(kernel);
  globalThis.document = { createElement: (tag) => new Element(tag) };
  const editor = new ProactivePreferences(new Element("section"), net, () => true);
  try {
    await editor.load();
    editor.editor.value = "早上 9 点前别找我";
    await editor.save();
    assert.equal(editor.status.textContent, "已保存。");
    assert.equal(files.get("PROACTIVE.md"), "早上 9 点前别找我");
    const touched = kernel.requests.filter((request) => request.word.startsWith("workspace."));
    assert.ok(touched.length >= 3 && touched.every((request) => request.to === "body:main"));
    assert.ok(touched.find((request) => request.word === "workspace.write").client_id, "the write carries a retry id");
  } finally { editor.dispose(); delete globalThis.document; net.stop(); kernel.close(); }
});
