// Small helpers the conversation page draws with: text nodes, the designed icons, and how times are said.
import { icon } from "./ash-icons.js";
import { graphemesOf } from "./graphemes.js";

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

/** The six colours of a helper's face, in the order of the design table (tokens `helper-*`). */
export const HELPER_TONES = Object.freeze(["purple", "blue", "teal", "green", "amber", "rose"]);

/** The letter on a helper's face: the first character of its name, whole (an emoji or an accented letter is never cut). */
export function letterOf(name) {
  const first = graphemesOf(String(name ?? "").trim())[0];
  if (first === undefined) return "?";
  return /^[a-z]$/.test(first) ? first.toUpperCase() : first;
}

/** Which of the six colours a helper wears: the sum of the code points of its name, mod 6. The same name always gets the same one. */
export function toneOf(name) {
  let sum = 0;
  for (const ch of String(name ?? "").trim()) sum += ch.codePointAt(0);
  return HELPER_TONES[sum % HELPER_TONES.length];
}

/** The classes of a helper's letter face: the shared look plus its colour. */
export const letterClasses = (name) => `av-letter av-tone-${toneOf(name)}`;
