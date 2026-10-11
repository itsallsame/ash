import { safeActivityView } from "./activity-model.js";
import { addIcon, text } from "./chat-ui.js";

/** A small pill over the composer for the latest real turn; never reads request bodies or raw tool names. */
export function renderProgress(root, view, { now = Date.now(), onOpen } = {}) {
  root.replaceChildren();
  const turns = Object.entries(safeActivityView(view).turns)
    .filter(([, turn]) => !turn.background && (!turn.ended || now - turn.ended < 60_000))
    .sort((a, b) => b[1].started - a[1].started);
  if (!turns.length) { root.hidden = true; return; }
  const [id, turn] = turns[0];
  // A plain reply did nothing worth reporting; "做了 0 步" under every message is noise.
  if (turn.ended && !turn.steps.length) { root.hidden = true; return; }
  root.hidden = false;
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "pill progress-button";
  pill.dataset.turn = id;
  pill.setAttribute("aria-label", "查看活动");
  const seconds = Math.max(0, Math.floor((Math.min(now, turn.ended ?? now) - turn.started) / 1000));
  if (turn.ended) {
    addIcon(pill, "check", "i-xs");
    text(pill, "b", `做了 ${turn.steps.filter((step) => !step.summary).length} 步`);
  } else {
    text(pill, "span", "", "spinner");
    text(pill, "b", turn.steps.at(-1)?.label || "正在处理");
  }
  text(pill, "span", `· ${seconds} 秒`, "pill-time");
  addIcon(pill, "chev", "i-xs");
  pill.addEventListener("click", () => onOpen?.(id));
  root.append(pill);
}
