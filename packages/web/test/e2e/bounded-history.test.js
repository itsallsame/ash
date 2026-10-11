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
  const custom = "完整的自定义回答。".repeat(1800);
  kernel.append({ id: "long_answer", from: "agent:main", to: OWNER, kind: "request", word: "ask", body: { title: "自己回答", human_kind: "question", allow_custom: true, expires_at: Date.now() + 3600000, options: [] } });
  kernel.append({ from: OWNER, to: "agent:main", kind: "response", word: "ask", reply_to: "long_answer", body: { ok: true, result: { data: { choice: "custom", text: custom } } } });
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
  const answer = page.locator('#log [data-row-key="message:long_answer"]');
  assert.equal(await answer.locator(".ask-detail").count(), 0, "the decided card stays folded");
  await answer.locator("summary").click();
  await eventually(async () => (await answer.locator("pre").textContent()) === custom);
  await answer.locator("summary").click();
  await page.locator('#log [data-row-key="message:gate_original"] summary').click();
  await eventually(async () => (await page.locator('#log [data-row-key="message:gate_original"] pre').textContent()) === original);
  await openHome(page, { page: "home", section: "waiting" }, '#home .hm-screen[data-page="waiting"]');
  await page.locator('#home [data-ask-id="gate_original"] summary').click();
  await eventually(async () => (await page.locator('#home [data-ask-id="gate_original"] pre').textContent()) === original);
  assert.equal(await page.locator('#home [data-ask-id="gate_original"] pre script').count(), 0);
  await page.locator('#home [data-ask-id="gate_original"] summary').click();
  await eventually(async () => (await page.locator('#home [data-ask-id="gate_original"] pre').textContent()) === "");
}));

test(...withBrowser("home totals and a child agent's pending page include entries outside the conversation and global current slice", async ({ kernel, browser }) => {
  homeHub(kernel);
  for (let i = 0; i < 20; i++) {
    const agent = i < 7 ? "agent:helper" : "agent:main", turn = `stats_${i}`;
    kernel.append({ from: agent, kind: "event", word: "turn.started", turn, body: { turn, lane: "front" } });
    kernel.append({ from: agent, kind: "event", word: "turn.ended", turn, body: { turn, lane: "front", outcome: "completed" } });
  }
  for (const [agent, count] of [["agent:helper", 13], ["agent:main", 20]]) for (let i = 0; i < count; i++) {
    kernel.append({ from: agent, to: OWNER, kind: "request", word: "ask", body: { title: `Pending ${agent}-${i}`, human_kind: "question", expires_at: Date.now() + 3600000, options: [{ id: "yes", label: "好" }] } });
  }
  const { page } = await openPage(browser, kernel);
  await openHome(page);
  await eventually(async () => (await page.locator('#home #homeStatDone .hm-stat-n').textContent()) === "20");
  assert.equal(await page.locator('#home #homeStatWaiting .hm-stat-n').textContent(), "33");
  await page.keyboard.press("Escape");
  await openHome(page, { page: "home", agent: "agent:helper" });
  await eventually(async () => (await page.locator('#home #homeStatDone .hm-stat-n').textContent()) === "7");
  await eventually(async () => (await page.locator('#home #homeStatWaiting .hm-stat-n').textContent()) === "13");
  await page.locator('#home #homeStatWaiting').click();
  await eventually(async () => (await page.locator('#home .hm-screen[data-page="waiting"] [data-ask-id]').count()) === 13);
  assert.ok(kernel.requests.some(row => row.word === "current" && row.body.agent === "agent:helper"));
}));

test(...withBrowser("a cached expanded body revisits as a preview until scrolling settles, without rereading its source", async ({ kernel, browser }) => {
  homeHub(kernel);
  const paragraphs = Array.from({ length: 180 }, (_, i) => `第${i}段：` + "原文保持完整。".repeat(15));
  const original = [...paragraphs, "恢复后的完整结尾。"].join("\n\n");
  for (let i = 1; i <= 220; i++) say(kernel, i === 100 ? original : `History ${i}`, { id: `restore_${i}` });
  const { page } = await openPage(browser, kernel);
  const jump = id => page.evaluate(id => window.dispatchEvent(new CustomEvent("ash:jump", { cancelable: true, detail: { id } })), id);
  await jump("restore_100");
  const message = page.locator('#log .msg[data-seq="100"]');
  await message.locator(".expand").click();
  await page.waitForFunction(() => document.querySelector('#log .msg[data-seq="100"] .markdown')?.textContent.endsWith("恢复后的完整结尾。"));
  const reads = kernel.requests.filter(row => row.to === "service:blobs" && row.word === "read").length;
  assert.ok(reads > 0);
  await jump("restore_5");
  await page.locator('#log .msg[data-seq="5"]').waitFor();
  assert.equal(await message.count(), 0, "the earlier body was actually evicted");
  await page.evaluate(() => { window.wheelPulses = 0; const pulse = () => { const log = document.querySelector("#log"); log.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 })); wheelPulses++; }; pulse(); window.scrollPulse = setInterval(pulse, 20); });
  try {
    await jump("restore_100");
    await message.locator(".expand").waitFor();
    await page.waitForTimeout(350);
    assert.ok((await message.locator(".markdown p").count()) < paragraphs.length, "cached source does not bypass the idle gate");
    const preview = await page.evaluate(() => ({ pulses: wheelPulses, label: document.querySelector('#log .msg[data-seq="100"] .expand')?.textContent, count: document.querySelectorAll('#log .msg[data-seq="100"] .markdown p').length }));
    assert.equal(preview.label, "正在展开…", JSON.stringify(preview));
  } finally { await page.evaluate(() => clearInterval(scrollPulse)); }
  await page.waitForFunction(() => document.querySelector('#log .msg[data-seq="100"] .markdown')?.textContent.endsWith("恢复后的完整结尾。"));
  assert.equal(await message.locator(".markdown p").count(), paragraphs.length + 1);
  assert.equal(kernel.requests.filter(row => row.to === "service:blobs" && row.word === "read").length, reads);
  assert.equal(await message.locator(".markdown").textContent(), paragraphs.join("") + "恢复后的完整结尾。");
}));

test(...withBrowser("an old-message jump does not page itself away as inline Markdown and live arrivals change layout", async ({ kernel, browser }) => {
  homeHub(kernel);
  const inline = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: keep the reading position.`).join("\n\n");
  for (let i = 1; i <= 240; i++) say(kernel, i <= 10 && i !== 5 ? inline : `Reading target ${i}`, { id: `reading_${i}` });
  const { page } = await openPage(browser, kernel);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ash:jump", { cancelable: true, detail: { id: "reading_5" } })));
  const target = page.locator('#log .msg[data-seq="5"]');
  await target.waitFor();
  await page.evaluate(() => { window.readingTarget = document.querySelector('#log .msg[data-seq="5"]'); });
  for (let i = 0; i < 100; i++) say(kernel, `Live arrival ${i}`);
  await page.locator("#returnLatest", { hasText: /100 条新消息/ }).waitFor();
  await page.waitForFunction(() => document.querySelector('#log .msg[data-seq="1"] .markdown p:last-child')?.textContent.includes("Paragraph 59"));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => readingTarget === document.querySelector('#log .msg[data-seq="5"]')), true);
  assert.equal(kernel.requests.filter(row => row.word === "window" && row.body.after !== undefined).length, 0, "position compensation must not initiate newer-page reads");
  const offset = await page.evaluate(() => readingTarget.getBoundingClientRect().top - document.querySelector("#log").getBoundingClientRect().top);
  assert.ok(Math.abs(offset) < 3, `reading target shifted ${offset}px`);
}));
