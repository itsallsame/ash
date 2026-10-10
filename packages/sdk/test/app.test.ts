import assert from "node:assert/strict";
import test from "node:test";
import { appToolContract, toolEffectRisk, wakeEvents, type AppJson } from "../src/app";
import { effectRiskProblem } from "../src/word";

test("annotations -> effect and risk: the four rules of SPEC-02 §5.3", () => {
  assert.deepEqual(toolEffectRisk({ readOnlyHint: true }), { effect: "read", risk: "none" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: true }), { effect: "write", risk: "structure" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: false }), { effect: "act", risk: "outward" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: false, openWorldHint: true }), { effect: "act", risk: "outward" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: false, openWorldHint: false }), { effect: "write", risk: "none" });
});

test("a tool that says nothing needs approval", () => {
  for (const annotations of [undefined, null, {}, { title: "x" }, { idempotentHint: true }, { openWorldHint: false }, { readOnlyHint: false }]) {
    assert.deepEqual(toolEffectRisk(annotations), { effect: "write", risk: "structure" }, JSON.stringify(annotations));
  }
  // a wrong type is not a safe declaration
  assert.deepEqual(toolEffectRisk({ readOnlyHint: "true" as unknown as boolean }), { effect: "write", risk: "structure" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: "false" as unknown as boolean, openWorldHint: false }), { effect: "write", risk: "structure" });
});

test("several annotations at once: the first rule that matches wins", () => {
  assert.deepEqual(toolEffectRisk({ readOnlyHint: true, destructiveHint: true, openWorldHint: true }), { effect: "read", risk: "none" });
  assert.deepEqual(toolEffectRisk({ readOnlyHint: false, destructiveHint: false, openWorldHint: false }), { effect: "write", risk: "none" });
  assert.deepEqual(toolEffectRisk({ readOnlyHint: false, destructiveHint: true, openWorldHint: false }), { effect: "write", risk: "structure" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: false, openWorldHint: true, idempotentHint: true }), { effect: "act", risk: "outward" });
  for (const hints of [{}, { readOnlyHint: true }, { destructiveHint: false }, { destructiveHint: false, openWorldHint: false }]) {
    const { effect, risk } = toolEffectRisk(hints);
    assert.equal(effectRiskProblem(effect, risk), null);
  }
});

test("an app tool compiles to a word contract", () => {
  const contract = appToolContract("todo", { name: "todo.list", title: "List todos", description: "List the todo items.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
  assert.equal(contract.member, "app:todo");
  assert.equal(contract.word, "todo.list");
  assert.deepEqual([contract.effect, contract.risk], ["read", "none"]);
  assert.deepEqual(contract.label, { doing: "在用 List todos" });
  const plain = appToolContract("todo", { name: "todo.add" });
  assert.deepEqual([plain.effect, plain.risk], ["write", "structure"]);
  assert.deepEqual(plain.input_schema, { type: "object" });
});

test("wake_events may name the agent to wake", () => {
  const app = { wake_events: ["notes.due", { event: "message.received", agent: "ash-chat" }, { event: "x.y" }] } as Pick<AppJson, "wake_events">;
  assert.deepEqual(wakeEvents(app), [{ event: "notes.due" }, { event: "message.received", agent: "ash-chat" }, { event: "x.y" }]);
  assert.deepEqual(wakeEvents({}), []);
});
