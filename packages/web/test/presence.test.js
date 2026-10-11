import assert from "node:assert/strict";
import test from "node:test";
import { faceForStatus, PresenceBar } from "../js/presence.js";

function fixture() {
  const nodes = Object.fromEntries(["#presence", "#title", "#state", "#stateNet", "#face", "#face img", "#dot", "#connection", "#presenceNotice", "#netBanner", "#netBannerText"]
    .map((selector) => [selector, { dataset: {}, textContent: "", title: "", className: "", src: "", hidden: false, setAttribute(name, value) { this[name] = value; }, addEventListener(_event, callback) { this.click = callback; } }]));
  return { nodes, bar: new PresenceBar({ querySelector: (selector) => nodes[selector] }) };
}

test("all seven authoritative states select the specified image and human text", () => {
  const { nodes, bar } = fixture();
  bar.network("online");
  const cases = [
    ["resting", "resting", "休息中"], ["listening", "listening", "在听"],
    ["thinking", "thinking", "正在想"], ["working", "focused", "在忙"],
    ["done", "success", ""], ["waiting_you", "listening", "等你一句话"],
    ["idle", "default", "在线"],
  ];
  for (const [state, face, label] of cases) {
    assert.equal(faceForStatus(state), face);
    bar.render({ state, text: "" });
    assert.equal(nodes["#presence"].dataset.state, state);
    assert.equal(nodes["#state"].textContent, label);
    assert.equal(nodes["#face img"].src, `/avatars/${face}.webp`);
  }
  bar.render({ state: "working", text: "在看文件" });
  assert.equal(nodes["#state"].textContent, "在看文件");
  bar.render({ state: "working", text: "" });
  assert.equal(nodes["#state"].textContent, "在忙");
});

test("the face and the state line show what she is doing: a ring by state, amber while she waits, a dot when idle", () => {
  const { nodes, bar } = fixture();
  bar.network("online");
  const look = (state) => { bar.render({ state, text: "" }); return [nodes["#face"].className, nodes["#state"].className, nodes["#dot"].className]; };
  assert.deepEqual(look("idle"), ["av av-36", "state", "dot"]);
  assert.deepEqual(look("working"), ["av av-36 av-live", "state c-her", "dot gone"]);
  assert.deepEqual(look("thinking"), ["av av-36 av-breath", "state c-her", "dot gone"]);
  assert.deepEqual(look("waiting_you"), ["av av-36 av-wait", "state c-warn", "dot gone"]);
  assert.deepEqual(look("resting"), ["av av-36", "state", "dot off"]);
});

test("transport failures and unavailable sheet never forge an agent state", () => {
  const { nodes, bar } = fixture();
  bar.network("online");
  bar.render({ state: "thinking", text: "正在想" });
  assert.equal(nodes["#presence"].dataset.net, "online");
  bar.network("offline");
  assert.equal(nodes["#state"].textContent, "正在想", "her own line is left alone");
  assert.equal(nodes["#presence"].dataset.net, "offline", "the connection line takes its place on screen");
  assert.equal(nodes["#stateNet"].textContent, "离线，正在重连…");
  assert.equal(nodes["#connection"].textContent, "离线，正在重连…");
  assert.equal(nodes["#face"].className, "av av-36", "no ring while offline");
  assert.equal(nodes["#dot"].className, "dot off");
  assert.equal(nodes["#netBanner"].hidden, false);
  assert.equal(nodes["#netBannerText"].textContent, "暂时连不上 Ash。你写的消息会先存着，连上就发。");
  nodes["#presence"].click();
  assert.equal(nodes["#presenceNotice"].textContent, "她的主页尚未接入");
  bar.network("online");
  assert.equal(nodes["#netBanner"].hidden, true, "the banner folds away once she is back");
  bar.render({ state: "not-a-status", text: "unsafe" });
  assert.equal(nodes["#state"].textContent, "状态待同步");
  assert.equal(nodes["#face img"].src, "/avatars/default.webp");
  assert.equal(nodes["#presence"].dataset.net, "connecting", "until the first history is in, the line says she is connecting");
});

test("a problem is told in the banner for a few seconds and then the banner goes back to the connection", async () => {
  const { nodes, bar } = fixture();
  bar.network("online");
  bar.problem("没发出去：太大了");
  assert.equal(nodes["#netBanner"].hidden, false);
  assert.equal(nodes["#netBannerText"].textContent, "没发出去：太大了");
  clearTimeout(bar.problemTimer);
  bar.problemTimer = null;
});
