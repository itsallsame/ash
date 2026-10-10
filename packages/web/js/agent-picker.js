/** Explicit addressing: selecting one recipient never broadcasts or wakes the primary agent. */
export function agentPicker(form, input, net, changed = () => {}) {
  /** The agent the owner picked; none means the hub's primary agent. */
  let selected = null;
  const basePlaceholder = input.placeholder;
  const names = new Map();
  const nameOf = (id) => id ? names.get(id) ?? id.replace(/^agent:/, "") : "…";
  const control = document.createElement("button"); control.type = "button"; control.className = "agent-recipient";
  const label = () => { control.textContent = `@ ${nameOf(selected?.id ?? net.primary)}`; };
  label();
  const panel = document.createElement("div"); panel.className = "agent-picker"; panel.hidden = true;
  form.before(panel); form.prepend(control);
  const list = async () => {
    const { agents } = await net.data("service:agents", "list");
    if (!Array.isArray(agents)) throw new Error("agent list invalid");
    const known = agents.filter((agent) => agent && typeof agent.id === "string" && typeof agent.name === "string");
    for (const agent of known) names.set(agent.id, agent.name);
    return known;
  };
  async function open() {
    panel.hidden = false; panel.textContent = "正在读取 Agent…";
    try {
      const agents = await list(); panel.replaceChildren();
      for (const agent of agents) {
        const button = document.createElement("button"); button.type = "button";
        // Reachable: the agent takes messages (its process may still be starting; what is said waits in its inbox).
        button.disabled = agent.reachable === false;
        button.textContent = `${agent.name} · ${agent.reachable === false ? "不可用" : agent.state === "starting" ? "启动中" : agent.state === "working" ? "工作中" : agent.summary || "就绪"}`;
        button.title = button.textContent;
        button.onclick = () => { selected = agent; label(); panel.hidden = true; input.value = input.value.replace(/^@\s*/, ""); input.placeholder = `跟 ${agent.name} 说点什么…`; input.focus(); };
        panel.append(button);
      }
    } catch { panel.textContent = "暂时无法读取名单，连上后重试"; }
  }
  control.onclick = () => { if (panel.hidden) void open(); else panel.hidden = true; };
  input.addEventListener("input", () => { if (input.value === "@") void open(); });
  return { target: () => selected?.id ?? net.primary, name: nameOf,
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
