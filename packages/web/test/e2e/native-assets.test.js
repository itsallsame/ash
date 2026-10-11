import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { startKernel } from "../kernel.js";
import { nativeBridgeFor, until } from "../support.js";
import { launchBrowser, newPage } from "./browser.js";
import { gateAsk, requested, say } from "./support.js";

const origin = "https://appassets.androidplatform.net";
const assetRoot = new URL("../../../../android/app/src/main/assets/ash-ui/", import.meta.url);
const mime = { html: "text/html", js: "text/javascript", webp: "image/webp", svg: "image/svg+xml", webmanifest: "application/manifest+json" };

for (const readyDelay of [0, 75]) test(`exact APK assets boot with ${readyDelay ? "late native ready" : "synchronous native ready"}, SQLite history, and the restrictive CSP`, async t => {
  const browser = await launchBrowser();
  if (!browser) return t.skip("no browser to drive");
  const kernel = startKernel();
  const errors = [], assets = [], messages = [], cspViolations = [];
  let native, page;
  try {
    say(kernel, "APK asset history");
    const ask = gateAsk(kernel);
    native = await nativeBridgeFor(kernel);
    await until(native.linked, 2000, "native human channel");
    ({ page } = await newPage(browser));
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && /Content Security Policy/i.test(message.text())) cspViolations.push(message.text()); });
    let link;
    const deliver = value => page.evaluate(value => globalThis.AshNative?.onmessage?.({ data: JSON.stringify(value) }), value).catch(error => errors.push(error.message));
    native.bridge.onLink(value => { link = value; });
    native.bridge.onFrame(frame => { void deliver({ type: "frame", frame }); });
    await page.exposeBinding("nativePost", async ({ frame }, text) => {
      assert.equal(frame, page.mainFrame());
      assert.equal(new URL(frame.url()).origin, origin);
      const message = JSON.parse(text);
      messages.push(message);
      if (message.type === "link_state") await deliver(link);
      else if (message.type === "frame") native.bridge.post(message.frame);
    });
    // The real shell installs its bridge before loading the page. Answering hello immediately exercises defer order.
    await page.addInitScript(readyDelay => {
      globalThis.AshNative = {
        onmessage: null,
        postMessage(text) {
          const message = JSON.parse(text);
          if (message.type === "hello") {
            const ready = () => this.onmessage({ data: '{"type":"ready"}' });
            if (readyDelay) setTimeout(ready, readyDelay); else ready();
          }
          else void globalThis.nativePost(text);
        },
      };
      globalThis.WebSocket = class { constructor() { throw new Error("APK page opened its own socket"); } };
    }, readyDelay);
    await page.route("**/*", async route => {
      const address = new URL(route.request().url());
      const path = address.pathname.slice("/assets/ash-ui/".length);
      if (address.origin !== origin || !address.pathname.startsWith("/assets/ash-ui/") || address.search || address.hash || path.includes("..") || path.includes("%")) return route.abort();
      // A document script tests eval itself: DevTools evaluation deliberately bypasses that CSP check.
      if (path === "csp-probe.js") return route.fulfill({ contentType: "text/javascript", body: 'globalThis.cspEvalBlocked = false; try { globalThis.eval("globalThis.evalRan = true"); } catch { globalThis.cspEvalBlocked = true; }' });
      assets.push(path);
      try {
        await route.fulfill({ body: await readFile(new URL(path, assetRoot)), contentType: mime[path.split(".").at(-1)] ?? "text/plain", headers: { "Cache-Control": path === "index.html" ? "no-cache" : "private, max-age=31536000" } });
      } catch { await route.fulfill({ status: 404, body: "" }); }
    });
    await page.goto(`${origin}/assets/ash-ui/index.html`);
    await page.waitForFunction(() => document.querySelector("#log")?.getAttribute("aria-busy") === "false");
    await page.getByText("APK asset history", { exact: true }).waitFor();
    assert.equal(kernel.sessions[0].hello.hand.kind, "phone");
    assert.ok(kernel.requests.some(request => request.to === "service:history" && request.word === "window"));
    assert.ok(assets.some(path => /^app\.[a-f0-9]{64}\.js$/.test(path)) && assets.some(path => /^native-bootstrap\.[a-f0-9]{64}\.js$/.test(path)));
    assert.ok(messages.some(message => message.type === "frame"));
    assert.deepEqual(errors, []);

    await page.getByRole("button", { name: "允许这一次", exact: true }).click();
    await requested(kernel, request => request.reply_to === ask.id && request.kind === "response");
    say(kernel, "APK asset live update");
    await page.getByText("APK asset live update", { exact: true }).waitFor();
    assert.deepEqual(cspViolations, [], "normal packaged resources and NativePort work without CSP violations");
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.src = "csp-probe.js";
      document.body.append(script);
    });
    await page.waitForFunction(() => typeof globalThis.cspEvalBlocked === "boolean");
    // Evaluate is test instrumentation; inserted scripts and document fetch still obey its CSP.
    const blocked = await page.evaluate(async () => {
      const script = document.createElement("script");
      script.textContent = "globalThis.inlineScriptRan = true";
      document.body.append(script);
      let networkBlocked = false;
      try { await fetch(document.scripts[0].src); } catch { networkBlocked = true; }
      return { inlineBlocked: !globalThis.inlineScriptRan, evalBlocked: globalThis.cspEvalBlocked, networkBlocked, boot: typeof globalThis.__ashNativeBoot, legacyAndroidBridge: typeof globalThis.Android };
    });
    assert.deepEqual(blocked, { inlineBlocked: true, evalBlocked: true, networkBlocked: true, boot: "function", legacyAndroidBridge: "undefined" });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    native?.close();
    kernel.close();
  }
});
