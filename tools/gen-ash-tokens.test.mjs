// The design tokens: the generated files follow design/app/tokens.json, and the page's styles use only colours the tokens define.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const tokens = JSON.parse(read("design/app/tokens.json"));

test("committed token files match tokens.json", () => {
  for (const tool of ["tools/gen-ash-tokens.mjs", "tools/gen-ash-icons.mjs"])
    execFileSync(process.execPath, [`${root}${tool}`, "--check"], { stdio: "pipe" });
});

test("the page's CSS variables carry every token, light in :root and dark under prefers-color-scheme", () => {
  const css = read("packages/web/ash-tokens.css");
  const [light, dark] = css.split("@media (prefers-color-scheme:dark)");
  assert.ok(dark, "dark block present");
  for (const [name, value] of Object.entries(tokens.color)) {
    assert.ok(light.includes(`--${name}:${value.light};`), `light --${name}`);
    assert.ok(dark.includes(`--${name}:${value.dark};`), `dark --${name}`);
  }
});

test("Android resources carry every colour in both themes", () => {
  const argb = (v) => v.startsWith("#") ? `#FF${v.slice(1).toUpperCase()}` : null;
  for (const [file, mode] of [["values", "light"], ["values-night", "dark"]]) {
    const xml = read(`android/app/src/main/res/${file}/ash_colors.xml`);
    for (const [name, value] of Object.entries(tokens.color)) {
      const entry = xml.match(new RegExp(`<color name="ash_${name.replace(/-/g, "_")}">(#[0-9A-F]{8})</color>`));
      assert.ok(entry, `ash_${name} in ${file}`);
      if (argb(value[mode])) assert.equal(entry[1], argb(value[mode]), `${name} ${mode}`);
    }
  }
});

test("component styles are plain page CSS built on the tokens", () => {
  const ui = read("packages/web/ash-ui.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\.t-(light|dark)\b/.test(ui), "the canvas wrappers are not part of the page styles");
  assert.ok(!/\.(device|screen|board|shot)\b/.test(ui), "display chrome is not part of the page styles");
  const hex = ui.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual([...new Set(hex)].filter((h) => !["#fff", "#000"].includes(h.toLowerCase())), [], "colours come from tokens");
});

test("every CSS variable the page uses is defined by the tokens, the aliases or the rule itself", () => {
  const defined = new Set();
  for (const f of ["packages/web/ash-tokens.css", "packages/web/ash-ui.css", "packages/web/index.html"])
    for (const m of read(f).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  for (const f of ["packages/web/ash-ui.css", "packages/web/index.html"])
    for (const m of read(f).matchAll(/var\((--[a-z0-9-]+)/g)) assert.ok(defined.has(m[1]), `${f} uses undefined ${m[1]}`);
});

test("the generated page and the app's packaged page start with the tokens and the component styles", () => {
  for (const [rel, what] of [["packages/core/src/edges/link-server/ui.generated.ts", "browser page"], ["android/app/src/main/assets/ash-ui/index.html", "app page"]]) {
    const text = read(rel);
    assert.ok(text.includes("--you-soft"), `${what}: tokens`);
    assert.ok(text.includes(".a-card"), `${what}: component styles`);
    assert.ok(!text.includes("ash-style"), `${what}: style marker replaced`);
  }
});
