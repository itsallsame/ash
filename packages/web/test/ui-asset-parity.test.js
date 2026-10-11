import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { coreUiBytes, staticManifest, verifyStaticUi } from "../../../tools/spikes/v2-604-ui-asset.mjs";
import { UI_JS, UI_JS_FILE } from "../../core/src/edges/link-server/ui.generated.ts";
import { assertNoInlineScripts } from "../../../tools/ui-scripts.mjs";

const appAsset = () => readFileSync(new URL("../../../android/app/src/main/assets/ash-ui/index.html", import.meta.url), "utf8");
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

test("packaged UI refuses executable inline markup, including encoded and mixed-case URL attributes", () => {
  for (const html of ['<script>run()</script>', '<script src="app.js">run()</script>', '<button ONCLICK="run()">', '<input onfocus=run()>', '<a href="javascript:run()">', '<a href=" java&#x73;cript:run()">', '<a href="java&#10;script:run()">', '<svg><a xlink:href=JavaScript:run()>'])
    assert.throws(() => assertNoInlineScripts(html), /inline|JavaScript/);
  assert.doesNotThrow(() => assertNoInlineScripts('<script defer src="app.abc.js"></script><a href="ash://console">go</a>'));
  assert.doesNotThrow(() => assertNoInlineScripts('<!-- <script>example()</script> --><style>.a{color:red}</style>'));
});

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
  assert.ok(html.includes(`<script defer src="/${UI_JS_FILE}"></script>`));
  assert.equal(UI_JS_FILE, `app.${createHash("sha256").update(UI_JS).digest("hex")}.js`);
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

test("the app's page loads the browser's exact bundle before its native bridge, under a same-origin script CSP", () => {
  const asset = appAsset();
  const generated = coreUiBytes().toString("utf8");
  const native = readFileSync(new URL("../js/native-bootstrap.js", import.meta.url), "utf8");
  const root = new URL("../../../android/app/src/main/assets/ash-ui/", import.meta.url);
  const bootstrapFile = `native-bootstrap.${createHash("sha256").update(native).digest("hex")}.js`;
  const appScript = readFileSync(new URL(UI_JS_FILE, root), "utf8");
  const bootstrap = readFileSync(new URL(bootstrapFile, root), "utf8");
  assert.equal(appScript, UI_JS);
  assert.equal(bootstrap, native);
  assert.equal(scripts(asset).length, 0);
  const scriptTags = [...asset.matchAll(/<script\b[^>]*>/g)].map(match => match[0]);
  assert.deepEqual(scriptTags, [`<script defer src="${UI_JS_FILE}">`, `<script defer src="${bootstrapFile}">`]);
  assert.deepEqual(readdirSync(root).filter(file => file.endsWith(".js")).sort(), [UI_JS_FILE, bootstrapFile].sort(), "only current content-addressed scripts ship");
  assert.doesNotThrow(() => assertNoInlineScripts(asset));
  // Everything outside the page script and the bootstrap is the browser's page exactly.
  assert.equal(asset.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>\n/, "").replace(`<script defer src="${bootstrapFile}"></script>\n`, "").replace(`<script defer src="${UI_JS_FILE}"></script>`, "<!-- ui-app -->"),
    generated.replace(`<script defer src="/${UI_JS_FILE}"></script>`, "<!-- ui-app -->"));
  assert.match(asset, /script-src 'self';/);
  assert.match(asset, /connect-src 'none'; form-action 'none'; frame-src about:; worker-src 'none'/);
  assert.doesNotMatch(asset, /script-src[^;]*unsafe-(?:eval|inline)/);
  assert.ok(!asset.includes("/?token="));
  // Browser frame checks are generated at build time; neither transport compiles code while opening the page.
  assert.ok(!UI_JS.includes("new Function") && !appScript.includes("new Function"));
});
