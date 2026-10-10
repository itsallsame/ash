import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { standardContracts } from "../src/namespaces";
import { WORD_CONTRACTS } from "../src/words";
import { DEFAULT_CALLERS } from "../src/word";

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "callers.snapshot.txt");
const HEADER = [
  "# Who may call each word (the `callers` of its contract), one line per word: member/word  callers  [flags].",
  "# Words that say nothing get the default (owner, agent, app); they are listed too so a review sees what a new word got.",
  "# `*` marks a line that is not the default. Change it on purpose: UPDATE_SNAPSHOT=1 node --import tsx --test packages/sdk/test/callers.test.ts",
].join("\n");

function render(): string {
  const lines = [...WORD_CONTRACTS, ...standardContracts()].map((word) => {
    const same = word.callers.length === DEFAULT_CALLERS.length && DEFAULT_CALLERS.every((who, i) => word.callers[i] === who);
    const flags = [word.local_only ? "local_only" : null, word.kind === "event" ? `event-${word.direction}` : null].filter(Boolean).join(" ");
    return `${same ? " " : "*"} ${word.member}/${word.word}  ${word.callers.join(",")}${flags ? `  ${flags}` : ""}`;
  });
  return `${HEADER}\n${lines.join("\n")}\n`;
}

test("the callers of every word match the snapshot", () => {
  const now = render();
  if (process.env.UPDATE_SNAPSHOT === "1") writeFileSync(SNAPSHOT, now);
  const before = readFileSync(SNAPSHOT, "utf8");
  assert.equal(now, before, "callers changed: if on purpose, update the snapshot (see its header) and say why in the review");
});

test("callers are one of the four kinds and a kernel-only word is not offered to anyone else", () => {
  for (const word of [...WORD_CONTRACTS, ...standardContracts()]) {
    if (word.callers.includes("kernel") && word.callers.length === 1) assert.ok(!word.local_only, `${word.member}/${word.word}`);
    assert.ok(word.callers.every((who) => ["owner", "agent", "app", "kernel"].includes(who)));
  }
});
