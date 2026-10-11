import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { build } from "esbuild";
import { browserLinkPlugin } from "../../../tools/browser-link.mjs";
import * as sdk from "../../sdk/src/link.ts";

// Exercise the same plugin gen:ui uses, with dynamic compilation forbidden in the resulting runtime.
const link = fileURLToPath(new URL("../../sdk/src/link.ts", import.meta.url));
const compiled = await build({
  stdin: { contents: `import * as checks from ${JSON.stringify(link)}; globalThis.checks = checks;`, resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "js" },
  bundle: true, write: false, platform: "browser", format: "iife", target: "es2022",
  plugins: [browserLinkPlugin()], metafile: true,
});
const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(compiled.outputFiles[0].text, context);
const checks = context.checks;
const local = (value) => structuredClone(value);

test("browser protocol constants and frame definitions match the SDK", () => {
  for (const name of ["LINK_PROTOCOL", "LIMITS", "CLOSE_CODES", "NO_RECONNECT_CODES", "FRAME_TYPES", "FRAME_DEFS"])
    assert.deepEqual(local(checks[name]), sdk[name], name);
  assert.ok(!Object.keys(compiled.metafile.inputs).some((file) => /ajv\/dist\/(?:compile|core|2020)/.test(file)), "runtime bundle has no schema compiler");
});

test("standalone browser checks preserve every valid and malicious frame fixture and error", () => {
  const seen = new Set();
  for (const kind of ["valid", "invalid"]) {
    const dir = fileURLToPath(new URL(`../../sdk/fixtures/link/${kind}/`, import.meta.url));
    for (const file of readdirSync(dir).sort()) {
      const type = file.split("__")[0];
      if (type === "capability-spec") continue; // Capabilities are validated by the kernel, not the browser transport.
      const value = JSON.parse(readFileSync(`${dir}${file}`, "utf8"));
      seen.add(type);
      assert.equal(checks.frameError(type, value), sdk.frameError(type, value), file);
      assert.equal(checks.isFrame(type, value), sdk.isFrame(type, value), file);
      assert.deepEqual(local(checks.validateFrame(value)), sdk.validateFrame(value), file);
    }
  }
  assert.deepEqual([...seen].sort(), sdk.FRAME_TYPES.toSorted());
});

test("unknown types, forged fields and size limits are rejected identically", () => {
  const values = [null, [], {}, { t: "constructor" }, { t: "__proto__" }, { t: "nope" },
    { t: "ping", at: 1, extra: true }, { t: "ping", at: "1" }, { t: "ping", at: NaN },
    { t: "stream", sid: "s", op: "data", seq: 0, b64: "!" },
    { t: "stream", sid: "s", op: "data", seq: 0, b64: Buffer.alloc(sdk.LIMITS.streamChunkBytes + 3, 1).toString("base64") },
  ];
  for (const value of values) {
    assert.equal(checks.frameType(value), sdk.frameType(value));
    assert.deepEqual(local(checks.validateFrame(value)), sdk.validateFrame(value));
  }
  const ping = { t: "ping", at: 1 };
  assert.equal(checks.frameError("ping", ping), null, "previous errors do not contaminate a valid frame");
  assert.equal(checks.frameError("pong", ping), sdk.frameError("pong", ping), "each frame keeps its own schema");
});
