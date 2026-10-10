import assert from "node:assert/strict";
import test from "node:test";
import { presentUiOpen } from "../js/suggestions.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  remove() { this.removed = true; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
}

test("a suggested page is visible, opens only on click, and can be dismissed; the kernel is told it was not opened", async () => {
  globalThis.document = { createElement: (tag) => new Node(tag) };
  try {
    const root = new Node("root");
    const opened = [];
    const open = async (target) => { opened.push(target); return true; };
    const request = { target: "activity", mode: "suggest" };
    assert.equal(await presentUiOpen(root, request, open), false, "the answer describes this request, not a later click");
    assert.match(root.textContent, /建议查看活动.*打开.*关闭/);
    assert.deepEqual(opened, []);
    await root.children[0].children[1].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, ["activity"]);
    assert.equal(root.children[0].removed, true);
    await presentUiOpen(root, request, open);
    await root.children[0].children[2].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, ["activity"]);
  } finally { delete globalThis.document; }
});

test("perform (or no mode) opens directly and reports whether it did; an unknown target never claims success", async () => {
  const opened = [];
  const open = async (target) => { opened.push(target); return target !== "settings"; };
  assert.equal(await presentUiOpen(null, { target: "settings", mode: "perform" }, open), false, "the page refused");
  assert.equal(await presentUiOpen(null, { target: "memory" }, open), true);
  assert.equal(await presentUiOpen(null, { target: "unlisted", mode: "perform" }, open), false);
  assert.equal(await presentUiOpen(null, { target: "turn", id: "t_1", mode: "bad" }, open), false);
  assert.deepEqual(opened, ["settings", "memory"]);
});
