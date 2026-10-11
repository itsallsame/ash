import assert from "node:assert/strict";
import test from "node:test";
import { outcomeText, safeActivityView } from "../js/activity-model.js";
import { fold, initialView } from "../js/project.js";

const message = (seq, fields) => ({ seq, ts: seq * 1000, id: `m${seq}`, kind: "event", to: null, body: {}, ...fields });
const replay = (messages) => messages.reduce((view, item) => fold(view, item), initialView());
const started = (seq, turn, fields = {}) => message(seq, { from: "agent:main", word: "turn.started", body: { turn, lane: "front", ids: [], ...fields } });
const ended = (seq, turn, outcome = "completed") => message(seq, { from: "agent:main", word: "turn.ended", body: { turn, outcome } });
const tool = (seq, turn, phase, name, summary) => message(seq, { from: "agent:main", word: "agent.tool", body: { turn, name, phase, summary, ok: true } });

test("a native tool call shows its summary and keeps raw route names and arguments out of the activity view", () => {
  const view = replay([
    started(1, "t_native"), tool(2, "t_native", "start", "read", "读取文件"), tool(3, "t_native", "end", "read", "读取文件"),
    message(4, { id: "call", kind: "request", from: "agent:main", to: "service:dsh-tool", word: "read", turn: "t_native", body: { arguments: "SECRET_FILE_PATH" } }),
    ended(5, "t_native"),
  ]);
  const safe = safeActivityView(view);
  assert.ok(safe.turns.t_native.steps.some((step) => step.label === "读取文件" && step.state === "ok"));
  assert.doesNotMatch(JSON.stringify(safe), /service:dsh-tool|SECRET_/);
});

test("the safe view drops raw route words from step labels, keeps web details and accepts any ledger turn id", () => {
  const view = { turns: {
    t_one: { title: "查天气", started: 1000, steps: [
      { label: "service:self · write", requestId: "raw" }, { label: "calendar.search", ts: 1000 },
      { label: "正在查找", ts: 1001 }, { label: "在看网页 · nba.com", ts: 1002 }, { label: "raw tool", tool: "bash", ts: 1003 },
    ] },
    "9f3c-uuid": { title: "", background: true, started: 2000, outcome: "done", steps: [{ label: "x".repeat(200) }] },
    "bad id!": { title: "no", started: 3000, steps: [] },
  } };
  const safe = safeActivityView(view);
  assert.deepEqual(safe.turns.t_one.steps.map((step) => step.label), ["正在查找", "在看网页 · nba.com", "raw tool"]);
  assert.equal(JSON.stringify(safe).includes("service:self"), false);
  assert.equal(safe.turns["9f3c-uuid"].title, "后台任务");
  assert.equal(safe.turns["9f3c-uuid"].outcome, undefined);
  assert.deepEqual(safe.turns["9f3c-uuid"].steps, []);
  assert.equal(safe.turns["bad id!"], undefined);
});

test("how a turn ended reads in plain words, with how long it took", () => {
  assert.equal(outcomeText({ started: 0 }).key, "running");
  assert.equal(outcomeText({ started: 0, ended: 3000, outcome: "completed" }).label, "完成了 · 用时 3 秒");
  assert.equal(outcomeText({ started: 0, ended: 120_000, outcome: "error" }).label, "没做完 · 用时 2 分钟");
  assert.equal(outcomeText({ started: 0, ended: 1000, outcome: "cancelled" }).key, "cancelled");
});
