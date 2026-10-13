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

test("the light primary colour carries white text; the brighter coral is only for marks with no text", () => {
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const c = tokens.color;
  assert.deepEqual([c.you.light, c["you-press"].light], ["#CC4B2E", "#B8432A"]);
  assert.ok(1.05 / (lum(c.you.light) + 0.05) >= 4.5, "white on the light primary reads");
  assert.equal(c.you.dark, "#FF8A66", "the dark theme is unchanged");
  assert.deepEqual([c["you-mark"].light, c["you-mark"].dark], ["#F2704E", c.you.dark]);
  const home = read("packages/web/home.css");
  assert.match(home, /\.hm-bar\.last\{background:var\(--you-mark\)\}/, "today's bar in the spend chart uses the mark colour");
});

test("component styles are plain page CSS built on the tokens", () => {
  const ui = read("packages/web/ash-ui.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\.t-(light|dark)\b/.test(ui), "the canvas wrappers are not part of the page styles");
  assert.ok(!/\.(device|screen|board|shot)\b/.test(ui), "display chrome is not part of the page styles");
  const home = read("packages/web/home.css").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const css of [ui, home]) {
    const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual([...new Set(hex)].filter((h) => !["#fff", "#000"].includes(h.toLowerCase())), [], "colours come from tokens");
  }
  assert.ok(!/rgba?\(/.test(home), "the home pages carry no colour of their own");
});

test("every CSS variable the page uses is defined by the tokens, the aliases or the rule itself", () => {
  const defined = new Set();
  for (const f of ["packages/web/ash-tokens.css", "packages/web/ash-ui.css", "packages/web/index.html"])
    for (const m of read(f).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  for (const f of ["packages/web/ash-ui.css", "packages/web/home.css", "packages/web/index.html"])
    for (const m of read(f).matchAll(/var\((--[a-z0-9-]+)/g)) assert.ok(defined.has(m[1]), `${f} uses undefined ${m[1]}`);
});

test("the generated browser page starts with the tokens and the component styles", () => {
  for (const [rel, what] of [["packages/core/src/edges/link-server/ui.generated.ts", "browser page"]]) {
    const text = read(rel);
    assert.ok(text.includes("--you-soft"), `${what}: tokens`);
    assert.ok(text.includes(".a-card"), `${what}: component styles`);
    assert.ok(text.includes(".hm-root"), `${what}: home page styles`);
    assert.ok(!text.includes("ash-style"), `${what}: style marker replaced`);
  }
});
