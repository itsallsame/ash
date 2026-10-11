import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { coreUiBytes, staticManifest, verifyStaticUi } from "../../../tools/spikes/v2-604-ui-asset.mjs";
import { UI_JS } from "../../core/src/edges/link-server/ui.generated.ts";

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

test("the deferred browser script parses without placeholder substitution", () => {
  const html = coreUiBytes().toString("utf8");
  assert.ok(html.includes('<script defer src="/app.js"></script>'));
  assert.equal(scripts(html).length, 0, "the browser bundle is not parsed as HTML");
  assert.ok(!UI_JS.includes("<!-- ui-app -->"));
  assert.doesNotThrow(() => new Function(UI_JS));
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
    generated.replace('<script defer src="/app.js"></script>', "<!-- ui-app -->"));
  assert.match(asset, /connect-src 'none'; form-action 'none'; frame-src about:; worker-src 'none'/);
  assert.doesNotMatch(asset, /script-src[^;]*unsafe-eval/);
  assert.ok(!asset.includes("/?token="));
  // Browser frame checks are generated at build time; neither transport compiles code while opening the page.
  assert.ok(!UI_JS.includes("new Function") && !appScript.includes("new Function"));
  assert.ok(UI_JS.length > appScript.length);
});
