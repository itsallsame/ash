import assert from "node:assert/strict";
import test from "node:test";
import { echoAgent, eventually, gateAsk, openPage, OWNER, requested, withBrowser } from "./support.js";
import { homeHub, openHome, sent } from "./home-support.js";

const turn = (kernel, id, { lane = "front", ids = [], tools = [], outcome = "completed", agent = "agent:main" } = {}) => {
  const event = (word, body) => kernel.append({ from: agent, kind: "event", word, turn: id, body: { turn: id, ...body } });
  event("turn.started", { lane, ids });
  for (const name of tools) { event("agent.tool", { name, phase: "start", summary: `在查 ${name.replace(/_/g, " ")}` }); event("agent.tool", { name, phase: "end", ok: true }); }
  if (outcome) event("turn.ended", { lane, outcome });
};
const screen = (page, name) => page.locator(`#home .hm-screen[data-page="${name}"]`);
const open = async (page, section, extra = {}) => { await openHome(page, { page: "home", section, ...extra }, `#home .hm-screen[data-page="${section}"]`); return screen(page, section); };

test(...withBrowser("the home page shows her state, what waits for you, what is coming, what she remembers and what you agreed", async ({ kernel, browser }) => {
  const hub = homeHub(kernel);
  hub.files.set("USER.md", "# 关于你\n## 生活\n- 住在杭州\n## 要紧的\n- 对花生过敏\n");
  hub.files.set("PROACTIVE.md", "快递变化直接说。");
  hub.settings["delivery.quiet_hours"] = "21:30-09:00";
  hub.timers = [{ id: "c1", next: Date.now() + 3_600_000, label: "每日复盘", every: 86_400 }];
  turn(kernel, "t1", { tools: ["read"] });
  gateAsk(kernel, { title: "要发消息给小李" });
  kernel.append({ id: "q1", from: "agent:main", to: OWNER, kind: "request", word: "ask", body: { title: "订哪个营地？", human_kind: "question", expires_at: Date.now() + 3_600_000, options: [{ id: "a", label: "西溪" }, { id: "b", label: "千岛湖" }] } });
  const { page } = await openPage(browser, kernel);
  await openHome(page);
  const home = screen(page, "home");
  await home.locator("#homeName", { hasText: "小岛" }).waitFor();
  assert.equal(await home.locator("#homeStatDone .hm-stat-n").textContent(), "1", "the turns of today");
  await eventually(async () => (await home.locator("#homeStatWaiting .hm-stat-n").textContent()) === "2", "an approval and a question wait");
  await home.getByText("要发消息给小李").waitFor();
  await home.getByText("订哪个营地？").waitFor();
  await home.locator("[data-timer=c1]").getByText("每日复盘").waitFor();
  await home.locator(".hm-chip.urgent", { hasText: "对花生过敏" }).waitFor();
  await home.getByText("21:30", { exact: true }).waitFor();
  await home.getByText("快递变化直接说。").waitFor();
  await home.getByText("对话还没设").waitFor();
  assert.equal(await home.locator("#homeCellPhone").count(), 0, "outside the app there is no phone checkup");
  assert.doesNotMatch(await home.textContent(), /service:|agent:|body:|\bJEV\b|DSH/);
}));

test(...withBrowser("the page's own state follows her work: working shows what she does, and the back button goes home", async ({ kernel, browser }) => {
  homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openHome(page);
  kernel.append({ from: "agent:main", kind: "event", word: "turn.started", turn: "t_live", body: { turn: "t_live", lane: "front", ids: [] } });
  kernel.append({ from: "agent:main", kind: "event", word: "agent.tool", turn: "t_live", body: { turn: "t_live", name: "web_search", phase: "start", summary: "在搜索 营地" } });
  await page.locator("#homeState", { hasText: "在搜索 营地" }).waitFor();
  await page.locator("#home .navbar button").first().click();
  await page.locator("#home").waitFor({ state: "hidden" });
}));

test(...withBrowser("an approval is answered from 等你的 with the same answer as in the conversation; a question with one of its options", async ({ kernel, browser }) => {
  homeHub(kernel);
  gateAsk(kernel, { title: "要发消息给小李" });
  kernel.append({ id: "q1", from: "agent:main", to: OWNER, kind: "request", word: "ask", body: { title: "订哪个营地？", human_kind: "question", expires_at: Date.now() + 3_600_000, options: [{ id: "a", label: "西溪" }, { id: "b", label: "千岛湖" }] } });
  const { page } = await openPage(browser, kernel);
  const waiting = await open(page, "waiting");
  const approval = waiting.locator("article", { hasText: "要发消息给小李" });
  await approval.getByRole("button", { name: "允许这一次" }).click();
  const answer = await requested(kernel, (r) => r.kind === "response" && r.word === "ask" && r.body?.result?.data?.choice === "once");
  assert.equal(answer.to, "service:gate");
  const question = waiting.locator("article", { hasText: "订哪个营地？" });
  await question.getByRole("button", { name: "千岛湖" }).click();
  await requested(kernel, (r) => r.kind === "response" && r.word === "ask" && r.body?.result?.data?.choice === "b");
  await waiting.getByText("最近处理过 1 件").waitFor();
  await waiting.getByText("最近处理过 1 件").click();
  const settled = screen(page, "settled");
  await settled.getByRole("button", { name: "查看依据" }).click();
  await settled.getByText("你的回答").waitFor();
}));

test(...withBrowser("the activity page lists a day's turns with their steps, keeps background work in its own row, and asks about a turn", async ({ kernel, browser }) => {
  homeHub(kernel);
  kernel.append({ id: "s1", from: OWNER, to: "agent:main", kind: "request", word: "say", body: { text: "查一下资料" } });
  turn(kernel, "t_front", { ids: ["s1"], tools: ["web_search"] });
  turn(kernel, "t_back", { lane: "back", tools: ["grep"], agent: "agent:xiaoyan" });
  const { page } = await openPage(browser, kernel);
  const activity = await open(page, "activity");
  await activity.locator(".hm-daychip.on", { hasText: "今天 · 2" }).waitFor();
  const card = activity.locator('[data-turn="t_front"]');
  await card.getByText("查一下资料").waitFor();
  await card.getByText("在查 web search").waitFor();
  assert.match(await card.textContent(), /完成了/);
  assert.doesNotMatch(await activity.textContent(), /web_search\b(?! )|agent:|service:/);
  await activity.locator(".hm-bgrow", { hasText: "后台做的 1 件" }).click();
  await activity.locator('[data-turn="t_back"]').waitFor();
  await card.getByRole("button", { name: "问问她这件事" }).click();
  await page.locator("#home").waitFor({ state: "hidden" });
  assert.match(await page.locator("#t").inputValue(), /^关于.*，$/);
}));

test(...withBrowser("a step of a turn opens the detail of what was asked and answered, in pages", async ({ kernel, browser }) => {
  homeHub(kernel);
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
  const activity = await open(page, "activity");
  await activity.locator("summary", { hasText: "查看调用与结果" }).click();
  await activity.locator(".hm-detail pre", { hasText: "first page of detail" }).waitFor();
  await activity.getByRole("button", { name: "继续查看" }).click();
  await activity.locator(".hm-detail pre", { hasText: "and the second page" }).waitFor();
}));

test(...withBrowser("the plans page lists the clock's timers by day and removes one only after the clock confirmed its cancel", async ({ kernel, browser }) => {
  const hub = homeHub(kernel);
  const noon = new Date(); noon.setHours(23, 30, 0, 0);
  hub.timers = [{ id: "c1", next: noon.getTime() > Date.now() ? noon.getTime() : Date.now() + 3_600_000, label: "吃药提醒", every: 86_400 }, { id: "c2", next: Date.now() + 40 * 3_600_000, label: "开会" }];
  const { page } = await openPage(browser, kernel);
  const upcoming = await open(page, "upcoming");
  const row = upcoming.locator('.hm-plan[data-timer="c1"]');
  await row.getByText("吃药提醒").waitFor();
  assert.equal(await upcoming.locator(".hm-weekday").count(), 7);
  await row.getByRole("button", { name: "删除" }).click();
  assert.equal(sent(kernel, "service:clock", "cancel").length, 0, "one tap only says what will be lost");
  await row.getByText(/以后都不会再有了/).waitFor();
  await row.getByRole("button", { name: "确认删除" }).click();
  await upcoming.locator('.hm-plan[data-timer="c1"]').waitFor({ state: "detached" });
  assert.deepEqual((await requested(kernel, (r) => r.word === "cancel")).body, { id: "c1" });
}));

test(...withBrowser("the memory page groups USER.md by its headings, edits it on the body, and refuses to overwrite a file that changed meanwhile", async ({ kernel, browser }) => {
  const hub = homeHub(kernel);
  hub.files.set("USER.md", "# 关于你\n## 生活\n- 喜欢喝茶\n- 住杭州\n## 习惯\n- 早睡\n");
  const { page } = await openPage(browser, kernel);
  const memory = await open(page, "memory");
  await memory.getByText("生活", { exact: true }).waitFor();
  await memory.getByText("喜欢喝茶").waitFor();
  assert.equal(await memory.locator(".li").count(), 3, "one line one row");
  assert.equal(await memory.getByText(/历史|回滚|恢复/).count(), 0, "memory has no history or rollback");
  await memory.getByRole("button", { name: "编辑" }).click();
  await memory.locator("textarea").fill("# 关于你\n## 生活\n- 喜欢喝茶，不喝咖啡");
  hub.files.set("USER.md", "别处改过了");
  await memory.getByRole("button", { name: "保存" }).click();
  await memory.getByText(/刚在别处改过/).waitFor();
  assert.equal(hub.files.get("USER.md"), "别处改过了", "nothing was overwritten");
  assert.equal(await memory.locator("textarea").inputValue(), "# 关于你\n## 生活\n- 喜欢喝茶，不喝咖啡", "the owner's draft is kept");
  assert.equal(kernel.requests.filter((r) => r.word === "workspace.write").length, 0);
}));

test(...withBrowser("the identity page saves SOUL through persona/propose", async ({ kernel, browser }) => {
  homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  const identity = await open(page, "identity");
  await identity.getByText("我叫小岛。").waitFor();
  await identity.getByRole("button", { name: "编辑" }).click();
  await identity.locator("textarea").fill("# 新的灵魂\n温柔一点");
  await identity.getByRole("button", { name: "保存" }).click();
  const proposal = await requested(kernel, (r) => r.word === "propose");
  assert.deepEqual([proposal.to, proposal.body.file, proposal.body.content], ["service:persona", "SOUL.md", "# 新的灵魂\n温柔一点"]);
}));

test(...withBrowser("the promises page: quiet hours are changed in the sentence, the approval mode and a rule's revoke are saved by their own words, the preferences are a file", async ({ kernel, browser }) => {
  const hub = homeHub(kernel);
  hub.settings["delivery.quiet_hours"] = "21:30-09:00";
  const { page } = await openPage(browser, kernel);
  const promises = await open(page, "promises");
  await promises.locator("input[type=time]").first().waitFor({ state: "attached" });
  await promises.locator("input[type=time]").first().fill("22:00");
  await promises.locator("#homeQuietStatus", { hasText: "已保存" }).waitFor();
  assert.equal(hub.settings["delivery.quiet_hours"], "22:00-09:00");
  await promises.locator("#homeMode_always").click();
  await promises.locator("#homeModeStatus", { hasText: "已保存" }).waitFor();
  assert.deepEqual(sent(kernel, "service:gate", "mode.set")[0].body, { mode: "always" });
  const rule = promises.locator('.hm-rule[data-rule="r1"]');
  await rule.getByRole("button", { name: "撤销" }).click();
  assert.equal(sent(kernel, "service:gate", "rules.revoke").length, 0, "the first tap says what will happen");
  await rule.getByText(/下次做这件事前会先问你/).waitFor();
  await rule.getByRole("button", { name: "确认撤销" }).click();
  await promises.locator('.hm-rule[data-rule="r1"]').waitFor({ state: "detached" });
  await promises.locator("#homeProactiveEdit").click();
  await promises.locator(".hm-prefs textarea").fill("早上 9 点前别找我");
  await promises.getByRole("button", { name: "保存", exact: true }).click();
  await eventually(() => hub.files.get("PROACTIVE.md") === "早上 9 点前别找我", "preferences saved");
  await promises.locator("#homeQuietOff").click();
  await eventually(() => hub.settings["delivery.quiet_hours"] === "", "quiet hours off");
}));

