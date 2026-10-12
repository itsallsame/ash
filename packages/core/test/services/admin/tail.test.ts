import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tailFile } from "../../../src/services/admin";

test("tailFile gives the last lines, oldest first; a file that is not there has none", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "tail-"));
  const file = join(dir, "core.log");
  writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n") + "\n");
  const lines = tailFile(file, 3);
  assert.deepEqual(lines.map((l) => l.split(" ")[1]), ["4997", "4998", "4999"]);
  assert.equal(tailFile(file, 100000).length < 5000, true, "only the last 256 KB are read, and a cut first line is dropped");
  assert.ok(tailFile(file, 100000)[0]!.startsWith("line "));
  assert.deepEqual(tailFile(join(dir, "none.log"), 5), []);
});
