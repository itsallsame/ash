import assert from "node:assert/strict";
import test from "node:test";
import { SettingsControls } from "../js/settings.js";
import { appState, appsSummary, needText } from "../js/settings-apps.js";
import { startKernel } from "./kernel.js";
import { connect, FakeElement, until } from "./support.js";

test("an app's needs, state and the home line read in plain words", () => {
  assert.equal(needText({ member: "device:phone", words: ["health.read", "sensors.steps"], why: "读取你的健康数据" }), "· 读取你的健康数据（device:phone：health.read、sensors.steps）");
  assert.equal(needText({ notify: true, why: "体重变化较大时提醒你" }), "· 体重变化较大时提醒你（提醒你）");
  assert.equal(needText({ card: true, why: "每周一放一张小结卡片" }), "· 每周一放一张小结卡片（在对话里放入口卡片）");
  assert.equal(needText(null), "");
  assert.equal(appState({ granted: false }), "未授权");
  assert.equal(appState({ granted: true, enabled: false }), "已停用");
  assert.equal(appState({ granted: true, enabled: true, running: true }), "已启用 · 运行中");
  assert.equal(appsSummary([]), "还没有应用");
  assert.equal(appsSummary([{ granted: true, enabled: true }, { granted: false }]), "2 个应用 · 1 个已启用");
});

test("settings list the apps and install, disable, enable and revoke them through service:apps words", async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  const kernel = startKernel();
  const health = { id: "health", name: "健康", version: "1.0.1", summary: "体重、步数、睡眠", enabled: false, granted: false, running: false,
    needs: [{ member: "device:phone", words: ["health.read"], why: "读取你的健康数据" }, { notify: true, why: "提醒你" }] };
  const change = (patch) => () => Object.assign(health, patch);
  kernel.on("service:apps", "apps.list", () => ({ apps: [{ ...health }] }));
  kernel.on("service:apps", "apps.refresh", () => ({ apps: [{ ...health }] }));
  kernel.on("service:apps", "apps.install", () => ({ ...change({ granted: true, enabled: true, running: true })() }));
  kernel.on("service:apps", "apps.enable", () => ({ ...change({ granted: true, enabled: true, running: true })() }));
  kernel.on("service:apps", "apps.disable", () => ({ ...change({ enabled: false, running: false })() }));
  kernel.on("service:apps", "apps.revoke", () => ({ ...change({ granted: false, enabled: false, running: false })() }));
  const { net } = await connect(kernel);
  try {
    const panel = new FakeElement("div");
    const settings = new SettingsControls(panel, net);
    settings.network("online");
    settings.opened();
    await until(() => panel.find("settingsAppsRow").sub.textContent === "1 个应用 · 都没启用", 2000, "the home line");
    panel.find("settingsAppsRow").click();
    const card = () => panel.find("settingsAppsList").children[0];
    await until(() => card());
    assert.equal(panel.find("settingsApps").hidden, false);
    const control = (word) => card().all().find((item) => item.attributes?.["data-app-word"] === word);
    const words = () => kernel.requests.filter((request) => request.to === "service:apps").map((request) => [request.word, request.body]);
    assert.equal(card().attributes["data-app-id"], "health");
    assert.match(card().text, /未授权/);
    assert.match(card().text, /· 读取你的健康数据（device:phone：health.read）\n· 提醒你（提醒你）/);
    const before = words().length;
    control("apps.install").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(words().length, before, "the first tap only says what installing allows");
    assert.equal(control("apps.install").textContent, "确认安装");
    control("apps.install").click();
    await until(() => /已启用 · 运行中/.test(card()?.text ?? ""));
    assert.deepEqual(words().find(([word]) => word === "apps.install"), ["apps.install", { id: "health" }]);
    await until(() => /已安装「健康」/.test(panel.find("settingsAppsStatus").textContent));
    control("apps.disable").click();
    await until(() => /已停用/.test(card().text));
    control("apps.enable").click();
    await until(() => /已启用/.test(card().text));
    const beforeRevoke = words().length;
    control("apps.revoke").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(words().length, beforeRevoke, "taking back every grant takes a second tap");
    control("apps.revoke").click();
    await until(() => /未授权/.test(card().text));
    assert.deepEqual(words().find(([word]) => word === "apps.revoke"), ["apps.revoke", { id: "health" }]);
    panel.find("settingsAppsRefresh").click();
    await until(() => words().at(-1)?.[0] === "apps.refresh");
  } finally { delete globalThis.document; net.stop(); kernel.close(); }
});

test("an app word that the hub refuses is not shown as done, and the card shows what is true now", async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  const kernel = startKernel();
  const app = { id: "health", name: "健康", version: "1", enabled: false, granted: true, running: false, needs: [] };
  kernel.on("service:apps", "apps.list", () => ({ apps: [{ ...app }] }));
  kernel.on("service:apps", "apps.enable", { ok: false, error: { code: "failed", message: "could not start" } });
  const { net } = await connect(kernel);
  try {
    const panel = new FakeElement("div");
    const settings = new SettingsControls(panel, net);
    settings.network("online");
    panel.find("settingsAppsRow").click();
    const card = () => panel.find("settingsAppsList").children[0];
    await until(() => card());
    card().all().find((item) => item.attributes?.["data-app-word"] === "apps.enable").click();
    await until(() => /没有确认完成/.test(panel.find("settingsAppsStatus").textContent));
    assert.match(card().text, /已停用/);
  } finally { delete globalThis.document; net.stop(); kernel.close(); }
});
