import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { standardContracts } from "../src/namespaces";
import { ERROR_CODES } from "../src/message";
import { ASH_SDK } from "../src/versions";
import { WORD_CONTRACTS } from "../src/words";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// The name of the private project this was split from must not appear in public text; spelled out in pieces so this file itself is clean.
const FORBIDDEN_NAME = new RegExp(["at", "oll"].join(""), "i");

test("words.json and docs/WORDS.md match what the source generates", () => {
  // --check writes nothing and exits 1 when the committed files differ from the source.
  execFileSync(process.execPath, ["--import", "tsx", join(root, "tools/gen-words.mjs"), "--check"], { cwd: root, stdio: "pipe" });
});

test("words.json carries every contract, the error codes and a content hash", () => {
  const file = JSON.parse(readFileSync(join(root, "packages/sdk/schema/words.json"), "utf8"));
  assert.equal(file.sdk, ASH_SDK);
  assert.equal(file.api, "ash-api/3");
  assert.deepEqual(file.error_codes, [...ERROR_CODES]);
  assert.equal(file.words.length, WORD_CONTRACTS.length + standardContracts().length);
  assert.match(file.hash, /^[0-9a-f]{64}$/);
  const keys = new Set(file.words.map((word: { member: string; word: string }) => `${word.member}/${word.word}`));
  assert.equal(keys.size, file.words.length, "no word twice");
  for (const word of file.words) {
    assert.ok(Array.isArray(word.callers) && word.label?.doing && word.input_schema && word.effect && word.risk, `${word.member}/${word.word}`);
    assert.ok(!("audience" in word) && !("agents" in word), `${word.member}/${word.word} has no old fields`);
  }
});

test("docs/WORDS.md lists every word and never names the project it was split from", () => {
  const text = readFileSync(join(root, "docs/WORDS.md"), "utf8");
  for (const word of WORD_CONTRACTS) assert.ok(text.includes(`| \`${word.word}\` |`), `${word.member}/${word.word}`);
  assert.ok(!FORBIDDEN_NAME.test(text));
});
