// What the activity page says about a turn, from display-safe ledger facts only (never raw ledger bodies).

// Where she looked on the web reads like a domain, which the raw-route guard would otherwise drop.
const webDetail = /^(?:在看网页|在搜索) · [^\n]{1,61}$/u;
const rawRoute = /\b(?:agent|worker|device|service|person):[A-Za-z0-9_-]+\b|\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\b/i;

/** Only ledger-derived, human-facing status steps enter the activity page. */
export function safeActivityView(view) {
  const turns = {};
  for (const [id, turn] of Object.entries(view?.turns ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !turn || !Number.isFinite(turn.started)) continue;
    turns[id] = {
      title: typeof turn.title === "string" && turn.title ? turn.title : turn.background ? "后台任务" : "对话",
      background: turn.background === true, started: turn.started,
      ended: Number.isFinite(turn.ended) ? turn.ended : undefined,
      outcome: ["completed", "cancelled", "error"].includes(turn.outcome) ? turn.outcome : undefined,
      ...(Number.isSafeInteger(turn.step_count) && turn.step_count >= 0 ? { step_count: turn.step_count } : {}),
      steps: Array.isArray(turn.steps) ? turn.steps.filter((step) => typeof step.label === "string" && step.label.length <= 180 &&
        (step.tool || step.summary || webDetail.test(step.label) || !rawRoute.test(step.label)))
        .map((step) => ({ label: step.label, ts: step.ts, ended: step.ended, state: step.state, tool: step.tool,
          requestId: step.requestId, approval: step.approval, summary: step.summary })) : [],
    };
  }
  return { turns };
}


const duration = (ms) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` :
  ms < 3_600_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 360_000) / 10} 小时`;

/** The ending of a turn in plain words. */
export function outcomeText(turn) {
  if (!Number.isFinite(turn.ended)) return { key: "running", label: "还在做…" };
  const took = turn.ended >= turn.started ? ` · 用时 ${duration(turn.ended - turn.started)}` : "";
  if (turn.outcome === "completed") return { key: "completed", label: `完成了${took}` };
  if (turn.outcome === "cancelled") return { key: "cancelled", label: `被打断了${took}` };
  if (turn.outcome === "error") return { key: "error", label: `没做完${took}` };
  return { key: "ended", label: `结束了${took}` };
}
