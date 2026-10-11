// Small helpers the conversation page draws with: text nodes, the designed icons, and how times are said.
import { icon } from "./ash-icons.js";

const AVATAR_ROOT = globalThis.location?.origin === "https://appassets.androidplatform.net" ? "/assets/ash-ui/avatars" : "/avatars";
/** Where the face [name] (default, thinking, listening...) is served: the browser's own server, or the app's packaged assets. */
export const avatarUrl = (name) => `${AVATAR_ROOT}/${name}.webp`;

/** Appends `<tag class>value</tag>` and returns it. */
export function text(parent, tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
}

/** Appends the designed icon [name]; a page without SVG support (a test's stand-in document) just goes without. */
export function addIcon(parent, name, className = "") {
  if (typeof document.createElementNS !== "function") return null;
  const svg = icon(name, className);
  parent.append(svg);
  return svg;
}

/** A `<button type=button class>` with an optional leading icon and a label. */
export function button(parent, label, className = "", glyph = "", glyphClass = "") {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  if (glyph) { addIcon(node, glyph, glyphClass); if (label) text(node, "span", label); }
  else node.textContent = label;
  parent.append(node);
  return node;
}

const two = (n) => String(n).padStart(2, "0");
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hhmm = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;

/** "今天 09:12", "昨天 22:40", "10月3日 08:00". */
export function dayStamp(ts, now = Date.now()) {
  const d = new Date(ts);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(d, today)) return `今天 ${hhmm(d)}`;
  if (sameDay(d, yesterday)) return `昨天 ${hhmm(d)}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(d)}`;
}

/** "今天 23:59 前有效": when a question stops waiting for an answer. */
export function validUntil(ts, now = Date.now()) {
  const d = new Date(ts);
  const today = new Date(now);
  const tomorrow = new Date(now + 86_400_000);
  const day = sameDay(d, today) ? "今天" : sameDay(d, tomorrow) ? "明天" : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${day} ${hhmm(d)} 前有效`;
}

/** The letter on a helper's face: the first character of its name that tells it apart ("小研" is 研, not 小). */
export function letterOf(name) {
  const chars = [...String(name ?? "").trim()];
  if (!chars.length) return "?";
  return (chars.length > 1 ? chars.find((ch) => !"小阿老大".includes(ch)) : undefined) ?? chars[0];
}
