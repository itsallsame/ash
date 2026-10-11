// 你们的约定: the quiet hours, how often she asks before acting (and what you said "always" to), and when she may come to you.
// What is changeable is written into the sentence: the words in the accent colour are tapped and changed in place.
import { ProactivePreferences } from "./settings-preferences.js";
import { QUIET_FORMAT, QUIET_DEFAULT } from "./settings.js";
import { readApproval, readFile, readQuiet } from "./home-data.js";
import { actionLabel } from "./home-waiting.js";
import { btn, card, h, ico, note, twoTap } from "./home-ui.js";
import { named } from "./editor.js";
import { dayTime, fill } from "./home-dom.js";

const QUIET_KEY = "delivery.quiet_hours";
const revokeIntents = new Map();

const MODES = [
  { mode: "auto", title: "有影响时才问", sub: () => "对外发消息、删改你的数据、花钱、执行命令之前先问你；看、找、打开这类能撤回的事，她直接做。" },
  { mode: "always", title: "每次都问", sub: (name) => `除了看和读，外部操作都先问你；单独设为「完全放开」的电脑除外。` },
];

/** A time in the sentence: a pill that opens the time picker; a change is [onPick]ed. */
const timePill = (value, label, onPick, disabled) => {
  const input = h("input", { type: "time", value, "aria-label": label, disabled, step: 60 });
  input.addEventListener("change", () => { if (input.value) onPick(input.value); });
  return h("label", { class: "hm-pill" }, value, input);
};

export function promisesPage(ctx, screen, arg) {
  const name = ctx.name;
  const state = { quiet: undefined, quietStatus: "", mode: null, modeStatus: "", rules: null, armed: null, ruleStatus: "", proactive: undefined, editing: arg === "proactive" };
  const quietBox = h("div"), modeBox = h("div"), proactiveBox = h("div");

  // ---- quiet hours
  const saveQuiet = async (value) => {
    state.quietStatus = "正在保存…"; drawQuiet();
    try {
      if (value !== "" && !QUIET_FORMAT.test(value)) throw new Error("invalid");
      const reply = await screen.ask("service:admin", "settings.set", { [QUIET_KEY]: value });
      if (reply[QUIET_KEY] !== value) throw new Error("unconfirmed");
      state.quiet = value;
      state.quietStatus = value ? "已保存免打扰时段。" : "已关闭免打扰。";
    } catch (error) { if (error?.code === "stale") return; state.quietStatus = "保存未确认，请重试。"; }
    if (screen.alive()) drawQuiet();
  };
  const drawQuiet = () => {
    const quiet = state.quiet;
    const [from, to] = quiet ? quiet.split("-") : [];
    const loading = quiet === undefined;
    const sentence = loading ? h("span", { class: "hm-sentence" }, "正在读取…") : quiet
      ? h("span", { class: "hm-sentence" }, "每天 ", timePill(from, "开始时间", (v) => void saveQuiet(`${v}-${to}`)), " 到 ", timePill(to, "结束时间", (v) => void saveQuiet(`${from}-${v}`)), "，她不主动找你。")
      : h("span", { class: "hm-sentence" }, "没有设置免打扰，她随时可能找你。");
    fill(quietBox, card("hm-promise", h("span", { class: "tx-sub hm-promise-ttl" }, ico("moon", "i-s"), "免打扰"), sentence,
      h("span", { class: "tx-caption" }, "这段时间里她想主动说的事先攒着，到点再说；你找她、你定的提醒，照常送达。"),
      !loading && (quiet ? btn("不设免打扰", "a-btn btn-ghost btn-sm hm-left", () => void saveQuiet(""), { id: "homeQuietOff" }) : btn("设置免打扰", "a-btn btn-secondary btn-sm hm-left", () => void saveQuiet(QUIET_DEFAULT), { id: "homeQuietOn" })),
      state.quietStatus ? h("p", { class: "hm-note", id: "homeQuietStatus", role: "status" }, state.quietStatus) : null));
  };

  // ---- approval
  const saveMode = async (mode) => {
    state.modeStatus = "正在保存…"; drawMode();
    try {
      const reply = await screen.ask("service:gate", "mode.set", { mode });
      if (reply.mode !== mode) throw new Error("unconfirmed");
      state.mode = mode; state.modeStatus = "已保存。";
    } catch (error) { if (error?.code === "stale") return; state.modeStatus = "保存未确认，请重试。"; }
    if (screen.alive()) drawMode();
  };
  const revoke = async (rule) => {
    const clientId = revokeIntents.get(rule.id) ?? crypto.randomUUID();
    revokeIntents.set(rule.id, clientId);
    try {
      const result = await screen.ask("service:gate", "rules.revoke", { id: rule.id }, { clientId });
      if (result?.revoked !== true) throw new Error("not revoked");
      revokeIntents.delete(rule.id);
      state.armed = null; state.ruleStatus = "";
      const next = await readApproval(screen); state.rules = next.rules; state.mode = next.mode ?? state.mode;
    } catch (error) { if (error?.code === "stale") return; state.ruleStatus = "还没确认撤销成功；再点一次「确认撤销」会原样重试。"; }
    if (screen.alive()) drawMode();
  };
  const ruleLabel = (rule) => {
    const object = rule.object_pattern === "*" ? "" : String(rule.object_pattern ?? "").slice(0, 80);
    if (rule.word === "calendar.create" && object) return `在「${object}」日历里建日程`;
    if (rule.word === "message.send" && object) return `给「${object}」发消息`;
    return `${actionLabel(rule)}${object ? ` · ${object}` : ""}`;
  };
  const drawMode = () => {
    const now = Date.now();
    const seg = h("div", { class: "seg", role: "tablist" }, MODES.map(({ mode, title }) => btn(title, state.mode === mode ? "on" : "", () => { if (state.mode !== mode) void saveMode(mode); }, { role: "tab", "aria-selected": String(state.mode === mode), id: `homeMode_${mode}`, disabled: state.mode === null })));
    const current = MODES.find((item) => item.mode === state.mode);
    const rules = state.rules ?? [];
    const ruleRows = rules.map((rule) => {
      const armed = state.armed === rule.id;
      const control = btn(armed ? "确认撤销" : "撤销", `a-btn btn-ghost btn-sm${armed ? " armed" : ""}`, () => { if (!armed) { state.armed = rule.id; drawMode(); } else void revoke(rule); }, { dataset: { rule: rule.id } });
      return h("div", { class: "hm-rule", dataset: { rule: rule.id } }, h("span", { class: "hm-rule-t" }, h("span", {}, ruleLabel(rule)), h("span", { class: "tx-caption" }, `${dayTime(rule.expires_at, now)} 前有效`),
        armed ? h("span", { class: "tx-caption c-err" }, "撤销后，她下次做这件事前会先问你。") : null), control);
    });
    fill(modeBox, card("hm-promise", h("span", { class: "tx-sub hm-promise-ttl" }, ico("shield", "i-s"), "什么时候先问你"), seg,
      current ? h("span", { class: "tx-sub" }, current.sub(name)) : null,
      h("div", { class: "hr" }), h("span", { class: "tx-caption" }, "你说过以后都可以的"),
      state.rules === null ? h("span", { class: "tx-caption" }, "正在读取…") : ruleRows.length ? ruleRows : h("span", { class: "tx-caption" }, "还没有。你点「以后都允许」的事会记在这里。"),
      state.ruleStatus ? h("p", { class: "hm-note c-warn", role: "status" }, state.ruleStatus) : null,
      state.modeStatus ? h("p", { class: "hm-note", id: "homeModeStatus", role: "status" }, state.modeStatus) : null));
  };

  // ---- proactive contact
  const prefsRoot = h("div", { class: "hm-prefs" });
  const prefs = new ProactivePreferences(prefsRoot, ctx.net, () => screen.alive(), { onText: (text) => { state.proactive = text; drawProactive(false); } });
  prefs.editor.className = "hm-source"; prefs.saveButton.className = "a-btn btn-primary btn-block"; prefs.loadButton.className = "a-btn btn-neutral btn-block"; prefs.status.className = "hm-note";
  const drawProactive = (reload = true) => {
    const text = state.proactive;
    const view = h("div", { class: "hm-proactive-view" }, text === undefined ? h("span", { class: "hm-sentence" }, "正在读取…") : text && text.trim() ? h("span", { class: "hm-sentence plain" }, text.trim()) : h("span", { class: "hm-sentence plain c-3" }, "关于你的偏好，还没写。"));
    const pen = btn([ico("pen", "i-xs")], "iconbtn hm-pen", () => { state.editing = !state.editing; drawProactive(); if (state.editing && !prefs.loaded) void prefs.load(); }, { "aria-label": state.editing ? "收起" : "改这一条", id: "homeProactiveEdit" });
    prefsRoot.hidden = !state.editing;
    fill(proactiveBox, card("hm-promise", h("span", { class: "tx-sub hm-promise-ttl" }, ico("bell", "i-s"), "什么事可以直接找你", pen), view, prefsRoot));
  };

  drawQuiet(); drawMode(); drawProactive();
  const refresh = async () => {
    const settle = (work, fn) => work.then((value) => { if (screen.alive()) fn(value); }, () => {});
    await Promise.all([
      settle(readQuiet(screen), (quiet) => { if (quiet !== null) state.quiet = quiet; drawQuiet(); }),
      settle(readApproval(screen), (approval) => { state.mode = approval.mode; state.rules = approval.rules; drawMode(); }),
      (async () => { await prefs.load(); if (!screen.alive()) return; if (state.proactive === undefined) state.proactive = ""; drawProactive(); })(),
    ]);
  };
  return { title: "你们的约定", body: h("div", { class: "hm-stack" }, quietBox, modeBox, proactiveBox), refresh, dispose: () => prefs.dispose() };
}
