// 她做过的事: a timeline of her turns by day (a chip per day), the steps of a turn, and the background work as one row.
import { safeActivityView } from "./activity-model.js";
import { activityByDay, chipLabel } from "./home-model.js";
import { btn, h, ico } from "./home-ui.js";
import { duration, hhmm, fill } from "./home-dom.js";
import { readAgents } from "./home-data.js";
import { HELPER } from "./home-text.js";
import { outcomeText } from "./activity-model.js";

const OUTCOME_TONE = { running: "her", completed: "ok", cancelled: "3", error: "err", ended: "3" };

function stepRow(step, turn, now, detail) {
  const ended = Number.isFinite(turn.ended);
  const waiting = step.state === "waiting_owner";
  const running = !waiting && (step.state === "pending" && !ended || step.state === "accepted");
  const lead = running || waiting ? h("span", { class: "spinner hm-step-spin" }) : step.state === "failed" ? ico("x", "i-xs c-err") : step.state === "ok" || step.summary ? ico("check", "i-xs c-ok") : ico("alert", "i-xs c-3");
  const label = waiting ? `等你确认：${step.label}` : step.label || "处理了一步";
  const took = step.tool && Number.isFinite(step.ts) && !waiting ? duration(Math.max(0, (step.ended ?? turn.ended ?? now) - step.ts)) : "";
  const tail = waiting ? h("span", { class: "tx-caption c-warn" }, "还没执行") : step.state === "unconfirmed" ? h("span", { class: "tx-caption c-warn" }, "记录不完整")
    : step.state === "pending" && ended ? h("span", { class: "tx-caption c-warn" }, "结果未确认") : took ? h("span", { class: "tx-caption" }, took) : null;
  return h("li", { class: "hm-step", dataset: { state: step.state ?? "" } }, h("span", { class: "hm-step-line" }, lead, h("span", { class: "hm-step-label" }, label), tail), detail);
}

/** The "查看调用与结果" of a step: what was asked and answered, read in pages when opened. */
function stepDetail(step, loadDetails, state) {
  if (!step.requestId || typeof loadDetails !== "function") return null;
  const saved = state.get(step.requestId) ?? { open: false, text: "", next: 0 };
  state.set(step.requestId, saved);
  const details = h("details", { class: "hm-detail" }, h("summary", {}, "查看调用与结果"));
  details.open = saved.open;
  const pre = h("pre", {}, saved.text);
  const more = btn("继续查看", "a-btn btn-ghost btn-sm", null, { hidden: saved.next === null });
  details.append(pre, more, h("small", { class: "tx-caption" }, "敏感字段已隐藏；这里展示执行记录，不是审批按钮。"));
  const load = async () => {
    if (saved.loading || saved.next === null) return;
    saved.loading = true; more.disabled = true;
    try { const result = await loadDetails(step.requestId, saved.next); saved.text += result.text; saved.next = result.next_offset; pre.textContent = saved.text; more.hidden = saved.next === null; }
    catch (error) { pre.textContent = `${saved.text}\n${error.message || "读取失败，请重试"}`; }
    finally { saved.loading = false; more.disabled = false; }
  };
  details.addEventListener("toggle", () => { saved.open = details.open; if (saved.open && !saved.text) void load(); });
  more.addEventListener("click", load);
  return details;
}

export function activityPage(ctx, screen, arg) {
  const agent = typeof arg === "string" ? arg : ctx.agent;
  const chips = h("div", { class: "hm-chips-row", role: "tablist" });
  const timeline = h("div", { class: "hm-timeline" });
  const empty = h("p", { class: "hm-note", hidden: true }, "还没有活动记录。她做过的事会按天出现在这里。");
  const state = { latest: null, agents: new Map(), day: null, open: new Set(), seen: new Set(), backgroundOpen: false, details: new Map(), items: [], steps: new Map(), page: null, loading: false };
  const loadDetails = async (id, offset = 0) => {
    let data;
    try { data = await screen.ask("service:history", "activity", { id, offset }); } catch { throw new Error("详情暂时无法读取"); }
    const text = (Array.isArray(data.items) ? data.items : []).map((item) => item?.text).filter((part) => typeof part === "string").join("\n");
    return { text, next_offset: Number.isSafeInteger(data.next_offset) ? data.next_offset : null };
  };

  const titleOf = (turn) => turn.background ? `${state.agents.get(turn.agent) ?? HELPER} 在后台工作`.trim() : turn.title || "对话";
  const turnEl = (turn, now, askable) => {
    const out = outcomeText(turn);
    const open = state.open.has(turn.id) || (!state.seen.has(turn.id) && (out.key === "running" || turn.id === state.latest));
    const stepPage = state.steps.get(turn.id);
    const steps = Array.isArray(turn.steps) ? turn.steps : [];
    if (open && !stepPage) { state.steps.set(turn.id, { loading: true, items: [] }); void loadSteps(turn.id); }
    const dot = h("span", { class: `hm-dot ${out.key}` });
    const title = h("button", { type: "button", class: "hm-turn-title", "aria-expanded": String(open), onclick: () => { if (state.open.has(turn.id)) state.open.delete(turn.id); else state.open.add(turn.id); state.seen.add(turn.id); draw(); } }, titleOf(turn));
    const body = h("div", { class: "hm-turn-body" }, title);
    const outcomeLine = h("span", { class: `tx-caption c-${OUTCOME_TONE[out.key]}` }, out.label);
    if (open && steps.length) {
      body.append(h("ol", { class: "hm-steps" }, steps.map((step) => stepRow(step, turn, now, stepDetail(step, loadDetails, state.details)))));
    } else body.append(outcomeLine);
    if (open && steps.length) body.append(outcomeLine);
    if (open && stepPage?.has_more_before) body.append(btn("更早的步骤", "a-btn btn-ghost btn-sm", () => { void loadSteps(turn.id, { before: stepPage.before }); }));
    if (open && stepPage?.has_more_after) body.append(btn("更新的步骤", "a-btn btn-ghost btn-sm", () => { void loadSteps(turn.id, { after: stepPage.after }); }));
    if (open && askable) body.append(btn([ico("chat", "i-xs"), "问问她这件事"].flat(), "a-btn btn-ghost btn-sm hm-ask", () => ctx.compose?.(`关于${turn.title || "这件事"}，`, { turn: turn.id })));
    if (open && turn.message_id && typeof ctx.jump === "function") body.append(btn("查看对话", "a-btn btn-ghost btn-sm", () => ctx.jump(turn.message_id)));
    return h("div", { class: "hm-turn", dataset: { turn: turn.id } }, h("span", { class: "tx-caption tx-num hm-turn-time" }, hhmm(turn.started)), h("span", { class: "hm-rail" }, dot, h("span", { class: "hm-rail-line" })), body);
  };

  const draw = () => {
    const now = Date.now();
    const raw = { turns: Object.fromEntries(state.items.map(turn => [turn.id, { ...turn, steps: state.steps.get(turn.id)?.items ?? [] }])) };
    const safe = safeActivityView(raw).turns;
    const days = activityByDay(raw, now, agent).map((day) => ({ ...day, front: day.front.filter((turn) => safe[turn.id]).map((turn) => ({ ...turn, ...safe[turn.id], id: turn.id })), back: day.back.filter((turn) => safe[turn.id]).map((turn) => ({ ...turn, ...safe[turn.id], id: turn.id })) }));
    state.running = days.some((day) => [...day.front, ...day.back].some((turn) => !Number.isFinite(turn.ended)));
    empty.hidden = days.length > 0;
    if (!days.length) { fill(chips); fill(timeline); return; }
    state.latest = days.find((item) => item.day === state.day)?.front[0]?.id ?? days[0].front[0]?.id ?? null;
    if (state.day === null || !days.some((day) => day.day === state.day)) state.day = days[0].day;
    fill(chips, ...days.slice(0, 14).map((day) => btn(`${chipLabel(day.day, now)} · ${day.front.length + day.back.length}`, `hm-daychip${day.day === state.day ? " on" : ""}`, () => { state.day = day.day; draw(); }, { role: "tab", "aria-selected": String(day.day === state.day) })));
    const day = days.find((item) => item.day === state.day);
    const nodes = day.front.map((turn) => turnEl(turn, now, true));
    if (day.back.length) {
      const names = [...new Set(day.back.map((turn) => titleOf(turn)))].slice(0, 2).join(" · ");
      nodes.push(h("button", { type: "button", class: "hm-bgrow", "aria-expanded": String(state.backgroundOpen), onclick: () => { state.backgroundOpen = !state.backgroundOpen; draw(); } },
        ico("moon", "i-s c-her"), h("span", { class: "hm-bgrow-t" }, h("b", {}, `后台做的 ${day.back.length} 件`), h("span", { class: "tx-caption" }, names)), ico(state.backgroundOpen ? "up" : "down", "i-s c-3")));
      if (state.backgroundOpen) nodes.push(h("div", { class: "hm-bgbox" }, day.back.map((turn) => turnEl(turn, now, false))));
    }
    fill(timeline, ...nodes);
  };
  const older = btn("更早的记录", "a-btn btn-ghost btn-sm", () => load({ before: state.page.before }));
  const newer = btn("更新的记录", "a-btn btn-ghost btn-sm", () => load({ after: state.page.after }));
  const pages = h("div", { class: "hm-actions" }, older, newer);
  const load = async (params = {}) => {
    if (state.loading) return;
    state.loading = true; older.disabled = newer.disabled = true;
    try {
      const page = await screen.ask("service:history", "activity.page", { limit: 30, ...(agent ? { agent } : {}), ...params });
      if (!screen.alive()) return;
      state.page = page;
      state.items = page.items;
      const ids = new Set(page.items.map(item => item.id));
      for (const id of state.steps.keys()) if (!ids.has(id)) state.steps.delete(id);
      for (const id of state.open) if (!ids.has(id)) state.open.delete(id);
      for (const id of state.seen) if (!ids.has(id)) state.seen.delete(id);
      const detailIds = new Set([...state.steps.values()].flatMap(page => page.items.map(step => step.requestId ?? step.id)));
      for (const id of state.details.keys()) if (!detailIds.has(id)) state.details.delete(id);
      older.hidden = !page.has_more_before; newer.hidden = !page.has_more_after;
      draw();
    } catch { /* Keep the current page until a later refresh succeeds. */ } finally { state.loading = false; older.disabled = newer.disabled = false; }
  };
  const loadSteps = async (id, params = {}) => {
    try {
      const page = await screen.ask("service:history", "activity.page", { turn: id, limit: 40, ...params });
      if (!screen.alive() || !state.items.some(turn => turn.id === id)) return;
      page.items = page.items.map(step => ({ ...step, requestId: step.requestId ?? step.id }));
      state.steps.set(id, page);
      const detailIds = new Set([...state.steps.values()].flatMap(page => page.items.map(step => step.requestId ?? step.id)));
      for (const key of state.details.keys()) if (!detailIds.has(key)) state.details.delete(key);
      draw();
    } catch { state.steps.delete(id); }
  };
  screen.onView(() => { void load(state.page?.after ? { before: state.page.after + 1 } : {}).catch(() => {}); });
  // Only a turn still running has times that move by themselves.
  screen.every(() => { if (state.running) draw(); }, 5000);
  draw();
  const refresh = async () => { await load(); try { for (const agent of await readAgents(screen)) state.agents.set(agent.id, agent.name); draw(); } catch { /* ids stay */ } };
  return { title: "她做过的事", body: h("div", { class: "hm-activity" }, chips, empty, timeline, pages), refresh };
}
