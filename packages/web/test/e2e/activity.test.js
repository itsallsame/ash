import assert from "node:assert/strict";
import test from "node:test";
import { echoAgent, eventually, openPage, say, withBrowser, OWNER } from "./support.js";
import { homeHub } from "./home-support.js";

test(...withBrowser("live progress is a pill over the composer; tapping it opens the activity page of her home, without raw tool data", async ({ kernel, browser }) => {
  homeHub(kernel);
  echoAgent(kernel);
  const { page } = await openPage(browser, kernel);
  await page.locator("#t").fill("查一下资料");
  await page.locator("#send").click();
  const progress = page.locator("#progress");
  await progress.getByText(/做了 1 步/).waitFor();
  await progress.locator(".pill").click();
  const activity = page.locator('#home .hm-screen[data-page="activity"]');
  await activity.waitFor();
  const card = activity.locator("[data-turn]").first();
  await card.getByText("查一下资料").waitFor();
  await card.getByText("在搜索 资料").waitFor();
  assert.match(await card.textContent(), /完成了/);
  assert.doesNotMatch(await activity.textContent(), /web_search|agent:main|service:/);
}));

test(...withBrowser("the kernel opens a page on the chat: an order opens it, a suggestion shows a chip that opens only when accepted", async ({ kernel, browser }) => {
  homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  const suggested = await kernel.present("chat", "open", { target: "activity", mode: "suggest" });
  assert.deepEqual(suggested.data, { opened: false }, "the answer describes the suggestion, not a later click");
  const chip = page.locator("#suggestions .suggestion");
  await chip.getByText("Ash 建议查看活动").waitFor();
  assert.equal(await page.locator("#home:not([hidden])").count(), 0);
  await chip.getByRole("button", { name: "打开" }).click();
  await page.locator('#home .hm-screen[data-page="activity"]').waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator("#home").waitFor({ state: "hidden" });
  // Names the kernel uses map onto the pages of her home: approvals are "waiting", a turn is its activity.
  for (const [target, page_] of [["memory", "memory"], ["approvals", "waiting"], ["turn", "activity"], ["settings", "home"]]) {
    const performed = await kernel.present("chat", "open", { target });
    assert.deepEqual(performed.data, { opened: true }, target);
    await page.locator(`#home .hm-screen[data-page="${page_}"]`).waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator("#home").waitFor({ state: "hidden" });
  }
  assert.deepEqual((await kernel.present("chat", "focus")).ok, true);
}));

test(...withBrowser("recent history paints first and scrolling up loads the earlier page", async ({ kernel, browser }) => {
  for (let n = 1; n <= 230; n++) say(kernel, `message ${n}`);
  const { page } = await openPage(browser, kernel);
  await page.locator("#log .msg", { hasText: "message 230" }).waitFor();
  const first = await page.locator("#log .msg").evaluateAll(nodes => Math.min(...nodes.map(node => Number(node.dataset.seq))));
  assert.ok(first > 20, "the first render reads a recent range");
  await page.locator("#log").evaluate((el) => { el.scrollTop = 0; });
  await page.locator("#log .msg", { hasText: new RegExp(`^message ${first - 1}$`) }).waitFor({ state: "attached" });
  assert.ok(kernel.requests.some(row => row.to === "service:history" && row.word === "window" && row.body.before === first), "the earlier range is an indexed before window");
  assert.ok(await page.locator("#log .msg").count() <= 60);
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
  await page.locator("#log .atts .attachment", { hasText: "dot.png" }).click();
  await page.locator("#log .atts img").waitFor();
  assert.match(await page.locator("#log .atts img").getAttribute("src"), /^blob:/);
}));

test(...withBrowser("the progress pill appearing leaves the last message in view, not under the pill", async ({ kernel, browser }) => {
  for (let n = 1; n <= 40; n++) say(kernel, `message ${n}`);
  const { page } = await openPage(browser, kernel);
  await page.locator("#log .msg", { hasText: "message 40" }).waitFor();
  kernel.append({ from: "agent:main", kind: "event", word: "turn.started", turn: "t_pill", body: { turn: "t_pill", lane: "front" } });
  kernel.append({ from: "agent:main", kind: "event", word: "agent.tool", turn: "t_pill", body: { turn: "t_pill", name: "web_fetch", phase: "start", summary: "在看网页" } });
  await page.locator("#progress .pill").waitFor();
  await eventually(async () => await page.evaluate(() => {
    const last = [...document.querySelectorAll("#log .msg")].pop().getBoundingClientRect();
    const log = document.querySelector("#log").getBoundingClientRect();
    return last.bottom <= log.bottom + 1;
  }), "the last message above the pill");
}));

test(...withBrowser("controls the design draws under 44px still take a tap within 44px", async ({ kernel, browser }) => {
  kernel.append({ from: "agent:main", to: OWNER, kind: "request", word: "show", body: { card: { type: "options", prompt: "选一个", options: [{ id: "a", text: "方案甲" }] } } });
  const { page } = await openPage(browser, kernel);
  await page.locator(".opt", { hasText: "方案甲" }).waitFor();
  for (const selector of ["#f .to", ".opt", ".topbar .who"]) {
    const reached = await page.evaluate((s) => {
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      const grow = (44 - r.height) / 2 - 0.5;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top - Math.max(grow, 0));
      return grow <= 0 || el.contains(hit);
    }, selector);
    assert.equal(reached, true, `${selector} is reachable 22px from its centre`);
  }
}));

test(...withBrowser("an option button takes a tap just outside its 40px, up to 44px in all", async ({ kernel, browser }) => {
  const cards = ["甲", "乙"].map((name) => kernel.append({ from: "agent:main", to: OWNER, kind: "request", word: "show", body: { card: { type: "options", prompt: `选${name}`, options: [{ id: name, text: `方案${name}` }] } } }));
  const { page } = await openPage(browser, kernel);
  const button = (name) => page.locator(".card", { hasText: `选${name}` }).locator(".opt");
  await button("甲").waitFor();
  await button("乙").waitFor();
  for (const [name, side] of [["甲", "above"], ["乙", "below"]]) {
    const box = await button(name).boundingBox();
    assert.equal(box.height, 40, "the button looks as designed");
    // 1.5px outside the edge: inside the 2px the touch area reaches beyond the button
    await page.mouse.click(box.x + box.width / 2, side === "above" ? box.y - 1.5 : box.y + box.height + 1.5);
    await eventually(() => kernel.requests.some((r) => r.word === "say" && r.body.option_id === name), `the tap ${side} the button chose ${name}`);
  }
  assert.equal(cards.length, 2);
}));
