// The parts the home pages are built from. Class names are those of ash-ui.css (the design's components) and home.css.
import { append, btn, h, ico } from "./home-dom.js";

/** A section of the home page: a headline, something small on its right (a count, "全部 ›"), and the content. */
export function section(title, { right = null, onOpen = null, tone = "" } = {}, ...content) {
  const isNode = right !== null && typeof right === "object";
  const more = right === null ? (onOpen ? h("span", { class: "tx-sub hm-more" }, ico("chev", "i-xs")) : null) : isNode ? h("span", { class: "hm-more" }, right, onOpen ? ico("chev", "i-xs") : null) : onOpen
    ? h("span", { class: "tx-sub hm-more" }, right, ico("chev", "i-xs"))
    : h("span", { class: `tx-sub${tone ? ` c-${tone}` : ""}` }, right);
  const head = h("div", { class: "hm-head" }, h("span", { class: "tx-headline" }, title), more);
  const box = h("section", { class: "hm-section" }, head, ...content);
  if (onOpen) {
    head.classList.add("tap");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.addEventListener("click", onOpen);
    head.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } });
  }
  return box;
}

/** A row of a list: an icon tile, a title and a line under it, a value or a control on the right, and a chevron if it opens. */
export function row({ icon = null, tone = "", title, sub = null, subTone = "", value = null, valueTone = "", right = null, onClick = null, id = null, tall = false, titleTone = "", note = null } = {}) {
  const tile = icon ? h("span", { class: `lic${tone ? ` lic-${tone}` : ""}` }, ico(icon, "i-s")) : null;
  const text = h("span", { class: "lt" }, h("span", { class: `t${titleTone ? ` c-${titleTone}` : ""}` }, title),
    sub === null || sub === "" ? null : h("span", { class: `s${subTone ? ` c-${subTone}` : ""}` }, sub), note ? h("span", { class: "s hm-wrap" }, note) : null);
  const val = value === null ? null : h("span", { class: `lv${valueTone ? ` c-${valueTone}` : ""}` }, value);
  const tail = right === false ? null : right ?? (onClick ? ico("chev", "i-s chev") : null);
  const el = h(onClick ? "button" : "div", { class: `li${icon ? "" : " noic"}${onClick ? " tap" : ""}${tall ? " li-tall" : ""}`, type: onClick ? "button" : null, id, onclick: onClick }, tile, text, val, tail);
  return el;
}

export const list = (...rows) => h("div", { class: "list" }, ...rows);

/** A titled group of a page (the small grey title above, the list below). */
export const group = (title, content, foot = null) => h("div", { class: "group" }, title ? h("span", { class: "group-ttl" }, title) : null, content, foot ? h("span", { class: "group-foot" }, foot) : null);

export const tag = (text, tone = "mute") => h("span", { class: `tag tag-${tone}` }, text);

/** The empty/loading/failed line of a page. */
export const note = (text, tone = "") => h("p", { class: `hm-note${tone ? ` c-${tone}` : ""}`, role: "status" }, text);

/** A card holding free content (the design's `.list` without rows). */
export const card = (className, ...content) => h("div", { class: `list hm-card${className ? ` ${className}` : ""}` }, ...content);

/** A skeleton of [count] rows, shown while a page reads. */
export const skeleton = (count = 3) => h("div", { class: "list", "aria-hidden": "true" }, Array.from({ length: count }, () => h("div", { class: "li noic" }, h("span", { class: "sk hm-sk" }))));

/**
 * A button that takes something away asks twice: the first tap says what will happen, the second does it.
 * `warn(text)` is told what to say after the first tap. Leaving the page takes the first tap back.
 */
export function twoTap(control, { label, confirm, warn, run, onWarn = () => {} }) {
  let ready = false;
  const reset = () => { ready = false; control.textContent = label; control.classList.remove("armed"); onWarn(""); };
  control.textContent = label;
  control.disarm = reset;
  control.addEventListener("click", () => {
    if (control.disabled) return;
    if (!ready) { ready = true; control.textContent = confirm; control.classList.add("armed"); onWarn(warn); return; }
    reset();
    void run();
  });
  return control;
}

/** The top bar of a page: back, a title, and one thing on the right. */
export function navbar({ title = "", onBack, right = null, backLabel = "返回" }) {
  return h("div", { class: "navbar" }, h("button", { class: "iconbtn", type: "button", "aria-label": backLabel, onclick: onBack }, ico("back")), h("span", { class: "ttl" }, title), right ?? h("span", { class: "hm-navgap" }));
}

export { append, btn, h, ico };

/** A few words can only be done on the machine the hub runs on; the hub refuses them elsewhere, and the page says so beforehand. */
export const localHint = (ctx) => ctx.net.local ? null : note("暂停和恢复、保存和删除密钥、查看配对码，这几项只能在她所在的手机上操作。");
