// Pause and resume (`service:admin`). Pausing is at once; resuming asks once more. A lost answer keeps its request id, so the
// same request may be sent again; a definite refusal retires it.
import { retryable } from "./link.js";
import { btn, h } from "./home-ui.js";

let intent = null;

/** The pause control. [className] draws the button ("btn btn-ghost btn-block", "btn btn-danger btn-block"). */
export function pauseControl(ctx, screen, className) {
  const name = ctx.name;
  const feedback = h("p", { class: "hm-note", role: "status" });
  const button = btn(`暂停 ${name}`, `a-btn ${className} hm-pause`, null, { id: "homePause" });
  const confirmation = h("div", { class: "hm-confirm", hidden: true, id: "homeResumeConfirmation" }, h("p", { class: "tx-sub" }, `确定要恢复 ${name} 吗？`));
  const yes = btn("确认恢复", "a-btn btn-primary btn-sm", null, { id: "homeResumeYes" });
  const no = btn("取消", "a-btn btn-neutral btn-sm", () => { confirmation.hidden = true; });
  confirmation.append(h("div", { class: "hm-actions" }, yes, no));
  let paused = false;
  const show = (value) => {
    paused = value === true;
    button.textContent = paused ? `恢复 ${name}` : `暂停 ${name}`;
    button.id = paused ? "homeResume" : "homePause";
  };
  const send = async (word) => {
    const session = ctx.net.session;
    if (intent?.word !== word || intent.session !== session) intent = { word, session, clientId: crypto.randomUUID() };
    const current = intent;
    const reply = await screen.call("service:admin", word, word === "resume" ? { confirmed: true } : {}, { clientId: current.clientId });
    if (!reply.ok) { if (!retryable(reply.error) && intent === current) intent = null; return false; }
    if (reply.result?.data?.paused !== (word === "pause")) return false;
    if (intent === current) intent = null;
    return true;
  };
  const run = async (word) => {
    button.disabled = yes.disabled = true;
    feedback.textContent = "正在处理…";
    let done = false;
    try { done = await send(word); } catch (error) { if (error?.code === "stale") return; }
    if (!screen.alive()) return;
    feedback.textContent = done ? (word === "pause" ? `已暂停 ${name}` : `已恢复 ${name}`) : "状态未确认，请检查连接后重试。";
    if (done) show(word === "pause");
    button.disabled = yes.disabled = false;
  };
  button.addEventListener("click", () => { if (paused) confirmation.hidden = false; else void run("pause"); });
  yes.addEventListener("click", () => { confirmation.hidden = true; void run("resume"); });
  const root = h("div", { class: "hm-pause-box" }, button, confirmation, feedback);
  return { root, show, refresh: async () => { try { const status = await screen.ask("service:admin", "status", {}); if (typeof status?.paused === "boolean") show(status.paused); } catch { /* the button keeps its words */ } } };
}
