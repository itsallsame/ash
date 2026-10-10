import assert from "node:assert/strict";
import test from "node:test";
import { ManagedMarkdownEditor } from "../js/editor.js";
import { WordFailure } from "../js/link.js";
import { IdentitySheet, personaStore } from "../js/sheet-identity.js";
import { MemorySheet, workspaceStore } from "../js/sheet-memory.js";
import { startKernel } from "./kernel.js";
import { netFor, until } from "./support.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value ?? "") + this.children.map((child) => child.textContent).join(""); }
}
async function dom(run) {
  globalThis.document = { createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment") };
  try { return await run(new Element("root")); }
  finally { delete globalThis.document; }
}
function findAll(element, predicate) {
  return [...(predicate(element) ? [element] : []), ...(element.children ?? []).flatMap((child) => findAll(child, predicate))];
}
const failure = (code, message = code) => new WordFailure({ code, message });

/** A store over a plain object of files; [writes] records every write. */
function memoryStore(files, { onWrite } = {}) {
  const writes = [];
  return { files, writes,
    async read(path) { return path in files ? { content: files[path] } : null; },
    async write(path, content, clientId) { writes.push({ path, content, clientId }); if (onWrite) await onWrite(path, content, clientId); else files[path] = content; } };
}

test("the editor keeps a dirty draft when the file changed since it loaded, and writes nothing", () => dom(async (root) => {
  const store = memoryStore({ "SOUL.md": "before\n" });
  const editor = new ManagedMarkdownEditor(root, { path: "SOUL.md", store, idFactory: () => "save-1" });
  await editor.load();
  editor.setDraft("owner draft\n");
  store.files["SOUL.md"] = "background update\n";
  await assert.rejects(editor.save(), /刚在别处改过，未覆盖/);
  assert.equal(store.files["SOUL.md"], "background update\n");
  assert.deepEqual(store.writes, []);
  assert.equal(editor.draft, "owner draft\n");
  assert.equal(editor.conflict, true);
  await assert.rejects(editor.save(), /请先重新读取/);
  await editor.load({ discardDraft: true });
  assert.equal(editor.draft, "background update\n");
  assert.equal(editor.conflict, false);
}));

test("a save is verified by reading the file back, and calls onSaved once it went through", () => dom(async (root) => {
  const store = memoryStore({});
  const saved = [];
  const editor = new ManagedMarkdownEditor(root, { path: "USER.md", store, onSaved: (path) => saved.push(path), idFactory: () => "id-1" });
  await editor.load();
  assert.equal(editor.missing, true, "a file that is not there reads as empty, not as an error");
  editor.setDraft("Synthetic owner fact\n");
  await editor.save();
  assert.deepEqual(store.writes, [{ path: "USER.md", content: "Synthetic owner fact\n", clientId: "id-1" }]);
  assert.equal(editor.conflict, false);
  assert.equal(editor.unverified, false);
  assert.equal(editor.content, "Synthetic owner fact\n");
  assert.equal(editor.missing, false);
  assert.equal(editor.status, "已保存。");
  assert.deepEqual(saved, ["USER.md"]);
}));

test("a write that reads back differently is reported, not claimed as saved", () => dom(async (root) => {
  const store = memoryStore({ "MEMORY.md": "old" }, { onWrite: (path, content) => { store.files[path] = `${content}\n(edited elsewhere)`; } });
  const editor = new ManagedMarkdownEditor(root, { path: "MEMORY.md", store });
  await editor.load();
  editor.setDraft("new");
  await editor.save();
  assert.equal(editor.conflict, true);
  assert.match(editor.status, /又在别处被改过/);
  assert.equal(editor.draft, "new", "the owner's text is still there");
}));

test("an unconfirmed write is retried with the same client id and never written twice", () => dom(async (root) => {
  const store = memoryStore({ "IDENTITY.md": "old" });
  let lose = true;
  store.write = async (path, content, clientId) => {
    store.writes.push({ path, content, clientId });
    store.files[path] = content;
    if (lose) { lose = false; throw failure("result_unknown", "no answer"); }
  };
  const editor = new ManagedMarkdownEditor(root, { path: "IDENTITY.md", store, idFactory: () => "stable-id" });
  await editor.load();
  editor.setDraft("new");
  await assert.rejects(editor.save(), /no answer/);
  assert.match(editor.status, /再点一次「保存」会原样重试/);
  assert.ok(editor.pending);
  await assert.rejects(editor.load({ discardDraft: true }), /还没确认/);
  await assert.rejects((async () => { editor.draft = "other"; return editor.save(); })(), /只能原样再试一次/);
  editor.draft = "new";
  await editor.save();
  assert.equal(store.writes.length, 1, "the file already read as the owner's text: no second write");
  assert.equal(editor.pending, null);
  assert.equal(editor.status, "已保存。");
}));

test("when the lost write did not land, the retry repeats the exact payload and client id", () => dom(async (root) => {
  const store = memoryStore({ "IDENTITY.md": "old" });
  let lose = true;
  store.write = async (path, content, clientId) => {
    store.writes.push({ path, content, clientId });
    if (lose) { lose = false; throw failure("timeout", "lost"); }
    store.files[path] = content;
  };
  const editor = new ManagedMarkdownEditor(root, { path: "IDENTITY.md", store, idFactory: () => "stable-id" });
  await editor.load();
  editor.setDraft("new");
  await assert.rejects(editor.save(), /lost/);
  await editor.save();
  assert.deepEqual(store.writes, [{ path: "IDENTITY.md", content: "new", clientId: "stable-id" }, { path: "IDENTITY.md", content: "new", clientId: "stable-id" }]);
  assert.equal(editor.status, "已保存。");
}));

test("when the file changed while a write was unconfirmed, the retry stops instead of overwriting", () => dom(async (root) => {
  const store = memoryStore({ "SOUL.md": "old" });
  store.write = async () => { throw failure("offline", "gone"); };
  const editor = new ManagedMarkdownEditor(root, { path: "SOUL.md", store });
  await editor.load();
  editor.setDraft("mine");
  await assert.rejects(editor.save(), /gone/);
  store.files["SOUL.md"] = "someone else";
  await assert.rejects(editor.save(), /刚在别处改过/);
  assert.equal(editor.pending, null);
  assert.equal(editor.conflict, true);
}));

test("a definite refusal clears the pending write and says nothing was changed", () => dom(async (root) => {
  const store = memoryStore({ "SOUL.md": "old" });
  store.write = async () => { throw failure("forbidden", "no"); };
  const editor = new ManagedMarkdownEditor(root, { path: "SOUL.md", store });
  await editor.load();
  editor.setDraft("new");
  await assert.rejects(editor.save(), /没有得到允许，什么都没改/);
  assert.equal(editor.pending, null);
  assert.equal(editor.conflict, false);
  assert.equal(editor.draft, "new");
}));

test("a file read that failed before writing leaves nothing pending", () => dom(async (root) => {
  const store = memoryStore({ "SOUL.md": "old" });
  const editor = new ManagedMarkdownEditor(root, { path: "SOUL.md", store });
  await editor.load();
  editor.setDraft("new");
  store.read = async () => { throw failure("offline", "gone"); };
  await assert.rejects(editor.save(), /gone/);
  assert.equal(editor.pending, null);
  assert.deepEqual(store.writes, []);
  assert.match(editor.status, /什么都没改/);
}));

test("a file that came back truncated is shown read-only and is never written", () => dom(async (root) => {
  const store = memoryStore({});
  store.read = async () => ({ content: "the first part", truncated: true });
  const editor = new ManagedMarkdownEditor(root, { path: "MEMORY.md", store });
  await editor.load();
  const by = (className) => findAll(root, (item) => String(item.className ?? "").split(" ").includes(className))[0];
  assert.equal(by("editor-edit").hidden, true);
  assert.match(root.textContent, /内容太长/);
  assert.throws(() => editor.setDraft("x"), /还不能修改/);
  await assert.rejects(editor.save(), /现在不能修改/);
  assert.deepEqual(store.writes, []);
}));

test("an unknown path or a store without read and write is refused", () => dom(async (root) => {
  const store = memoryStore({});
  assert.throws(() => new ManagedMarkdownEditor(root, { path: "../secret", store }), /unsupported/);
  assert.throws(() => new ManagedMarkdownEditor(root, { path: "SOUL.md" }), /unsupported/);
  assert.throws(() => new ManagedMarkdownEditor(root, { path: "SOUL.md", store: { read: async () => null } }), /unsupported/);
}));

test("identity and memory sheets use only allowlisted managed paths and block dirty tab switches", () => dom(async (root) => {
  const store = memoryStore({ "SOUL.md": "safe", "IDENTITY.md": "safe", "USER.md": "u", "MEMORY.md": "m" });
  const identity = new IdentitySheet(root, { store });
  await identity.open();
  assert.equal(identity.active, "SOUL.md");
  identity.editor.setDraft("dirty");
  await assert.rejects(identity.open("IDENTITY.md"), /先保存或取消/);
  await assert.rejects(identity.open("../secret"), /unknown/);
  await assert.rejects(identity.open("USER.md"), /unknown/);
  const memory = new MemorySheet(root, { store });
  await memory.open();
  assert.equal(memory.active, "USER.md");
  await memory.open("MEMORY.md");
  assert.equal(memory.active, "MEMORY.md");
  await assert.rejects(memory.open("SOUL.md"), /unknown/);
  assert.match(root.textContent, /性格|名片|关于你|她记下的事/);
}));

test("the file reads as a card; editing sits behind 编辑 and the page shows no versions or hashes", () => dom(async (root) => {
  const store = memoryStore({ "USER.md": "# 关于你\n- 喜欢清晨跑步\n" });
  const editor = new ManagedMarkdownEditor(root, { path: "USER.md", store });
  await editor.load();
  const by = (className) => findAll(root, (item) => String(item.className ?? "").split(" ").includes(className))[0];
  assert.equal(by("markdown-source").hidden, true, "the source is not shown until the owner asks to edit");
  assert.equal(by("editor-edit").hidden, false);
  assert.match(by("doc-body").textContent, /关于你.*喜欢清晨跑步/s);
  assert.doesNotMatch(root.textContent, /哈希|版本|回滚|改动记录|恢复/);
  await by("editor-edit").listeners.click();
  assert.equal(editor.editing, true);
  const source = by("markdown-source");
  assert.equal(source.hidden, false);
  assert.equal(source.value, "# 关于你\n- 喜欢清晨跑步\n");
  source.value = "# 关于你\n- 喜欢傍晚散步\n";
  source.listeners.input();
  await editor.save();
  assert.equal(editor.editing, false, "a confirmed save returns to the reading view");
  assert.equal(by("editor-status").textContent, "已保存。");
  assert.match(by("doc-body").textContent, /傍晚散步/);
  await by("editor-edit").listeners.click();
  by("markdown-source").value = "scratch";
  by("markdown-source").listeners.input();
  by("editor-cancel").listeners.click();
  assert.equal(editor.editing, false);
  assert.equal(editor.draft, editor.content, "cancel discards the local draft only");
}));

test("editing starts from what the file says now", () => dom(async (root) => {
  const store = memoryStore({ "USER.md": "one" });
  const editor = new ManagedMarkdownEditor(root, { path: "USER.md", store });
  await editor.load();
  store.files["USER.md"] = "two";
  await editor.edit();
  assert.equal(editor.draft, "two");
  assert.equal(editor.editing, true);
}));

test("a read-only screen shows the file without an edit button", () => dom(async (root) => {
  const store = memoryStore({ "SOUL.md": "沉着、好奇" });
  const editor = new ManagedMarkdownEditor(root, { path: "SOUL.md", store, canEdit: false });
  await editor.load();
  const by = (className) => findAll(root, (item) => String(item.className ?? "").split(" ").includes(className))[0];
  assert.equal(by("editor-edit").hidden, true);
  assert.equal(by("editor-save").disabled, true);
  assert.match(root.textContent, /沉着、好奇.*只能在她所在的那台手机上修改/s);
}));

// ---- the two stores, against the test kernel ----

const online = async (options) => {
  const kernel = startKernel(options);
  const handle = netFor(kernel);
  handle.net.start();
  await until(() => handle.net.status === "online", 2000, "online");
  return { kernel, ...handle, stop: () => { handle.net.stop(); kernel.close(); } };
};

test("the workspace store reads and writes the main body's files; a missing file is null", async () => {
  const { kernel, net, stop } = await online();
  try {
    const files = { "USER.md": "喜欢茶\n" };
    kernel.on("body:main", "workspace.read", (body) => body.path in files ? { path: body.path, text: files[body.path], truncated: false }
      : { ok: false, error: { code: "not_found", message: "no such file" } });
    kernel.on("body:main", "workspace.write", (body) => { files[body.path] = body.content; return { path: body.path, bytes: body.content.length }; });
    const store = workspaceStore(net, net.binding());
    assert.deepEqual(await store.read("USER.md"), { content: "喜欢茶\n", truncated: false });
    assert.equal(await store.read("MEMORY.md"), null);
    await store.write("MEMORY.md", "笔记", "client-1");
    assert.equal(files["MEMORY.md"], "笔记");
    const write = kernel.requests.find((r) => r.word === "workspace.write");
    assert.deepEqual(write, { to: "body:main", kind: "request", word: "workspace.write", body: { path: "MEMORY.md", content: "笔记" }, wait: true, client_id: "client-1" });
    assert.equal(kernel.requests.find((r) => r.word === "workspace.read").to, "body:main");
    kernel.on("body:main", "workspace.read", { path: "USER.md", text: "partial", truncated: true });
    assert.equal((await store.read("USER.md")).truncated, true);
    kernel.on("body:main", "workspace.read", { ok: false, error: { code: "forbidden", message: "no" } });
    await assert.rejects(store.read("USER.md"), (error) => error.code === "forbidden");
  } finally { stop(); }
});

test("the workspace store writes nothing from a page that is not on her machine, and drops a result from another connection", async () => {
  const remote = await online({ local: false });
  try {
    const store = workspaceStore(remote.net, remote.net.binding());
    await assert.rejects(store.write("USER.md", "x", "c"), (error) => error.code === "forbidden");
    assert.equal(remote.kernel.requests.some((r) => r.word === "workspace.write"), false);
  } finally { remote.stop(); }
  const { kernel, net, stop } = await online();
  try {
    kernel.on("body:main", "workspace.read", async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { path: "USER.md", text: "old account", truncated: false }; });
    const store = workspaceStore(net, net.binding());
    const pending = store.read("USER.md");
    kernel.drop();
    await assert.rejects(pending, /连接已经换过/);
    await assert.rejects(store.write("USER.md", "x", "c"), /连接已经换过/, "a retryable failure, so the editor keeps the draft");
  } finally { stop(); }
});

test("the persona store reads with get and changes with propose, with the owner's reason and the same client id", async () => {
  const { kernel, net, stop } = await online();
  try {
    const files = { "SOUL.md": "沉着", "IDENTITY.md": "- 名字：小舟\n" };
    kernel.on("service:persona", "get", (body) => ({ files: Object.entries(files).filter(([file]) => !body.file || body.file === file).map(([file, content]) => ({ file, content, version: "v1" })) }));
    kernel.on("service:persona", "propose", (body) => { files[body.file] = body.content; return { proposed: true, applied: true }; });
    const store = personaStore(net, net.binding());
    assert.deepEqual(await store.read("SOUL.md"), { content: "沉着" });
    assert.deepEqual(kernel.requests.find((r) => r.word === "get").body, { file: "SOUL.md" });
    await store.write("SOUL.md", "沉着、好奇", "client-2");
    assert.equal(files["SOUL.md"], "沉着、好奇");
    assert.deepEqual(kernel.requests.find((r) => r.word === "propose"), { to: "service:persona", kind: "request", word: "propose",
      body: { file: "SOUL.md", content: "沉着、好奇", reason: "主人在人物页修改" }, wait: true, client_id: "client-2" });
    await assert.rejects(store.write("SOUL.md", "  \n", "client-3"), (error) => error.userMessage === "这份内容不能是空的。");
    assert.equal(kernel.requests.filter((r) => r.word === "propose").length, 1, "empty text never leaves the page");
    kernel.on("service:persona", "propose", { proposed: true, applied: false });
    await assert.rejects(store.write("SOUL.md", "x", "client-4"), /没有马上生效/);
    kernel.on("service:persona", "get", { files: [] });
    assert.equal(await store.read("SOUL.md"), null);
  } finally { stop(); }
});

test("an identity edit end to end: the editor saves through propose, reads back, and tells the page", async () => {
  const { kernel, net, stop } = await online();
  try {
    let content = "- 名字：小舟\n";
    kernel.on("service:persona", "get", () => ({ files: [{ file: "IDENTITY.md", content, version: "v" }] }));
    kernel.on("service:persona", "propose", (body) => { content = body.content; return { proposed: true, applied: true }; });
    await dom(async (root) => {
      const changed = [];
      const sheet = new IdentitySheet(root, { store: personaStore(net, net.binding()), canEdit: net.local, onSaved: (path) => changed.push(path) });
      const editor = await sheet.open("IDENTITY.md");
      editor.setDraft("- 名字：River\n");
      await editor.save();
      assert.equal(editor.status, "已保存。");
      assert.deepEqual(changed, ["IDENTITY.md"]);
      assert.equal(content, "- 名字：River\n");
    });
  } finally { stop(); }
});
