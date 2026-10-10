import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

describe("host edge", () => {
  it("names no platform (SPEC-07 section 8, item 5)", () => {
    const dir = fileURLToPath(new URL("../../../src/edges/host/", import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"));
    assert.ok(files.length >= 4);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      assert.doesNotMatch(text, /android|keystore|systemd|launchd/i, file);
    }
  });
});
