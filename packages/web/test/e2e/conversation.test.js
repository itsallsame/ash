import assert from "node:assert/strict";
import test from "node:test";
import { echoAgent, eventually, gateAsk, openPage, requested, withBrowser } from "./support.js";

test(...withBrowser("the owner sends from the page, the agent answers, and a reload shows the same conversation", async ({ kernel, browser }) => {
  echoAgent(kernel);
  const { page } = await openPage(browser, kernel);
  await page.locator("#t").fill("e2e hello");
  await page.locator("#send").click();
  await page.locator("#log .msg.me", { hasText: "e2e hello" }).waitFor();
  await page.locator("#log .msg.ai", { hasText: "echo: e2e hello" }).waitFor();
  // sent -> delivered -> read: the agent took the say in, then opened a turn with it
  await page.waitForFunction(() => document.querySelector("#log .delivery")?.textContent === "已读");
  const say = await requested(kernel, (r) => r.word === "say");
  assert.deepEqual([say.to, say.body], ["agent:main", { text: "e2e hello" }]);
  await page.reload();
  await page.locator("#log .msg.me", { hasText: "e2e hello" }).waitFor();
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
  const ask = gateAsk(kernel, { title: "改审批规则", ts: Date.now() });
  const question = kernel.append({ from: "agent:main", to: "person:owner", kind: "request", word: "ask", ts: Date.now(), body: { title: "晚饭吃什么？", human_kind: "question", options: [{ id: "noodles", label: "面" }, { id: "rice", label: "饭" }], expires_at: Date.now() + 3_600_000 } });
  const { page } = await openPage(browser, kernel);
  await page.locator("#presence").click();
  await page.locator('#agentTabs [data-tab="approvals"]').click();
  const sheet = page.locator('#agentPanel section[data-tab="approvals"]');
  await sheet.locator(".sheet-approval", { hasText: "改审批规则" }).getByRole("button", { name: "不允许" }).click();
  await page.waitForFunction(() => !document.querySelector('#agentPanel [data-ask-id]'));
  assert.deepEqual(kernel.ledger.find((m) => m.reply_to === ask.id).body.result.data, { choice: "deny" });
  await page.locator("#agentClose").click();
  await page.locator(".card.ask", { hasText: "晚饭吃什么" }).getByRole("button", { name: "面" }).click();
  await page.locator(".card.ask .ask-outcome", { hasText: "已选择：面" }).waitFor();
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
  await second.page.locator(".card", { hasText: "选一个" }).getByText("已选择").waitFor();
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
  await page.context().setOffline(false);
  await page.locator("#log .msg.ai", { hasText: "echo: typed offline" }).waitFor();
  assert.equal(kernel.requests.filter((r) => r.word === "say").length, 1, "delivered exactly once");
  assert.equal(await page.locator("#log .msg.me", { hasText: "typed offline" }).count(), 1);
}));
