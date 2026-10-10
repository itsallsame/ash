/**
 * REGRESSION-0.3 §1 (文件浏览 S026) and §2 (SPEC-00 §6.4: files in the work directory do not ask, files elsewhere do).
 * `body:main` is the hub's own body; the owner uses it directly, an agent through the tool surface and the gate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { accepted, byOwnerText, isApprovalAsk, quiet, resultOf, startScenario, type ToolResult } from "./harness";
import { eventually } from "../fixtures/wait";

test("S026: the owner lists, writes and reads files in the main body directly", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();

  const wrote = await owner.call("body:main", "workspace.write", { path: "notes/hello.txt", content: "你好，文件" });
  const listed = await owner.call("body:main", "workspace.ls", { path: "notes" });
  const read = await owner.call("body:main", "workspace.read", { path: "notes/hello.txt" });

  assert.ok(wrote.ok, "the owner writes without a card");
  assert.ok(listed.ok && JSON.stringify(listed.result).includes("hello.txt"));
  assert.ok(read.ok && (read.result as { text: string }).text.includes("你好，文件"));
});

test("SPEC-00 §6.4: an agent writes inside the work directory without a card; writing outside it asks the owner", async (t) => {
  const s = await startScenario(t);
  const state: { inside?: ToolResult; outside?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "写在家里": async (turn) => { state.inside = await turn.call("body:main", "workspace.write", { path: "notes/agent.txt", content: "agent 写的" }); },
    "写在系统里": async (turn) => { state.outside = await turn.call("body:main", "workspace.write", { path: "/etc/ash-scenario-outside.txt", content: "不该写成" }); },
  }));
  const owner = await s.human();

  accepted(await owner.say("写在家里"));
  await eventually(() => state.inside, "the first write");
  assert.equal(state.inside!.isError, false);
  await quiet();
  assert.equal(owner.messages.filter(isApprovalAsk).length, 0, "no card for a write in the work directory");
  const read = await owner.call("body:main", "workspace.read", { path: "notes/agent.txt" });
  assert.ok(read.ok && (read.result as { text: string }).text.includes("agent 写的"));

  accepted(await owner.say("写在系统里"));
  await owner.seen(isApprovalAsk, "a card for the write outside");
  await eventually(() => state.outside, "the second receipt");
  assert.equal(resultOf(state.outside!).status, "waiting_owner");
  const missing = await owner.call("body:main", "workspace.read", { path: "/etc/ash-scenario-outside.txt" });
  assert.ok(!missing.ok, "nothing was written before the owner answered");
});
