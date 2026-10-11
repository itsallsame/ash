import assert from "node:assert/strict";
import test from "node:test";
import { openPage, say, withBrowser, eventually, OWNER } from "./support.js";
import { homeHub, openHome } from "./home-support.js";

test(...withBrowser("bounded history jumps directly, keeps an old reading window during live arrivals, and returns to latest", async ({ kernel, browser }) => {
  homeHub(kernel);
  for (let i = 1; i <= 300; i++) say(kernel, `History message ${i}`, { id: `history_${i}` });
  const { page } = await openPage(browser, kernel);
  const firstPage = kernel.requests.find(row => row.to === "service:history" && row.word === "window");
  assert.equal(firstPage.body.limit, 10);
  assert.ok(kernel.synced.every(request => request.limit === 1));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ash:jump", { cancelable: true, detail: { id: "history_5" } })));
  await page.locator('#log .msg[data-seq="5"]').waitFor();
  await page.evaluate(() => { window.savedReadingNode = document.querySelector('#log .msg[data-seq="5"]'); });
  say(kernel, "Arrived while reading history", { id: "latest_arrival" });
  await page.locator("#returnLatest", { hasText: /新消息/ }).waitFor();
  assert.equal(await page.evaluate(() => savedReadingNode === document.querySelector('#log .msg[data-seq="5"]')), true);
  assert.equal(await page.locator("#log .msg", { hasText: "Arrived while reading history" }).count(), 0);
  assert.ok(await page.locator("#log .msg").count() <= 60);
  await page.locator("#returnLatest").click();
  await page.locator("#log .msg", { hasText: "Arrived while reading history" }).waitFor();
  await eventually(() => page.evaluate(() => { const log = document.querySelector("#log"); return log.scrollHeight - log.clientHeight - log.scrollTop < 3; }));
  assert.equal(kernel.requests.filter(row => row.word === "window" && row.body.around_id === "history_5").length, 1);
}));

test(...withBrowser("externalized Chinese messages and gate originals remain complete selectable text in conversation and home", async ({ kernel, browser }) => {
  homeHub(kernel);
  const message = "完整中文消息，逐字保留。".repeat(1500) + "最后一字。";
  say(kernel, message, { id: "long_source" });
  const original = "<script>这是原文而不是脚本</script>\n".repeat(1000) + "完整原文的结尾。";
  kernel.append({ id: "gate_original", from: "service:gate", to: OWNER, kind: "request", word: "ask", body: {
    title: "审阅完整请求", detail: "摘要", human_kind: "confirmation", expires_at: Date.now() + 3600000,
    options: [{ id: "once", label: "允许这一次" }, { id: "deny", label: "不允许" }], source: { body_full: original },
  } });
  const { page } = await openPage(browser, kernel);
  assert.equal(kernel.requests.filter(row => row.to === "service:blobs").length, 0);
  await page.locator('#log .msg[data-seq="1"] .expand').click();
  await page.waitForFunction(() => document.querySelector('#log .msg[data-seq="1"] .markdown')?.textContent.endsWith("最后一字。"));
  const selected = await page.evaluate(() => {
    const node = document.querySelector('#log .msg[data-seq="1"] .markdown');
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString(); selection.removeAllRanges(); return text;
  });
  assert.equal(selected, message);
  await page.locator('#log [data-row-key="message:gate_original"] summary').click();
  await eventually(async () => (await page.locator('#log [data-row-key="message:gate_original"] pre').textContent()) === original);
  await openHome(page, { page: "home", section: "waiting" }, '#home .hm-screen[data-page="waiting"]');
  await page.locator('#home [data-ask-id="gate_original"] summary').click();
  await eventually(async () => (await page.locator('#home [data-ask-id="gate_original"] pre').textContent()) === original);
  assert.equal(await page.locator('#home [data-ask-id="gate_original"] pre script').count(), 0);
  await page.locator('#home [data-ask-id="gate_original"] summary').click();
  await eventually(async () => (await page.locator('#home [data-ask-id="gate_original"] pre').textContent()) === "");
}));
