// Managed Markdown editor. The editor knows no transport: a store adapter reads and writes the file
// (`store.read(path)` -> {content, truncated?} or null when the file is missing; `store.write(path, content, clientId)`;
// both throw a WordFailure when the word did not succeed). The memory sheet builds a store on the main body's files,
// the identity sheet one on the persona member.
import { retryable } from "./link.js";

const paths = new Set(["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]);
const STALE = "这段内容刚在别处改过，未覆盖。你的修改还在；请重新读取后再改。";
const UNSURE = "还不确定有没有保存上。再点一次「保存」会原样重试。";
const failText = (error) => typeof error?.userMessage === "string" ? error.userMessage
  : error?.code === "forbidden" || error?.code === "denied" ? "这次没有得到允许，什么都没改。"
  : error?.code === "too_large" ? "内容太长，没能保存，什么都没改。"
  : "没有完成，什么都没改；可以再试一次。";
/** Her name inside a Chinese sentence: Latin names get spaces around them, Chinese names do not. */
export const named = (name, before = true, after = true) =>
  /[A-Za-z0-9]/.test(name) ? `${before ? " " : ""}${name}${after ? " " : ""}` : name;
/** What each managed file is, in the owner's words. */
export const FILE_LABELS = Object.freeze({ "SOUL.md": "性格", "IDENTITY.md": "名片", "USER.md": "关于你", "MEMORY.md": "她记下的事" });
const two = (value) => String(value).padStart(2, "0");
/** "今天 14:20", "昨天 09:05", "10月3日 14:20". */
export function when(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return "时间不详";
  const at = new Date(ts);
  const time = `${at.getHours()}:${two(at.getMinutes())}`;
  const day = (value) => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const diff = Math.round((day(ts) - day(now)) / 86_400_000);
  if (diff === 0) return `今天 ${time}`;
  if (diff === -1) return `昨天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  const year = at.getFullYear() === new Date(now).getFullYear() ? "" : `${at.getFullYear()}年`;
  return `${year}${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

function node(parent, tag, value, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(value ?? "");
  parent.append(element);
  return element;
}

/** Plain reading view of a Markdown file: headings, bullets and paragraphs; never parsed as HTML. */
export function renderReadable(parent, text) {
  let list = null;
  let paragraph = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const plain = (value) => value.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
    if (!line) { list = null; paragraph = null; continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) { list = null; paragraph = null; node(parent, "h4", plain(heading[1])); }
    else if (bullet) {
      paragraph = null;
      list ??= node(parent, "ul", "");
      node(list, "li", plain(bullet[1]));
    } else if (paragraph) {
      const before = paragraph.textContent;
      paragraph.textContent = `${before}${/[A-Za-z0-9,.;:!?)]$/.test(before) && /^[A-Za-z0-9(]/.test(line) ? " " : ""}${plain(line)}`;
    }
    else { list = null; paragraph = node(parent, "p", plain(line)); }
  }
}

/**
 * One managed file. [store] reads and writes it; [onSaved](path) runs after the owner's change went through. A save is
 * guarded by reading the file again first: if it no longer reads as it did when the editor loaded it, nothing is written.
 */
export class ManagedMarkdownEditor {
  constructor(root, { path, store, onSaved = () => {}, idFactory = () => crypto.randomUUID() } = {}) {
    if (!paths.has(path) || typeof store?.read !== "function" || typeof store?.write !== "function") throw new TypeError("unsupported managed editor path or store");
    this.root = root;
    this.path = path;
    this.label = FILE_LABELS[path];
    this.store = store;
    this.onSaved = onSaved;
    this.idFactory = idFactory;
    this.loaded = false;
    this.missing = false;
    this.truncated = false;
    this.content = "";
    this.draft = "";
    this.conflict = false;
    this.unverified = false;
    this.pending = null;
    this.editing = false;
    this.status = "正在读取…";
    this.disposed = false;
    this.render();
  }

  /** Whether the owner may change the file here: only from the machine she lives on, and never from a partial read. */
  get editable() { return !this.truncated; }

  dispose() {
    this.disposed = true;
    this.loaded = false;
    this.content = "";
    this.draft = "";
    this.pending = null;
    this.editing = false;
    this.root.replaceChildren();
  }

  async read() {
    if (this.disposed) throw new Error("已经关闭。");
    const found = await this.store.read(this.path);
    if (this.disposed) throw new Error("已经关闭。");
    if (found !== null && typeof found?.content !== "string") throw new Error("读到的内容不完整，请再试一次。");
    return found;
  }

  /** Reload discards a local draft only when explicitly requested by the caller. */
  async load({ discardDraft = false } = {}) {
    if (this.pending) throw new Error("上次的改动还没确认；请先再点一次同一个按钮。");
    if (this.loaded && this.draft !== this.content && !discardDraft) throw new Error("还有没保存的修改；先保存或取消。");
    let found;
    try { found = await this.read(); }
    catch (error) {
      if (this.disposed) throw error;
      throw new Error(error instanceof Error && /不完整/.test(error.message) ? error.message : "没能读取，请再试一次。");
    }
    const content = found?.content ?? "";
    this.content = content;
    this.draft = content;
    this.loaded = true;
    this.missing = found === null;
    this.truncated = found?.truncated === true;
    this.conflict = false;
    this.unverified = false;
    this.pending = null;
    this.status = this.truncated ? "内容太长，这里只显示了一部分，不能在这里修改。" : "";
    this.render();
    return { content };
  }

  setDraft(content) {
    if (!this.loaded || !this.editable || typeof content !== "string") throw new Error("还不能修改。");
    this.draft = content;
    this.render();
  }

  /** Editing always starts from what is on disk now, so a quiet background change is not overwritten later. */
  async edit() {
    if (!this.loaded || !this.editable || this.editing) return;
    if (!this.pending && !this.conflict && !this.unverified && this.draft === this.content) {
      try { await this.load(); }
      catch (error) { this.status = error instanceof Error ? error.message : "没能读取，请再试一次。"; this.render(); return; }
      if (!this.editable) return;
    }
    this.editing = true;
    this.render();
  }

  cancelEdit() {
    if (this.pending) return;
    this.draft = this.content;
    this.editing = false;
    this.status = this.truncated ? this.status : "";
    this.render();
  }

  async save() {
    if (!this.loaded || !this.editable) throw new Error("现在不能修改。");
    if (this.conflict || this.unverified) throw new Error("请先重新读取，再保存，以免覆盖别处的修改。");
    if (this.draft === this.content && !this.pending) {
      this.editing = false;
      this.render();
      return { unchanged: true };
    }
    if (this.pending && this.draft !== this.pending.content) throw new Error("上次保存还没确认；只能原样再试一次。");
    this.pending ??= { content: this.draft, base: this.content, client_id: this.idFactory(), sent: false };
    const pending = this.pending;
    this.status = "正在保存…";
    this.render();

    // The file must still read as it did when it was loaded (or already as the owner's text, after a lost answer).
    let current;
    try { current = await this.read(); }
    catch (error) {
      if (this.disposed) throw error;
      if (!pending.sent) this.pending = null;
      this.status = pending.sent ? UNSURE : "没能确认文件现在的内容，什么都没改；可以再点一次「保存」。";
      this.render();
      throw error instanceof Error ? error : new Error(this.status);
    }
    const now = current?.content ?? "";
    if (current?.truncated === true || (now !== pending.base && !(pending.sent && now === pending.content))) {
      this.pending = null;
      this.conflict = true;
      this.status = STALE;
      this.render();
      throw new Error(this.status);
    }
    if (now !== pending.content) {
      pending.sent = true;
      try { await this.store.write(this.path, pending.content, pending.client_id); }
      catch (error) {
        if (this.disposed) throw error;
        if (retryable(error)) {
          this.status = UNSURE;
          this.render();
          throw error instanceof Error ? error : new Error(this.status);
        }
        this.pending = null;
        this.status = failText(error);
        this.render();
        throw new Error(this.status);
      }
      if (this.disposed) throw new Error("已经关闭。");
    }
    this.pending = null;
    this.content = pending.content;
    this.unverified = true;
    this.status = "正在保存…";
    this.render();
    try { this.onSaved(this.path); } catch { /* the owner's change is saved either way */ }
    try {
      const saved = await this.read();
      if (saved === null || saved.truncated === true || saved.content !== pending.content) {
        this.conflict = true;
        this.status = "保存后这段内容又在别处被改过。你的修改还在；请重新读取后再看。";
      } else {
        this.content = saved.content;
        this.draft = saved.content;
        this.missing = false;
        this.editing = false;
        this.status = "已保存。";
      }
      this.unverified = false;
    } catch {
      if (this.disposed) return { conflict: false };
      this.unverified = true;
      this.status = "已保存，但没能重新读取；请点「重新读取」看看现在的内容。";
    }
    this.render();
    return { conflict: this.conflict };
  }

  render() {
    if (this.disposed) { this.root.replaceChildren(); return; }
    const fragment = document.createDocumentFragment();
    const card = node(fragment, "div", "", "set-card doc-card");
    card.dataset.file = this.path;
    const reading = node(card, "div", "", "doc-body");
    reading.hidden = this.editing;
    if (!this.loaded) node(reading, "p", "", "doc-empty");
    else if (!this.content.trim()) node(reading, "p", this.editable ? "还没有写下什么。点「编辑」写几句。" : "还没有写下什么。", "doc-empty");
    else renderReadable(reading, this.content);
    const source = node(card, "textarea", "", "markdown-source");
    source.value = this.draft;
    source.hidden = !this.editing;
    source.disabled = !this.loaded || !this.editable || !!this.pending || this.unverified;
    source.addEventListener("input", () => { this.draft = source.value; });
    const warning = this.conflict || this.unverified || !!this.pending;
    node(card, "p", this.status, warning ? "editor-warning" : "editor-status");
    const actions = node(card, "div", "", "set-actions");
    const action = (label, className, run) => {
      const button = node(actions, "button", label, className);
      button.type = "button";
      button.addEventListener("click", async () => {
        try { await run(); }
        catch (error) { if (!this.disposed) { this.status = error instanceof Error ? error.message : "没有完成，可以再试一次。"; this.render(); } }
      });
      return button;
    };
    const edit = action("编辑", "btn editor-edit", () => this.edit());
    edit.hidden = this.editing || !this.editable || !this.loaded;
    edit.disabled = !!this.pending;
    const save = node(actions, "button", this.pending ? "再试一次保存" : "保存", "btn editor-save");
    save.type = "button";
    save.hidden = !this.editing;
    save.disabled = !this.loaded || !this.editable || this.conflict || this.unverified;
    save.addEventListener("click", async () => { try { await this.save(); } catch { /* status is visible; draft remains */ } });
    const cancel = action("取消", "btn gray editor-cancel", () => this.cancelEdit());
    cancel.hidden = !this.editing || !!this.pending || this.conflict || this.unverified;
    const refresh = action(this.editing ? "重新读取（放弃修改）" : "重新读取", "btn gray editor-refresh", async () => {
      await this.load({ discardDraft: true });
    });
    refresh.hidden = !(this.conflict || this.unverified);
    this.root.replaceChildren(fragment);
  }
}

/** One page of managed files (identity or memory): a short note, a file switcher and the active file. */
export class ManagedFilesSheet {
  constructor(root, options, { files, intro = "", extra = null } = {}) {
    this.root = root;
    this.options = options;
    this.files = files;
    this.intro = intro;
    this.extra = extra;
    this.active = null;
    this.editor = null;
    this.epoch = 0;
  }

  dispose() {
    this.epoch++;
    this.editor?.dispose();
    this.editor = null;
    this.active = null;
    this.root.replaceChildren();
  }

  busy() {
    return Boolean(this.editor && (this.editor.pending || this.editor.editing ||
      this.editor.loaded && this.editor.draft !== this.editor.content));
  }

  async open(path = this.files[0]) {
    if (!this.files.includes(path)) throw new TypeError("unknown managed file");
    if (this.editor?.pending ||
      this.editor?.loaded && this.editor.draft !== this.editor.content) throw new Error("先保存或取消正在改的内容，再切换。");
    const epoch = ++this.epoch;
    const panel = document.createElement("section");
    const editor = new ManagedMarkdownEditor(panel, { ...this.options, path });
    await editor.load();
    if (epoch !== this.epoch) { editor.dispose(); throw new Error("页面已经换过，这次读取没有采用。"); }
    const tabs = document.createElement("nav");
    tabs.className = "sheet-switch";
    for (const name of this.files) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = FILE_LABELS[name];
      button.dataset.file = name;
      button.disabled = name === path;
      if (name === path) button.className = "on";
      button.addEventListener("click", async () => {
        try { await this.open(name); }
        catch (error) { editor.status = error instanceof Error ? error.message : "没能切换。"; editor.render(); }
      });
      tabs.append(button);
    }
    this.editor?.dispose();
    const parts = [];
    if (this.intro) {
      const note = document.createElement("p");
      note.className = "set-intro";
      note.textContent = this.intro;
      parts.push(note);
    }
    parts.push(tabs, panel);
    const extra = this.extra?.();
    if (extra) parts.push(extra);
    this.root.replaceChildren(...parts);
    this.active = path;
    this.editor = editor;
    return editor;
  }

  /** Coming back to the page shows what is on disk now, unless the owner is in the middle of something. */
  async refresh() {
    if (!this.editor || this.busy()) return;
    try { await this.editor.load(); } catch { /* the visible card keeps its last confirmed content */ }
  }
}
