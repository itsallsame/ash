import { addIcon, text } from "./chat-ui.js";

/**
 * The "+" sheet: what each choice asks the browser for. A phone browser opens the camera for `capture`; in the Ash app
 * the same attributes reach the native picker, which opens the system camera, the photo picker or the file picker.
 */
export const ATTACH_CHOICES = Object.freeze([
  Object.freeze({ id: "photo", label: "拍照", glyph: "camera", accept: "image/*", capture: "environment", multiple: false }),
  Object.freeze({ id: "video", label: "录像", glyph: "video", accept: "video/*", capture: "environment", multiple: false }),
  Object.freeze({ id: "gallery", label: "相册", glyph: "image", accept: "image/*,video/*", capture: null, multiple: true }),
  Object.freeze({ id: "file", label: "文件", glyph: "file", accept: null, capture: null, multiple: true }),
]);

/** Point the hidden file input at one choice before it is clicked. */
export function applyChoice(input, choice) {
  if (choice.accept) input.setAttribute("accept", choice.accept); else input.removeAttribute("accept");
  if (choice.capture) input.setAttribute("capture", choice.capture); else input.removeAttribute("capture");
  input.multiple = choice.multiple;
}

/** Files picked one choice after another add up until sent (at most [limit]); a new pick never drops the earlier ones. */
export function addPicked(picked, files, limit = 32) {
  return [...picked, ...files].slice(0, limit);
}

/** The sheet over the page: the four ways to attach something, and what one message can carry. */
export function attachMenu(root, button, input) {
  const close = () => { root.hidden = true; button.setAttribute("aria-expanded", "false"); };
  const open = () => { root.hidden = false; button.setAttribute("aria-expanded", "true"); };
  root.replaceChildren();
  const scrim = text(root, "div", "", "scrim");
  scrim.addEventListener("click", close);
  const sheet = text(root, "div", "", "sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "添加附件");
  text(sheet, "span", "", "grabber");
  const grid = text(sheet, "div", "", "attach-grid");
  for (const choice of ATTACH_CHOICES) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "attach-choice";
    item.dataset.pick = choice.id;
    const tile = text(item, "span", "", "attach-tile");
    addIcon(tile, choice.glyph);
    text(item, "span", choice.label);
    item.addEventListener("click", () => { close(); applyChoice(input, choice); input.click(); });
    grid.append(item);
  }
  text(sheet, "span", "一条消息最多带约 3 MB", "tx-caption");
  close();
  button.addEventListener("click", () => { if (root.hidden) open(); else close(); });
  return { open, close };
}
