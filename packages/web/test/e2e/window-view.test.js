import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { withBrowser } from "./support.js";

async function fixture(browser) {
  const web = new URL("../../", import.meta.url);
  const html = await readFile(new URL("index.html", web), "utf8");
  const css = (await Promise.all(["ash-tokens.css", "ash-ui.css"].map(path => readFile(new URL(path, web), "utf8")))).join("\n") + [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join("\n");
  const bundle = await build({ stdin: { contents: 'export { WindowView, changedIds } from "./window-view.js"; export { appendConversation } from "./conversation.js";', resolveDir: fileURLToPath(new URL("js/", web)) }, bundle: true, write: false, format: "iife", globalName: "ViewModule" });
  const page = await browser.newPage({ viewport: { width: 393, height: 852 }, reducedMotion: "reduce" });
  await page.setContent(`<style>${css}body{display:block;height:852px}#log{height:740px}</style><main id="log" class="stream"></main><button id="outside">outside</button>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    window.view = new ViewModule.WindowView(document.querySelector("#log"));
    window.say = (id, text = `message ${id}`) => ({ id: `m${id}`, seq: id, ts: Date.now() + id * 1000, type: "say", side: "agent", from: "agent:main", text, group: "t1", reactions: [] });
    window.options = { primary: "agent:main", agentName: id => id.slice(6), atStart: false };
  });
  return page;
}

test(...withBrowser("stable rows preserve Markdown, card drafts, selection, and the original sibling layout", async ({ browser }) => {
  const page = await fixture(browser);
  const result = await page.evaluate(async () => {
    const custom = { id: "choice", seq: 2, ts: Date.now(), type: "card", side: "agent", card: { type: "options", prompt: "choose", options: [{ id: "a", text: "A" }], allow_custom: true } };
    options.onSelect = async () => {};
    window.items = [say(1, "## Heading\n\nread **this**\n\n```js\nlet a=1;\n```"), custom];
    view.update(items, [], options);
    const first = document.querySelector('.msg[data-seq="1"]'), paragraph = first.querySelector("p");
    const input = document.querySelector(".card-custom"); input.value = "unfinished"; input.focus(); input.setSelectionRange(2, 5);
    items.push(say(3)); view.update(items, [], options, new Set(["m3"]));
    const draft = input === document.activeElement && input.value === "unfinished" && input.selectionStart === 2 && input.selectionEnd === 5;
    document.querySelector("#outside").focus();
    const selection = document.getSelection(), range = document.createRange(); range.selectNodeContents(paragraph); selection.removeAllRanges(); selection.addRange(range);
    items.push(say(4)); view.update(items, [], options, new Set(["m4"]));
    const keptSelection = selection.toString();
    items[0] = { ...items[0], text: "changed while selected" }; view.update(items, [], options, new Set(["m1"]));
    const deferred = first.querySelector("p") === paragraph;
    selection.removeAllRanges(); document.dispatchEvent(new Event("selectionchange"));
    const changed = document.querySelector('.msg[data-seq="1"]').textContent;
    const eager = document.createElement("div"); ViewModule.appendConversation(eager, items, options);
    const normalize = root => [...root.children].map(node => { const clone = node.cloneNode(true); clone.removeAttribute("data-row-key"); clone.classList.remove("enter"); return clone.outerHTML; });
    return { draft, keptSelection, deferred, changed, layout: normalize(document.querySelector("#log")), eager: normalize(eager), markdownSurvived: first.querySelector("p") === paragraph };
  });
  assert.equal(result.draft, true); assert.equal(result.keptSelection, "read this"); assert.equal(result.deferred, true);
  assert.match(result.changed, /changed while selected/); assert.deepEqual(result.layout, result.eager);
}));

test(...withBrowser("receipt, reaction, and burst grouping updates retain the message body and attachment nodes", async ({ browser }) => {
  const page = await fixture(browser);
  const result = await page.evaluate(() => {
    let files = 0; options.onOpenFile = () => files++;
    const owner = { ...say(1), side: "owner", text: "hello", delivery: "sent", attachments: [{ workspace: "main", path: "a.png", name: "a.png" }] };
    window.items = [owner, say(2, "## Title\n\nkeep body")]; view.update(items, [], options);
    const body = document.querySelector('.msg[data-seq="2"]'), paragraph = body.querySelector("p"), attachment = document.querySelector(".atts button");
    items = [{ ...owner, delivery: "read" }, { ...items[1], reactions: [{ id: "r", emoji: "👍" }] }, say(3)];
    view.update(items, [], options, new Set(["m1", "m2", "m3"])); attachment.click();
    return { sameBody: body === document.querySelector('.msg[data-seq="2"]'), sameParagraph: paragraph === body.querySelector("p"), sameAttachment: attachment === document.querySelector(".atts button"), files, receipt: document.querySelector(".delivery").textContent, reaction: body.querySelector(".reaction").textContent, group: body.className };
  });
  assert.equal(result.sameBody, true); assert.equal(result.sameParagraph, true); assert.equal(result.sameAttachment, true);
  assert.equal(result.files, 1); assert.equal(result.receipt, "已读"); assert.equal(result.reaction, "👍"); assert.match(result.group, /group-first/);
}));

test(...withBrowser("prepend, append, eviction, delayed heights and long-message blocks keep the reading anchor", async ({ browser }) => {
  const page = await fixture(browser);
  await page.evaluate(() => { window.items = Array.from({ length: 60 }, (_, i) => say(i + 100)); view.update(items, [], options); view.position.jump(document.querySelector('.msg[data-seq="130"]')); window.anchor = document.querySelector('.msg[data-seq="130"]'); window.offset = anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top; });
  const measure = () => page.evaluate(() => anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top - offset);
  await page.evaluate(() => { items = [...Array.from({ length: 10 }, (_, i) => say(i + 90)), ...items]; view.update(items, [], options); }); assert.ok(Math.abs(await measure()) < 1);
  await page.evaluate(() => { items.push(say(160)); view.update(items, [], options, new Set(["m160"])); }); assert.ok(Math.abs(await measure()) < 1);
  await page.evaluate(() => { items = items.slice(10); view.update(items, [], options); }); assert.ok(Math.abs(await measure()) < 1);
  await page.evaluate(() => { const space = document.createElement("div"); space.style.height = "800px"; document.querySelector('.msg[data-seq="110"]').append(space); });
  await page.waitForFunction(() => Math.abs(anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top - offset) < 1);
  await page.evaluate(() => { items = [say(1000, Array.from({ length: 80 }, (_, i) => `paragraph ${i}\n`).join("\n"))]; view.update(items, [], options); window.anchor = document.querySelectorAll(".markdown p")[40]; view.position.jump(anchor); window.offset = anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top; const space = document.createElement("div"); space.style.height = "300px"; document.querySelector(".markdown").prepend(space); });
  await page.waitForFunction(() => Math.abs(anchor.getBoundingClientRect().top - view.root.getBoundingClientRect().top - offset) < 1);
  await page.evaluate(() => { view.position.latest(); items.push(say(1001)); view.update(items, [], options, new Set(["m1001"])); });
  assert.ok(await page.evaluate(() => view.root.scrollHeight - view.root.scrollTop - view.root.clientHeight < 1));
}));

test(...withBrowser("eviction respects focus and late attachment reads revoke their resources", async ({ browser }) => {
  const page = await fixture(browser);
  await page.evaluate(() => {
    window.released = 0; options.openInline = () => new Promise(resolve => { window.finishAttachment = resolve; });
    window.items = [{ ...say(1), attachments: [{ source: "inline", message_id: "m1", index: 0, name: "image.png" }] }];
    view.update(items, [], options); document.querySelector(".atts button").click();
    const bubble = document.querySelector(".msg"); bubble.tabIndex = 0; bubble.focus();
    view.update([], [], options); window.pins = view.pinnedIds(); document.querySelector("#outside").focus();
    finishAttachment({ preview: true, name: "image", url: "blob:unused", revoke: () => released++ });
  });
  await page.waitForFunction(() => released === 1);
  assert.deepEqual(await page.evaluate(() => pins), ["m1"]);
  assert.equal(await page.locator("#log .atts").count(), 0);
}));
