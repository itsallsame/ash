// What an approval is: the gate's pending asks as the owner may see them, the evidence of a decision, and the owner's answer through
// the kernel (the first answer counts).
import { retryable } from "./link.js";
const safeText = (value, max = 240) => typeof value === "string" ? value.slice(0, max) : "";
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const choices = new Set(["once", "always", "deny"]);
export const actionLabel = (item) => item?.word === "calendar.create" ? "创建日历事件" :
  item?.word === "message.send" ? "发送消息" :
  item?.word === "browser.click" ? "在网页上点击" : item?.word === "browser.type" ? "在网页上输入" :
  item?.word === "shell.run" ? "执行命令" :
  item?.word === "rules.set" || item?.word === "rules.revoke" ? "修改审批规则" : item?.word === "mode.set" ? "修改审批档位" :
  item?.risk === "outward" ? "对外操作" : item?.risk === "structure" ? "修改资料" : "受保护操作";
export function approvalSections(view, now = Date.now()) {
  const pending = [];
  let unknownSource = 0;
  const seen = new Set();
  for (const ask of Array.isArray(view?.asks) ? view.asks : []) {
    if (!ask || !validId(ask.id) || seen.has(ask.id)) continue;
    seen.add(ask.id);
    if (ask.from !== "service:gate") {
      if (ask.from === undefined) unknownSource++;
      continue;
    }
    if (!Number.isSafeInteger(ask.seq) || ask.seq < 1 || ask.state !== "pending" || ask.options_valid !== true || !validTime(ask.expires_at) || ask.expires_at <= now) continue;
    const offered = ask.options;
    if (!Array.isArray(offered) || offered.length === 0 || offered.length > (ask.human_kind === "question" ? 8 : choices.size) ||
      !offered.every((option) => option && (ask.human_kind === "question" ? typeof option.id === "string" && option.id.length > 0 : choices.has(option.id)) && typeof option.label === "string" && option.label.length > 0) ||
      new Set(offered.map((option) => option.id)).size !== offered.length) continue;
    pending.push({ id: ask.id, seq: ask.seq, from: "service:gate", state: "pending", options_valid: true,
      human_kind: ask.human_kind, allow_custom: ask.allow_custom === true,
      title: safeText(ask.title) || "待确认的操作", detail: safeText(ask.detail, 1000),
      ...(typeof ask.original === "string" ? { original: ask.original } : {}),
      expires_at: ask.expires_at, options: offered.map((option) => ({ id: option.id, label: safeText(option.label, 80) })) });
  }
  pending.sort((a, b) => a.expires_at - b.expires_at || a.seq - b.seq);
  return { pending, unknownSource };
}

function text(parent, tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

const two = (value) => String(value).padStart(2, "0");
const at = (value, now) => {
  const date = new Date(value);
  const time = `${date.getHours()}:${two(date.getMinutes())}`;
  const day = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((day(value) - day(now)) / 86_400_000);
  if (diff === 0) return `今天 ${time}`;
  if (diff === -1) return `昨天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  return `${date.getFullYear() === new Date(now).getFullYear() ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
};
const EFFECTS = { read: "读", act: "操作", write: "改数据", send: "对外发送", execute: "执行命令", structure: "改结构" };
const DECIDED_BY = { hand_full: "设备完全放开", device_full: "设备完全放开", declared_none: "本来就不需要审批", assessed_none: "评估后无影响，直接放行", rule: "你定的规则", review: "裁判（模型判断）", carry: "沿用你几分钟前的允许", owner: "你", timeout: "没人回答，过期", cancelled: "取消了", waiting: "还在等" };
const ANSWERS = { once: "允许这一次", always: "以后都允许", deny: "不允许" };

/** One record's evidence: what was asked, what the reviewer saw and said, the card, the answer, and whether it ran. */
export function renderEvidence(parent, entry, { now = Date.now(), name = "Ash", primary = null } = {}) {
  const box = text(parent, "div", "", "hm-ev");
  const row = (label, value) => {
    if (!value) return;
    const line = text(box, "div", "", "hm-ev-row");
    text(line, "span", label, "hm-ev-label");
    text(line, "span", value, "hm-ev-value");
  };
  const effect = EFFECTS[entry.effect] ?? safeText(entry.effect, 40);
  row("谁要做", entry.requester === primary ? name : safeText(entry.requester, 80));
  // The gate's own words carry English contract labels; the owner reads them by what they do.
  const what = entry.member === "service:gate" ? actionLabel(entry) : safeText(entry.label, 120) || safeText(entry.word, 80);
  row("要做什么", `${what}${effect ? `（${effect}）` : ""}`);
  row("具体内容", safeText(entry.content, 1200));
  const facts = entry.facts && typeof entry.facts === "object" ? entry.facts : null;
  if (facts) {
    const said = Array.isArray(facts.owner_said) ? facts.owner_said.filter((item) => typeof item === "string").map((item) => `「${safeText(item, 300)}」`) : [];
    row("裁判看到你说的", said.length ? said.join("\n") : "这一轮你没有说话");
    const steps = Array.isArray(facts.context) ? facts.context.filter((item) => typeof item === "string").map((item) => safeText(item, 200)) : [];
    if (steps.length) row("裁判看到的前几步", steps.join("\n"));
  }
  const review = entry.review && typeof entry.review === "object" ? entry.review : null;
  if (review) {
    const ms = Number.isSafeInteger(review.ms) ? `，用了 ${(review.ms / 1000).toFixed(1)} 秒` : "";
    if (review.decision === "unavailable") row("裁判结论", `没判出来（${safeText(review.error, 200)}）${ms}，所以问你`);
    else row("裁判结论", `${review.decision === "allow" ? "可以直接做" : "要问你"}${ms}${safeText(review.reason, 400) ? `：${safeText(review.reason, 400)}` : ""}`);
  }
  const card = entry.card && typeof entry.card === "object" ? entry.card : null;
  if (card) {
    row("卡片上写的", [safeText(card.title, 240), safeText(card.detail, 1000)].filter(Boolean).join("\n"));
    if (card.forced) row("为什么一定问你", "改审批规则和档位，写死必须由你决定");
  }
  const answer = ANSWERS[entry.decision];
  if (answer) row("你的回答", `${answer}${validTime(entry.answered_at) ? ` · ${at(entry.answered_at, now)}` : ""}`);
  row("谁做的决定", DECIDED_BY[entry.decided_by] ?? safeText(entry.decided_by, 40));
  if (entry.decided_by !== "review" && entry.decided_by !== "carry" && safeText(entry.reason, 400) && !review) row("理由", safeText(entry.reason, 400));
  const executed = entry.executed && typeof entry.executed === "object" ? entry.executed : null;
  row("最后", executed ? executed.ok ? "做成了" : entry.decision === "deny" ? "没有做" : `没做成（${safeText(executed.message, 200) || safeText(executed.error, 60)}）` :
    ["deny", "timeout", "cancelled"].includes(entry.decision) ? "没有做" : "还没有结果");
  return box;
}

/**
 * The owner answers an approval or question card. The kernel's `send.result` is the confirmation: the first answer counts,
 * a later one is a conflict. Resolves `{id, seq}` of the recorded response.
 */
export async function answerGateAsk(net, ask, choice, clientId, { now = Date.now, answerText } = {}) {
  if (!ask || approvalSections({ asks: [ask] }, now()).pending[0]?.id !== ask.id ||
    !(ask.options.some((option) => option.id === choice) || ask.human_kind === "question" && ask.allow_custom && choice === "custom" && typeof answerText === "string" && answerText.trim()) || typeof clientId !== "string" || !clientId)
    throw new Error("待批请求已失效或选项不可用。");
  const binding = net.binding();
  if (!net.same(binding)) throw new Error("还没连上，不能回答审批。");
  const result = await net.answerAsk(ask, { choice, ...(answerText ? { text: answerText } : {}) }, clientId);
  if (!net.same(binding)) throw new Error("连接已经换过，回答结果已丢弃。");
  if (!result.ok) {
    if (result.error?.code === "forbidden") throw new Error("当前设备无权回答审批。");
    if (retryable(result.error)) throw new Error("审批回执未知；只能用同一选项原样重试。");
    throw new Error("审批回答被拒绝；请刷新记录。");
  }
  const message = result.message;
  if (typeof message?.id !== "string" || !message.id || !Number.isSafeInteger(message.seq) || message.seq <= ask.seq)
    throw new Error("审批回执无法配对；只能原样重试。");
  return { id: message.id, seq: message.seq };
}
