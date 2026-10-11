// 接下来: a week strip, and the plans of the chosen day by time. A plan is removed only after the clock confirmed its cancel.
import { cancelClock, listClock } from "./clock.js";
import { dayItems, weekStrip } from "./home-model.js";
import { dayTime, h, hhmm, ico, startOfDay, weekday, weekdayShort, fill } from "./home-dom.js";
import { btn, list, note, row, skeleton } from "./home-ui.js";
import { repeatText } from "./clock.js";

const cancelIntents = new Map();

export function upcomingPage(ctx, screen) {
  const strip = h("div", { class: "hm-week", role: "tablist" });
  const dayBox = h("div", { class: "hm-stack" }, skeleton(2));
  const state = { timers: null, day: startOfDay(Date.now()), armed: null, error: "" };

  const draw = () => {
    if (state.timers === undefined) { fill(strip); fill(dayBox, h("div", { class: "hm-retry" }, note("暂时读不到计划（不代表没有）。", "warn"), btn("重试", "a-btn btn-neutral btn-sm", () => void refresh()))); return; }
    if (!state.timers) return;
    const now = Date.now();
    const week = weekStrip(state.timers, now);
    fill(strip, ...week.map(({ day, count }) => {
      const on = day === state.day;
      return h("button", { type: "button", role: "tab", "aria-selected": String(on), class: `hm-weekday${on ? " on" : ""}`, onclick: () => { state.day = day; state.armed = null; draw(); }, dataset: { day: String(day) } },
        h("span", { class: "hm-wd-name" }, weekdayShort(day)), h("span", { class: "tx-num hm-wd-num" }, String(new Date(day).getDate())), h("span", { class: `hm-wd-dot${count ? " has" : ""}` }));
    }));
    if (!state.timers.length) { fill(dayBox, list(row({ icon: "clock", title: "暂无计划", sub: "她答应到点做的事、提醒你的事，会出现在这里。" }))); return; }
    const items = dayItems(state.timers, state.day);
    const date = new Date(state.day);
    const label = `${state.day === startOfDay(now) ? "今天" : state.day === startOfDay(now) + 86_400_000 ? "明天" : weekday(state.day)} · ${date.getMonth() + 1}月${date.getDate()}日`;
    const rows = items.map(({ at, timer }) => {
      const key = `${timer.id}:${at}`;
      const armed = state.armed === key;
      const title = timer.label || "没有名字的计划";
      const del = armed ? btn("确认删除", "a-btn btn-sm btn-danger", () => void remove(timer), { dataset: { timer: timer.id } }) : btn([ico("trash", "i-s")], "iconbtn hm-trash", () => { state.armed = key; state.error = ""; draw(); }, { "aria-label": "删除", dataset: { timer: timer.id } });
      const el = h("div", { class: "li li-tall hm-plan", dataset: { timer: timer.id } },
        h("span", { class: "tx-num hm-plan-time" }, hhmm(at)),
        h("span", { class: "lt" }, h("span", { class: "t" }, title), h("span", { class: "s hm-plan-rep" }, timer.every ? ico("repeat") : null, repeatText(timer.every)),
          timer.blocked ? h("span", { class: "s c-warn" }, `暂时没法执行：${timer.blocked}`) : null), del);
      if (armed) el.append(h("span", { class: "tx-caption c-err hm-plan-warn" }, timer.every ? `删除后，「${title}」以后都不会再有了。` : `删除后，${dayTime(at, now)}的「${title}」就取消了。`));
      if (state.armed === key && state.error) el.append(h("span", { class: "tx-caption c-err hm-plan-warn" }, state.error));
      return el;
    });
    fill(dayBox, h("div", { class: "group" }, h("span", { class: "group-ttl" }, label), rows.length ? h("div", { class: "list" }, ...rows) : list(row({ icon: "clock", title: "这一天没有计划" }))));
  };

  const refresh = async () => {
    try { state.timers = await listClock(ctx.net, screen.binding); } catch (error) { if (error?.code === "stale") return; state.timers = undefined; }
    if (screen.alive()) draw();
  };

  async function remove(timer) {
    let clientId = cancelIntents.get(timer.id);
    if (!clientId) { clientId = crypto.randomUUID(); cancelIntents.set(timer.id, clientId); }
    try {
      await cancelClock(ctx.net, screen.binding, timer.id, clientId);
      const fresh = await listClock(ctx.net, screen.binding);
      if (!screen.alive()) return;
      if (fresh.some((item) => item.id === timer.id)) throw new Error("删除后它还在列表里；请稍后再看。");
      cancelIntents.delete(timer.id);
      state.timers = fresh; state.armed = null; state.error = "";
    } catch (error) { state.error = error instanceof Error ? error.message : "没能删除，可以再试一次。"; }
    if (screen.alive()) draw();
  }
  return { title: "接下来", body: h("div", { class: "hm-stack" }, strip, dayBox), refresh };
}
