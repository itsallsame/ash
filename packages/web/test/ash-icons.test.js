import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { ICON_SHAPES, icon } from "../js/ash-icons.js";

const element = (tag) => ({ tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.kids.push(...n); } });

test("every designed icon is available by its file name", () => {
  const files = readdirSync(new URL("../../../design/app/icons/", import.meta.url)).filter((f) => f.endsWith(".svg") && f !== "app-icon.svg").map((f) => f.slice(0, -4));
  assert.deepEqual(Object.keys(ICON_SHAPES).sort(), files.sort());
});

test("icon() draws an svg with the shared class and the icon's shapes", () => {
  globalThis.document = { createElementNS: (_ns, tag) => element(tag) };
  try {
    const svg = icon("back", "i-s");
    assert.equal(svg.attrs.class, "i i-s");
    assert.equal(svg.attrs.viewBox, "0 0 24 24");
    assert.equal(svg.kids.length, ICON_SHAPES.back.length);
    assert.equal(icon("back").attrs.class, "i");
    assert.throws(() => icon("nope"), /no icon/);
  } finally { delete globalThis.document; }
});
