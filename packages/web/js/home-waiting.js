// 等你的: the approvals and questions waiting for you, drawn as the same cards as in the conversation, and the decisions
// made lately (with the evidence of each).
import { actionLabel, answerGateAsk, renderEvidence } from "./approvals.js";
import { ago, dayTime, h, ico, fill } from "./home-dom.js";
import { group, list, note, row, skeleton, btn } from "./home-ui.js";
import { waitingItems } from "./home-model.js";

const DECISIONS = { once: "允许了", always: "以后都允许", deny: "拒绝了", timeout: "过期没回答：", cancelled: "取消了", rule: "按规则放行：", review: "她判断后放行：", carry: "刚允许过，沿用：", hand_full: "设备完全放开放行：", declared_none: "无影响，直接放行：", assessed_none: "评估无影响，直接放行：" };
const decisionText = (item) => `${DECISIONS[item.decision] ?? "已记录："}「${(typeof item.label === "string" && item.label) || actionLabel(item)}」`;
export const VERB = { once: "仅这一次", always: "以后都允许", deny: "已拒绝", timeout: "过期没回答", cancelled: "已取消", rule: "按规则放行", review: "由她判断后放行", carry: "刚允许过，沿用", hand_full: "设备完全放开放行", declared_none: "无影响，直接放行", assessed_none: "评估无影响，直接放行" };
const valid = (item) => item && typeof item.id === "string" && item.id && Number.isSafeInteger(item.at);

/** The same answer the conversation's card gives: a gate approval through the gate's checks, anything else as a plain answer. */
async function answer(ctx, screen, ask, choice, answerText) {
  const intents = ctx.feed.intents;
  const fresh = ctx.feed.view().asks.find((item) => item.id === ask.id) ?? ask;
  if (!fresh || fresh.seq !== ask.seq || fresh.state !== "pending") throw new Error("待批请求已失效。");
  let intent = intents.get(ask.id);
  if (intent?.choice && (intent.choice !== choice || intent.answerText !== answerText || ["pending", "confirmed", "rejected"].includes(intent.status))) return;
  if (!intent?.choice) { intent = { choice, answerText, clientId: crypto.randomUUID(), status: "pending" }; intents.set(ask.id, intent); }
  else intent.status = "pending";
  const binding = ctx.net.binding();
  try {
    if (!ctx.net.same(binding)) throw new Error("连接已经换过，回答没有送出。");
    if (ask.from === "service:gate") await answerGateAsk(ctx.net, fresh, choice, intent.clientId, { answerText });
    else {
      const custom = fresh.allow_custom && choice === "custom" && typeof answerText === "string" && answerText.trim();
      if (!custom && !fresh.options.some((option) => option.id === choice)) throw new Error("待批请求已失效或选项不可用。");
      const result = await ctx.net.answerAsk(fresh, { choice: custom ? "custom" : choice, ...(custom ? { text: answerText } : {}) }, intent.clientId);
      if (!result.ok) throw new Error(["offline", "unavailable", "timeout", "result_unknown", "internal"].includes(result.error.code) ? "回答的回执未知；只能用同一选项原样重试。" : "回答被拒绝；请刷新记录。");
    }
    intent.status = "confirmed";
  } catch (error) {
    intent.status = /无权|被拒绝|已失效|不可用/.test(error?.message || "") ? "rejected" : "uncertain";
  }
}

/** One waiting item as the card of the conversation. */
function waitingCard(ctx, screen, item, redraw, now = Date.now()) {
  const intents = ctx.feed.intents;
  const { kind, ask } = item;
  const approval = kind === "approval";
  const state = intents.get(ask.id);
  const head = h("div", { class: `card-hd c-${approval ? "warn" : "her"}` }, h("span", { class: "chip-ic", style: `background:var(--${approval ? "warn" : "her"}-soft)` }, ico(approval ? "shield" : "ask", "i-xs")),
    approval ? "需要你确认" : "她问你", h("span", { class: "exp" }, approval ? `${dayTime(ask.expires_at, now)} 前有效` : ago(ask.ts, now)));
  const el = h("article", { class: "a-card hm-wide", dataset: { askId: ask.id } }, head, h("div", { class: "card-title" }, ask.title));
  if (ask.detail) el.append(h("div", { class: "card-body" }, ask.detail));
  if (typeof ctx.jump === "function") el.append(btn("查看对话", "a-btn btn-ghost btn-sm", () => ctx.jump(ask.id)));
  if (approval && typeof ask.original === "string") {
    const full = h("pre", { class: "hm-original", hidden: true }, ask.original);
    const link = h("button", { type: "button", class: "card-link" }, "查看完整原文", ico("chev", "i-xs"));
    link.addEventListener("click", () => { full.hidden = !full.hidden; link.firstChild.textContent = full.hidden ? "查看完整原文" : "收起原文"; });
    el.append(link, full);
  }
  const busy = state?.status === "pending" || state?.status === "confirmed" || state?.status === "rejected";
  const send = (choice, text) => { void answer(ctx, screen, ask, choice, text).then(redraw); redraw(); };
  if (state?.status === "confirmed") {
    el.append(h("div", { class: "resolved ok" }, ico("check", "i-s"), "已收到你的回答"), h("p", { class: "tx-caption" }, "事情本身做没做完，看她接下来的消息。"));
    return el;
  }
  if (approval) {
    const by = (id) => ask.options.find((option) => option.id === id);
    const button = (option, cls) => option ? btn(option.label, `a-btn ${cls}`, () => send(option.id), { disabled: busy || Boolean(state?.choice && state.choice !== option.id), dataset: { choice: option.id } }) : null;
    el.append(h("div", { class: "card-acts" }, button(by("once"), "btn-primary btn-block"), h("div", { class: "two" }, button(by("always"), "btn-secondary"), button(by("deny"), "btn-neutral"))));
  } else {
    const opts = h("div", { class: "opts" }, ask.options.map((option) => btn(option.label, `opt${state?.choice && state.choice !== option.id ? " dim" : ""}${state?.choice === option.id ? " on" : ""}`, () => send(option.id), { disabled: busy, dataset: { choice: option.id } })));
    el.append(opts);
    if (ask.allow_custom) {
      const input = h("input", { type: "text", placeholder: "自己说…", class: "hm-custom", maxlength: 500, "aria-label": "自己回答" });
      const go = btn("发送", "a-btn btn-secondary btn-sm", () => { const value = input.value.trim(); if (value) send("custom", value); }, { disabled: busy });
      el.append(h("div", { class: "hm-actions" }, input, go));
    }
  }
  if (state?.status === "pending") el.append(h("p", { class: "tx-caption" }, "正在送出你的回答…"));
  else if (state?.status === "uncertain") el.append(h("p", { class: "tx-caption c-warn" }, `还没确认你的回答送到了。再点一次「${ask.options.find((option) => option.id === state.choice)?.label ?? "同一个选项"}」会原样重试。`));
  else if (state?.status === "rejected") el.append(h("p", { class: "tx-caption c-warn" }, "这次回答没有被接受；它可能已经过期，或这台设备不能回答。"));
  return el;
}

export function waitingPage(ctx, screen, arg) {
  const intents = ctx.feed.intents;
  const agent = typeof arg === "string" ? arg : ctx.agent;
  const cards = h("div", { class: "hm-stack" });
  const settledBox = h("div");
  let history = null;
  let currentPage = null;
  let loading = false;
  const draw = () => {
    const current = currentPage ? { asks: currentPage.items.map(item => item.ask).filter(Boolean) } : ctx.feed.view();
    const items = waitingItems(current).filter((item) => !agent || item.ask.from === agent);
    screen.wake("expiry", draw, Math.min(...items.map(({ ask }) => ask.expires_at)));
    fill(cards, ...(items.length ? items.map((item) => waitingCard(ctx, screen, item, draw)) : [list(row({ icon: "check", tone: "ok", title: "现在没有要你决定的事", sub: "有事她会叫你" }))]));
  };
  const drawSettled = () => {
    if (!history || !history.length) { fill(settledBox); return; }
    const last = history[0];
    fill(settledBox, list(row({ icon: "check", tone: "ok", title: `最近处理过 ${history.length} 件`, sub: `最近一件：${decisionText(last)}`, onClick: () => ctx.go("settled") })));
  };
  const older = btn("更早的问题", "a-btn btn-ghost btn-sm", () => { void load({ before: currentPage.before }); });
  const newer = btn("更新的问题", "a-btn btn-ghost btn-sm", () => { void load({ after: currentPage.after }); });
  older.hidden = newer.hidden = true;
  const load = async (params = {}) => {
    if (loading) return;
    loading = true; older.disabled = newer.disabled = true;
    try {
      currentPage = await screen.ask("service:history", "current", { limit: 40, ...params });
      if (!screen.alive()) return;
      older.hidden = !currentPage.has_more_before; newer.hidden = !currentPage.has_more_after;
      const active = new Set(currentPage.items.map(item => item.ask?.id));
      intents.prune(active);
      draw();
    } catch { /* connection state remains visible and a later refresh can retry */ }
    finally { loading = false; older.disabled = newer.disabled = false; }
  };
  screen.onView(() => { void load(currentPage?.after ? { before: currentPage.after + 1 } : {}); });
  draw();
  const refresh = async () => {
    await load();
    try { history = (await screen.ask("service:gate", "history", { limit: 100 })).items?.filter(valid).sort((a, b) => b.at - a.at) ?? []; drawSettled(); } catch { /* the cards above stand */ }
  };
  return { title: "等你的", body: h("div", { class: "hm-stack" }, cards, h("div", { class: "hm-actions" }, older, newer), settledBox), refresh };
}

/** The decisions made lately, newest first; "查看依据" opens what the gate saw and said. */
export function settledPage(ctx, screen) {
  const box = h("div", { class: "hm-stack" }, skeleton(4));
  const evidence = new Map();
  let items = null;
  const draw = () => {
    if (items === undefined) { fill(box, note("暂时读不到审批记录（不代表没有）。", "warn")); return; }
    if (!items) return;
    if (!items.length) { fill(box, list(row({ icon: "check", title: "还没有审批记录" }))); return; }
    const now = Date.now();
    fill(box, group("最近的决定", list(...items.slice(0, 40).map((item) => {
      const shown = evidence.get(item.request_id);
      const el = row({ icon: item.decision === "deny" ? "x" : "check", tone: item.decision === "deny" ? "err" : "ok", title: (typeof item.label === "string" && item.label) || actionLabel(item), sub: `${VERB[item.decision] ?? "已记录"} · ${dayTime(item.at, now)}`, note: (item.decision === "review" || item.decision === "carry") && typeof item.reason === "string" ? item.reason.slice(0, 200) : null,
        right: typeof item.request_id === "string" ? btn(shown ? "收起" : "查看依据", "a-btn btn-ghost btn-sm", () => toggle(item.request_id)) : null });
      if (shown) {
        const body = h("div", { class: "hm-evidence" });
        if (shown.status === "loading") body.append(note("正在读取…"));
        else if (shown.status === "missing") body.append(note("这条没有留下依据（多半是证据记录上线之前的）。"));
        else if (shown.status === "failed") body.append(note("暂时读不到依据（不代表没有），稍后再点一次。", "warn"));
        else renderEvidence(body, shown.entry, { now, name: ctx.name, primary: ctx.net.primary });
        return h("div", { class: "hm-evrow" }, el, body);
      }
      return el;
    }))));
  };
  const toggle = async (id) => {
    if (evidence.has(id)) { evidence.delete(id); draw(); return; }
    evidence.set(id, { status: "loading" }); draw();
    let next;
    try {
      const result = await screen.ask("service:gate", "audit", { request_id: id, limit: 1 });
      const entry = Array.isArray(result?.entries) ? result.entries.find((item) => item?.request_id === id) : undefined;
      next = entry ? { status: "ready", entry } : { status: "missing" };
    } catch { next = { status: "failed" }; }
    if (!screen.alive() || !evidence.has(id)) return;
    evidence.set(id, next); draw();
  };
  const refresh = async () => {
    try { items = (await screen.ask("service:gate", "history", { limit: 100 })).items?.filter(valid).sort((a, b) => b.at - a.at) ?? []; } catch { items = undefined; }
    if (screen.alive()) draw();
  };
  return { title: "处理过的事", body: box, refresh };
}
