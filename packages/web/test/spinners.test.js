// Everything that turns on the page turns smoothly: a linear, endless rotation of the element itself, on its own layer so a busy main
// thread does not make it step, and still when the owner has asked for less motion.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const sheets = { "ash-ui.css": read("ash-ui.css"), "index.html": read("index.html"), "home.css": read("home.css") };

/** The rules (selector + body) that start the `spin` animation. */
function spinners() {
  const found = [];
  for (const [file, css] of Object.entries(sheets))
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*animation:\s*spin\b[^{}]*)\}/g)) found.push({ file, selector: rule[1].trim().split("\n").pop(), body: rule[2] });
  return found;
}

test("the page has its spinners, and each is a linear endless rotation", () => {
  const all = spinners();
  assert.ok(all.length >= 3, "the small spinner, the avatar's working ring and the top bar's");
  for (const { selector, body } of all) {
    assert.match(body, /animation:\s*spin\s+[\d.]+s\s+linear\s+infinite/, `${selector} turns linearly and for ever`);
    assert.ok(!/steps\(/.test(body), `${selector} does not step`);
  }
});

test("the spin keyframes change only transform: no border, size or layout property moves", () => {
  const frames = sheets["ash-ui.css"].match(/@keyframes spin\{([^@]*?)\}\s*(?=@|\.|#|$)/);
  assert.ok(frames, "keyframes spin");
  assert.match(frames[0], /transform:rotate\(360deg\)/);
  assert.ok(!/(width|height|border|margin|padding|top|left)\s*:/.test(frames[0]), "only the rotation");
  for (const css of Object.values(sheets)) assert.ok(!/animation[^;{}]*steps\(/.test(css), "no stepped animation anywhere");
});

test("every spinner is on its own layer, and only the spinners are", () => {
  for (const { selector, body } of spinners()) assert.match(body, /will-change:\s*transform/, `${selector} has its own layer`);
  const hinted = [...sheets["ash-ui.css"].matchAll(/([^{}]+)\{[^{}]*will-change:\s*transform[^{}]*\}/g)].map((m) => m[1].trim().split("\n").pop());
  for (const selector of hinted) assert.ok(spinners().some((s) => s.selector === selector), `${selector} spins`);
});

test("with less motion asked for, nothing turns and the layers are released", () => {
  assert.match(sheets["ash-ui.css"], /prefers-reduced-motion:reduce\)\{[^}]*\.spinner[^}]*animation:none;will-change:auto/);
  assert.match(sheets["index.html"], /prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important;will-change:auto!important\}/);
});
