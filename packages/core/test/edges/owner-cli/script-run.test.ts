import assert from "node:assert/strict";
import test from "node:test";
import { judge, judgeExec, matches, parseScript, reportOf, subset, type Report, type Seen } from "../../../../../tools/e2e/script-run";

const report = (steps: Report["steps"]): Report => ({ run: "r", trigger: "script", completed: true, steps });
const seen = (from: string, to: string, word: string, text: string): Seen => ({ seq: 1, from, to, word, kind: "request", body: { text } });

test("a script is read, and a bad one is refused with a reason", () => {
  assert.equal(parseScript('{"steps":[]}').steps.length, 0);
  assert.throws(() => parseScript("{"), /not JSON/);
  assert.throws(() => parseScript('{"nope":1}'), /steps/);
  assert.throws(() => parseScript('{"steps":[],"owner":[{"do":[]}]}'), /needs `when`/);
});

test("subset: every wanted key is there, recursively", () => {
  assert.ok(subset({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } }));
  assert.ok(!subset({ a: 1 }, { a: 2 }));
  assert.ok(subset([{ x: 1, y: 2 }], [{ x: 1 }]));
  assert.ok(!subset([1, 2], [1]));
  assert.ok(!subset(undefined, { a: 1 }));
});

test("steps are judged by id or position: ok, error code, status, data, time", () => {
  const reports = [report([
    { i: 0, id: "a1", kind: "call", ok: true, status: "waiting_owner", ms: 5000, data: { pending_id: "p" } },
    { i: 1, kind: "call", ok: false, error: { code: "denied", message: "no" }, ms: 10 },
  ])];
  const out = judge([
    { step: "a1", ok: true, status: "waiting_owner", data: { pending_id: "p" }, min_ms: 4000, max_ms: 6000 },
    { step: 1, error: "denied", ok: false },
    { step: "a1", status: "accepted" },
    { step: "zz", ok: true },
    { step: 1, max_ms: 5 },
  ], reports, []);
  assert.deepEqual(out.map((o) => o.pass), [true, true, false, false, false]);
  assert.match(out[2]!.detail!, /status is waiting_owner, wanted accepted/);
  assert.match(out[3]!.detail!, /no such step/);
});

test("messages are counted by from, to, word and text; the count is exact, a range or at least one", () => {
  const messages = [seen("person:owner", "agent:script", "say", "批准：创建虚拟屏"), seen("agent:script", "service:gate", "pending.redeem", "")];
  assert.ok(matches(messages[0]!, { from: "person:owner", text: "批准" }));
  assert.ok(!matches(messages[0]!, { word: "ask" }));
  const out = judge([
    { messages: { text: "批准" }, count: 1 }, { messages: { text: "拒绝" }, count: 0 }, { messages: { word: "pending.redeem" } },
    { messages: { word: "say" }, count: { min: 2 } }, { messages: { text: "批准" }, count: 0 },
  ], [], messages);
  assert.deepEqual(out.map((o) => o.pass), [true, true, true, false, false]);
});

test("the agent's report is read from its message; the output of a program is judged", () => {
  assert.equal(reportOf('{"script_report":{"run":"x","trigger":"script","steps":[]}}')?.run, "x");
  assert.equal(reportOf("hello"), null);
  assert.equal(reportOf('{"script_report":'), null);
  assert.deepEqual(judgeExec({ stdout: "channel=ash\\.important", not_stdout: "silent" }, 0, "id=1 channel=ash.important.v3").map((o) => o.pass), [true, true, true]);
  assert.deepEqual(judgeExec({ exit: 1 }, 0, "").map((o) => o.pass), [false]);
});
