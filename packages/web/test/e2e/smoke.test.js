import assert from "node:assert/strict";
import test from "node:test";
import { serveKernel } from "../kernel.js";
import { launchBrowser, newPage } from "./browser.js";
test("smoke", async (t) => {
  const browser = await launchBrowser();
  if (!browser) return t.skip("no browser");
  const kernel = await serveKernel();
  const { page } = await newPage(browser);
  await page.goto(kernel.url);
  await page.waitForFunction(() => document.querySelector("#connection")?.textContent.includes("已连接"));
  assert.match(await page.locator("#connection").textContent(), /已连接/);
  await browser.close(); kernel.close();
});
