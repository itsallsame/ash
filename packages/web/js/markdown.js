import { marked } from "marked";
import { decodeHTML } from "entities";
import { addIcon } from "./chat-ui.js";

// Parse Markdown, never HTML: only these code-owned DOM elements are created.
// Raw HTML remains visible text; images are opt-in links, not network requests.
export function markdownUrl(value) {
  const href = decodeHTML(String(value ?? "")).trim();
  if (!/^(https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return null;
  try { const url = new URL(href); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

function element(parent, tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent.append(node);
  return node;
}
function literal(parent, value) { parent.append(document.createTextNode(String(value ?? ""))); }

async function copyCode(value) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  } catch { /* Android WebView can deny the browser Clipboard API; use its user-gesture fallback. */ }
  const focused = document.activeElement;
  const selection = document.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.className = "md-copy-buffer";
  field.value = value;
  field.readOnly = true;
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand?.("copy")) throw new Error("copy unavailable");
  } finally {
    field.remove();
    focused?.focus?.({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}

// A table is drawn as its shell (wrapper, header, empty body) and then one row at a time, so a slice can stop between rows.
function tableShell(parent, token, children) {
  const wrap = element(parent, "div", "md-table-wrap tbl");
  wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "表格，可横向滚动");
  const table = element(wrap, "table");
  tableRow(element(table, "thead"), token, token.header, "th", children);
  return element(table, "tbody");
}
function tableRow(section, token, cells, tag, children) {
  const tr = element(section, "tr");
  for (let i = 0; i < cells.length; i++) {
    const cell = element(tr, tag);
    if (tag === "th") cell.scope = "col";
    if (["left", "center", "right"].includes(token.align[i])) cell.style.textAlign = token.align[i];
    children(cell, cells[i]);
  }
}

function listShell(parent, token) {
  const list = element(parent, token.ordered ? "ol" : "ul");
  if (token.ordered && Number.isSafeInteger(token.start)) list.start = token.start;
  return list;
}
function listItem(list, item, children) { children(element(list, "li", item.task ? "md-task" : undefined), item); }
const childrenOf = (depth, options) => (node, token) => token.tokens ? renderTokens(node, token.tokens, depth + 1, options) : literal(node, decodeHTML(token.text ?? ""));

function renderTokens(parent, tokens, depth = 0, options = {}) {
  if (depth > 64) { for (const token of tokens) literal(parent, token.raw ?? token.text); return; }
  const children = childrenOf(depth, options);
  for (const token of tokens) {
    switch (token.type) {
      case "space": case "def": break;
      case "text": case "escape": children(parent, token); break;
      case "html": literal(parent, token.raw ?? token.text); break;
      case "paragraph": children(element(parent, "p"), token); break;
      case "heading": children(element(parent, `h${Math.max(1, Math.min(6, token.depth))}`), token); break;
      case "strong": case "em": case "del": children(element(parent, token.type), token); break;
      case "codespan": literal(element(parent, "code"), token.text); break;
      case "br": element(parent, "br"); break;
      case "hr": element(parent, "hr"); break;
      case "blockquote": children(element(parent, "blockquote"), token); break;
      case "list": { const list = listShell(parent, token); for (const item of token.items) listItem(list, item, children); break; }
      case "checkbox": {
        const check = element(parent, "input"); check.type = "checkbox"; check.disabled = true; check.checked = token.checked;
        check.setAttribute("aria-label", token.checked ? "已完成" : "未完成");
        literal(parent, " "); break;
      }
      case "link": case "image": {
        const href = markdownUrl(token.href);
        const fileLink = !href && options.onFileLink && typeof token.href === "string" && token.href && !/^[a-z][a-z0-9+.-]*:|^\/\/|^#|[\\\x00-\x1f\x7f]/i.test(decodeHTML(token.href));
        const node = href || fileLink ? element(parent, "a", token.type === "image" ? "md-image-link" : undefined) : parent;
        if (href) { node.href = href; node.target = "_blank"; node.rel = "noopener noreferrer"; node.referrerPolicy = "no-referrer"; }
        if (fileLink) { node.href = "#"; node.className = "md-file-link"; node.addEventListener("click", (event) => { event.preventDefault(); options.onFileLink(decodeHTML(token.href)); }); }
        if (token.type === "image") literal(node, `图片：${decodeHTML(token.text || "查看图片")}`);
        else children(node, token);
        break;
      }
      case "code": {
        const block = element(parent, "div", "md-code-block codeblk");
        const bar = element(block, "div", "md-code-bar hd");
        literal(element(bar, "span"), String(token.lang || "代码").split(/\s/)[0]);
        const button = element(bar, "button", "md-copy"); button.type = "button";
        const showIcon = () => { button.textContent = ""; addIcon(button, "copy", "i-s"); };
        showIcon();
        button.setAttribute("aria-label", "复制代码");
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await copyCode(token.text); button.textContent = "已复制"; }
          catch { button.textContent = "复制失败，请长按选择"; }
          finally { button.disabled = false; setTimeout(showIcon, 1800); }
        });
        const pre = element(block, "pre"); literal(element(pre, "code"), token.text);
        break;
      }
      case "table": { const body = tableShell(parent, token, children); for (const cells of token.rows) tableRow(body, token, cells, "td", children); break; }
      default: literal(parent, token.raw ?? token.text);
    }
  }
}

const lex = (raw) => {
  // Bound parser work on unexpectedly large messages; the caller keeps the whole source in the fallback.
  if (raw.length > 200_000) throw new Error("large message");
  return marked.lexer(raw, { gfm: true, breaks: true });
};

export function appendMarkdown(parent, source, options = {}) {
  const raw = String(source ?? "");
  const content = element(parent, "div", "markdown");
  try { renderTokens(content, lex(raw), 0, options); }
  catch { content.className = "markdown md-plain"; content.textContent = raw; }
  return content;
}

// All mounted messages share one frame budget, including a page of short inline messages.
export class MarkdownQueue {
  constructor({ budget = 4, before = () => {}, after = () => {} } = {}) {
    Object.assign(this, { budget, before, after });
    this.jobs = []; this.scheduled = false;
  }
  add(iterator, signal, shouldBuild = () => true) {
    return new Promise(resolve => {
      const job = { iterator, signal, resolve, shouldBuild };
      job.finish = complete => {
        signal?.removeEventListener("abort", job.abort);
        iterator.return?.();
        const index = this.jobs.indexOf(job); if (index >= 0) this.jobs.splice(index, 1);
        resolve(complete);
      };
      job.abort = () => job.finish(false);
      if (signal?.aborted) { job.finish(false); return; }
      signal?.addEventListener("abort", job.abort, { once: true });
      this.jobs.push(job); this.schedule();
    });
  }
  schedule() {
    if (this.scheduled || !this.jobs.length) return;
    this.scheduled = true;
    // A microtask/task alone can pack every slice into the same frame before layout.
    requestAnimationFrame(() => setTimeout(() => {
      this.scheduled = false;
      if (!this.jobs.length) return;
      if (!this.jobs.some(job => job.shouldBuild())) { this.schedule(); return; }
      this.before();
      const end = performance.now() + this.budget;
      try {
        do {
          const job = this.jobs.find(candidate => candidate.shouldBuild());
          if (!job) break;
          if (job.iterator.next().done) job.finish(true);
        } while (this.jobs.length && performance.now() < end);
      } finally { this.after(); this.schedule(); }
    }, 0));
  }
  dispose() { for (const job of [...this.jobs]) job.finish(false); }
}

// Complete original DOM: tables stop between rows, lists between items, other blocks are one step.
function* markdownSteps(content, raw, options) {
  try {
    const tokens = lex(raw);
    yield; // The parser's work counts against the same slice budget as DOM construction.
    options.onStart?.();
    const children = childrenOf(0, options);
    for (const token of tokens) {
      if (token.type === "table") {
        const body = tableShell(content, token, children); yield;
        for (const cells of token.rows) { tableRow(body, token, cells, "td", children); yield; }
      } else if (token.type === "list") {
        const list = listShell(content, token); yield;
        for (const item of token.items) { listItem(list, item, children); yield; }
      } else { renderTokens(content, [token], 0, options); yield; }
    }
  } catch { options.onStart?.(); content.className = "markdown md-plain"; content.textContent = raw; }
}

export function appendMarkdownInSlices(parent, source, { queue = new MarkdownQueue(), signal, shouldBuild, ...options } = {}) {
  const content = element(parent, "div", "markdown");
  return queue.add(markdownSteps(content, String(source ?? ""), options), signal, shouldBuild).then(() => content);
}
