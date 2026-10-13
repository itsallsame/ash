import assert from "node:assert/strict";
import test from "node:test";
import { appendMarkdown, markdownUrl } from "../js/markdown.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attributes = {}; this.listeners = {}; }
  append(child) { this.children.push(child); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map(c => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("Markdown must never inject HTML"); }
}
function draw(source) {
  globalThis.document = { createElement: tag => new Node(tag), createTextNode: value => { const n = new Node("#text"); n.textContent = value; return n; } };
  try { return appendMarkdown(new Node("root"), source); } finally { delete globalThis.document; }
}
const all = node => [node, ...node.children.flatMap(all)];
const tags = (node, tag) => all(node).filter(n => n.tag === tag);

test("Markdown renders rich structure, nested lists, task boxes, tables and explicit line breaks", () => {
  const n = draw("# 结果\n\n**重点**、*说明*、~~过时~~ &amp; `x < y`\n下一行\n\n> 引用\n\n3. 第三项\n   - 子项\n\n- [x] 已完成\n- [ ] 待完成\n\n|型号|价格|\n|:---|---:|\n|**A**|680|\n\n---");
  assert.equal(tags(n, "h1")[0].textContent, "结果");
  assert.equal(tags(n, "strong")[0].textContent, "重点");
  assert.equal(tags(n, "em")[0].textContent, "说明");
  assert.equal(tags(n, "del")[0].textContent, "过时");
  assert.equal(tags(n, "code")[0].textContent, "x < y");
  assert.equal(tags(n, "ol")[0].start, 3);
  assert.equal(tags(n, "input").length, 2);
  assert.equal(tags(n, "input")[0].checked, true);
  assert.ok(tags(n, "input").every(x => x.disabled));
  assert.equal(tags(n, "th")[1].style.textAlign, "right");
  assert.equal(tags(n, "td")[0].textContent, "A");
  assert.equal(tags(n, "hr").length, 1);
  assert.equal(tags(n, "br").length, 1);
});

test("HTML and entity-encoded markup stay text, images never load, unsafe URLs never become anchors", () => {
  const n = draw('<img src=x onerror=alert(1)>\n\n&lt;svg onload=alert(1)&gt;\n\n[bad](javascript:alert%281%29) [data](data:text/html,x) [local](/api/send) [safe](https://example.com/?a=1&amp;b=2)\n\n![remote](https://example.com/track.png)');
  assert.equal(tags(n, "img").length, 0);
  assert.equal(tags(n, "svg").length, 0);
  assert.equal(tags(n, "script").length, 0);
  assert.ok(n.textContent.includes("<img src=x onerror=alert(1)>"));
  assert.ok(n.textContent.includes("<svg onload=alert(1)>"));
  assert.deepEqual(tags(n, "a").map(a => a.href), ["https://example.com/?a=1&b=2", "https://example.com/track.png"]);
  assert.ok(tags(n, "a").every(a => a.rel === "noopener noreferrer" && a.referrerPolicy === "no-referrer"));
  for (const href of ["javascript:alert(1)", "&#106;avascript:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "file:///a", "intent://x", "/api/send", "//evil.test", "https://example.com/\nfoo"]) assert.equal(markdownUrl(href), null);
});

test("fenced code preserves whitespace and markup literally, unclosed fences still render, huge messages fall back intact", () => {
  const source = '```html\n<main> &amp; **not emphasis**\n\t  tail\n```';
  const n = draw(source);
  assert.equal(tags(n, "pre")[0].textContent, '<main> &amp; **not emphasis**\n\t  tail');
  assert.equal(tags(n, "button")[0].attributes["aria-label"], "复制代码");
  assert.equal(tags(n, "main").length, 0);
  assert.equal(tags(draw('```js\nconst x = 1;'), "code")[0].textContent, "const x = 1;");
  const huge = "# x\n".repeat(50001);
  const fallback = draw(huge);
  assert.equal(fallback.className, "markdown md-plain");
  assert.equal(fallback.textContent, huge);
});

test("sliced Markdown retains the synchronous structure and cancels queued parsing", async () => {
  const { appendMarkdownInSlices, MarkdownQueue } = await import("../js/markdown.js");
  const source = '# 标题\n\n[reference][r] **bold**\n\n- [x] done\n  - nested\n- next\n\n|a|b|\n|:---|---:|\n|one|**two**|\n\n```html\n<img src=x>\n```\n\n<script>unsafe</script>\n\n[r]: https://example.com/';
  const expected = draw(source);
  const frames = [];
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  globalThis.document = { createElement: tag => new Node(tag), createTextNode: value => { const n = new Node("#text"); n.textContent = value; return n; } };
  try {
    const root = new Node("root"), canceled = new Node("root");
    let slices = 0;
    const queue = new MarkdownQueue({ budget: 0, after: () => slices++ });
    const done = appendMarkdownInSlices(root, source, { queue });
    const controller = new AbortController();
    const stop = appendMarkdownInSlices(canceled, '## never built', { queue, signal: controller.signal });
    controller.abort(); await stop;
    assert.equal(canceled.textContent, "");
    assert.equal(frames.length, 1, "all messages share one scheduled frame");
    while (frames.length) { frames.shift()(0); await new Promise(resolve => setTimeout(resolve, 5)); }
    const actual = await done;
    const shape = node => ({ tag: node.tag, text: node.value, className: node.className, style: node.style, attributes: node.attributes, children: node.children.map(shape) });
    assert.deepEqual(shape(actual), shape(expected));
    assert.ok(slices > 8, "zero-budget test yields between table/list steps");
    assert.equal(queue.jobs.length, 0);
  } finally { delete globalThis.document; delete globalThis.requestAnimationFrame; }
});

test("paused full-text work neither parses nor blocks inline work, and cancellation releases its completion", async () => {
  const { appendMarkdownInSlices, MarkdownQueue } = await import("../js/markdown.js");
  const frames = [];
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  globalThis.document = { createElement: tag => new Node(tag), createTextNode: value => { const n = new Node("#text"); n.textContent = value; return n; } };
  const advance = async count => { for (let i = 0; i < count && frames.length; i++) { frames.shift()(0); await new Promise(resolve => setTimeout(resolve, 5)); } };
  try {
    const queue = new MarkdownQueue({ budget: 0 }), paused = new Node("root"), inline = new Node("root");
    let allowed = false, completed = false;
    const pending = appendMarkdownInSlices(paused, '# restored text', { queue, shouldBuild: () => allowed }).then(() => { completed = true; });
    const normal = appendMarkdownInSlices(inline, 'ordinary inline', { queue });
    await advance(5); await normal;
    assert.equal(inline.textContent, 'ordinary inline'); assert.equal(paused.textContent, ''); assert.equal(completed, false);
    allowed = true; await advance(5); await pending;
    assert.equal(paused.textContent, 'restored text');
    const controller = new AbortController();
    const stop = appendMarkdownInSlices(new Node("root"), '# canceled', { queue, shouldBuild: () => false, signal: controller.signal });
    await advance(1); controller.abort(); await stop;
    assert.equal(queue.jobs.length, 0);
  } finally { delete globalThis.document; delete globalThis.requestAnimationFrame; }
});
