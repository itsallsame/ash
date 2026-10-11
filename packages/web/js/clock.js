// The clock's timers as the plans page reads them, and the two words the page calls on it. A plan is removed only after the clock
// confirmed its cancel; the clock's own list is authoritative.
import { retryable } from "./link.js";
const rawRoute = /\b(?:agent|worker|device|service|person):[A-Za-z0-9_-]+\b|\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\b/i;
const human = (value) => value == null || typeof value === "string" && value.length <= 160 && !rawRoute.test(value);

/** The timers of a `service:clock/list` answer (its data), checked; a malformed one is an error, never an empty list. */
export function normalizeClockList(data) {
  const timers = data?.timers;
  if (!Array.isArray(timers)) throw new Error("暂时读不到计划（不代表没有）。");
  if (timers.some((item) => !item || typeof item.id !== "string" || !item.id ||
    !Number.isSafeInteger(item.next) || item.next < 0 || item.next > 8_640_000_000_000_000 ||
    item.every != null && (!Number.isSafeInteger(item.every) || item.every < 60) ||
    !human(item.label) || !human(item.blocked))) throw new Error("暂时读不到计划（不代表没有）。");
  return timers.map((item) => ({ id: item.id, next: item.next, every: Number.isSafeInteger(item.every) && item.every >= 60 ? item.every : null,
      to: typeof item.to === "string" ? item.to : null, by: typeof item.created_by === "string" ? item.created_by : null, word: typeof item.word === "string" ? item.word : null,
      label: typeof item.label === "string" ? item.label : "", blocked: typeof item.blocked === "string" ? "请稍后再看" : null }));
}

/**
 * The plans the system makes for its own upkeep (reloading memory, waking on a pulse, whatever is added later) are not the owner's
 * to read or delete. The clock says who made a plan and what it is aimed at: a plan made by a service, or aimed at a service, is the
 * system's (the owner's and her agents' plans are made by a person or an agent and wake an agent or speak to a person). A name
 * that looks like a code (`remind:water`) proves nothing when an agent made it; the name is only a guess for a plan whose maker
 * and target the clock did not say (`pulse:wake:…`: a word, a colon, more, no space; or a bare code with a long run of digits).
 */
export const isSystemPlan = (timer) => {
  const by = timer?.by ?? null;
  const to = timer?.to ?? null;
  if (/^service:/.test(by ?? "") || /^service:/.test(to ?? "")) return true;
  if (by !== null || to !== null) return false;
  const label = timer?.label ?? "";
  return /^[a-z][a-z0-9_-]*(:[^\s:]+)+$/i.test(label) || /^[\x21-\x7e]*\d{9,}[\x21-\x7e]*$/.test(label);
};

/** The plans of [timers] that are the owner's to see. */
export const userPlans = (timers) => timers.filter((timer) => !isSystemPlan(timer));

/** How often a timer repeats, in the owner's words. */
export function repeatText(every) {
  if (!Number.isSafeInteger(every) || every < 60) return "只一次";
  if (every % 604_800 === 0) return every === 604_800 ? "每周" : `每 ${every / 604_800} 周`;
  if (every % 86_400 === 0) return every === 86_400 ? "每天" : `每 ${every / 86_400} 天`;
  if (every % 3_600 === 0) return every === 3_600 ? "每小时" : `每 ${every / 3_600} 小时`;
  if (every % 60 === 0) return `每 ${every / 60} 分钟`;
  return `每 ${every} 秒`;
}


/** A word of the clock on the connection [binding] stands for; its data, or an error the owner can read. */
async function clockRequest(net, binding, word, body, clientId) {
  if (!net.same(binding)) throw new Error("还没连上，暂时不能读取或修改计划。");
  const reply = await net.call("service:clock", word, body, clientId ? { clientId } : undefined);
  if (!net.same(binding)) throw new Error("连接已经换过，这次的结果没有采用。");
  if (!reply.ok) throw new Error(reply.error?.code === "forbidden" ? "这台设备不能修改计划。" :
    retryable(reply.error) ? "还没确认结果；再点一次会原样重试。" : "没有收到确认，可以再试一次。");
  return reply.result?.data ?? {};
}

export async function listClock(net, binding) {
  return userPlans(normalizeClockList(await clockRequest(net, binding, "list", {})));
}

export async function cancelClock(net, binding, id, clientId) {
  if (typeof id !== "string" || !id || typeof clientId !== "string" || !clientId) throw new TypeError("invalid clock cancel intent");
  const data = await clockRequest(net, binding, "cancel", { id }, clientId);
  if (data.cancelled !== true) throw new Error("没能删除这条计划，它还在。");
}
