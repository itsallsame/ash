// The page is for the desktop browser now, and nothing on it loops: a looping animation keeps the compositor drawing a frame every
// 16 ms for as long as it is on screen (what made the phone's chat slow when it was a web view). A working state is a still mark.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const sheets = { "ash-ui.css": read("ash-ui.css"), "index.html": read("index.html"), "home.css": read("home.css") };

test("no animation on the page runs for ever", () => {
  for (const [file, css] of Object.entries(sheets)) {
    assert.ok(!/animation[^;{}]*infinite/.test(css), `${file} has an endless animation`);
    assert.ok(!/@keyframes\s+(spin|breath|dots)\b/.test(css), `${file} still defines a looping keyframes`);
  }
});

test("no layer is held for an animation that is not there", () => {
  for (const [file, css] of Object.entries(sheets)) assert.ok(!/will-change:\s*transform/.test(css), `${file} keeps a layer for nothing`);
});

test("with less motion asked for, transitions and animations are off", () => {
  assert.match(sheets["index.html"], /prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important;will-change:auto!important\}/);
});
