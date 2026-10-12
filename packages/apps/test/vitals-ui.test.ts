// 她的状态（packages/apps/vitals/ui）：页面的数据模型（纯函数）、两个页面文件和源对得上、文字和颜色只来自表和令牌，
// 以及在真浏览器里按假主机逐种情况（正常 / 留意 / 有问题 / 体检有待办 / 刚装好 / 大脑没在运行）× 亮暗跑一遍。没有浏览器时后一部分跳过。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// 纯 ESM、没有类型声明：按路径加载，让检查器当它没类型
const here = dirname(fileURLToPath(import.meta.url));
const load = async (rel: string) => await import(join(here, rel)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const model = await load("../vitals/ui/src/model.mjs");
const support = await load("./vitals-ui-support.mjs");
const { launchBrowser } = await load("../../web/test/e2e/browser.js");
const { pages } = await load("../../../tools/gen-vitals-ui.mjs");
const { COPY } = model;
const { NOW, scenarios } = support;
const MIN = 60_000, HOUR = 3_600_000;
const view = (name: string, patch: (s: any, d: any) => void = () => {}) => { const { status, day } = scenarios[name](); patch(status, day); return model.build(status, day, NOW); };

test("the head: the lamp and the sentence are the server's; an invariant id as the sentence is that check's own line, with the device named", () => {
  assert.deepEqual([view("ok").level, view("ok").say], ["ok", COPY.say.ok]);
  assert.equal(view("ok", (s) => { s.say = { id: "ok_busy" }; }).say, COPY.say.ok_busy);
  assert.equal(view("err").say, COPY.invariants["idle.msg_rate"].say);
  assert.equal(view("todo").say, "「我的电脑」一直断开又连上");
  assert.equal(view("warn").say, COPY.say.warn_recovered);
  assert.equal(view("ok", (s) => { s.lamp = "warn"; s.say = { id: "warn_hands", args: { n: 2 } }; }).say, "我一切正常，但有 2 处要你帮我修");
  assert.equal(view("down").say, COPY.say.err_brain_down);
  assert.equal(view("ok", (s) => { s.say = { id: "mystery.thing" }; }).say, COPY.unknown.say, "an id the table does not know still says something");
  assert.deepEqual([view("fresh").level, view("fresh").say], ["new", COPY.say.new]);
  assert.equal(view("ok", (s) => { s.lamp = "paused"; s.say = { id: "paused" }; }).levelName, "暂停");
  assert.equal(model.build(null, null, NOW).level, "err", "nothing read at all is not calm");
});

test("the chips: how many devices, idle or busy with what; the button goes to the alert the server named", () => {
  assert.deepEqual(view("ok").chips, { online: "连着 2 台设备", idle: true, busy: null });
  assert.deepEqual(view("todo").chips, { online: "连着 2 台设备", idle: false, busy: "整理你的日程" });
  assert.equal(view("todo", (s) => { delete s.busy_what; }).chips.busy, null, "she is busy and nobody says with what");
  assert.equal(view("err").action.id, "idle.msg_rate");
  assert.equal(view("ok").action, null);
  assert.equal(view("warn").action, null, "only err has the button");
});

test("the three tiles say it in words; the one that is out turns colour; idle high cpu is err, busy high cpu is not", () => {
  assert.deepEqual(view("ok").tiles.map((t: any) => [t.word, t.num, t.tone]), [["很闲", "CPU 2%", ""], ["不多", "186 MB", ""], ["很快", "延迟 12 毫秒", ""]]);
  assert.deepEqual(view("err").tiles.map((t: any) => [t.word, t.num, t.tone]), [["很忙", "CPU 38% · 闲着", "err"], ["有点多", "342 MB", "warn"], ["很快", "延迟 24 毫秒", ""]]);
  assert.deepEqual(view("err", (s) => { s.vitals.idle = false; }).tiles[0], { id: "busy", label: "忙不忙", word: "很忙", num: "CPU 38%", tone: "" });
  assert.deepEqual(view("down").tiles.map((t: any) => t.word), ["—", "—", "—"], "no reading is a dash, not a guess");
  assert.equal(model.band(COPY.now.lag.bands, 200).word, "卡住了", "the limit itself is in the next band");
  assert.equal(model.band(COPY.now.lag.bands, 199).word, "有点慢");
});

test("today: five numbers, the cost in yuan, zero faded, null a dash, the one that is over red; a new install counts from when it came", () => {
  const today = view("ok").today;
  assert.deepEqual(today.map((c: any) => c.text), ["12", "86", "¥3.42", "0", "0"]);
  assert.deepEqual(today.map((c: any) => !!c.zero), [false, false, false, true, true]);
  assert.deepEqual([view("todo").today[3].text, view("todo").today[3].tone], ["7", "err"]);
  assert.equal(view("ok", (_s, d) => { d.today.reconnects = null; }).today[3].text, "—");
  assert.equal(view("warn").today[4].text, "2");
  assert.equal(view("fresh").since, "14:07");
  assert.equal(view("ok").since, null);
});

test("recent alerts: the server's rows in its order, live ones say so, recovered ones the past; the order of the page follows", () => {
  const err = view("err");
  assert.deepEqual(err.alerts.map((a: any) => [a.id, a.live]), [["idle.msg_rate", true], ["idle.cpu", true], ["loop.lag", false]]);
  assert.equal(err.alertsFirst, true);
  assert.equal(view("ok").alertsFirst, false);
  assert.equal(view("warn").alertsFirst, true);
  assert.equal(err.alerts[0].key, `idle.msg_rate@${new Date(2026, 9, 12, 14, 2).getTime()}`);
});

test("an alert's detail: the numbers, how long, the words from the table; recovered says how long it lasted; unknown ids still say something", () => {
  const live = view("err").alerts[0];
  assert.deepEqual([live.title, live.minutes, live.value, live.limit, live.unit, live.limitUnit], ["我在空转", 6, 44, 30, "条 / 分钟", "条以内"]);
  assert.deepEqual(live.actions.map((a: any) => a.kind), ["restart_brain", "open_checkup", "dismiss"]);
  const gone = view("err").alerts[2];
  assert.equal(gone.live, false);
  assert.equal(gone.minutes, 1);
  assert.equal(gone.lead, COPY.invariants["loop.lag"].recovered.lead);
  assert.equal(gone.why, COPY.invariants["loop.lag"].recovered.why);
  const odd = view("ok", (s) => { s.alerts = [{ id: "mystery.thing", state: "live", since: NOW - 5 * MIN, ended: null, minutes: 5, value: 9, budget: 3, device: null }]; });
  assert.deepEqual(odd.alerts[0].actions.map((a: any) => a.kind), ["copy_debug"]);
  assert.match(odd.alerts[0].lead, /实际是 9，正常是 3 以内/);
  assert.equal(odd.alerts[0].debug.value, 9, "what is copied for the developer is the alert itself");
  const todo = view("todo").alerts[0];
  assert.deepEqual(todo.device, { id: "device:laptop", name: "我的电脑" });
  assert.equal(todo.title, "「我的电脑」重连了好多次");
  assert.equal(view("todo", (s) => { s.alerts[0].device = { id: "device:x", name: "一台设备" }; }).alerts[0].title, "「一台设备」重连了好多次");
  assert.deepEqual(view("todo", (s) => { s.alerts[0].device = null; }).alerts[0].actions.map((a: any) => a.kind), ["dismiss"], "no device found: no button that goes to it");
  assert.deepEqual(view("todo").alerts[0].actions.map((a: any) => a.kind), ["open_device", "dismiss"]);
});

test("the gauge: the value and the normal limit as parts of one scale, both inside it", () => {
  const g = model.gauge(44, 30);
  assert.ok(Math.abs(g.v - 0.8) < 1e-9 && Math.abs(g.lim - 30 / 55) < 1e-9);
  const over = model.gauge(860, 200);
  assert.ok(over.v > 0.7 && over.v < 0.9 && over.lim < over.v);
  assert.deepEqual(model.gauge(0, 5), { v: 0, lim: 5 / 6 }, "nothing reads as an empty bar with the limit still shown");
});

test("the rules: one line per group of the table over the nine checks; the one over says so, then the ones still being watched, then the ones busy", () => {
  const rows = view("ok").rules;
  assert.deepEqual(rows.map((r: any) => r.tone), Array(COPY.rules.length).fill("ok"));
  assert.equal(rows[0].line, "每分钟 2 条消息，30 条以内");
  assert.deepEqual(view("err").rules.map((r: any) => r.tag), ["越界", "正常", "越界", "正常", "正常", "正常", "正常"]);
  assert.equal(view("err").rules[0].line, "每分钟 44 条消息，30 条以内");
  assert.deepEqual(view("todo").rules.slice(0, 3).map((r: any) => [r.tag, r.tone]), Array(3).fill(["在忙，不算", "mute"]));
  assert.equal(view("todo").rules[3].tone, "err");
  assert.deepEqual(view("fresh").rules.slice(0, 3).map((r: any) => [r.tag, r.line]), Array(3).fill(["在看", "看满一分钟才知道"]));
  const split = view("ok", (s) => { s.rules.find((r: any) => r.id === "idle.msg_key_rate").state = "err"; s.rules.find((r: any) => r.id === "idle.msg_key_rate").value = 9; });
  assert.equal(split.rules[0].tag, "越界", "of the two checks under one line, the one over speaks");
  assert.equal(split.rules[0].line, "同一件事每分钟 9 次，6 次以内算正常", "and says it with that check's own limit, not the line's");
});

test("the checkup: not told yet draws nothing; all good is one row; otherwise only the parts to fix, the optional one never", () => {
  assert.deepEqual(view("ok").checkup.good, { title: "7 处都好", sub: COPY.checkup.all_good_s });
  const todo = view("todo").checkup;
  assert.equal(todo.title, "手和眼 · 2 处要修");
  assert.deepEqual(todo.fix.map((p: any) => [p.id, p.name, p.bad]), [["awake", "在后台醒着", "可能被系统清理掉"], ["eyes", "眼睛和手", "屏幕上的事我看不到了"]]);
  assert.equal(todo.rest, "其余 5 处都好");
  assert.equal(view("fresh").checkup, null);
  assert.equal(view("ok", (s) => { s.checkup.groups.find((g: any) => g.id === "location").todo = 3; }).checkup.good.title, "7 处都好", "「位置和健康」 is optional");
  const phone = view("ok", (s) => { s.checkup.groups.find((g: any) => g.id === "files").todo = 1; s.checkup.groups.find((g: any) => g.id === "files").text = "没给权限"; }).checkup;
  assert.deepEqual(phone.fix[0], { id: "files", name: "照片和文件", icon: "folder", bad: "没给权限" }, "a part the design has no sentence for says what the phone said");
});

test("the 24 hours: one bar per hour, the last one is now (scaled to an hour) and never red; no data yet, no chart", () => {
  const t = view("err").trend;
  assert.equal(t.act.length, 24);
  assert.equal(t.cpu.length, 24);
  assert.deepEqual(t.ticks, ["15:00", "21:00", "03:00", "09:00", "现在"]);
  assert.ok(!t.bad.includes(23), "an alert in this very hour does not turn the 'now' bar red");
  assert.deepEqual(view("warn").trend.bad, [18, 22], "the hours of the alerts' starts");
  assert.equal(view("fresh").trend, null);
  const { day } = scenarios.ok();
  const full = model.trend(day, [], NOW);
  assert.ok(full.act[23] > 300, "8 minutes of this hour count as the rate of a whole hour");
});

test("every word on the pages comes from copy.json and every colour from a token", () => {
  const dir = join(here, "../vitals/ui/src");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "host.mjs")) {
    const code = strip(readFileSync(join(dir, file), "utf8"));
    assert.ok(!/[一-鿿]/.test(code), `${file}: Chinese text in code (it belongs in design/vitals/copy.json)`);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(code), `${file}: a colour that is not a token`);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(strip(readFileSync(join(dir, "extra.css"), "utf8"))), "extra.css: a colour that is not a token");
});

test("home.html and alert.html are what tools/gen-vitals-ui.mjs makes from the sources", async () => {
  const made = await pages();
  for (const [name, text] of Object.entries(made)) assert.equal(support.pageHtml(name), text, `${name} is stale: node tools/gen-vitals-ui.mjs`);
  for (const text of Object.values(made) as string[]) {
    assert.ok(text.includes("--you-soft") && text.includes(".lamp-err") && text.includes("prefers-color-scheme:dark") && text.includes(':root[data-theme=dark]'), "tokens, vitals.css and both themes inline");
    assert.ok(!/<script[^>]*\ssrc=|<link\b|@import|url\(\s*["']?https?:/i.test(text), "nothing is fetched: the page is one file");
    assert.ok(text.indexOf("<script>") > 0 && text.indexOf("<script>") < text.indexOf("<body>"), "the host hands the page its port when the page first paints: the listener must be up by then, so the script is in the head");
  }
});

// ---------- 真浏览器 ----------
const browser = await launchBrowser();
const skip = browser ? false : "no browser";
test.after(async () => { await browser?.close(); });

/** 一个情况 × 一种主题的页面；返回 page 和假主机（page.evaluate 里 window.__host）。 */
async function open(name: string, surface: "home.html" | "alert.html", theme: "light" | "dark", opts: { reduced?: boolean; scheme?: "light" | "dark" } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 1400 }, colorScheme: opts.scheme ?? theme, reducedMotion: opts.reduced ? "reduce" : "no-preference" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.setContent('<style>html,body{margin:0}iframe{border:0;width:390px;height:1400px;display:block}</style><iframe id="f"></iframe>');
  await page.evaluate(support.hostScript(theme, scenarios[name]()));
  await page.evaluate((html: string) => { (document.getElementById("f") as HTMLIFrameElement).srcdoc = html; }, support.pageHtml(surface));
  const frame = page.frames().find((f: any) => f !== page.mainFrame());
  await frame.waitForSelector("#app > *", { timeout: 5000 });
  return { page, frame, context, errors, host: () => page.evaluate(() => (window as any).__host) };
}
const text = async (frame: any) => {
  const body = await frame.evaluate(() => document.body.innerText);
  assert.ok(!/NaN|undefined|\[object|\{[a-z]+\}/.test(body), `an unfilled value on the page: ${body.match(/NaN|undefined|\[object[^\]]*\]|\{[a-z]+\}/)?.[0]}`);
  return body;
};

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: normal — one calm sentence, no red or amber anywhere`, { skip }, async () => {
    const { frame, context, errors } = await open("ok", "home.html", theme);
    const body = await text(frame);
    for (const word of ["正常", "我一切正常", "连着 2 台设备", "闲着", "很闲", "不多", "很快", "¥3.42", "最近一切正常", "7 处都好", "闲着时不空转", "最近 24 小时"]) assert.ok(body.includes(word), word);
    assert.equal(await frame.evaluate(() => document.querySelectorAll(".lvl-warn,.lvl-err,.tag-warn,.tag-err,.btn-fix,[style*='var(--err)'],[style*='var(--warn)']").length), 0, "no amber or red on a calm page");
    assert.equal(await frame.evaluate(() => document.querySelectorAll(".vt-chart svg rect").length), 48, "24 bars in each of the two charts");
    assert.ok(!/idle\.|loop\.|errors\.|link\.|invariant/.test(body), "no internal ids on the page");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test(`${theme}: err — the lamp, the button that goes to the alert, the way out is a confirmed restart`, { skip }, async () => {
    const { page, frame, context, host } = await open("err", "home.html", theme);
    const body = await text(frame);
    for (const word of ["有问题", "我在空转，可能很费电", "看看怎么办", "进行中", "很忙", "CPU 38% · 闲着", "越界"]) assert.ok(body.includes(word), word);
    assert.ok(body.indexOf("最近告警") < body.indexOf("此刻"), "the alerts go above the moment when there are some");
    await frame.click("text=看看怎么办");
    await frame.waitForSelector("text=为什么会这样");
    assert.ok((await text(frame)).includes("我在空转"));
    await frame.click("text=重启我的大脑");
    await frame.waitForSelector("text=重启我的大脑？");
    assert.deepEqual((await host()).called.filter((n: string) => !["vitals.status", "vitals.day"].includes(n)), [], "asking is not doing");
    await frame.click("text=先不重启");
    assert.equal(await frame.locator("text=重启我的大脑？").count(), 0);
    assert.deepEqual((await host()).called.filter((n: string) => !["vitals.status", "vitals.day"].includes(n)), []);
    await frame.click("text=重启我的大脑");
    await frame.click("button:has-text('重启大脑')");
    await page.waitForFunction(() => (window as any).__host.called.includes("vitals.restart"));
    assert.deepEqual((await host()).args["vitals.restart"], { confirmed: true }, "the server only restarts what was confirmed");
    await frame.click("text=去体检看看").catch(() => {});
    await context.close();
  });
}

test("the checkup: 去修 goes to that part, the whole row to the whole checkup; the alert's own actions go where they say", { skip }, async () => {
  const { page, frame, context, host } = await open("todo", "home.html", "light");
  const body = await text(frame);
  for (const word of ["手和眼 · 2 处要修", "去修", "在后台醒着", "可能被系统清理掉", "其余 5 处都好", "在忙 · 整理你的日程", "在忙，不算"]) assert.ok(body.includes(word), word);
  await frame.locator(".btn-fix").first().click();
  await frame.locator("text=其余 5 处都好").click();
  await frame.locator(".li", { hasText: "「我的电脑」重连了好多次" }).click();
  await frame.click("text=去看看这台电脑");
  await page.waitForFunction(() => (window as any).__host.opened.length === 3);
  assert.deepEqual((await host()).opened, ["ash://checkup/awake", "ash://checkup", `ash://device/${encodeURIComponent("device:laptop")}`]);
  await context.close();
});

test("a recovered alert only offers 知道了, which goes back; the alert surface opens on the one that is going on", { skip }, async () => {
  const one = await open("err", "home.html", "light");
  await one.frame.locator(".li", { hasText: "我卡了一下" }).click();
  await one.frame.waitForSelector("text=已恢复");
  const body = await text(one.frame);
  assert.ok(body.includes("那一分钟里你跟我说话，我可能回得晚。") && body.includes("知道了") && !body.includes("重启"));
  await one.frame.click("button:has-text('知道了')");
  await one.frame.waitForSelector("text=最近告警");
  await one.context.close();
  const two = await open("err", "alert.html", "dark");
  const alertBody = await text(two.frame);
  assert.ok(alertBody.includes("进行中") && alertBody.includes("我在空转") && alertBody.includes("重启我的大脑"));
  assert.equal(await two.frame.locator(".navbar").count(), 0, "the app's own frame has the way back");
  await two.context.close();
});

test("new, warn, and no data: she says so instead of pretending", { skip }, async () => {
  const fresh = await open("fresh", "home.html", "light");
  const a = await text(fresh.frame);
  for (const word of ["刚到", "我刚到，还在熟悉这台手机", "从 14:07 开始算", "还没有记录", "看满一分钟才知道", "在看", "过一个小时再来看"]) assert.ok(a.includes(word), word);
  assert.ok(!a.includes("手和眼"), "no summary from the phone yet: no block for it");
  await fresh.context.close();
  const warn = await open("warn", "home.html", "dark");
  const b = await text(warn.frame);
  for (const word of ["留意", "我刚才有点忙，已经缓过来了", "已恢复 · CPU 到了 38%"]) assert.ok(b.includes(word), word);
  await warn.context.close();
  const down = await open("down", "home.html", "light");
  const c = await text(down.frame);
  assert.ok(c.includes("我的大脑没在运行") && c.includes("有问题"));
  await down.context.close();
});

test("the theme is the host's, not the system's; the big lamp's ring stops after a few turns and does not move at all with less motion", { skip }, async () => {
  const dark = await open("ok", "home.html", "dark", { scheme: "light" });
  assert.equal(await dark.frame.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(27, 23, 21)", "--bg of the dark tokens");
  await dark.context.close();
  const light = await open("ok", "home.html", "light", { scheme: "dark" });
  assert.equal(await light.frame.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(255, 248, 241)");
  await light.context.close();
  const err = await open("err", "home.html", "light");
  assert.equal(await err.frame.evaluate(() => getComputedStyle(document.querySelector(".lamp-err.lamp-xl")!, "::after").animationIterationCount), "3");
  await err.context.close();
  const calm = await open("err", "home.html", "light", { reduced: true });
  assert.equal(await calm.frame.evaluate(() => getComputedStyle(document.querySelector(".lamp-err.lamp-xl")!, "::after").animationName), "none");
  await calm.context.close();
});
