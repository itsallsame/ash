import assert from "node:assert/strict";
import test from "node:test";
import { openPage, say, withBrowser } from "./support.js";

const sample = '# 耳机对比结果\n\n推荐 **Sony XM4**，更适合你在意的降噪。\n\n| 型号 | 降噪 |\n|---|---|\n| XM4 | 强 |\n| AirPods | 中 |\n\n> 价格尚未与卖家确认\n\n- [x] 比价\n- [ ] 下单\n\n```js\nconst message = "<script>文本，不是代码</script>";\n  console.log(message);\n```\n';

test(...withBrowser("a reply renders as Markdown, copies exact code, and keeps its rendering after a reload", async ({ kernel, browser }) => {
  const { page } = await openPage(browser, kernel);
  const sent = say(kernel, sample);
  const bubble = page.locator(`.msg[data-seq="${sent.seq}"]`);
  await bubble.locator("h1", { hasText: "耳机对比结果" }).waitFor();
  assert.equal(await bubble.locator("table tbody tr").count(), 2);
  assert.match(await bubble.locator("blockquote").textContent(), /尚未与卖家确认/);
  assert.equal(await bubble.locator('input[type="checkbox"]').count(), 2);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.copiedMarkdown = text; } } }); });
  await bubble.getByRole("button", { name: "复制代码" }).click();
  await bubble.locator(".md-copy", { hasText: "已复制" }).waitFor();
  assert.equal(await page.evaluate(() => window.copiedMarkdown), 'const message = "<script>文本，不是代码</script>";\n  console.log(message);');
  await page.reload();
  await page.locator(`.msg[data-seq="${sent.seq}"] h1`).waitFor();
}));

test(...withBrowser("hostile Markdown stays inert and wide tables and code scroll instead of widening the page", async ({ kernel, browser }) => {
  const external = [];
  const { page } = await openPage(browser, kernel, { width: 320, height: 740 });
  page.on("request", (request) => { if (request.url().includes("markdown-tracker.invalid")) external.push(request.url()); });
  const long = "long_code_".repeat(50);
  const sent = say(kernel, `## 安全检查\n\n<script>window.markdownExecuted=true</script>\n\n<img src=x onerror="window.markdownExecuted=true">\n\n[unsafe](javascript:alert%281%29) ![图片](https://markdown-tracker.invalid/pixel)\n\n| A | B | C | D | E | F |\n|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 |\n\n\`\`\`\n${long}\n\`\`\`\n`);
  const bubble = page.locator(`.msg[data-seq="${sent.seq}"]`);
  await bubble.locator("h2", { hasText: "安全检查" }).waitFor();
  assert.equal(await bubble.locator("script,img,iframe,svg").count(), 0);
  assert.equal(await bubble.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
  assert.deepEqual(external, []);
  const sizes = await bubble.evaluate((el) => ({ page: document.documentElement.scrollWidth, viewport: innerWidth, pre: el.querySelector("pre").clientWidth, code: el.querySelector("pre").scrollWidth }));
  assert.ok(sizes.page <= sizes.viewport);
  assert.ok(sizes.code > sizes.pre);
}));
