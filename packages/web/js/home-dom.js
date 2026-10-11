// Small DOM helpers for the home pages: build elements without markup strings, so nothing a member wrote is ever parsed as HTML.
import { icon } from "./ash-icons.js";

/** `h("div", { class: "x", dataset: { id: 1 }, onclick }, child, "text")`; false/null children are skipped. */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "hidden" || key === "disabled" || key === "value" || key === "checked") element[key] = value;
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
  }
  return parent;
}

export const ico = (name, size = "") => icon(name, size);

/** A <button type=button>. */
export const btn = (label, className, onclick, props = {}) => h("button", { type: "button", class: className, onclick, ...props }, label);

export const two = (value) => String(value).padStart(2, "0");
export const hhmm = (ts) => { const at = new Date(ts); return `${two(at.getHours())}:${two(at.getMinutes())}`; };
export const startOfDay = (ts) => { const at = new Date(ts); at.setHours(0, 0, 0, 0); return at.getTime(); };
const WEEK = "日一二三四五六";
export const weekday = (ts) => `周${WEEK[new Date(ts).getDay()]}`;
export const weekdayShort = (ts) => WEEK[new Date(ts).getDay()];

/** "刚刚", "3 分钟前", "今天 09:12", "昨天 …", "10月9日 …". */
export function ago(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return "";
  if (now - ts < 60_000) return "刚刚";
  if (now - ts < 3_600_000) return `${Math.floor((now - ts) / 60_000)} 分钟前`;
  return dayTime(ts, now);
}

/** "今天 09:12", "昨天 09:12", "明天 …", "10月9日 09:12" (with the year when it is not this year). */
export function dayTime(ts, now = Date.now()) {
  const diff = Math.round((startOfDay(ts) - startOfDay(now)) / 86_400_000);
  const time = hhmm(ts);
  if (diff === 0) return `今天 ${time}`;
  if (diff === -1) return `昨天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  const at = new Date(ts);
  const year = at.getFullYear() === new Date(now).getFullYear() ? "" : `${at.getFullYear()}年`;
  return `${year}${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

/** "3 秒", "2 分钟", "1.5 小时". */
export const duration = (ms) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` :
  ms < 3_600_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 360_000) / 10} 小时`;

/** Replaces the children of [parent] with [children] (null, undefined and false are skipped, unlike `replaceChildren`). */
export function fill(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}
