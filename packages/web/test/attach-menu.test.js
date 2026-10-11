import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { addPicked, applyChoice, ATTACH_CHOICES, attachMenu } from "../js/attach-menu.js";

class Input {
  constructor() { this.attributes = {}; this.multiple = true; this.clicks = 0; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  click() { this.clicks++; }
}
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.hidden = false; this.attributes = {}; }
  append(child) { this.children.push(child); }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
  /** Every node below this one, this one included. */
  all() { return [this, ...this.children.flatMap((child) => child.all?.() ?? [])]; }
  replaceChildren() { this.children = []; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

test("the attach sheet offers camera, video, gallery and files in that order", () => {
  assert.deepEqual(ATTACH_CHOICES.map((choice) => choice.label), ["拍照", "录像", "相册", "文件"]);
});

test("each choice sets what the file input asks for, and clears what the previous one set", () => {
  const input = new Input();
  const pick = (id) => applyChoice(input, ATTACH_CHOICES.find((choice) => choice.id === id));
  pick("photo");
  assert.deepEqual(input.attributes, { accept: "image/*", capture: "environment" });
  assert.equal(input.multiple, false);
  pick("video");
  assert.deepEqual(input.attributes, { accept: "video/*", capture: "environment" });
  pick("gallery");
  assert.deepEqual(input.attributes, { accept: "image/*,video/*" });
  assert.equal(input.multiple, true);
  pick("file");
  assert.deepEqual(input.attributes, {});
  assert.equal(input.multiple, true);
});

test("the + button opens the sheet and a choice opens the picker once", () => {
  globalThis.document = { createElement: (tag) => new Node(tag) };
  try {
    const root = new Node("div");
    const button = new Node("button");
    const input = new Input();
    attachMenu(root, button, input);
    assert.equal(root.hidden, true);
    button.listeners.click();
    assert.equal(root.hidden, false);
    assert.equal(button.attributes["aria-expanded"], "true");
    assert.match(root.textContent, /一条消息最多带约 3 MB/);
    root.all().find((item) => item.dataset.pick === "photo").listeners.click();
    assert.equal(root.hidden, true);
    assert.equal(input.clicks, 1);
    assert.equal(input.attributes.capture, "environment");
  } finally { delete globalThis.document; }
});

test("picks add up instead of replacing each other", () => {
  const first = addPicked([], [{ name: "a.jpg" }]);
  const second = addPicked(first, [{ name: "b.mp4" }]);
  assert.deepEqual(second.map((file) => file.name), ["a.jpg", "b.mp4"]);
  assert.equal(addPicked([], Array.from({ length: 40 }, (_, i) => ({ name: `${i}` }))).length, 32);
});

test("the scrim closes the sheet without choosing", () => {
  globalThis.document = { createElement: (tag) => new Node(tag) };
  try {
    const root = new Node("div");
    const button = new Node("button");
    const input = new Input();
    attachMenu(root, button, input);
    button.listeners.click();
    root.children[0].listeners.click();
    assert.equal(root.hidden, true);
    assert.equal(input.clicks, 0);
  } finally { delete globalThis.document; }
});

test("the page carries the sheet's layer next to the + button", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<div id="attachMenu" class="layer attach-menu" hidden><\/div>/);
  assert.match(html, /<input type="file" id="file" multiple hidden>/);
});
