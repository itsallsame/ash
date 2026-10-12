// A helper's letter face: its first character, whole, on one of six colours chosen by its name. The vectors are shared with the Android test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HELPER_TONES, letterClasses, letterOf, toneOf } from "../js/chat-ui.js";

const { cases } = JSON.parse(readFileSync(new URL("../../../design/app/letter-avatar-vectors.json", import.meta.url), "utf8"));
const tokens = JSON.parse(readFileSync(new URL("../../../design/app/tokens.json", import.meta.url), "utf8"));

test("the letter and the colour follow the shared vectors", () => {
  assert.ok(cases.length >= 15);
  for (const { name, letter, tone } of cases) {
    assert.equal(letterOf(name), letter, `letter of ${JSON.stringify(name)}`);
    assert.equal(toneOf(name), HELPER_TONES[tone], `tone of ${JSON.stringify(name)}`);
  }
});

test("the six colours are the design's, the same in light and dark, and white text reads on every one", () => {
  const table = { purple: ["#6B5BD6", 5.1], blue: ["#2F73C9", 4.8], teal: ["#14837A", 4.6], green: ["#3A8540", 4.6], amber: ["#A8641A", 4.7], rose: ["#B5456C", 5.2] };
  assert.deepEqual([...HELPER_TONES], Object.keys(table));
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  for (const [tone, [hex, ratio]] of Object.entries(table)) {
    const token = tokens.color[`helper-${tone}`];
    assert.deepEqual([token.light, token.dark], [hex, hex]);
    assert.ok(Math.abs(1.05 / (lum(hex) + 0.05) - ratio) < 0.06, `${tone} contrast`);
  }
});

test("a name is summed by code point and trimmed, so one helper keeps one colour", () => {
  assert.equal(letterClasses(" 研 "), letterClasses("研"));
  assert.equal(letterClasses("研"), `av-letter av-tone-${HELPER_TONES[0x7814 % 6]}`);
  assert.equal(toneOf(undefined), HELPER_TONES[0]);
});
