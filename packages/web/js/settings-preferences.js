// The proactive-contact preferences: the text of PROACTIVE.md in the main body's work directory, read and written with
// the body's own file words (`workspace.read` / `workspace.write`), like any other file.
import { BODY_MAIN, readText, writeText } from "./body.js";
import { retryable } from "./link.js";

const PATH = "PROACTIVE.md";
const MAX_CHARS = 65_536;

function element(tag, text = "") {
  const item = document.createElement(tag);
  item.textContent = text;
  return item;
}

/** An editor bound to one connection. Drafts and uncertain writes live only in this instance. */
export class ProactivePreferences {
  constructor(root, net, valid) {
    this.root = root;
    this.net = net;
    this.valid = valid;
    this.identity = net.binding();
    this.active = true;
    this.baseline = null;
    this.loaded = false;
    this.pending = null;
    this.busy = false;
    this.status = element("p", "");
    this.status.className = "set-status";
    this.status.setAttribute("role", "status");
    this.loadButton = element("button", "重新读取");
    this.loadButton.className = "btn gray";
    this.loadButton.id = "settingsProactiveLoad";
    this.loadButton.type = "button";
    this.saveButton = element("button", "保存");
    this.saveButton.className = "btn";
    this.saveButton.id = "settingsProactiveSave";
    this.saveButton.type = "button";
    this.editor = document.createElement("textarea");
    this.editor.id = "settingsProactiveText";
    this.editor.className = "set-editor";
    this.editor.placeholder = "比如：早上 9 点前别找我；快递和日程变化可以直接说；别的事攒到晚上一起说。";
    this.editor.maxLength = MAX_CHARS;
    this.editor.disabled = true;
    this.saveButton.disabled = true;
    this.loadButton.addEventListener("click", () => { void this.load(); });
    this.saveButton.addEventListener("click", () => { void this.save(); });
    root.append(this.editor, this.saveButton, this.loadButton, this.status);
  }

  current() {
    return this.active && this.valid() && this.net.same(this.identity);
  }

  dispose() {
    this.active = false;
    this.pending = null;
    this.baseline = null;
    this.loaded = false;
    this.editor.value = "";
  }

  /** The text of the file now, or null when it does not exist yet. A file read only in part cannot be edited here. */
  async fileText() {
    try {
      const { text, truncated } = await readText(this.net, BODY_MAIN, PATH);
      if (truncated) throw Object.assign(new Error("too large"), { code: "too_large" });
      return text;
    } catch (error) {
      if (error?.code === "not_found") return null;
      throw error;
    }
  }

  async load() {
    if (!this.current() || this.busy || this.pending) return;
    this.busy = true;
    this.loadButton.disabled = true;
    this.saveButton.disabled = true;
    this.status.textContent = "正在读取…";
    try {
      const text = await this.fileText();
      if (!this.current()) return;
      this.baseline = text;
      this.editor.value = text ?? "";
      this.loaded = true;
      this.pending = null;
      this.status.textContent = text === null ? "还没有写过，写下来保存就行。" : "已读取当前偏好。";
    } catch (error) {
      if (this.current()) {
        this.loaded = false;
        this.status.textContent = error?.code === "too_large" ? "这个文件太长了，不能在这里改。"
          : retryable(error) ? "连接断了，没读到偏好。" : "没读到偏好，请点「重新读取」。";
      }
    } finally {
      this.busy = false;
      if (this.current()) {
        this.loadButton.disabled = Boolean(this.pending);
        this.editor.disabled = !this.loaded || Boolean(this.pending);
        this.saveButton.disabled = !this.loaded;
      }
    }
  }

  async save() {
    if (!this.current() || !this.loaded || this.busy) return;
    if (!this.pending && this.editor.value.length > MAX_CHARS) {
      this.status.textContent = "内容太长了，没有保存。";
      return;
    }
    // [expected] is the text this edit started from; [sent] says a write was tried, so the file may already hold [content].
    const pending = this.pending ?? { content: this.editor.value, expected: this.baseline, sent: false, client_id: crypto.randomUUID() };
    this.pending = pending;
    this.busy = true;
    this.editor.disabled = true;
    this.saveButton.disabled = true;
    this.loadButton.disabled = true;
    this.status.textContent = "正在保存…";
    try {
      // Words have no hash to check: read again and compare with what this edit started from before writing over it.
      let now;
      try { now = await this.fileText(); } catch {
        if (this.current()) {
          if (!pending.sent) this.pending = null;
          this.status.textContent = pending.sent ? "保存结果未确认，请再点一次保存。" : "没能确认文件现在的内容，没有保存，请再点一次保存。";
        }
        return;
      }
      if (!this.current()) return;
      if (now !== pending.content) {
        if (now !== pending.expected) {
          this.pending = null;
          this.status.textContent = "这段偏好刚在别处改过，未覆盖；请点「重新读取」后再改。";
          return;
        }
        pending.sent = true;
        try { await writeText(this.net, BODY_MAIN, PATH, pending.content, { clientId: pending.client_id }); }
        catch (error) {
          if (!this.current()) return;
          if (retryable(error)) this.status.textContent = "保存结果未确认，请再点一次保存。";
          else { this.pending = null; this.status.textContent = "保存被拒绝了。"; }
          return;
        }
        if (!this.current()) return;
      }
      let after;
      try { after = await this.fileText(); } catch { after = undefined; }
      if (!this.current()) return;
      if (after === pending.content) {
        this.baseline = pending.content;
        this.pending = null;
        this.status.textContent = "已保存。";
      } else this.status.textContent = "保存结果未确认，请再点一次保存。";
    } finally {
      this.busy = false;
      if (this.current()) {
        this.loadButton.disabled = Boolean(this.pending);
        this.editor.disabled = Boolean(this.pending);
        this.saveButton.disabled = false;
      }
    }
  }
}
