import assert from "node:assert/strict";
import test from "node:test";
import { echoAgent, eventually, gateAsk, openPage, requested, withBrowser } from "./support.js";
import { homeHub, openHome } from "./home-support.js";

test(...withBrowser("the owner sends from the page, the agent answers, and a reload shows the same conversation", async ({ kernel, browser }) => {
  echoAgent(kernel);
  const { page } = await openPage(browser, kernel);
  await page.locator("#t").fill("e2e hello");
  await page.locator("#send").click();
  await page.locator("#log .msg.me[data-seq]", { hasText: "e2e hello" }).waitFor();
  await page.locator("#log .msg.ai", { hasText: "echo: e2e hello" }).waitFor();
  // sent -> delivered -> read: the agent took the say in, then opened a turn with it
  await page.waitForFunction(() => document.querySelector("#log .delivery")?.textContent === "已读");
  const say = await requested(kernel, (r) => r.word === "say");
  assert.deepEqual([say.to, say.body], ["agent:main", { text: "e2e hello" }]);
  await page.reload();
  await page.locator("#log .msg.me[data-seq]", { hasText: "e2e hello" }).waitFor();
  await page.locator("#log .msg.ai", { hasText: "echo: e2e hello" }).waitFor();
  assert.equal(await page.locator("#log .delivery").count(), 1);
}));

test(...withBrowser("two screens of the owner see the same messages", async ({ kernel, browser }) => {
  echoAgent(kernel);
  const first = await openPage(browser, kernel);
  const second = await openPage(browser, kernel);
  await first.page.locator("#t").fill("from the first");
  await first.page.locator("#send").click();
  await second.page.locator("#log .msg.me", { hasText: "from the first" }).waitFor();
  await second.page.locator("#log .msg.ai", { hasText: "echo: from the first" }).waitFor();
  assert.equal(await second.page.locator("#log button").count(), 0, "no conversation control buttons");
}));

test(...withBrowser("the page says it is in view, and when the owner types, to which agent; and says when they stop", async ({ kernel, browser }) => {
  const { page } = await openPage(browser, kernel);
  await eventually(() => kernel.presence.some((p) => p.visible === true), "visible on connecting");
  await page.locator("#t").fill("typing…");
  await eventually(() => kernel.presence.some((p) => p.typing === true), "typing");
  assert.equal(kernel.presence.find((p) => p.typing === true).agent, "agent:main");
  await page.locator("#t").fill("");
  await page.locator("#t").dispatchEvent("input");
  await eventually(() => kernel.presence.some((p) => p.typing === false), "typing stopped");
}));

test(...withBrowser("the presence bar follows the ledger: working while a turn is open, waiting for the owner while a question is", async ({ kernel, browser }) => {
  const { page } = await openPage(browser, kernel);
  assert.equal(await page.locator("#presence").getAttribute("data-state"), "idle");
  kernel.append({ from: "agent:main", kind: "event", word: "turn.started", turn: "t1", body: { turn: "t1", lane: "front" } });
  await page.waitForFunction(() => document.querySelector("#presence").dataset.state === "thinking");
  kernel.append({ from: "agent:main", kind: "event", word: "agent.tool", turn: "t1", body: { turn: "t1", name: "read", phase: "start", summary: "在看文件" } });
  await page.waitForFunction(() => document.querySelector("#state").textContent === "在看文件");
  kernel.append({ from: "agent:main", kind: "event", word: "turn.ended", turn: "t1", body: { turn: "t1", lane: "front", outcome: "completed" } });
  await page.waitForFunction(() => document.querySelector("#presence").dataset.state === "idle");
  gateAsk(kernel, { ts: Date.now() });
  await page.waitForFunction(() => document.querySelector("#presence").dataset.state === "waiting_you");
}));

test(...withBrowser("an approval card is answered from the conversation: one response to the ask, then the card says how it ended", async ({ kernel, browser }) => {
  const ask = gateAsk(kernel, { ts: Date.now() });
  const { page } = await openPage(browser, kernel);
  const card = page.locator(".card.ask");
  await card.getByText("要发消息给小李").waitFor();
  await card.locator("details summary").click();
  assert.match(await card.locator(".approval-original-text").textContent(), /完整原文/);
  await card.getByRole("button", { name: "允许这一次" }).click();
  await card.locator(".ask-outcome", { hasText: "已允许这一次" }).waitFor();
  const answer = kernel.ledger.find((m) => m.kind === "response" && m.reply_to === ask.id);
  assert.deepEqual([answer.from, answer.to, answer.word, answer.body], ["person:owner", "service:gate", "ask", { ok: true, result: { data: { choice: "once" } } }]);
  assert.equal(await card.getByRole("button").count(), 0);
}));

test(...withBrowser("an approval can also be answered on the approvals page, and a question from an agent with its own options on the card", async ({ kernel, browser }) => {
  homeHub(kernel);
  const ask = gateAsk(kernel, { title: "改审批规则", ts: Date.now() });
  const question = kernel.append({ from: "agent:main", to: "person:owner", kind: "request", word: "ask", ts: Date.now(), body: { title: "晚饭吃什么？", human_kind: "question", options: [{ id: "noodles", label: "面" }, { id: "rice", label: "饭" }], expires_at: Date.now() + 3_600_000 } });
  const { page } = await openPage(browser, kernel);
  await openHome(page, { page: "home", section: "waiting" }, '#home .hm-screen[data-page="waiting"]');
  await page.locator("#home article", { hasText: "改审批规则" }).getByRole("button", { name: "不允许" }).click();
  await requested(kernel, (r) => r.kind === "response" && r.reply_to === ask.id);
  assert.deepEqual(kernel.ledger.find((m) => m.reply_to === ask.id).body.result.data, { choice: "deny" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator("#home").waitFor({ state: "hidden" });
  await page.locator(".card.ask", { hasText: "晚饭吃什么" }).getByRole("button", { name: "面" }).click();
  await page.locator(".card.ask .opt.on", { hasText: "面" }).waitFor();
  assert.deepEqual(kernel.ledger.find((m) => m.reply_to === question.id).body.result.data, { choice: "noodles" });
}));

test(...withBrowser("an approval past its deadline is inert, and an answer that arrives from another screen closes the card", async ({ kernel, browser }) => {
  kernel.append({ from: "service:gate", to: "person:owner", kind: "request", word: "ask", ts: Date.now() - 5000, body: { title: "过期的", human_kind: "confirmation", expires_at: Date.now() - 1000, options: [{ id: "once", label: "允许这一次" }, { id: "deny", label: "不允许" }] } });
  const live = gateAsk(kernel, { title: "另一块屏回答", ts: Date.now() });
  const { page } = await openPage(browser, kernel);
  const expired = page.locator(".card.ask", { hasText: "过期的" });
  await expired.locator(".ask-outcome", { hasText: "已过期" }).waitFor();
  assert.equal(await expired.getByRole("button").count(), 0);
  // the owner answers on a notification or another screen: the ledger gets the response
  kernel.append({ from: "person:owner", to: "service:gate", kind: "response", word: "ask", reply_to: live.id, body: { ok: true, result: { data: { choice: "deny" } } } });
  await page.locator(".card.ask", { hasText: "另一块屏回答" }).locator(".ask-outcome", { hasText: "已拒绝" }).waitFor();
}));

test(...withBrowser("an option card is settled by one ordinary say on both screens", async ({ kernel, browser }) => {
  echoAgent(kernel, { tool: false });
  const card = kernel.append({ from: "agent:main", to: "person:owner", kind: "request", word: "show", body: { card: { type: "options", prompt: "选一个", options: [{ id: "a", text: "方案甲" }, { id: "b", text: "方案乙" }] } } });
  const first = await openPage(browser, kernel);
  const second = await openPage(browser, kernel);
  await first.page.locator(".card", { hasText: "选一个" }).getByRole("button", { name: "方案乙" }).click();
  const sent = await requested(kernel, (r) => r.word === "say");
  assert.deepEqual(sent.body, { text: "方案乙", in_reply_to: card.id, option_id: "b" });
  await second.page.locator(".card", { hasText: "选一个" }).locator(".opt.on", { hasText: "方案乙" }).waitFor();
  assert.equal(await second.page.locator(".card", { hasText: "选一个" }).getByRole("button", { name: "方案甲" }).isDisabled(), true);
}));

test(...withBrowser("a message typed while the connection is down is shown as unsent and delivered once after it returns", async ({ kernel, browser }) => {
  echoAgent(kernel, { tool: false });
  const { page } = await openPage(browser, kernel);
  await page.context().setOffline(true);
  kernel.drop();
  await page.waitForFunction(() => /离线|连接中/.test(document.querySelector("#connection").textContent));
  await page.locator("#t").fill("typed offline");
  await page.locator("#send").click();
  await page.locator("#log .msg.pending-local", { hasText: "typed offline" }).waitFor();
  assert.equal(kernel.requests.filter((r) => r.word === "say").length, 0);
  // Offline says so in the top bar and in a banner under it; what was typed waits under its bubble, with no storage notice.
  assert.equal(await page.locator("#presence").getAttribute("data-net"), "offline");
  await page.locator("#netBanner", { hasText: "你写的消息会先存着，连上就发" }).waitFor();
  await page.locator("#log .meta-pending", { hasText: "等连上就发" }).waitFor();
  assert.equal(await page.getByText(/暂存在此浏览器/).count(), 0);
  await page.context().setOffline(false);
  await page.locator("#log .msg.ai", { hasText: "echo: typed offline" }).waitFor();
  // A send the dropped connection may have swallowed is sent again with the same client_id, which the hub answers from its first
  // record: so the page may send twice, but it is one message, one id.
  const ids = new Set(kernel.requests.filter((r) => r.word === "say").map((r) => r.client_id));
  assert.equal(ids.size, 1, "every send of it carries the same client_id");
  assert.equal(kernel.ledger.filter((m) => m.word === "say" && m.from === "person:owner").length, 1, "delivered exactly once");
  // the local placeholder gives way to the ledger's own bubble
  await page.locator("#log .msg.pending-local").waitFor({ state: "detached" });
  assert.equal(await page.locator("#log .msg.me", { hasText: "typed offline" }).count(), 1);
}));

test(...withBrowser("the top bar has her and the apps: tapping her opens her home (the helper's when talking to one), tapping the apps asks for the apps page", async ({ kernel, browser }) => {
  homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  assert.equal(await page.locator("#files, #menu, #drawer, #agentSheet").count(), 0, "no files button, no menu, no old sheets");
  await page.evaluate(() => { window.opened = []; window.addEventListener("ash:open", (event) => { window.opened.push(event.detail); }); });
  await page.locator("#presence").click();
  await page.locator('#home .hm-screen[data-page="home"]').waitFor();
  assert.deepEqual(await page.evaluate(() => window.opened), [{ page: "home" }]);
  await page.keyboard.press("Escape");
  await page.locator("#home").waitFor({ state: "hidden" });
  // The apps page is the home's apps page.
  await page.locator("#apps").click();
  await page.locator('#home .hm-screen[data-page="apps"]').waitFor();
  assert.deepEqual((await page.evaluate(() => window.opened)).at(-1), { page: "apps" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator("#home").waitFor({ state: "hidden" });
  await page.evaluate(() => { window.opened = []; });
  // Talking to a helper: her home is the helper's.
  await page.locator("#f .to").click();
  await page.locator(".layer .li", { hasText: "小研" }).click();
  await page.locator("#presence").click();
  await page.locator('#home .hm-screen[data-page="home"]').waitFor();
  assert.deepEqual(await page.evaluate(() => window.opened), [{ page: "home", agent: "agent:xiaoyan" }]);
}));

test(...withBrowser("her home puts words in the box with ash:compose: plain words fill it, words about a turn come as a removable chip", async ({ kernel, browser }) => {
  const { page } = await openPage(browser, kernel);
  const compose = (detail) => page.evaluate((d) => !window.dispatchEvent(new CustomEvent("ash:compose", { cancelable: true, detail: d })), detail);
  assert.equal(await compose({ text: "帮我看看这个" }), true, "the page took the words");
  assert.equal(await page.locator("#t").inputValue(), "帮我看看这个");
  assert.equal(await page.evaluate(() => document.activeElement.id), "t");
  assert.equal(await page.locator("#send").evaluate((el) => el.classList.contains("idle")), false, "there is something to send now");
  assert.equal(await compose({ text: "关于查资料，", turn: "t_one" }), true);
  assert.equal(await page.locator("#t").inputValue(), "关于查资料，");
  await page.locator("#context .context-chip", { hasText: "关于这件事" }).waitFor();
  await page.locator("#context .context-chip button").click();
  assert.equal(await page.locator("#context").isHidden(), true);
  assert.equal(await page.locator("#t").inputValue(), "关于查资料，", "removing the chip keeps what was written");
}));

test(...withBrowser("a turn that ended badly leaves one card with a retry that says the same words again", async ({ kernel, browser }) => {
  echoAgent(kernel, { tool: false });
  kernel.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "查一下天气" } });
  kernel.append({ from: "agent:main", kind: "event", word: "turn.started", turn: "t_bad", body: { turn: "t_bad", lane: "front" } });
  kernel.append({ from: "agent:main", kind: "event", word: "turn.ended", turn: "t_bad", body: { turn: "t_bad", lane: "front", outcome: "error" } });
  const { page } = await openPage(browser, kernel);
  const card = page.locator(".card.failure");
  await card.locator(".card-hd", { hasText: "没做成" }).waitFor();
  assert.equal(await card.locator(".opt").count(), 0);
  await card.getByRole("button", { name: "重试" }).click();
  const sent = await requested(kernel, (r) => r.word === "say" && r.body.text === "查一下天气" && r.client_id);
  assert.equal(sent.body.text, "查一下天气");
  await page.locator("#log .msg.ai", { hasText: "echo: 查一下天气" }).waitFor();
  assert.equal(await page.locator(".card.failure").count(), 0, "once the owner has said something again the card is gone");
}));
