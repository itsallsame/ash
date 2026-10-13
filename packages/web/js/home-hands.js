import { fill } from "./home-dom.js";
// 她的手和眼: the devices she can use, the apps, and a button to connect a new device.
import { readApps, readDevices, settled } from "./home-data.js";
import { deviceRows } from "./home-devices.js";
import { appsSummary } from "./home-text.js";
import { btn, group, h, ico, list, note, row } from "./home-ui.js";

export function handsPage(ctx, screen) {
  const listBox = h("div", { class: "hm-stack" }), state = { devices: null, apps: null };
  const drawList = () => {
    const rows = [];
    if (state.devices) rows.push(...deviceRows(ctx, state.devices.devices, state.devices.pairs));
    rows.push(row({ icon: "grid", title: "应用", sub: state.apps ? appsSummary(state.apps) : null, onClick: () => ctx.go("apps") }));
    fill(listBox, group("她还能用的", list(...rows)), state.devices === null ? note("正在读取设备…") : null,
      btn([ico("plus", "i-s"), "连一台新设备"], "a-btn btn-secondary btn-block", () => ctx.go("connect"), { id: "homeConnect" }));
  };
  drawList();
  const refresh = async () => {
    const [devices, apps] = await Promise.all([settled(readDevices(screen)), settled(readApps(screen))]);
    if (!screen.alive()) return;
    if (devices) state.devices = devices;
    if (apps) state.apps = apps;
    drawList();
  };
  return { title: "她的手和眼", body: listBox, refresh };
}
