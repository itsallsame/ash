import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { balanceSentence, deviceDiagnosis, relayText, renderUsage, setupText, SettingsControls } from "../js/settings.js";
import { startKernel } from "./kernel.js";
import { connect, FakeElement, until } from "./support.js";

const fail = (code, message = code) => ({ ok: false, error: { code, message } });
const dev = (letter) => `device:${letter.repeat(22)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The settings drawer on a real Net connected to the test kernel; `setup(kernel)` scripts the hub's answers. */
async function drawer({ local = true, setup } = {}) {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  const kernel = startKernel({ local });
  setup?.(kernel);
  const { net } = await connect(kernel);
  const panel = new FakeElement("div");
  const settings = new SettingsControls(panel, net);
  settings.network("online");
  settings.connected();
  const sent = (member, word) => kernel.requests.filter((request) => request.to === member && (word === undefined || request.word === word));
  const close = () => { settings.reset(); delete globalThis.document; delete globalThis.location; net.stop(); kernel.close(); };
  return { kernel, net, panel, settings, sent, close };
}

/** A net with no hub behind it, for the parts of the drawer that never speak. */
function stubNet({ local = true } = {}) {
  const state = { generation: 1 };
  return { local, session: "s1", binding: () => ({ session: "s1", generation: state.generation }), same: (binding) => binding.generation === state.generation,
    call: async () => fail("not_found", "stub"), state };
}

test("the drawer is drawn whenever connected; from a page away from the hub the hub refuses the local-only words and the page says so", async () => {
  const remote = await drawer({ local: false });
  try {
    assert.equal(remote.net.local, false);
    assert.ok(remote.panel.find("settingsAdmin"), "the page does not hide the drawer by itself");
    assert.match(remote.panel.text, /只能在 Ash 所在的手机上操作/);
    remote.panel.find("settingsPause").click();
    await until(() => /未确认/.test(remote.panel.find("settingsFeedback").textContent));
    assert.equal(remote.sent("service:admin", "pause").length, 1, "the word was sent; the hub said no");
  } finally { remote.close(); }
  const local = await drawer();
  try {
    assert.ok(local.panel.find("settingsAdmin"));
    const first = local.panel.find("settingsAdmin");
    local.settings.connected();
    assert.equal(local.panel.find("settingsAdmin"), first, "the same connection keeps the same drawer");
    local.settings.network("offline");
    assert.equal(local.panel.find("settingsAdmin"), undefined);
    local.settings.network("online");
    assert.ok(local.panel.find("settingsAdmin"));
  } finally { local.close(); }
});

test("a new connection draws the drawer afresh and an old section's late answers are dropped", async () => {
  let release;
  const f = await drawer({ setup: (kernel) => kernel.on("service:admin", "settings.get", () => new Promise((resolve) => { release = () => resolve({ settings: { "delivery.quiet_hours": "05:00-06:00" } }); })) });
  try {
    const old = f.panel.find("settingsAdmin");
    f.panel.find("settingsQuietRow").click();
    await until(() => release);
    const generation = f.net.generation;
    f.kernel.drop();
    await until(() => f.net.generation >= generation + 2 && f.net.status === "online", 3000, "the connection to come back");
    f.settings.network("online");
    f.settings.connected();
    assert.notEqual(f.panel.find("settingsAdmin"), old);
    release();
    await sleep(50);
    assert.equal(f.panel.find("settingsQuietRow").sub.textContent, "这段时间不主动找你", "the new drawer was not touched by the old answer");
  } finally { f.close(); }
});

test("resume requires a second explicit tap and never labels an unconfirmed result as success", async () => {
  let answer = fail("failed", "refused");
  const f = await drawer({ setup: (kernel) => kernel.on("service:admin", "resume", () => answer) });
  try {
    f.panel.find("settingsResume").click();
    assert.equal(f.sent("service:admin", "resume").length, 0);
    assert.equal(f.panel.find("settingsResumeConfirmation").hidden, false);
    f.panel.find("settingsResumeYes").click();
    await until(() => /未确认/.test(f.panel.find("settingsFeedback").textContent));
    assert.equal(f.sent("service:admin", "resume").length, 1);
    assert.deepEqual(f.sent("service:admin", "resume")[0].body, { confirmed: true });
    answer = { paused: false };
    f.panel.find("settingsResume").click();
    f.panel.find("settingsResumeYes").click();
    await until(() => f.panel.find("settingsFeedback").textContent === "已恢复 Ash");
    assert.equal(f.panel.find("settingsResume").hidden, true);
  } finally { f.close(); }
});

test("a resume whose answer was lost is sent again as the same request", async () => {
  const f = await drawer({ setup: (kernel) => kernel.on("service:admin", "resume", fail("unavailable", "later")) });
  try {
    const resume = async () => { f.panel.find("settingsFeedback").textContent = ""; f.panel.find("settingsResume").click(); f.panel.find("settingsResumeYes").click(); await until(() => /未确认/.test(f.panel.find("settingsFeedback").textContent)); };
    await resume();
    await resume();
    const ids = f.sent("service:admin", "resume").map((r) => r.client_id);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
  } finally { f.close(); }
});

test("a resume the hub refused for good retires its request id", async () => {
  const f = await drawer({ setup: (kernel) => kernel.on("service:admin", "resume", fail("denied", "no")) });
  try {
    const resume = async () => { f.panel.find("settingsFeedback").textContent = ""; f.panel.find("settingsResume").click(); f.panel.find("settingsResumeYes").click(); await until(() => /未确认/.test(f.panel.find("settingsFeedback").textContent)); };
    await resume();
    await resume();
    const ids = f.sent("service:admin", "resume").map((r) => r.client_id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  } finally { f.close(); }
});

test("quiet hours load from and save to delivery.quiet_hours, a missing key means the default, an empty one means none", async () => {
  const store = {};
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:admin", "settings.get", (body) => ({ settings: Object.fromEntries(body.keys.filter((key) => key in store).map((key) => [key, store[key]])) }));
    kernel.on("service:admin", "settings.set", (body) => { Object.assign(store, body); return body; });
  } });
  try {
    f.panel.find("settingsQuietRow").click();
    await until(() => f.panel.find("settingsQuietRow").sub.textContent === "每天 21:30 到 09:00 不主动找你");
    assert.equal(f.panel.find("settingsQuietStart").value, "21:30");
    assert.deepEqual(f.sent("service:admin", "settings.get")[0].body, { keys: ["delivery.quiet_hours"] });
    f.panel.find("settingsQuietStart").value = "23:00";
    f.panel.find("settingsQuietEnd").value = "08:00";
    f.panel.find("settingsQuietSave").click();
    await until(() => f.panel.find("settingsQuietStatus").textContent === "已保存免打扰时段。");
    assert.deepEqual(f.sent("service:admin", "settings.set")[0].body, { "delivery.quiet_hours": "23:00-08:00" });
    assert.equal(store["delivery.quiet_hours"], "23:00-08:00");
    assert.equal(f.panel.find("settingsQuietRow").sub.textContent, "每天 23:00 到 08:00 不主动找你");
    f.panel.find("settingsQuietOff").click();
    await until(() => f.panel.find("settingsQuietStatus").textContent === "已关闭免打扰。");
    assert.equal(store["delivery.quiet_hours"], "");
    assert.equal(f.panel.find("settingsQuietRow").sub.textContent, "没有设置免打扰");
    f.panel.find("settingsQuietStart").value = "";
    f.panel.find("settingsQuietSave").click();
    await until(() => f.panel.find("settingsQuietStatus").textContent === "保存未确认，请重试。");
    assert.equal(f.sent("service:admin", "settings.set").length, 2, "an unusable time is not sent");
  } finally { f.close(); }
});

test("the approval page shows the two modes, saves a choice only after the hub echoes it, and the row says which is on", async () => {
  let mode = "auto", echo = true;
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:gate", "rules.list", () => ({ rules: [], mode }));
    kernel.on("service:gate", "mode.set", (body) => { if (echo) mode = body.mode; return { mode: echo ? body.mode : "auto" }; });
  } });
  try {
    f.panel.find("settingsApprovalRow").click();
    await until(() => f.panel.find("settingsApproval_auto").children[1].textContent === "✓");
    assert.equal(f.panel.find("settingsApproval_always").children[1].textContent, "");
    assert.match(f.panel.find("settingsApproval_auto").children[0].children[1].textContent, /先问你/);
    f.panel.find("settingsApproval_always").click();
    await until(() => f.panel.find("settingsApprovalStatus").textContent === "已保存。");
    assert.deepEqual(f.sent("service:gate", "mode.set").map((request) => request.body), [{ mode: "always" }]);
    assert.equal(f.panel.find("settingsApproval_always").children[1].textContent, "✓");
    assert.equal(f.panel.find("settingsApprovalRow").sub.textContent, "每次都问");
    echo = false;
    f.panel.find("settingsApproval_always").click();
    await until(() => f.panel.find("settingsApprovalStatus").textContent === "保存未确认，请重试。");
  } finally { f.close(); }
});

test("developer options switch a DSH plugin and refresh its actual state", async () => {
  let enabled = false;
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:admin", "plugins.list", () => ({ plugins: [{ entryId: "include:sample", moduleName: "sample", enabled }, { entryId: "builtin:core", moduleName: "core", enabled: true, readOnlyReason: "built in" }] }));
    kernel.on("service:admin", "plugins.op", (body) => { enabled = body.enabled; return { application: "applied", changed: true }; });
    kernel.on("service:agents", "list", { agents: [{ id: "agent:main", primary: true, runtime: { kind: "dsh", model: "deepseek-chat" } }] });
  } });
  try {
    f.panel.find("settingsDevRow").click();
    const row = () => f.panel.find("settingsPluginsList").children[0];
    await until(() => row());
    const state = () => row().children[0].children.map((item) => item.textContent).join(" · ");
    assert.equal(state(), "sample · 已停用");
    assert.equal(f.panel.find("settingsPluginsList").children[1].children.length, 1, "a read-only plugin has no switch");
    row().children[1].click();
    await until(() => state() === "sample · 已启用");
    assert.deepEqual(f.sent("service:admin", "plugins.op").map((request) => request.body), [{ op: "plugin", id: "include:sample", enabled: true }]);
    assert.equal(f.panel.find("settingsPluginsStatus").textContent, "已更新插件。");
  } finally { f.close(); }
});

test("developer options show the primary agent's model and save a new one, saying when a restart is needed", async () => {
  let restart = true;
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:agents", "list", { agents: [{ id: "agent:other", runtime: { kind: "x", model: "other" } }, { id: "agent:main", primary: true, runtime: { kind: "dsh", model: "deepseek-chat" } }] });
    kernel.on("service:admin", "plugins.list", { plugins: [] });
    kernel.on("service:admin", "model.set", (body) => ({ ...body, restart_required: restart }));
  } });
  try {
    f.panel.find("settingsDevRow").click();
    await until(() => f.panel.find("settingsModelName").value === "deepseek-chat");
    assert.equal(f.panel.find("settingsModelProvider").value, "", "the provider is not known to the page, so it is not guessed");
    f.panel.find("settingsModelName").value = "deepseek-reasoner";
    f.panel.find("settingsModelSave").click();
    assert.equal(f.sent("service:admin", "model.set").length, 0);
    await until(() => f.panel.find("settingsModelStatus").textContent === "Provider 和 Model 都要填。");
    f.panel.find("settingsModelProvider").value = "deepseek";
    f.panel.find("settingsModelSave").click();
    await until(() => /重启 Ash 后主模型生效/.test(f.panel.find("settingsModelStatus").textContent));
    assert.deepEqual(f.sent("service:admin", "model.set").map((request) => request.body), [{ provider: "deepseek", model: "deepseek-reasoner" }]);
    restart = false;
    f.panel.find("settingsModelSave").click();
    await until(() => f.panel.find("settingsModelStatus").textContent === "已保存，下一条消息起就用它。");
  } finally { f.close(); }
});

/** The hub side of the devices page: a device list, the requests waiting, and the pairing in progress. */
function devicesHub(kernel, world) {
  kernel.on("service:devices", "list", () => ({ devices: world.devices }));
  kernel.on("service:devices", "pair_pending", () => ({ pairs: world.pairs }));
  kernel.on("service:devices", "pair_start", (body) => { world.started = body; return { pair_id: "pair-1", expires_at: world.expires }; });
  kernel.on("service:devices", "pair_code", () => ({ code: "pair-XYZ-123", url: "https://relay.example.test/p/pair-XYZ-123", expires_at: world.expires }));
  kernel.on("service:devices", "pair_status", () => ({ pair_id: "pair-1", state: world.state }));
  kernel.on("service:devices", "pair_approve", (body) => {
    world.pairs = world.pairs.filter((pair) => pair.pair_id !== body.pair_id);
    world.devices.push({ device: dev("N"), name: "New", kind: "computer", online: true, tier: body.tier, lend: body.lend, body: body.body, local_agents: body.local_agents, web_ui: body.web_ui });
    world.state = "approved";
    return { pair_id: body.pair_id, state: "approved" };
  });
  kernel.on("service:devices", "revoke", (body) => { world.devices = world.devices.filter((device) => device.device !== body.device); return { revoked: true }; });
  kernel.on("service:devices", "rename", (body) => { world.devices.find((device) => device.device === body.device).name = body.name; return body; });
  kernel.on("service:devices", "access_set", (body) => { Object.assign(world.devices.find((device) => device.device === body.device), body); return {}; });
  kernel.on("service:devices", "restore", (body) => { delete world.devices.find((device) => device.device === body.device).revoked_at; return { restored: true }; });
}

test("the devices page lists devices, approves a request with the chosen permissions, and removes a device after a second tap", async () => {
  const world = { devices: [{ device: dev("L"), name: "Laptop", kind: "computer", online: true, tier: "ask", lend: true, via: "gateway" },
    { device: dev("B"), name: "Old tablet", kind: "browser", online: false, last_seen: new Date(2026, 9, 9, 18, 5).getTime(), revoked_at: 1 }],
  pairs: [{ pair_id: "pair-9", state: "requested", name: "MacBook", kind: "computer", expires_at: 1 }, { pair_id: "pair-8", state: "waiting", kind: "server", expires_at: 1 }] };
  const f = await drawer({ setup: (kernel) => devicesHub(kernel, world) });
  try {
    f.panel.find("settingsGatewayRow").click();
    await until(() => f.panel.find("settingsGatewayList").children.length === 3);
    const list = f.panel.find("settingsGatewayList");
    const subtitle = (index) => list.children[index].children[0].children[1].textContent;
    assert.match(subtitle(0), /^等你批准 · 电脑/);
    assert.equal(subtitle(1), "电脑 · 在线 · 经中转站 · 按规则审批");
    assert.equal(subtitle(2), "浏览器 · 已移除，连不上了");
    assert.equal(f.panel.find("settingsPending-pair-9Approve") !== undefined, true);
    assert.equal(f.panel.find("settingsPending-pair-8Approve"), undefined, "a code that nobody used yet is not a request");
    f.panel.find("settingsPending-pair-9Lend").checked = false;
    f.panel.find("settingsPending-pair-9Body").checked = true;
    f.panel.find("settingsPending-pair-9Access").value = "full";
    f.panel.find("settingsPending-pair-9Approve").click();
    await until(() => f.sent("service:devices", "pair_approve").length === 1);
    assert.deepEqual(f.sent("service:devices", "pair_approve")[0].body, { pair_id: "pair-9", tier: "full", lend: false, body: true, local_agents: false, web_ui: false });
    await until(() => list.children.length === 3 && list.children.some((row) => row.children[0].children[0].textContent === "New"));
    const revoke = f.panel.find(`settingsDevice-${dev("L")}Revoke`);
    revoke.click();
    await sleep(30);
    assert.equal(f.sent("service:devices", "revoke").length, 0, "one tap only says what removing does");
    assert.match(f.panel.find("settingsGatewayStatus").textContent, /重新配对/);
    revoke.click();
    await until(() => f.sent("service:devices", "revoke").length === 1);
    assert.deepEqual(f.sent("service:devices", "revoke")[0].body, { device: dev("L") });
    await until(() => !f.panel.find(`settingsDevice-${dev("L")}Revoke`));
    f.panel.find(`settingsDevice-${dev("B")}Restore`).click();
    await until(() => f.sent("service:devices", "restore").length === 1);
    assert.deepEqual(f.sent("service:devices", "restore")[0].body, { device: dev("B") });
  } finally { f.close(); }
});

test("a device can be renamed, given other permissions, and diagnosed in plain words", async () => {
  const world = { devices: [{ device: dev("L"), name: "Laptop", kind: "computer", online: false, tier: "ask", lend: true, via: "local", last_seen: new Date(2026, 9, 9, 18, 5).getTime() }], pairs: [] };
  const f = await drawer({ setup: (kernel) => {
    devicesHub(kernel, world);
    // The data itself has an `ok`, so it is given as a whole reply.
    kernel.on("service:link", "diagnose", { ok: true, result: { data: { ok: false, findings: [{ code: "heartbeat", message: "它已经三分钟没有回应心跳。" }] } } });
    kernel.on("service:link", "list", { connections: [{ conn: "c1", hand: "L".repeat(22) }, { conn: "c2", hand: "other".padEnd(22, "x") }] });
  } });
  try {
    f.panel.find("settingsGatewayRow").click();
    await until(() => f.panel.find("settingsGatewayList").children.length === 1);
    const details = f.panel.find("settingsGatewayList").children[0].children.find((child) => child.tag === "details");
    const input = details.children.find((child) => child.tag === "input");
    const buttons = (label) => details.children.find((child) => child.textContent === label);
    input.value = "  Work laptop ";
    buttons("保存名称").click();
    await until(() => f.sent("service:devices", "rename").length === 1);
    assert.deepEqual(f.sent("service:devices", "rename")[0].body, { device: dev("L"), name: "Work laptop" });
    await until(() => f.panel.find("settingsGatewayList").children[0].children[0].children[0].textContent === "Work laptop");
    const oldWeb = f.panel.find(`settingsDevice-${dev("L")}Web`);
    f.panel.find(`settingsDevice-${dev("L")}Access`).value = "full";
    oldWeb.checked = true;
    f.panel.find("settingsGatewayList").children[0].all().find((item) => item.textContent === "保存权限").click();
    await until(() => f.sent("service:devices", "access_set").length === 1);
    assert.deepEqual(f.sent("service:devices", "access_set")[0].body, { device: dev("L"), tier: "full", lend: true, body: false, local_agents: false, web_ui: true });
    await until(() => f.panel.find(`settingsDevice-${dev("L")}Web`) !== oldWeb, 2000, "the list to be drawn again");
    assert.equal(f.panel.find(`settingsDevice-${dev("L")}Web`).checked, true, "the saved permission is what the hub now reports");
    const info = f.panel.find("settingsGatewayList").children[0].all().find((item) => item.className === "set-status" && item.tag === "pre");
    f.panel.find("settingsGatewayList").children[0].all().find((item) => item.textContent === "诊断").click();
    await until(() => /心跳/.test(info.textContent));
    assert.deepEqual(f.sent("service:link", "diagnose")[0].body, { hand: "L".repeat(22) });
    assert.equal(info.textContent, "离线（和这台手机直连）。\n上次在线：10月9日 18:05。\n现在有 1 条连接。\n发现这些问题：\n· 它已经三分钟没有回应心跳。");
  } finally { f.close(); }
});

test("a browser device can only be given the chat and page", async () => {
  const world = { devices: [], pairs: [{ pair_id: "pair-b", state: "requested", name: "Chrome", kind: "browser", expires_at: 1 }] };
  const f = await drawer({ setup: (kernel) => devicesHub(kernel, world) });
  try {
    f.panel.find("settingsGatewayRow").click();
    await until(() => f.panel.find("settingsPending-pair-bApprove"));
    assert.equal(f.panel.find("settingsPending-pair-bLend").disabled, true);
    assert.equal(f.panel.find("settingsPending-pair-bWeb").checked, true);
    f.panel.find("settingsPending-pair-bApprove").click();
    await until(() => f.sent("service:devices", "pair_approve").length === 1);
    assert.deepEqual(f.sent("service:devices", "pair_approve")[0].body, { pair_id: "pair-b", tier: "ask", lend: false, body: false, local_agents: false, web_ui: true });
  } finally { f.close(); }
});

test("the pairing code is shown only on the page, with the install address, and goes away once the request is handled", async () => {
  const copied = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
  const world = { devices: [], pairs: [], state: "waiting", expires: Date.now() + 299_000 };
  const f = await drawer({ setup: (kernel) => devicesHub(kernel, world) });
  try {
    f.panel.find("settingsGatewayRow").click();
    await until(() => /还没有连接其他设备/.test(f.panel.find("settingsGatewayStatus").textContent));
    assert.equal(f.panel.find("settingsGatewayPairCode").hidden, true);
    // No code: no empty box holding only a copy button, and the page's styles really hide a hidden card.
    assert.equal(f.panel.find("settingsGatewayPairCopy").hidden, true);
    assert.match(readFileSync(new URL("../index.html", import.meta.url), "utf8"), /[,}]\.set-card\[hidden\][,{][^}]*display:none/);
    f.panel.find("settingsGatewayPair").click();
    await until(() => f.panel.find("settingsGatewayPairCode").hidden === false);
    assert.deepEqual(world.started, { kind: "computer" });
    assert.deepEqual(f.sent("service:devices", "pair_code").map((request) => request.body), [{ pair_id: "pair-1" }]);
    const shown = f.panel.find("settingsGatewayPairCodeText").textContent;
    assert.match(shown, /pair-XYZ-123/);
    assert.match(shown, /还剩 [45]:\d\d/);
    assert.match(shown, /浏览器打开下面的地址/);
    assert.equal(f.panel.find("settingsGatewayPairCommand").textContent, "https://relay.example.test/p/pair-XYZ-123");
    assert.doesNotMatch(JSON.stringify(f.kernel.ledger), /pair-XYZ-123/, "no message of the ledger carries the code");
    f.panel.find("settingsGatewayPairCopy").click();
    await until(() => copied.length === 1);
    assert.deepEqual(copied, ["https://relay.example.test/p/pair-XYZ-123"]);
    assert.equal(f.panel.find("settingsGatewayPairCopy").textContent, "已复制");
    // A computer used the code: the page notices by itself, shows the request and no longer shows the code.
    world.pairs = [{ pair_id: "pair-1", state: "requested", name: "MacBookPro", kind: "computer", expires_at: world.expires }];
    world.state = "requested";
    await until(() => /已使用/.test(f.panel.find("settingsGatewayPairCodeText").textContent), 6000, "the request to show");
    assert.doesNotMatch(f.panel.find("settingsGatewayPairCodeText").textContent, /pair-XYZ-123/);
    assert.equal(f.panel.find("settingsGatewayPairCommand").hidden, true);
    await until(() => f.panel.find("settingsPending-pair-1Approve"));
    assert.equal(f.panel.find("settingsGatewayPairCode").hidden, false);
    f.panel.find("settingsPending-pair-1Approve").click();
    await until(() => f.panel.find("settingsGatewayPairCode").hidden === true, 6000, "the spent code to leave");
    assert.equal(f.panel.find("settingsGatewayList").children[0].children[0].children[0].textContent, "New");
    // The hub cannot make a code: say so, and show no box.
    f.kernel.on("service:devices", "pair_start", fail("unavailable", "no relay"));
    f.panel.find("settingsGatewayPair").click();
    await until(() => /生成失败/.test(f.panel.find("settingsGatewayPairResult").textContent));
    assert.equal(f.panel.find("settingsGatewayPairCode").hidden, true);
  } finally { delete globalThis.navigator.clipboard; f.close(); }
});

test("the relay status reads in words, an address can be used, and a Cloudflare setup is walked through", async () => {
  let status = { configured: false, connected: false };
  let setup = { setup_id: "setup-1", state: "waiting_login" };
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:devices", "list", { devices: [] });
    kernel.on("service:devices", "pair_pending", { pairs: [] });
    kernel.on("service:link", "gateway.status", () => status);
    kernel.on("service:link", "gateway.use", (body) => { status = { configured: true, connected: false, url: body.url, last_error: "unreachable" }; return { url: body.url }; });
    kernel.on("service:link", "gateway.setup.start", () => setup);
    kernel.on("service:link", "gateway.setup.status", () => setup);
    kernel.on("service:link", "gateway.setup.deploy", (body) => { setup = { setup_id: body.setup_id, state: "deploying" }; return setup; });
    kernel.on("service:link", "gateway.setup.cancel", (body) => { setup = { setup_id: body.setup_id, state: "failed", reason: "cancelled" }; return setup; });
  } });
  try {
    f.panel.find("settingsGatewayRow").click();
    await until(() => /还没有设置中转站/.test(f.panel.find("settingsRelayStatus").textContent));
    assert.equal(f.panel.find("settingsGatewaySecret"), undefined, "no claim secret is handled on this page any more");
    f.panel.find("settingsGatewayUse").click();
    await sleep(20);
    assert.equal(f.sent("service:link", "gateway.use").length, 0);
    f.panel.find("settingsGatewayUrl").value = " https://relay.example.test ";
    f.panel.find("settingsGatewayUse").click();
    await until(() => /已设置中转站/.test(f.panel.find("settingsGatewayConfigStatus").textContent));
    assert.deepEqual(f.sent("service:link", "gateway.use")[0].body, { url: "https://relay.example.test" });
    await until(() => /暂时连不上.*unreachable/.test(f.panel.find("settingsRelayStatus").textContent));
    f.panel.find("settingsGatewaySetup").click();
    await until(() => /等你在 Cloudflare 登录/.test(f.panel.find("settingsGatewaySetupState").textContent));
    assert.deepEqual(f.sent("service:link", "gateway.setup.start")[0].body, { provider: "cloudflare" });
    assert.equal(f.panel.find("settingsGatewaySetup").hidden, true);
    assert.equal(f.panel.find("settingsGatewayDeploy").hidden, true);
    setup = { setup_id: "setup-1", state: "authorized" };
    f.panel.find("settingsGatewaySetupCheck").click();
    await until(() => f.panel.find("settingsGatewayDeploy").hidden === false);
    f.panel.find("settingsGatewaySetupName").value = "ash-relay";
    f.panel.find("settingsGatewayDeploy").click();
    await until(() => /正在搭建/.test(f.panel.find("settingsGatewaySetupState").textContent));
    assert.deepEqual(f.sent("service:link", "gateway.setup.deploy")[0].body, { setup_id: "setup-1", name: "ash-relay" });
    const cancel = f.panel.find("settingsGatewaySetupCancel");
    cancel.click();
    await sleep(20);
    assert.equal(f.sent("service:link", "gateway.setup.cancel").length, 0, "giving up takes a second tap");
    cancel.click();
    await until(() => f.panel.find("settingsGatewaySetupState").textContent === "已放弃搭建。");
    assert.equal(f.panel.find("settingsGatewaySetup").hidden, false);
  } finally { f.close(); }
});

test("a Cloudflare setup that finishes refreshes the relay and the devices", async () => {
  let status = { configured: false, connected: false };
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:devices", "list", { devices: [] });
    kernel.on("service:devices", "pair_pending", { pairs: [] });
    kernel.on("service:link", "gateway.status", () => status);
    kernel.on("service:link", "gateway.setup.start", { setup_id: "s", state: "deploying" });
    kernel.on("service:link", "gateway.setup.status", () => { status = { configured: true, connected: true, url: "https://r.example.test", account_email: "me@example.test" }; return { setup_id: "s", state: "connected" }; });
  } });
  try {
    f.panel.find("settingsGatewayRow").click();
    await until(() => /还没有设置中转站/.test(f.panel.find("settingsRelayStatus").textContent));
    f.panel.find("settingsGatewaySetup").click();
    await until(() => f.panel.find("settingsGatewaySetupCheck").hidden === false);
    f.panel.find("settingsGatewaySetupCheck").click();
    await until(() => /中转站已连接（https:\/\/r.example.test），账号 me@example.test/.test(f.panel.find("settingsRelayStatus").textContent));
    assert.equal(f.panel.find("settingsGatewaySetupState").textContent, "中转站已搭好，也连上了。");
    assert.equal(f.panel.find("settingsGatewayUrl").value, "https://r.example.test");
  } finally { f.close(); }
});

test("Android settings clear every browser login only after a second tap", async () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.location = { origin: "https://appassets.androidplatform.net" };
  let cleared = 0, ok = true;
  globalThis.__ashBrowserLogins = async () => { cleared++; return { ok }; };
  try {
    const panel = new FakeElement("div");
    const settings = new SettingsControls(panel, stubNet());
    settings.network("online");
    const clear = panel.find("settingsBrowserClear");
    clear.click();
    await sleep(10);
    assert.equal(cleared, 0, "one tap only asks");
    assert.match(clear.textContent, /再点一次/);
    clear.click();
    await until(() => cleared === 1);
    await until(() => /已清除/.test(panel.find("settingsBrowserStatus").textContent));
    ok = false;
    clear.click(); clear.click();
    await until(() => cleared === 2);
    await until(() => /清除失败/.test(panel.find("settingsBrowserStatus").textContent));
  } finally { delete globalThis.document; delete globalThis.location; delete globalThis.__ashBrowserLogins; }
});

test("outside the Android app there is no browser-login control, and the old native gateway config is gone", () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  try {
    const panel = new FakeElement("div");
    const settings = new SettingsControls(panel, stubNet());
    settings.network("online");
    assert.equal(panel.find("settingsBrowserClear"), undefined);
    assert.equal(panel.find("settingsGatewaySave"), undefined);
    assert.doesNotMatch(readFileSync(new URL("../js/settings.js", import.meta.url), "utf8"), /__ashGatewayConfig|SCREEN_TOKEN_HEADER|localManagement|net\.request|\/api\//);
  } finally { delete globalThis.document; }
});

test("settings show usage by period and by caller, and an unreadable balance is not shown as zero", async () => {
  const zero = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0 };
  const summary = { estimated: true, periods: { today: { ...zero, calls: 3, cost_usd: 0.0042, input_tokens: 12000, unpriced_calls: 1 }, "7d": { ...zero, calls: 9, cost_usd: 1.5 }, "30d": zero },
    by_caller: [{ ...zero, caller: "agent:main", calls: 7, cost_usd: 1.2 }, { ...zero, caller: "service:reflex", calls: 2, cost_usd: 0.3 }] };
  let balance = fail("failed", "HTTP 401");
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:cost", "usage.get", summary);
    kernel.on("service:cost", "balance.get", () => balance);
  } });
  try {
    f.panel.find("settingsUsageCard").click();
    await until(() => f.panel.find("settingsUsageBalance").textContent);
    const table = f.panel.find("settingsUsageTable").children.flatMap((box) => box.children.at(-1).children.map((row) => row.text));
    assert.match(table[0], /^今天3 次调用 · 输入 12\.0k.*另有 1 次没有价格¥0\.03$/);
    assert.match(table[1], /^近 7 天9 次调用.*¥10\.11$/);
    assert.match(table[2], /¥0\.00$/);
    assert.ok(table.some((row) => /^Ash.*¥8\.09$/.test(row)) && table.some((row) => /^service:reflex.*¥2\.02$/.test(row)));
    assert.equal(f.panel.find("settingsUsageCard").children[1].textContent, "¥0.03");
    assert.deepEqual(f.sent("service:cost").map((request) => [request.word, request.body]).slice(-2), [["usage.get", { days: 7 }], ["balance.get", {}]]);
    assert.match(f.panel.find("settingsUsageBalance").textContent, /读不到（不是零）/);
    assert.match(f.panel.find("settingsUsageStatus").textContent, /估算/);
    assert.match(f.panel.find("settingsUsageStatus").textContent, /1 美元 ≈ 6\.74 元固定换算/);
    balance = { balances: [{ provider: "deepseek", at: 1, balance: { available: true, balances: [{ currency: "CNY", total: "12.30" }] } }], errors: { openrouter: "HTTP 401" } };
    f.panel.find("settingsUsageRefresh").click();
    await until(() => /^账户余额：DeepSeek ¥12\.30（OpenRouter 暂时读不到）$/.test(f.panel.find("settingsUsageBalance").textContent));
  } finally { f.close(); }
});

test("the vault section saves and removes keys through the vault words, clears the field, and shows only saved or not", async () => {
  const saved = new Set();
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:vault", "list", () => ({ entries: ["DEEPSEEK_API_KEY"].filter((ref) => saved.has(ref)).map((ref) => ({ ref, label: ref, kind: "model", configured: true })) }));
    kernel.on("service:vault", "set", (body) => { saved.add(body.ref); return { ref: body.ref, configured: true }; });
    kernel.on("service:vault", "delete", (body) => ({ deleted: saved.delete(body.ref) }));
  } });
  try {
    const status = () => f.panel.find("settingsVault_DEEPSEEK_API_KEY_status").textContent;
    f.panel.find("settingsVaultRow").click();
    await until(() => /还没有保存/.test(status()));
    assert.match(status(), /还没有保存.*无法对话/, "a key the hub does not list is simply not saved");
    const field = f.panel.find("settingsVault_DEEPSEEK_API_KEY_value");
    const actions = f.panel.find("settingsVault_DEEPSEEK_API_KEY").children.at(-1);
    field.value = "  sk-vault-test  ";
    actions.children.find((item) => item.textContent === "保存").click();
    await until(() => /^已保存/.test(status()));
    assert.equal(field.value, "");
    assert.deepEqual(f.sent("service:vault", "set")[0].body, { ref: "DEEPSEEK_API_KEY", value: "sk-vault-test", label: "DeepSeek Key", kind: "model" });
    assert.doesNotMatch(JSON.stringify(f.panel), /sk-vault-test/);
    const remove = actions.children.find((item) => item.textContent === "移除");
    assert.equal(remove.hidden, false);
    remove.click();
    assert.match(status(), /^移除后，Ash 无法对话/);
    assert.equal(f.sent("service:vault", "delete").length, 0, "one tap only says what removing does");
    remove.click();
    await until(() => /还没有保存/.test(status()));
    assert.deepEqual(f.sent("service:vault", "delete")[0].body, { ref: "DEEPSEEK_API_KEY" });
  } finally { f.close(); }
});

test("a locked secure storage is explained and cannot be changed from settings", async () => {
  const f = await drawer({ setup: (kernel) => kernel.on("service:vault", "list", fail("unavailable", "locked")) });
  try {
    f.panel.find("settingsVaultRow").click();
    const status = f.panel.find("settingsVault_DEEPSEEK_API_KEY_status");
    await until(() => /安全存储暂时不可用/.test(status.textContent));
    const field = f.panel.find("settingsVault_DEEPSEEK_API_KEY_value");
    const actions = f.panel.find("settingsVault_DEEPSEEK_API_KEY").children.at(-1);
    const save = actions.children.find((item) => item.textContent === "保存");
    const remove = actions.children.find((item) => item.textContent === "移除");
    assert.match(status.textContent, /原有密钥未被读取或修改/);
    assert.equal(field.disabled, true);
    assert.equal(save.disabled, true);
    assert.equal(remove.disabled, true);
    field.value = "sk-must-not-save";
    save.click(); remove.click();
    await sleep(30);
    assert.equal(f.sent("service:vault", "set").length + f.sent("service:vault", "delete").length, 0);
  } finally { f.close(); }
});

test("the vault locking when a save is refused as unavailable", async () => {
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:vault", "list", { entries: [] });
    kernel.on("service:vault", "set", fail("unavailable", "locked"));
  } });
  try {
    f.panel.find("settingsVaultRow").click();
    const status = f.panel.find("settingsVault_OPENROUTER_API_KEY_status");
    await until(() => /还没有保存/.test(status.textContent));
    f.panel.find("settingsVault_OPENROUTER_API_KEY_value").value = "sk-x";
    f.panel.find("settingsVault_OPENROUTER_API_KEY").children.at(-1).children.find((item) => item.textContent === "保存").click();
    await until(() => /安全存储暂时不可用/.test(status.textContent));
    assert.equal(f.panel.find("settingsVault_DEEPSEEK_API_KEY_value").disabled, true);
  } finally { f.close(); }
});

test("opening settings reads what each row should say: quiet hours, pause, keys, devices and today's spend", async () => {
  const zero = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0 };
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:admin", "status", { now: 1, paused: true });
    kernel.on("service:admin", "settings.get", { settings: { "delivery.quiet_hours": "22:00-07:30" } });
    kernel.on("service:gate", "rules.list", { rules: [], mode: "always" });
    kernel.on("service:cost", "usage.get", { periods: { today: { ...zero, cost_usd: 0.12 }, "7d": { ...zero, cost_usd: 1.5 }, "30d": { ...zero, cost_usd: 4 } }, by_caller: [] });
    kernel.on("service:vault", "list", { entries: [{ ref: "DEEPSEEK_API_KEY", label: "DeepSeek", kind: "model", configured: false }, { ref: "OPENROUTER_API_KEY", label: "OpenRouter", kind: "model", configured: true }] });
    kernel.on("service:devices", "list", { devices: [{ device: dev("A"), name: "A", online: true }, { device: dev("R"), name: "R", online: false, revoked_at: 5 }] });
    kernel.on("service:devices", "pair_pending", { pairs: [{ pair_id: "p", state: "requested", kind: "computer" }] });
    kernel.on("service:link", "gateway.status", { configured: true, connected: true, url: "https://r.example.test" });
    kernel.on("service:apps", "apps.list", { apps: [] });
  } });
  try {
    f.settings.opened();
    await until(() => f.panel.find("settingsUsageCard").children[1].textContent !== "—");
    await until(() => f.panel.find("settingsGatewayRow").sub.textContent.startsWith("1 台"));
    assert.equal(f.panel.find("settingsQuietRow").sub.textContent, "每天 22:00 到 07:30 不主动找你");
    assert.equal(f.panel.find("settingsPause").hidden, true);
    assert.equal(f.panel.find("settingsResume").hidden, false);
    assert.equal(f.panel.find("settingsApprovalRow").sub.textContent, "每次都问");
    assert.equal(f.panel.find("settingsVaultRow").sub.textContent, "DeepSeek Key 未设置 · OpenRouter Key 已保存");
    assert.equal(f.panel.find("settingsVaultRow").sub.className, "set-sub warn");
    assert.equal(f.panel.find("settingsGatewayRow").sub.textContent, "1 台设备 · 1 个等你批准");
    assert.equal(f.panel.find("settingsUsageCard").children[1].textContent, "¥0.81");
    f.settings.setName("小灰");
    assert.equal(f.panel.find("settingsPause").textContent, "暂停 小灰");
  } finally { f.close(); }
});

test("the gateway row says when the relay is missing or cannot be reached", async () => {
  let status = { configured: false, connected: false };
  const f = await drawer({ setup: (kernel) => {
    kernel.on("service:devices", "list", { devices: [] });
    kernel.on("service:devices", "pair_pending", { pairs: [] });
    kernel.on("service:link", "gateway.status", () => status);
  } });
  try {
    f.settings.opened();
    await until(() => f.panel.find("settingsGatewayRow").sub.textContent === "还没有设置中转站");
    status = { configured: true, connected: false, last_error: "unreachable" };
    f.settings.opened();
    await until(() => f.panel.find("settingsGatewayRow").sub.textContent === "中转站连不上，点开看原因");
    assert.equal(f.panel.find("settingsGatewayRow").sub.className, "set-sub warn");
  } finally { f.close(); }
});

test("re-opening the drawer starts at the settings root and takes back a half-done destructive tap", () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  globalThis.location = { origin: "https://appassets.androidplatform.net" };
  globalThis.__ashBrowserLogins = async () => ({ ok: true });
  FakeElement.prototype.querySelectorAll = function querySelectorAll(selector) { return selector === "[data-armed]" ? this.all().filter((item) => "data-armed" in item.attributes) : []; };
  try {
    const panel = new FakeElement("div");
    const settings = new SettingsControls(panel, stubNet());
    settings.network("online");
    panel.find("settingsBrowserRow").click();
    assert.equal(panel.find("settingsBrowser").hidden, false);
    assert.equal(panel.find("settingsHome").hidden, true);
    const clear = panel.find("settingsBrowserClear");
    clear.click();
    assert.match(clear.textContent, /再点一次/);
    settings.opened();
    assert.equal(panel.find("settingsHome").hidden, false);
    assert.equal(panel.find("settingsBrowser").hidden, true);
    assert.equal(clear.textContent, "清除浏览器里的所有登录");
  } finally {
    delete FakeElement.prototype.querySelectorAll;
    delete globalThis.document; delete globalThis.location; delete globalThis.__ashBrowserLogins;
  }
});

test("a device's diagnosis reads as plain words, not a raw record", () => {
  const device = { device: dev("P"), name: "PC", online: true, via: "gateway" };
  assert.equal(deviceDiagnosis({ device, connections: [{}, {}], diagnosis: { ok: true, findings: [] } }), "在线（经中转站）。\n现在有 2 条连接。\n没有发现问题。");
  assert.equal(deviceDiagnosis({ device, diagnosis: { ok: false, findings: [{ code: "a", message: "没有回应" }, { code: "b", message: "版本太旧" }] } }), "在线（经中转站）。\n发现这些问题：\n· 没有回应\n· 版本太旧");
  assert.doesNotMatch(deviceDiagnosis({}), /[{}"]|undefined/);
  assert.equal(deviceDiagnosis({}), "离线。");
});

test("the relay, the setup state and the balances read in plain words", () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  assert.equal(relayText({ configured: false, connected: false }), "还没有设置中转站，其他设备暂时连不上。");
  assert.equal(relayText({ configured: true, connected: true, url: "https://r.test" }), "中转站已连接（https://r.test）。");
  assert.match(relayText({ configured: true, connected: false, last_error: "timed out" }), /暂时连不上：timed out/);
  assert.equal(setupText(null), "");
  assert.match(setupText({ state: "failed", reason: "no account" }), /没有成功：no account/);
  assert.equal(balanceSentence({ balances: [] }), "账户余额：无数据");
  assert.equal(balanceSentence({ balances: [{ provider: "openrouter", balance: { available: false, balances: [{ currency: "USD", total: "3" }] } }] }), "账户余额：OpenRouter 约 ¥20.22（账户当前不可用）");
  try { assert.match(renderUsage({ periods: {}, by_caller: [] })[0].text, /今天0 次调用/); } finally { delete globalThis.document; }
});
