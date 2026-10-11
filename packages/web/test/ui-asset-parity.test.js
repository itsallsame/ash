import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { coreUiBytes, staticManifest, verifyStaticUi } from "../../../tools/spikes/v2-604-ui-asset.mjs";

const appAsset = () => readFileSync(new URL("../../../android/app/src/main/assets/ash-ui/index.html", import.meta.url), "utf8");
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

test("test-only static UI uses exactly the generated core bytes", () => {
  const bytes = coreUiBytes();
  const manifest = staticManifest(bytes);
  assert.equal(verifyStaticUi(bytes, manifest), true);
  assert.equal(manifest.bytes, bytes.length);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  const html = bytes.toString("utf8");
  assert.ok(!html.includes("/?token="));
  assert.ok(!html.includes("ash_ui"));
});

test("generated inline browser script parses without placeholder substitution", () => {
  const html = coreUiBytes().toString("utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.ok(!script.includes("<!-- ui-app -->"));
  assert.doesNotThrow(() => new Function(script));
});

test("test-only static parity refuses altered bytes, digest and length", () => {
  const bytes = coreUiBytes();
  const manifest = staticManifest(bytes);
  const changed = Buffer.from(bytes);
  changed[changed.length - 2] ^= 1;
  assert.throws(() => verifyStaticUi(changed, manifest), /differs/);
  assert.throws(() => verifyStaticUi(bytes, { ...manifest, sha256: "0".repeat(64) }), /differs/);
  assert.throws(() => verifyStaticUi(bytes, { ...manifest, bytes: manifest.bytes + 1 }), /differs/);
});

test("the app's page is the same shell and page code as the browser's, with the app's transport and no run-time code compilation", () => {
  const asset = appAsset();
  const generated = coreUiBytes().toString("utf8");
  const native = readFileSync(new URL("../js/native-bootstrap.js", import.meta.url), "utf8");
  const [appScript, bootstrap] = scripts(asset);
  assert.equal(bootstrap, native);
  // Everything outside the page script and the bootstrap is the browser's page exactly.
  const shell = (html, script) => html.replace(`<script>${script}</script>`, "<!-- ui-app -->");
  assert.equal(shell(asset.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>\n/, "").replace(`<script>${native}</script>\n`, ""), appScript),
    shell(generated, scripts(generated)[0]));
  assert.match(asset, /connect-src 'none'; form-action 'none'; frame-src about:; worker-src 'none'/);
  assert.doesNotMatch(asset, /script-src[^;]*unsafe-eval/);
  assert.ok(!asset.includes("/?token="));
  // Browser frame checks are generated at build time; neither transport compiles code while opening the page.
  assert.ok(!scripts(generated)[0].includes("new Function") && !appScript.includes("new Function"));
  assert.ok(scripts(generated)[0].length > appScript.length);
});
