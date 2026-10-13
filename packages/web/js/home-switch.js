// A switch row (the design's `.sw`): a title, a line under it, and a control that says on or off.
import { h } from "./home-dom.js";

export function switchRow({ title, sub = null, checked = false, disabled = false, onChange = () => {}, id = null }) {
  const control = h("button", { type: "button", role: "switch", "aria-checked": String(checked), class: `sw${checked ? " on" : ""}`, disabled, id, "aria-label": title });
  const el = h("div", { class: "li noic hm-switchrow" }, h("span", { class: "lt" }, h("span", { class: "t" }, title), sub ? h("span", { class: "s" }, sub) : null), control);
  const set = (value) => { control.setAttribute("aria-checked", String(value)); control.classList.toggle("on", value); };
  control.addEventListener("click", () => { if (control.disabled) return; const next = control.getAttribute("aria-checked") !== "true"; set(next); onChange(next); });
  el.get = () => control.getAttribute("aria-checked") === "true";
  el.set = set;
  el.control = control;
  return el;
}
