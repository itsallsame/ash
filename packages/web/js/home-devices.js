import { fill } from "./home-dom.js";
// The devices that connect to her: the list on 她的手和眼, one device's page (name, what it may do, diagnosis, removal), a request
// waiting for your approval, and the pairing of a new one with the relay it goes through.
import { deviceDiagnosis, handOf, KIND_NAMES, clock, relayText, setupText, SETUP_ACTIVE } from "./home-text.js";
import { readDevices } from "./home-data.js";
import { btn, card, group, h, list, localHint, note, row, skeleton, twoTap } from "./home-ui.js";
import { switchRow } from "./home-switch.js";

const KINDS = [["computer", "电脑"], ["server", "服务器"], ["browser", "浏览器"]];

/** What a device may do, as switches and a choice. [read()] is the body of `access_set` / `pair_approve`. */
function permissions(device, { browser = false, idPrefix = "dev" } = {}) {
  const tier = h("div", { class: "seg", role: "tablist" });
  let current = device.tier === "full" ? "full" : "ask";
  const drawTier = () => fill(tier, ...[["ask", "按规则和影响审批"], ["full", "完全放开"]].map(([key, label]) => btn(label, current === key ? "on" : "", () => { if (!browser) { current = key; drawTier(); } }, { role: "tab", "aria-selected": String(current === key), disabled: browser })));
  drawTier();
  const rows = [
    ["lend", "借出它的能力", "让她能用它", device.lend === true],
    ["body", "当作身体", "让她读写它的文件、执行命令", device.body === true],
    ["local_agents", "允许本地 Agent", "使用电脑本地完整权限", device.local_agents === true],
    ["web_ui", "允许访问聊天和网页界面", null, device.web_ui === true],
  ].map(([key, title, sub, on]) => ({ key, el: switchRow({ title, sub, checked: browser ? key === "web_ui" : on, disabled: browser, id: `${idPrefix}_${key}` }) }));
  const root = h("div", { class: "hm-stack" }, h("span", { class: "group-ttl" }, "它能做什么"), tier, h("div", { class: "list noic" }, rows.map((r) => r.el)));
  return { root, read: () => ({ tier: browser ? "ask" : current, ...Object.fromEntries(rows.map(({ key, el }) => [key, browser ? key === "web_ui" : el.get()])) }) };
}

const deviceLine = (device) => {
  const kind = KIND_NAMES[device.kind] ?? "设备";
  if (device.revoked_at) return { text: `${kind} · 已移除，连不上了`, tone: "" };
  const seen = !device.online && device.last_seen ? ` · 上次在线 ${clock(device.last_seen)}` : "";
  return { text: `${kind} · ${device.online ? "在线" : "离线"}${seen}${device.via === "gateway" ? " · 经中转站" : ""}`, tone: device.online ? "ok" : "" };
};

/** The device list as rows (used by 她的手和眼). */
export function deviceRows(ctx, devices, pairs) {
  const rows = [];
  for (const pair of pairs.filter((p) => p.state === "requested")) {
    const kind = KIND_NAMES[pair.kind] ?? "设备";
    rows.push(row({ icon: "laptop", tone: "warn", title: pair.name || `新${kind}想连上来`, sub: "等你批准", subTone: "warn", onClick: () => ctx.go("device", { pair: pair.pair_id }) }));
  }
  for (const device of devices) {
    const line = deviceLine(device);
    rows.push(row({ icon: device.kind === "browser" ? "globe" : "laptop", title: device.name, sub: line.text, onClick: () => ctx.go("device", { device: device.device }) }));
  }
  return rows;
}

/** One device (`arg.device`) or one request waiting to be approved (`arg.pair`). */
export function devicePage(ctx, screen, arg) {
  const box = h("div", { class: "hm-stack" }, skeleton(3));
  const state = { status: "" };
  const act = async (word, body) => { await screen.ask("service:devices", word, body); await refresh(); };
  const failed = (text) => (error) => { if (screen.alive() && error?.code !== "stale") { state.status = text; draw(); } };
  let data = null;
  const statusEl = () => state.status ? h("p", { class: "hm-note c-warn", role: "status" }, state.status) : null;
  const draw = () => {
    if (!data) return;
    if (arg?.pair) {
      const pair = data.pairs.find((p) => p.pair_id === arg.pair && p.state === "requested");
      if (!pair) { fill(box, list(row({ icon: "check", tone: "ok", title: "这个请求已经处理了" })), btn("回到她的手和眼", "a-btn btn-neutral btn-block", () => ctx.back())); return; }
      const kind = KIND_NAMES[pair.kind] ?? "设备";
      const grant = permissions({ tier: "ask", lend: pair.kind !== "browser" }, { browser: pair.kind === "browser", idPrefix: `pending_${pair.pair_id}` });
      fill(box, card("hm-promise", h("span", { class: "hm-big" }, pair.name || `新${kind}`), h("span", { class: "tx-sub" }, `${kind} · 先确认它是你的设备，再选它能做什么`)), grant.root,
        btn("批准", "a-btn btn-primary btn-block", () => { void act("pair_approve", { pair_id: pair.pair_id, ...grant.read() }).then(() => ctx.back()).catch(failed("批准未确认，请刷新状态后检查。")); }, { id: "homePendingApprove" }),
        btn("拒绝", "a-btn btn-neutral btn-block", () => { void act("pair_reject", { pair_id: pair.pair_id }).then(() => ctx.back()).catch(failed("拒绝未确认，请重试。")); }, { id: "homePendingReject" }), statusEl());
      return;
    }
    const device = data.devices.find((d) => d.device === arg?.device);
    if (!device) { fill(box, list(row({ icon: "alert", title: "没有找到这台设备" }))); return; }
    const line = deviceLine(device);
    if (device.revoked_at) {
      fill(box, card("hm-promise", h("span", { class: "hm-big" }, device.name), h("span", { class: "tx-sub" }, line.text)),
        btn("恢复", "a-btn btn-secondary btn-block", () => { void act("restore", { device: device.device }).catch(failed("恢复未确认，请重试。")); }, { id: "homeDeviceRestore" }), statusEl());
      return;
    }
    const name = h("input", { type: "text", value: device.name, "aria-label": "设备名称", maxlength: 64 });
    const grant = permissions(device, { browser: device.kind === "browser", idPrefix: `dev_${handOf(device.device)}` });
    const info = h("pre", { class: "hm-pre", hidden: true });
    const remove = h("button", { type: "button", class: "a-btn btn-danger btn-block", id: "homeDeviceRevoke" });
    const warn = h("p", { class: "hm-note c-err", role: "status" });
    twoTap(remove, { label: "移除这台设备", confirm: "确定移除？", warn: `移除后 ${device.name} 需要重新配对才能连上。`, onWarn: (text) => { warn.textContent = text; }, run: () => act("revoke", { device: device.device }).then(() => ctx.back()).catch(failed("移除未确认，请重试。")) });
    fill(box, card("hm-promise", h("span", { class: "hm-big" }, device.name), h("span", { class: `tx-sub${line.tone ? ` c-${line.tone}` : ""}` }, line.text)),
      group("名称", h("div", { class: "hm-actions hm-inline" }, name, btn("保存名称", "a-btn btn-neutral btn-sm", () => { const next = name.value.trim(); if (!next) { state.status = "名称不能是空的。"; draw(); return; } void act("rename", { device: device.device, name: next }).catch(failed("名称未保存。")); }))),
      grant.root, btn("保存权限", "a-btn btn-primary btn-block", () => { void act("access_set", { device: device.device, ...grant.read() }).then(() => { state.status = ""; }).catch(failed("权限未确认，请刷新状态后检查。")); }, { id: "homeDeviceSave" }),
      btn("诊断", "a-btn btn-neutral btn-block", async () => {
        info.hidden = false; info.textContent = "正在诊断…";
        try {
          const hand = handOf(device.device);
          const [diagnosis, connected] = await Promise.all([screen.ask("service:link", "diagnose", { hand }), screen.ask("service:link", "list", {}).catch(() => ({ connections: [] }))]);
          if (screen.alive()) info.textContent = deviceDiagnosis({ device, diagnosis, connections: (connected.connections ?? []).filter((c) => c.hand === hand) });
        } catch (error) { if (screen.alive()) info.textContent = error?.code === "stale" ? "" : "诊断失败，请刷新状态。"; }
      }), info, remove, warn, statusEl());
  };
  async function refresh() { try { data = await readDevices(screen); } catch (error) { if (error?.code !== "stale" && screen.alive()) fill(box, note("读取失败，请返回后重试。", "warn")); return; } if (screen.alive()) draw(); }
  return { title: arg?.pair ? "新设备" : "设备", body: box, refresh };
}

/** 连一台新设备: a pairing code for a computer, server or browser, and the relay it connects through. */
export function connectPage(ctx, screen) {
  const root = h("div", { class: "hm-stack" });
  const state = { kind: "computer", shown: null, pairResult: "", relay: null, relayUrl: "", relayResult: "", setup: null, account: "", setupBusy: false, copy: "复制地址", requested: 0, signature: null };
  const countdown = (ms) => { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };
  const setupFailed = (text) => (error) => { if (screen.alive()) { state.relayResult = error?.code === "stale" ? "" : text; draw(); } };

  const refreshRelay = async () => { state.relay = await screen.ask("service:link", "gateway.status", {}); if (state.relay.configured === true && typeof state.relay.url === "string" && !state.relayUrl) state.relayUrl = state.relay.url; };
  const readSetup = async () => {
    if (!state.setup?.setup_id) return;
    try { await adopt(await screen.ask("service:link", "gateway.setup.status", { setup_id: state.setup.setup_id })); } catch (error) { setupFailed("没读到进度，请重试。")(error); }
  };
  const adopt = async (next) => { state.setup = { ...state.setup, ...next }; if (next.state === "claimed" || next.state === "connected") await refreshRelay().catch(() => {}); if (screen.alive()) draw(); };

  const readPairing = async () => {
    let pairs;
    try { pairs = (await screen.ask("service:devices", "pair_pending", {})).pairs ?? []; } catch { return; }
    const signature = pairs.map((p) => `${p.pair_id}:${p.state}`).join(",");
    let changed = state.signature !== null && signature !== state.signature;
    state.signature = signature;
    state.requested = pairs.filter((p) => p.state === "requested").length;
    if (state.shown) {
      let own = pairs.find((p) => p.pair_id === state.shown.pair_id);
      if (!own) own = await screen.ask("service:devices", "pair_status", { pair_id: state.shown.pair_id }).catch(() => null);
      if (own?.state && own.state !== state.shown.state) { state.shown.state = own.state; changed = true; }
    }
    if (screen.alive() && changed) draw();
  };

  const pairText = (shown, code, left) => code === "requested" ? "配对码已使用。新设备发来的连接请求在「她的手和眼」里，确认是你的设备再批准。"
    : code === "expired" ? "配对码已过期。需要时再点「生成配对码」。" : `配对码：${shown.code}（还剩 ${countdown(left)}，只能用一次）。${!shown.url ? "" : shown.kind === "browser" ? "在新浏览器里打开下面的地址，把上面的配对码输进去，再回到「她的手和眼」批准：" : "在要连接的电脑上用浏览器打开下面的地址，按页面提示安装，再回到「她的手和眼」批准："}`;
  const tickText = () => {
    const shown = state.shown;
    const text = root.querySelector("#homePairText");
    if (!shown || !text) return;
    const left = shown.deadline - Date.now();
    const code = shown.state === "waiting" && left <= 0 ? "expired" : shown.state;
    text.textContent = pairText(shown, code, left);
    if (code === "expired" && shown.state === "waiting") draw();
  };
  const draw = () => {
    const shown = state.shown && !["approved", "connected", "rejected"].includes(state.shown.state) ? state.shown : null;
    const left = shown ? shown.deadline - Date.now() : 0;
    const code = shown?.state === "waiting" && left <= 0 ? "expired" : shown?.state;
    const kinds = h("div", { class: "seg", role: "tablist" }, KINDS.map(([key, label]) => btn(label, state.kind === key ? "on" : "", () => { state.kind = key; draw(); }, { role: "tab", "aria-selected": String(state.kind === key), id: `homePairKind_${key}` })));
    const pairBox = shown ? card("hm-promise", h("p", { class: "hm-note", id: "homePairText" }, pairText(shown, code, left)),
      code === "waiting" && shown.url ? h("pre", { class: "hm-pre", id: "homePairCommand" }, shown.url) : null,
      code === "waiting" && shown.url ? btn(state.copy, "a-btn btn-neutral btn-sm hm-left", async () => { try { await globalThis.navigator.clipboard.writeText(shown.url); state.copy = "已复制"; } catch { state.copy = "长按上面的地址复制"; } draw(); }, { id: "homePairCopy" }) : null,
      code === "requested" ? btn("去批准", "a-btn btn-primary btn-sm hm-left", () => ctx.back()) : null) : null;
    const relay = state.relay;
    const setup = state.setup;
    const sState = setup?.state;
    const active = SETUP_ACTIVE.includes(sState);
    const accounts = sState === "authorized" && Array.isArray(setup.accounts) ? setup.accounts : [];
    const many = accounts.length > 1;
    const url = h("input", { type: "url", id: "homeRelayUrl", placeholder: "https://你的中转站地址", value: state.relayUrl, "aria-label": "中转站地址" });
    url.addEventListener("input", () => { state.relayUrl = url.value; });
    const name = h("input", { type: "text", id: "homeSetupName", placeholder: "中转站的名字（可不填）", "aria-label": "中转站的名字", maxlength: 40 });
    const cancel = h("button", { type: "button", class: "a-btn btn-neutral btn-block", id: "homeSetupCancel" });
    const cancelNote = h("p", { class: "hm-note c-err" });
    twoTap(cancel, { label: "放弃搭建", confirm: "确定放弃？", warn: "放弃后，已经搭到一半的东西不会继续。", onWarn: (text) => { cancelNote.textContent = text; }, run: async () => {
      try { await screen.ask("service:link", "gateway.setup.cancel", { setup_id: setup.setup_id }); if (screen.alive()) { state.setup = null; state.relayResult = "已放弃搭建。"; draw(); } } catch (error) { setupFailed("没能放弃，请重试。")(error); } } });
    fill(root, 
      localHint(ctx), group("连一台新设备", h("div", { class: "hm-stack" }, kinds, btn("生成配对码", "a-btn btn-primary btn-block", async () => {
        state.pairResult = "正在生成配对码…"; draw();
        try {
          const started = await screen.ask("service:devices", "pair_start", { kind: state.kind });
          const issued = await screen.ask("service:devices", "pair_code", { pair_id: started.pair_id });
          state.copy = "复制地址";
          state.shown = { pair_id: started.pair_id, kind: state.kind, code: issued.code, url: typeof issued.url === "string" ? issued.url : "", deadline: Number(issued.expires_at ?? started.expires_at) || Date.now(), state: "waiting" };
          state.pairResult = "";
        } catch (error) { state.pairResult = error?.code === "stale" ? "" : "生成失败：中转站可能离线，请稍后重试。"; state.shown = null; }
        if (screen.alive()) draw();
      }, { id: "homePair" }), state.pairResult ? note(state.pairResult) : null, pairBox)),
      group("中转站", card("hm-promise", h("span", { class: "tx-sub", id: "homeRelayStatus" }, relay ? relayText(relay) : "正在读取…"),
        url, btn("使用这个中转站", "a-btn btn-secondary btn-block", async () => {
          const value = state.relayUrl.trim();
          if (!value) { state.relayResult = "请先填中转站的地址。"; draw(); return; }
          state.relayResult = "正在保存…"; draw();
          try { const used = await screen.ask("service:link", "gateway.use", { url: value }); if (typeof used.url === "string") state.relayUrl = used.url; state.relayResult = `已设置中转站：${used.url ?? value}。`; await refreshRelay().catch(() => {}); }
          catch (error) { state.relayResult = error?.code === "stale" ? "" : "保存失败，请检查地址后重试。"; }
          if (screen.alive()) draw();
        }, { id: "homeRelayUse" }), state.relayResult ? h("p", { class: "hm-note", id: "homeRelayResult", role: "status" }, state.relayResult) : null,
        h("span", { class: "tx-caption" }, "没有中转站？可以在你的 Cloudflare 账号里搭一个。"),
        sState ? h("p", { class: "hm-note", id: "homeSetupState", role: "status" }, setupText(setup)) : null,
        many ? h("div", { class: "hm-actions", id: "homeSetupAccounts" }, accounts.map((account, index) => btn(account.name, `a-btn btn-sm ${account.id === state.account ? "btn-primary" : "btn-neutral"}`, () => { state.account = account.id; draw(); }, { "aria-pressed": String(account.id === state.account), id: `homeSetupAccount${index}` }))) : null,
        sState === "authorized" ? name : null,
        !active && sState !== "connected" ? btn("在 Cloudflare 搭一个", "a-btn btn-neutral btn-block", async () => {
          state.relayResult = ""; state.setup = { state: "starting" };
          try { state.setup = await screen.ask("service:link", "gateway.setup.start", { provider: "cloudflare" }); } catch (error) { state.setup = null; setupFailed("没能开始，请稍后重试。")(error); }
          if (screen.alive()) draw();
        }, { id: "homeSetupStart" }) : null,
        sState === "authorized" ? btn("开始搭建", "a-btn btn-primary btn-block", async () => {
          const nameText = name.value.trim();
          if (many && !state.account) { state.relayResult = "先选一个要搭在哪个 Cloudflare 账户。"; draw(); return; }
          try { await adopt(await screen.ask("service:link", "gateway.setup.deploy", { setup_id: setup.setup_id, ...(nameText ? { name: nameText } : {}), ...(many ? { account: state.account } : {}) })); } catch (error) { setupFailed("没能开始搭建，请重试。")(error); }
        }, { id: "homeSetupDeploy" }) : null,
        ["waiting_login", "deploying", "claimed"].includes(sState) ? btn("看看进度", "a-btn btn-neutral btn-block", () => void readSetup(), { id: "homeSetupCheck" }) : null,
        ["waiting_login", "authorized", "deploying"].includes(sState) ? cancel : null, ["waiting_login", "authorized", "deploying"].includes(sState) ? cancelNote : null)));
  };
  draw();
  let tick = 0;
  screen.every(() => { tickText(); if (++tick % 2 === 0) { void readPairing(); if (SETUP_ACTIVE.includes(state.setup?.state)) void readSetup(); } }, 1000);
  return { title: "连一台新设备", body: root, refresh: async () => { await Promise.all([refreshRelay().catch(() => {}), readPairing()]); if (screen.alive()) draw(); } };
}
