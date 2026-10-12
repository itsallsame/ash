// What the home pages say, worked out from the ledger view and the services' answers: plain functions, no DOM.
import { approvalSections } from "./approvals.js";
import { startOfDay } from "./home-dom.js";
import { graphemesOf } from "./graphemes.js";

const DAY = 86_400_000;

/** Everything waiting for the owner: gate approvals first (soonest to expire first), then the questions members asked. */
export function waitingItems(view, now = Date.now()) {
  const approvals = approvalSections(view, now).pending.map((ask) => ({ kind: "approval", ask }));
  const questions = (Array.isArray(view?.asks) ? view.asks : [])
    .filter((ask) => ask?.from !== "service:gate" && ask.state === "pending" && ask.expires_at > now && (ask.options_valid === true || ask.allow_custom === true))
    .sort((a, b) => a.seq - b.seq)
    .map((ask) => ({ kind: "question", ask }));
  return [...approvals, ...questions];
}

/** How many turns (of her or of one agent) began on the day of [now]. */
export function turnsToday(view, now = Date.now(), agent = null) {
  const from = startOfDay(now);
  return Object.values(view?.turns ?? {}).filter((turn) => Number.isFinite(turn?.started) && turn.started >= from && turn.started < from + DAY && (!agent || turn.agent === agent)).length;
}

/** The turns of the page's view as the activity page lists them: newest first, split into her conversations and background work. */
export function activityByDay(view, now = Date.now(), agent = null) {
  const turns = Object.entries(view?.turns ?? {})
    .filter(([id, turn]) => /^[A-Za-z0-9_-]{1,128}$/.test(id) && turn && Number.isFinite(turn.started) && (!agent || turn.agent === agent))
    .map(([id, turn]) => ({ id, ...turn }))
    .sort((a, b) => b.started - a.started);
  const days = new Map();
  for (const turn of turns) {
    const key = startOfDay(turn.started);
    if (!days.has(key)) days.set(key, { day: key, front: [], back: [] });
    days.get(key)[turn.background === true ? "back" : "front"].push(turn);
  }
  return [...days.values()].sort((a, b) => b.day - a.day);
}

/** The label of a day chip: "今天", "昨天", "10月9日". */
export function chipLabel(day, now = Date.now()) {
  const diff = Math.round((startOfDay(day) - startOfDay(now)) / DAY);
  if (diff === 0) return "今天";
  if (diff === -1) return "昨天";
  const at = new Date(day);
  return `${at.getMonth() + 1}月${at.getDate()}日`;
}

const plain = (value) => value.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();

/**
 * USER.md / MEMORY.md as the memory page shows them: one group per second-level heading, one row per line of it. A line
 * before any heading goes in a group without a title. The file's own title (a first-level heading) is not a row.
 */
export function groupMemory(markdown) {
  const groups = [];
  let current = null;
  for (const raw of String(markdown ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      if (heading[1].length === 1) { current = null; continue; }
      current = { title: plain(heading[2]), items: [] };
      groups.push(current);
      continue;
    }
    if (/^---+$|^<!--/.test(line)) continue;
    const text = plain(line.replace(/^(?:[-*+]|\d+[.)])\s+/, ""));
    if (!text) continue;
    if (!current) { current = { title: "", items: [] }; groups.push(current); }
    current.items.push(text);
  }
  return groups.filter((group) => group.items.length);
}

/** Every memory row of a list of groups. */
export const memoryCount = (groups) => groups.reduce((total, group) => total + group.items.length, 0);

/** A group whose rows are things she must not forget: they are drawn in the warning colour. */
export const urgentGroup = (title) => /要紧|重要|注意|禁忌|过敏|务必/.test(title);

/** How long a short label on the home page may be, in characters; a longer one is cut to one fewer and ends in "…". */
const CHIP_LIMIT = 12;
const isDigit = (ch) => ch !== undefined && ch >= "0" && ch <= "9";

/**
 * A memory line as a short label: the half before its first "：" or ":" (a ":" between digits, as in a time, is not one),
 * otherwise up to its first "，", "。", "；" or "、" (a line that starts with the colon is read after it); over 12 characters it keeps 11 and ends in "…". The line itself is not changed.
 */
export function memoryChip(line) {
  let full = String(line ?? "").trim();
  let head = "";
  for (let i = 0; i < full.length; i++) {
    const ch = full[i];
    if (ch !== "：" && !(ch === ":" && !(isDigit(full[i - 1]) && isDigit(full[i + 1])))) continue;
    head = full.slice(0, i).trim();
    if (!head) full = full.slice(i + 1).trim();
    break;
  }
  if (!head) {
    const clause = /[，。；、]/.exec(full);
    head = clause ? full.slice(0, clause.index).trim() : full;
  }
  if (!head) head = full;
  const chars = graphemesOf(head);
  return chars.length > CHIP_LIMIT ? `${chars.slice(0, CHIP_LIMIT - 1).join("")}…` : head;
}

/**
 * The labels of the home page's "她记得你": at most [limit] in all, the urgent groups' lines first. Up to [limit] lines are all
 * shown; more than that, [limit] - 1 of them and a last label that says how many are left out (`more`).
 */
export function memoryChips(groups, limit = 5) {
  const all = (groups ?? []).flatMap((group) => group.items.map((line) => ({ text: memoryChip(line), urgent: urgentGroup(group.title) })));
  all.sort((a, b) => Number(b.urgent) - Number(a.urgent));
  const shown = all.length > limit ? limit - 1 : all.length;
  return { chips: all.slice(0, shown), more: all.length - shown };
}

/** The times a timer fires in [from, to): its next time, and every repeat of it. */
export function occurrences(timer, from, to) {
  const out = [];
  if (!Number.isFinite(timer?.next)) return out;
  const step = Number.isSafeInteger(timer.every) && timer.every >= 60 ? timer.every * 1000 : 0;
  let at = timer.next;
  if (step && at < from) at += Math.ceil((from - at) / step) * step;
  for (let count = 0; at < to && count < 500; count++) { if (at >= from) out.push(at); if (!step) break; at += step; }
  return out;
}

/** Seven days from today: each with the number of things that happen on it. */
export function weekStrip(timers, now = Date.now()) {
  const today = startOfDay(now);
  return Array.from({ length: 7 }, (_, index) => {
    const day = today + index * DAY;
    const end = new Date(day); end.setDate(end.getDate() + 1);
    const to = end.getTime();
    return { day, count: timers.reduce((sum, timer) => sum + occurrences(timer, day, to).length, 0) };
  });
}

/** The things happening on one day, by time. A repeating timer shows once on each day it falls. */
export function dayItems(timers, day) {
  const end = new Date(day); end.setDate(end.getDate() + 1);
  return timers.flatMap((timer) => occurrences(timer, day, end.getTime()).map((at) => ({ at, timer })))
    .sort((a, b) => a.at - b.at);
}

/** The first [limit] things that will happen: the next time of each timer, soonest first. */
export const nextUp = (timers, limit = 5) => [...timers].sort((a, b) => a.next - b.next).slice(0, limit);
