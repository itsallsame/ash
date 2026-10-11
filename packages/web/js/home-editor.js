import { fill } from "./home-dom.js";
// A managed Markdown file on a home page: read as the page's own view, changed in a text box. The rules of reading before
// writing, of a lost answer and of a file that changed meanwhile are those of ManagedMarkdownEditor (editor.js); only the
// drawing is new.
import { ManagedMarkdownEditor } from "./editor.js";
import { h, btn } from "./home-ui.js";

export class HomeEditor extends ManagedMarkdownEditor {
  /** [view](content, parent) draws the reading view; [onChange]() runs after every redraw (the page's buttons follow the state). */
  constructor(root, { view = () => {}, onChange = () => {}, ...options } = {}) {
    super(root, { ...options, view, onChange });
    this.view = view;
    this.onChange = onChange;
    this.render();
  }

  render() {
    if (this.disposed) { fill(this.root); return; }
    const view = this.view ?? (() => {});
    const reading = h("div", { class: "hm-doc", hidden: this.editing });
    if (this.loaded) view(this.content, reading, { editable: this.editable });
    const warning = this.conflict || this.unverified || Boolean(this.pending);
    const source = h("textarea", { class: "hm-source", "aria-label": `编辑${this.label}`, hidden: !this.editing, disabled: !this.loaded || !this.editable || Boolean(this.pending) || this.unverified, value: this.draft });
    source.addEventListener("input", () => { this.draft = source.value; });
    const run = (fn) => async () => { try { await fn(); } catch (error) { if (!this.disposed) { this.status = error instanceof Error ? error.message : "没有完成，可以再试一次。"; this.render(); } } };
    const save = btn(this.pending ? "再试一次保存" : "保存", "a-btn btn-primary btn-block hm-save", async () => { try { await this.save(); } catch { /* the status line says what happened; the draft stays */ } }, { hidden: !this.editing, disabled: !this.loaded || !this.editable || this.conflict || this.unverified });
    const refresh = btn(this.editing ? "重新读取（放弃修改）" : "重新读取", "a-btn btn-neutral btn-block", run(() => this.load({ discardDraft: true })), { hidden: !(this.conflict || this.unverified) });
    const editor = h("div", { class: "hm-editor" }, source, h("p", { class: `hm-note${warning ? " c-warn" : ""}`, role: "status" }, this.status), save, refresh);
    fill(this.root, reading, editor);
    this.onChange?.(this);
  }
}

/** The state of the page's "编辑" button: its label, and what a tap does. */
export function editButton(editor) {
  if (!editor?.loaded || !editor.editable) return null;
  if (editor.editing) return { label: "取消", disabled: Boolean(editor.pending) || editor.conflict || editor.unverified, run: () => editor.cancelEdit() };
  return { label: "编辑", disabled: Boolean(editor.pending), run: () => editor.edit() };
}

/** Plain reading view of Markdown: headings, bullets and paragraphs; never parsed as HTML. */
export function readable(parent, text, { empty = "还没有写下什么。", skipTitle = false } = {}) {
  const plain = (value) => value.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  let any = false;
  let list = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (skipTitle && /^#\s/.test(line)) continue;
    any = true;
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) { list = null; parent.append(h("span", { class: "hm-doc-h" }, plain(heading[1]))); }
    else if (bullet) { if (!list) { list = h("ul", { class: "hm-doc-ul" }); parent.append(list); } list.append(h("li", {}, plain(bullet[1]))); }
    else { list = null; parent.append(h("span", { class: "hm-doc-p" }, plain(line))); }
  }
  if (!any) parent.append(h("span", { class: "hm-doc-empty" }, empty));
}
