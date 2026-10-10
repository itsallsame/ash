import assert from "node:assert/strict";
import test from "node:test";
import { echoAgent, eventually, openPage, requested, say, withBrowser, OWNER } from "./support.js";

const turn = (kernel, id, { lane = "front", ids = [], tools = [], outcome = "completed", agent = "agent:main" } = {}) => {
  const event = (word, body) => kernel.append({ from: agent, kind: "event", word, turn: id, body: { turn: id, ...body } });
  event("turn.started", { lane, ids });
  for (const name of tools) { event("agent.tool", { name, phase: "start", summary: `在用 ${name}` }); event("agent.tool", { name, phase: "end", ok: true }); }
  if (outcome) event("turn.ended", { lane, outcome });
};
const openSheet = async (page, tab) => {
  await page.locator("#presence").click();
  await page.locator(`#agentTabs [data-tab="${tab}"]`).click();
  return page.locator(`#agentPanel section[data-tab="${tab}"]`);
};

test(...withBrowser("live progress shows the step and folds into a turn on the activity page, without raw tool data", async ({ kernel, browser }) => {
  echoAgent(kernel);
  const { page } = await openPage(browser, kernel);
  await page.locator("#t").fill("查一下资料");
  await page.locator("#send").click();
  const progress = page.locator("#progress");
  await progress.getByText(/做了 1 步/).waitFor();
  await progress.click();
  const activity = page.locator('#agentPanel section[data-tab="activity"]');
  const card = activity.locator(".activity-turn").first();
  await card.getByText("查一下资料").waitFor();
  await card.getByText("在搜索 资料").waitFor();
  assert.match(await card.locator(".activity-outcome").textContent(), /完成了/);
  assert.doesNotMatch(await activity.textContent(), /web_search|agent:main|service:/);
}));

test(...withBrowser("a step of a turn opens the detail of what was asked and answered, in pages", async ({ kernel, browser }) => {
  kernel.on("service:history", "activity", ({ id, offset = 0 }) => {
    assert.equal(id, "call-1");
    return offset === 0 ? { items: [{ text: "first page of detail", total: 40, tool: "set", member: "service:clock" }], next_offset: 20 }
      : { items: [{ text: " and the second page", total: 40, tool: "set", member: "service:clock" }], next_offset: null };
  });
  kernel.append({ from: "agent:main", kind: "event", word: "turn.started", turn: "t_d", body: { turn: "t_d", lane: "front" } });
  kernel.append({ id: "call-1", from: "agent:main", to: "service:clock", kind: "request", word: "set", turn: "t_d", body: { at: Date.now() + 1e6, to: "agent:main", word: "wake", body: {}, label: "提醒" } });
  kernel.append({ from: "service:clock", to: "agent:main", kind: "response", word: "set", reply_to: "call-1", body: { ok: true, result: { data: { id: "c1", next: 1 } } } });
  kernel.append({ from: "agent:main", kind: "event", word: "turn.ended", turn: "t_d", body: { turn: "t_d", lane: "front", outcome: "completed" } });
  const { page } = await openPage(browser, kernel);
  const activity = await openSheet(page, "activity");
  await activity.locator("summary", { hasText: "查看调用与结果" }).click();
  await activity.locator(".activity-detail pre", { hasText: "first page of detail" }).waitFor();
  await activity.getByRole("button", { name: "继续查看" }).click();
  await activity.locator(".activity-detail pre", { hasText: "and the second page" }).waitFor();
}));

test(...withBrowser("background work is a group of its own; a finished turn can become a context chip in the composer", async ({ kernel, browser }) => {
  turn(kernel, "t_front", { tools: ["read"] });
  turn(kernel, "t_back", { lane: "back", tools: ["grep"], agent: "agent:main" });
  const { page } = await openPage(browser, kernel);
  const activity = await openSheet(page, "activity");
  const toggle = activity.locator(".activity-bg-toggle");
  await toggle.getByText(/后台任务 · 1 项/).waitFor();
  assert.equal(await activity.locator(".activity-bg").isHidden(), true);
  await toggle.click();
  await activity.locator(".activity-bg .activity-turn").getByText("在用 grep").waitFor();
  await activity.locator(".activity-turn:not(.background)").getByRole("button", { name: "问问她这件事" }).click();
  await page.locator("#context .context-chip").waitFor();
  assert.match(await page.locator("#t").inputValue(), /^关于.*，$/);
}));

test(...withBrowser("the plans page lists the clock's timers and removes one only after the clock confirmed its cancel", async ({ kernel, browser }) => {
  let timers = [{ id: "c1", next: Date.now() + 3_600_000, label: "吃药提醒", every: 86_400 }, { id: "c2", next: Date.now() + 7_200_000, label: "开会" }];
  kernel.on("service:clock", "list", () => ({ timers }));
  kernel.on("service:clock", "cancel", ({ id }) => { timers = timers.filter((t) => t.id !== id); return { cancelled: true }; });
  const { page } = await openPage(browser, kernel);
  const upcoming = await openSheet(page, "upcoming");
  await upcoming.locator('[data-timer="c1"]').getByText("吃药提醒").waitFor();
  const row = upcoming.locator('[data-timer="c1"]');
  await row.getByRole("button", { name: "删除" }).click();
  await row.getByRole("button", { name: "确认删除" }).click();
  await upcoming.locator('[data-timer="c1"]').waitFor({ state: "detached" });
  assert.equal(await upcoming.locator('[data-timer="c2"]').count(), 1);
  assert.deepEqual((await requested(kernel, (r) => r.word === "cancel")).body, { id: "c1" });
}));

test(...withBrowser("the kernel opens a page on the chat: an order opens it, a suggestion shows a chip that opens only when accepted", async ({ kernel, browser }) => {
  const { page } = await openPage(browser, kernel);
  const suggested = await kernel.present("chat", "open", { target: { target: "activity", mode: "suggest" } });
  assert.deepEqual(suggested.data, { opened: false }, "the answer describes the suggestion, not a later click");
  const chip = page.locator("#suggestions .suggestion");
  await chip.getByText("Ash 建议查看活动").waitFor();
  assert.equal(await page.locator("#agentSheet.open").count(), 0);
  await chip.getByRole("button", { name: "打开" }).click();
  await page.locator("#agentSheet.open").waitFor();
  await page.locator("#agentClose").click();
  const performed = await kernel.present("chat", "open", { target: "memory" });
  assert.deepEqual(performed.data, { opened: true });
  await page.locator('#agentTabs [aria-selected="true"][data-tab="memory"]').waitFor();
  await page.locator("#agentClose").click();
  const settings = await kernel.present("chat", "open", { target: "settings" });
  assert.deepEqual(settings.data, { opened: true });
  await page.locator("#drawer.open").waitFor();
  assert.deepEqual((await kernel.present("chat", "focus")).ok, true);
}));

test(...withBrowser("recent history paints first and scrolling up loads the earlier page", async ({ kernel, browser }) => {
  for (let n = 1; n <= 230; n++) say(kernel, `message ${n}`);
  const { page } = await openPage(browser, kernel);
  await page.locator("#log .msg", { hasText: "message 230" }).waitFor();
  assert.equal(await page.locator("#log .msg", { hasText: /^message 20$/ }).count(), 0);
  await page.locator("#log").evaluate((el) => { el.scrollTop = 0; });
  await page.locator("#log .msg", { hasText: /^message 20$/ }).waitFor({ state: "attached" });
  assert.ok(kernel.synced.some((frame) => frame.before !== undefined), "the earlier page is a `before` sync");
}));

test(...withBrowser("a long text shows the ledger's short version and opens in full on request", async ({ kernel, browser }) => {
  const hash = "c".repeat(64);
  const whole = "第一段。".repeat(2500);
  kernel.on("service:blobs", "read", ({ hash: asked, offset = 0 }) => {
    assert.equal(asked, hash);
    return offset === 0 ? { text: whole.slice(0, 6000), size: whole.length, offset: 0, next_offset: 6000 } : { text: whole.slice(6000), size: whole.length, offset: 6000, next_offset: null };
  });
  kernel.append({ from: "agent:main", to: OWNER, kind: "request", word: "say", body: { text: { $blob: hash, mime: "text/plain", size: whole.length, summary: "第一段。第一段。…（共10000字）" }, kind: "reply" } });
  const { page } = await openPage(browser, kernel);
  const bubble = page.locator("#log .msg.ai");
  await bubble.getByText("（共10000字）").waitFor();
  await bubble.getByRole("button", { name: "显示全文" }).click();
  await eventually(async () => (await bubble.textContent()).length > 9000, "the whole text");
  assert.equal(await bubble.getByRole("button", { name: "显示全文" }).count(), 0);
}));

test(...withBrowser("an attachment in the ledger opens from its bytes, or from the blob that holds them", async ({ kernel, browser }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  kernel.append({ from: "agent:main", to: OWNER, kind: "request", word: "say", body: { text: "给你图", kind: "reply", attachments: [{ name: "dot.png", mime_type: "image/png", data: png.toString("base64") }] } });
  const { page } = await openPage(browser, kernel);
  await page.locator("#log .msg.ai .attachment", { hasText: "dot.png" }).click();
  await page.locator("#log .msg.ai img").waitFor();
  assert.match(await page.locator("#log .msg.ai img").getAttribute("src"), /^blob:/);
}));
