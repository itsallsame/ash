import assert from "node:assert/strict";
import test from "node:test";
import { protectProcessMemory } from "../../../src/edges/host";

test("without the native library next to the program (anywhere but the phone) the process is left alone and logs nothing", () => {
  const lines: unknown[][] = [];
  assert.equal(protectProcessMemory((...args) => lines.push(args)), false);
  assert.deepEqual(lines, []);
});
