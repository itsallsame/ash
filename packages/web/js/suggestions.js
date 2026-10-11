const labels = Object.freeze({ activity: "活动", upcoming: "接下来", approvals: "审批", identity: "身份", memory: "记忆", settings: "设置", turn: "当前任务", file: "文件" });

/**
 * The kernel asks this page to open a page (`chat open`, SPEC-03 §5.4). [request] is `{target, id?, mode?}`; without a mode
 * it is an order ("perform"). A suggestion shows a small chip and answers `false` at once: the answer describes this
 * request, not a later click. Resolves with whether the page was opened.
 */
export async function presentUiOpen(root, request, open) {
  const { target, mode = "perform" } = request ?? {};
  if (!Object.hasOwn(labels, target) || !["perform", "suggest"].includes(mode)) return false;
  if (mode === "perform") return (await open(target, request)) === true;
  const chip = document.createElement("div");
  chip.className = "suggestion ctx";
  const label = document.createElement("span");
  label.textContent = `Ash 建议查看${labels[target]}`;
  const show = document.createElement("button");
  show.type = "button";
  show.textContent = "打开";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  show.addEventListener("click", () => { chip.remove(); void open(target, request); });
  close.addEventListener("click", () => chip.remove());
  chip.append(label, show, close);
  root.replaceChildren(chip);
  return false;
}
