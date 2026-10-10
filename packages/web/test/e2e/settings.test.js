import assert from "node:assert/strict";
import test from "node:test";
import { eventually, openPage, requested, withBrowser } from "./support.js";

/** A hub whose settings words remember what they were told, so a page that reads back sees its own change. */
function settingsHub(kernel) {
  const state = { paused: false, settings: {}, mode: "auto", model: "deepseek-chat", plugins: [{ entryId: "p1", moduleName: "web-tools", enabled: true }],
    vault: new Set(), apps: [{ id: "weather", name: "天气", version: "1.0", granted: false, enabled: false, running: false, needs: [{ why: "查天气", member: "service:senses", words: ["now"] }] }],
    files: new Map(), devices: [], pairs: [], relay: { configured: false, connected: false } };
  kernel.on("service:admin", "status", () => ({ now: Date.now(), paused: state.paused }));
  kernel.on("service:admin", "pause", () => { state.paused = true; return { paused: true }; });
  kernel.on("service:admin", "resume", () => { state.paused = false; return { paused: false }; });
  kernel.on("service:admin", "settings.get", ({ keys }) => ({ settings: Object.fromEntries(Object.entries(state.settings).filter(([k]) => !keys || keys.includes(k))) }));
  kernel.on("service:admin", "settings.set", (body) => { Object.assign(state.settings, body); return body; });
  kernel.on("service:admin", "model.set", ({ provider, model }) => { state.model = model; return { provider, model, restart_required: false }; });
  kernel.on("service:admin", "plugins.list", () => ({ plugins: state.plugins }));
  kernel.on("service:admin", "plugins.op", ({ id, enabled }) => { state.plugins.find((p) => p.entryId === id).enabled = enabled; return { application: "applied" }; });
  kernel.on("service:agents", "list", () => ({ agents: [{ id: "agent:main", name: "Ash", summary: "", state: "idle", primary: true, runtime: { kind: "dsh", model: state.model } }] }));
  kernel.on("service:gate", "rules.list", () => ({ rules: [], mode: state.mode }));
  kernel.on("service:gate", "history", () => ({ items: [] }));
  kernel.on("service:gate", "mode.set", ({ mode }) => { state.mode = mode; return { mode }; });
  const totals = (calls, cost_usd) => ({ calls, input_tokens: 10, output_tokens: 5, cost_usd, unpriced_calls: 0 });
  kernel.on("service:cost", "usage.get", () => ({ as_of: Date.now(), currency: "USD", estimated: true, periods: { today: totals(2, 0.5), "7d": totals(3, 1), "30d": totals(4, 2) },
    by_caller: [{ caller: "agent:main", ...totals(3, 1) }, { caller: "service:reflex", ...totals(1, 0.1) }], by_day: [], recent: [], balances: [] }));
  kernel.on("service:cost", "balance.get", () => ({ balances: [{ provider: "deepseek", at: Date.now(), balance: { available: true, balances: [{ currency: "CNY", total: "12.50" }] } }], errors: {} }));
  kernel.on("service:vault", "list", () => ({ entries: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"].map((ref) => ({ ref, label: ref, kind: "model", configured: state.vault.has(ref) })) }));
  kernel.on("service:vault", "set", ({ ref }) => { state.vault.add(ref); return { ref, configured: true }; });
  kernel.on("service:vault", "delete", ({ ref }) => { state.vault.delete(ref); return { ref, configured: false }; });
  kernel.on("service:apps", "apps.list", () => ({ apps: state.apps }));
  kernel.on("service:apps", "apps.install", ({ id }) => { Object.assign(state.apps.find((a) => a.id === id), { granted: true, enabled: true, running: true }); return {}; });
  kernel.on("service:apps", "apps.disable", ({ id }) => { state.apps.find((a) => a.id === id).enabled = false; return {}; });
  kernel.on("service:devices", "list", () => ({ devices: state.devices }));
  kernel.on("service:devices", "pair_pending", () => ({ pairs: state.pairs }));
  kernel.on("service:devices", "pair_start", ({ kind }) => { state.pairs.push({ pair_id: "pair1", state: "waiting", kind }); return { pair_id: "pair1", expires_at: Date.now() + 600_000 }; });
  kernel.on("service:devices", "pair_code", () => ({ code: "ABCD-1234", url: "https://relay.example/p/ABCD-1234", expires_at: Date.now() + 600_000 }));
  kernel.on("service:devices", "pair_status", ({ pair_id }) => state.pairs.find((p) => p.pair_id === pair_id) ?? { pair_id, state: "expired" });
  kernel.on("service:devices", "pair_approve", ({ pair_id }) => { state.pairs = []; state.devices.push({ device: "device:" + "N".repeat(22), name: "我的电脑", kind: "computer", online: true, tier: "ask", lend: true, body: false, local_agents: false, web_ui: false, via: "gateway" }); return { pair_id, state: "approved" }; });
  kernel.on("service:devices", "revoke", ({ device }) => { state.devices.find((d) => d.device === device).revoked_at = Date.now(); return { revoked: true }; });
  kernel.on("service:link", "gateway.status", () => state.relay);
  kernel.on("service:link", "gateway.use", ({ url }) => { state.relay = { configured: true, url, claimed: true, connected: true }; return { url }; });
  kernel.on("body:main", "workspace.read", ({ path }) => state.files.has(path) ? { path, text: state.files.get(path), offset: 1, next_offset: 2, truncated: false } : { ok: false, error: { code: "not_found", message: "no such file" } });
  kernel.on("body:main", "workspace.write", ({ path, content }) => { state.files.set(path, content); return { path, bytes: content.length }; });
  kernel.on("service:persona", "get", ({ file }) => ({ files: [{ file, content: file === "IDENTITY.md" ? "- 名字：小岛\n" : "# 灵魂\n", version: "v1" }] }));
  kernel.on("service:persona", "propose", () => ({ proposed: true, applied: true }));
  return state;
}
const openSettings = async (page) => { await page.locator("#menu").click(); await page.locator("#settingsHome").waitFor(); };
const sent = (kernel, to, word) => kernel.requests.filter((r) => r.to === to && r.word === word);

test(...withBrowser("pause is at once; resume needs a second, explicit tap", async ({ kernel, browser }) => {
  const hub = settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  await page.locator("#settingsPause").click();
  await page.locator("#settingsFeedback", { hasText: "已暂停" }).waitFor();
  assert.equal(hub.paused, true);
  await page.locator("#settingsResume").click();
  assert.equal(sent(kernel, "service:admin", "resume").length, 0, "one tap only asks");
  await page.locator("#settingsResumeYes").click();
  await page.locator("#settingsFeedback", { hasText: "已恢复" }).waitFor();
  assert.deepEqual(sent(kernel, "service:admin", "resume")[0].body, { confirmed: true });
  assert.equal(hub.paused, false);
}));

test(...withBrowser("quiet hours and the approval mode are saved by their own words and read back", async ({ kernel, browser }) => {
  const hub = settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  await page.locator("#settingsQuietRow").click();
  await page.locator("#settingsQuietStart").fill("22:00");
  await page.locator("#settingsQuietEnd").fill("08:30");
  await page.locator("#settingsQuietSave").click();
  await page.locator("#settingsQuietStatus", { hasText: "已保存" }).waitFor();
  assert.equal(hub.settings["delivery.quiet_hours"], "22:00-08:30");
  await page.locator("#settingsQuietBack").click();
  await page.locator("#settingsApprovalRow").click();
  await page.locator("#settingsApproval_always").click();
  await page.locator("#settingsApprovalStatus", { hasText: "已保存" }).waitFor();
  assert.equal(hub.mode, "always");
  assert.deepEqual(sent(kernel, "service:gate", "mode.set")[0].body, { mode: "always" });
}));

test(...withBrowser("the developer page changes the main model and switches a plugin", async ({ kernel, browser }) => {
  const hub = settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  await page.locator("#settingsDevRow").click();
  await page.locator("#settingsModelName").fill("deepseek-reasoner");
  await page.locator("#settingsModelProvider").fill("deepseek");
  await page.locator("#settingsModelSave").click();
  await page.locator("#settingsModelStatus", { hasText: "已保存" }).waitFor();
  assert.equal(hub.model, "deepseek-reasoner");
  await page.locator('[data-plugin-id="p1"]').getByRole("button", { name: "停用" }).click();
  await eventually(() => hub.plugins[0].enabled === false, "plugin off");
  assert.deepEqual(sent(kernel, "service:admin", "plugins.op")[0].body, { op: "plugin", id: "p1", enabled: false });
}));

test(...withBrowser("a key is saved and removed through the vault words; its text never comes back to the page", async ({ kernel, browser }) => {
  const hub = settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  await page.locator("#settingsVaultRow").click();
  await page.locator("#settingsVault_DEEPSEEK_API_KEY_value").fill("sk-test-secret-value");
  await page.locator("#settingsVault_DEEPSEEK_API_KEY").getByRole("button", { name: "保存" }).click();
  await page.locator("#settingsVault_DEEPSEEK_API_KEY_status", { hasText: "已保存" }).waitFor();
  assert.equal(hub.vault.has("DEEPSEEK_API_KEY"), true);
  assert.equal(await page.locator("#settingsVault_DEEPSEEK_API_KEY_value").inputValue(), "");
  const remove = page.locator("#settingsVault_DEEPSEEK_API_KEY").getByRole("button", { name: "移除" });
  await remove.click();
  await remove.click();
  await eventually(() => !hub.vault.has("DEEPSEEK_API_KEY"), "key removed");
  assert.equal((await page.content()).includes("sk-test-secret-value"), false, "the page does not keep the key");
}));

test(...withBrowser("devices: a pairing code is shown to the owner only, a request is approved, a device is removed", async ({ kernel, browser }) => {
  const hub = settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  await page.locator("#settingsGatewayRow").click();
  await page.locator("#settingsGatewayPair").click();
  await page.locator("#settingsGatewayPairCodeText", { hasText: "ABCD-1234" }).waitFor();
  assert.match(await page.locator("#settingsGatewayPairCommand").textContent(), /^https:\/\/relay\.example\/p\/ABCD-1234$/);
  assert.deepEqual(sent(kernel, "service:devices", "pair_start")[0].body.kind, "computer");
  // the new computer asked to join: the page notices on its poll and offers approve / reject
  hub.pairs = [{ pair_id: "pair1", state: "requested", kind: "computer", name: "我的电脑" }];
  await page.locator("#settingsPending-pair1Approve").waitFor({ timeout: 8000 });
  await page.locator("#settingsPending-pair1Approve").click();
  const device = "device:" + "N".repeat(22);
  const revoke = page.locator(`[id="settingsDevice-${device}Revoke"]`);
  await revoke.waitFor();
  assert.deepEqual(Object.keys(sent(kernel, "service:devices", "pair_approve")[0].body).sort(), ["body", "lend", "local_agents", "pair_id", "tier", "web_ui"]);
  await revoke.click();
  await revoke.click();
  await page.locator(`[id="settingsDevice-${device}Restore"]`).waitFor();
  assert.equal(sent(kernel, "service:devices", "revoke")[0].body.device, device);
}));

test(...withBrowser("the relay: an existing one is used by address", async ({ kernel, browser }) => {
  const hub = settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  await page.locator("#settingsGatewayRow").click();
  await page.locator("#settingsGatewayUrl").fill("https://relay.example");
  await page.locator("#settingsGatewayUse").click();
  await eventually(() => hub.relay.configured, "relay set");
  assert.deepEqual(sent(kernel, "service:link", "gateway.use")[0].body, { url: "https://relay.example" });
}));

test(...withBrowser("apps are installed and stopped with the apps words", async ({ kernel, browser }) => {
  settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  await page.locator("#settingsAppsRow").click();
  const card = page.locator('[data-app-id="weather"]');
  await card.getByRole("button", { name: "安装" }).click();
  await card.getByRole("button", { name: "确认安装" }).click();
  await card.locator("[data-app-state]", { hasText: "已启用" }).waitFor();
  await card.getByRole("button", { name: "停用" }).click();
  await card.locator("[data-app-state]", { hasText: "已停用" }).waitFor();
  assert.deepEqual(kernel.requests.filter((r) => r.to === "service:apps" && r.word !== "apps.list").map((r) => r.word), ["apps.install", "apps.disable"]);
}));

test(...withBrowser("usage is shown from the cost service", async ({ kernel, browser }) => {
  settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  await page.locator("#settingsUsageCard").click();
  await page.locator("#settingsUsageTable").getByText("今天").waitFor();
  await page.locator("#settingsUsageTable").getByText("service:reflex").waitFor();
  await page.locator("#settingsUsageBalance", { hasText: "12.5" }).waitFor();
  assert.equal(sent(kernel, "service:cost", "usage.get")[0].body.days, 7);
}));

test(...withBrowser("proactive preferences are a file in the body: saved, read back, and kept after a reload", async ({ kernel, browser }) => {
  const hub = settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  await page.locator("#settingsProactiveRow").click();
  await page.locator("#settingsProactiveText").fill("早上 9 点前别找我");
  await page.locator("#settingsProactiveSave").click();
  await page.locator("#settingsProactive .set-status", { hasText: "已保存" }).waitFor();
  assert.equal(hub.files.get("PROACTIVE.md"), "早上 9 点前别找我");
  await page.reload();
  await page.locator("#connection", { hasText: "已连接" }).waitFor();
  await openSettings(page);
  await page.locator("#settingsProactiveRow").click();
  await eventually(async () => (await page.locator("#settingsProactiveText").inputValue()) === "早上 9 点前别找我", "saved text");
}));

test(...withBrowser("the memory page edits USER.md on the body, and refuses to overwrite a file that changed meanwhile", async ({ kernel, browser }) => {
  const hub = settingsHub(kernel);
  hub.files.set("USER.md", "喜欢喝茶");
  const { page } = await openPage(browser, kernel);
  await page.locator("#presence").click();
  await page.locator('#agentTabs [data-tab="memory"]').click();
  const memory = page.locator('#agentPanel section[data-tab="memory"]');
  await memory.getByText("喜欢喝茶").waitFor();
  assert.equal(await memory.getByText(/历史|回滚|恢复/).count(), 0, "memory has no history or rollback");
  await memory.getByRole("button", { name: "编辑" }).click();
  await memory.locator("textarea").fill("喜欢喝茶，不喝咖啡");
  hub.files.set("USER.md", "别处改过了");
  await memory.getByRole("button", { name: "保存" }).click();
  await memory.getByText(/刚在别处改过/).waitFor();
  assert.equal(hub.files.get("USER.md"), "别处改过了", "nothing was overwritten");
  assert.equal(await memory.locator("textarea").inputValue(), "喜欢喝茶，不喝咖啡", "the owner's draft is kept");
  assert.equal(kernel.requests.filter((r) => r.word === "workspace.write").length, 0);
}));

test(...withBrowser("the identity page saves SOUL through persona/propose", async ({ kernel, browser }) => {
  settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await page.locator("#presence").click();
  const identity = page.locator('#agentPanel section[data-tab="identity"]');
  await identity.getByRole("button", { name: "编辑" }).click();
  await identity.locator("textarea").fill("# 新的灵魂\n温柔一点");
  await identity.getByRole("button", { name: "保存" }).click();
  const proposal = await requested(kernel, (r) => r.word === "propose");
  assert.deepEqual([proposal.to, proposal.body.file, proposal.body.content], ["service:persona", "SOUL.md", "# 新的灵魂\n温柔一点"]);
}));

test(...withBrowser("a page that is not on the hub's machine gets the drawer, a hint, and the hub's refusal of the local-only words", async ({ kernel, browser }) => {
  settingsHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openSettings(page);
  assert.match(await page.locator("#settingsHome").textContent(), /只能在 Ash 所在的手机上操作/);
  await page.locator("#settingsQuietRow").click();
  await page.locator("#settingsQuietSave").click();
  await page.locator("#settingsQuietStatus", { hasText: "已保存" }).waitFor();
  await page.locator("#settingsQuietBack").click();
  await page.locator("#settingsPause").click();
  await page.locator("#settingsFeedback", { hasText: "未确认" }).waitFor();
}, { local: false }));
