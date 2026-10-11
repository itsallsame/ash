import { addIcon, avatarUrl, text } from "./chat-ui.js";

/** What is shown for an agent that can be picked: the status line under its name. */
const statusOf = (agent) => agent.reachable === false ? "暂时用不了" : agent.state === "starting" ? "启动中" : agent.state === "working" ? agent.summary || "工作中" : agent.summary || (agent.primary ? "在线" : "就绪");
const LETTER_FILLS = Object.freeze(["her", "you", "warn", "ok"]);
const letterFill = (id) => LETTER_FILLS[[...String(id)].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % LETTER_FILLS.length];

/** The face of an agent: Ash's own for the primary one, a letter on a colour for a helper. */
function face(parent, agent, className) {
  if (agent.primary) {
    const holder = text(parent, "span", "", `av ${className}`);
    const image = document.createElement("img");
    image.src = avatarUrl("default");
    image.alt = "";
    holder.append(image);
    if (agent.reachable !== false) text(holder, "span", "", "dot");
    return holder;
  }
  return text(parent, "span", String(agent.name ?? "?").slice(0, 1), `av-letter ${className} fill-${letterFill(agent.id)}`);
}

/**
 * Explicit addressing: selecting one recipient never broadcasts or wakes the primary agent. The control is the small face at
 * the left of the input; it opens the "who to talk to" sheet. [field] is the composer's field, where the control sits.
 */
export function agentPicker(form, input, net, changed = () => {}, { field = form } = {}) {
  /** The agent the owner picked; none means the hub's primary agent. */
  let selected = null;
  const basePlaceholder = input.placeholder;
  const names = new Map();
  const nameOf = (id) => id ? names.get(id) ?? id.replace(/^agent:/, "") : "…";
  const control = document.createElement("button"); control.type = "button"; control.className = "to";
  const label = () => {
    const name = nameOf(selected?.id ?? net.primary);
    control.setAttribute("aria-label", `正在跟 ${name} 说，点按换人`);
    control.title = `跟 ${name} 说`;
    control.dataset.to = selected?.id ?? net.primary ?? "";
    control.replaceChildren();
    if (selected && !selected.primary) face(control, selected, "to-letter");
    else { const image = document.createElement("img"); image.src = avatarUrl("default"); image.alt = ""; control.append(image); }
  };
  label();
  const panel = document.createElement("div"); panel.className = "layer"; panel.hidden = true;
  const scrim = text(panel, "div", "", "scrim");
  const sheet = text(panel, "div", "", "sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "跟谁说");
  text(sheet, "span", "", "grabber");
  text(sheet, "span", "跟谁说", "tx-headline sheet-title");
  const rows = text(sheet, "div", "", "list");
  text(sheet, "span", "在输入框里打 @ 也能选。帮手都由 Ash 带着。", "tx-caption");
  form.before(panel); field.prepend(control);
  const close = () => { panel.hidden = true; control.setAttribute("aria-expanded", "false"); };
  scrim.addEventListener("click", close);
  const list = async () => {
    const { agents } = await net.data("service:agents", "list");
    if (!Array.isArray(agents)) throw new Error("agent list invalid");
    const known = agents.filter((agent) => agent && typeof agent.id === "string" && typeof agent.name === "string");
    for (const agent of known) names.set(agent.id, agent.name);
    return known;
  };
  async function open() {
    panel.hidden = false; control.setAttribute("aria-expanded", "true");
    rows.replaceChildren();
    text(rows, "div", "", "li sk-row");
    try {
      const agents = await list(); rows.replaceChildren();
      for (const agent of agents) {
        const row = document.createElement("button"); row.type = "button"; row.className = "li";
        // Reachable: the agent takes messages (its process may still be starting; what is said waits in its inbox).
        row.disabled = agent.reachable === false;
        face(row, agent, "av-40");
        const words = text(row, "span", "", "lt");
        text(words, "span", agent.name, "t");
        text(words, "span", statusOf(agent), `s${agent.state === "working" && agent.reachable !== false ? " c-her" : ""}`);
        if ((selected?.id ?? net.primary) === agent.id) addIcon(row, "check", "chev-on");
        row.title = `${agent.name} · ${statusOf(agent)}`;
        row.onclick = () => { selected = agent; label(); close(); input.value = input.value.replace(/^@\s*/, ""); input.placeholder = `跟 ${agent.name} 说点什么…`; input.focus(); };
        rows.append(row);
      }
    } catch { rows.replaceChildren(); text(rows, "div", "暂时无法读取名单，连上后重试", "li sheet-note"); }
  }
  control.onclick = () => { if (panel.hidden) void open(); else close(); };
  input.addEventListener("input", () => { if (input.value === "@") void open(); });
  return { target: () => selected?.id ?? net.primary, name: nameOf, close,
    /** The helper chosen to talk to, when it is not the primary agent. */
    picked: () => selected && selected.id !== net.primary ? selected.id : undefined,
    async refresh() {
      try {
        await net.primaryLoad;
        const agents = await list();
        // An agent that is gone cannot stay the recipient: back to the primary one.
        if (selected && !agents.some((agent) => agent.id === selected.id)) { selected = null; input.placeholder = basePlaceholder; }
        label();
        changed();
      } catch { /* retry on the next connection */ }
    },
  };
}
