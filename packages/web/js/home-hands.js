import { fill } from "./home-dom.js";
// 她的手和眼: the phone's checkup (drawn by the app itself; here only its state), the devices she can use, her browser, the
// apps, and a button to connect a new device.
import { readApps, readDevices, settled } from "./home-data.js";
import { deviceRows } from "./home-devices.js";
import { appsSummary } from "./home-text.js";
import { btn, card, group, h, ico, list, note, row, twoTap } from "./home-ui.js";

const PARTS = { brain: ["cpu", "大脑"], alarm: ["alarm", "闹钟"], notify: ["bell", "叫你"], awake: ["bolt", "在后台醒着"], eyes: ["eye", "眼睛和手"], files: ["folder", "照片和文件"], location: ["pin", "位置和健康"] };
const openNative = (page) => globalThis.__ashOpenNative?.(page);

export function handsPage(ctx, screen) {
  const phoneBox = h("div"), listBox = h("div", { class: "hm-stack" }), state = { devices: null, apps: null };
  const drawPhone = () => {
    if (typeof globalThis.__ashOpenNative !== "function") { fill(phoneBox); return; }
    const checkup = globalThis.__ashCheckup?.() ?? null;
    const todo = Number.isFinite(checkup?.todo) ? checkup.todo : 0;
    const groups = Array.isArray(checkup?.groups) ? checkup.groups.filter((item) => PARTS[item?.id]) : [];
    const cells = groups.map((item) => {
      const [icon, label] = PARTS[item.id];
      const bad = Number(item.todo) > 0;
      return h("button", { type: "button", class: `hm-part${bad ? " bad" : ""}`, dataset: { part: item.id }, onclick: () => openNative(`checkup/${item.id}`) },
        h("span", { class: "hm-part-name" }, ico(icon, "i-xs"), label), h("span", { class: `hm-part-state ${bad ? "c-warn" : "c-ok"}` }, bad ? "去修" : "正常"));
    });
    fill(phoneBox, card("hm-promise", h("button", { type: "button", class: "hm-checkhead", id: "handsPhone", onclick: () => openNative("checkup") },
      h("span", { class: `hm-checkicon${todo ? " bad" : ""}` }, ico("phone")), h("span", { class: "hm-checkt" }, h("span", { class: "tx-headline" }, "这台手机 · 体检"),
        h("span", { class: `tx-caption ${todo ? "c-warn" : "c-ok"}` }, checkup ? (todo ? `${todo} 项要处理，不然她可能被系统停掉` : "都好，她可以放心干活") : "点开看看她在这台手机上好不好")), null),
      cells.length ? h("div", { class: "hm-parts" }, cells) : null));
  };
  const drawList = () => {
    const rows = [];
    if (state.devices) rows.push(...deviceRows(ctx, state.devices.devices, state.devices.pairs));
    const android = globalThis.location?.origin === "https://appassets.androidplatform.net";
    if (android && typeof globalThis.__ashBrowserLogins === "function") rows.push(row({ icon: "globe", title: "她的浏览器", sub: "登录过的网站只存在这台手机上", onClick: () => ctx.go("browser") }));
    if (android && typeof globalThis.__ashOpenNative !== "function") rows.push(row({ icon: "shield", title: "手机权限", sub: "通知、无障碍、后台运行，以及诊断", onClick: () => { globalThis.location.href = "ash://console"; } }));
    rows.push(row({ icon: "grid", title: "应用", sub: state.apps ? appsSummary(state.apps) : null, onClick: () => typeof globalThis.__ashOpenNative === "function" ? openNative("apps") : ctx.go("apps") }));
    fill(listBox, group("她还能用的", list(...rows)), state.devices === null ? note("正在读取设备…") : null,
      btn([ico("plus", "i-s"), "连一台新设备"], "a-btn btn-secondary btn-block", () => ctx.go("connect"), { id: "homeConnect" }));
  };
  drawPhone(); drawList();
  screen.listen(globalThis, "ash:checkup", drawPhone);
  const refresh = async () => {
    const [devices, apps] = await Promise.all([settled(readDevices(screen)), settled(readApps(screen))]);
    if (!screen.alive()) return;
    if (devices) state.devices = devices;
    if (apps) state.apps = apps;
    drawList();
  };
  return { title: "她的手和眼", body: h("div", { class: "hm-stack" }, phoneBox, listBox), refresh };
}

/** Her browser: the logins she holds are kept on this phone; here they can all be cleared. */
export function browserPage(ctx, screen) {
  const status = h("p", { class: "hm-note", id: "homeBrowserStatus", role: "status" });
  const clear = h("button", { type: "button", class: "a-btn btn-danger btn-block", id: "homeBrowserClear" });
  twoTap(clear, { label: "清除浏览器里的所有登录", confirm: "再点一次确认清除", warn: `会清掉所有网站的登录并关闭浏览器，之后她需要你重新登录。`, onWarn: (text) => { status.textContent = text; }, run: async () => {
    clear.disabled = true; status.textContent = "正在清除…";
    try { const result = await globalThis.__ashBrowserLogins(); if (screen.alive()) status.textContent = result.ok ? "已清除所有登录。" : "清除失败，请重试。"; }
    catch { if (screen.alive()) status.textContent = "清除失败，请重试。"; }
    finally { clear.disabled = false; }
  } });
  return { title: "她的浏览器", body: h("div", { class: "hm-stack" }, card("hm-promise", h("span", { class: "hm-big" }, "登录过的网站"), h("span", { class: "tx-sub" }, `她用自己的浏览器帮你上网。你在里面登录过的网站只保存在这台手机上。`)), clear, status) };
}
