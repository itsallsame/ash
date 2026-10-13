import assert from "node:assert/strict";
import test from "node:test";
import { toolSummary } from "../../../src/edges/agents/dsh/tool-label";
import { wordContract } from "../../../../sdk/src/words";

test("DSH's own tools read by their name; its ACP kind only decides for a name nobody knows", () => {
  assert.equal(toolSummary("bash", "other"), "在跑命令");
  assert.equal(toolSummary("read", "other"), "在读文件");
  assert.equal(toolSummary("edit"), "在改文件");
  assert.equal(toolSummary("grep"), "在找东西");
  assert.equal(toolSummary("web_fetch"), "在看网页");
  assert.equal(toolSummary("new_tool", "execute"), "在跑命令");
  assert.equal(toolSummary("new_tool", "fetch"), "在看网页");
  assert.equal(toolSummary("new_tool", "think"), "在想");
  assert.equal(toolSummary("new_tool", "other"), "在处理");
  assert.equal(toolSummary(undefined), "在处理");
});

test("ash's tools: capability_call is the called word's own label, the rest are families", () => {
  const label = wordContract("service:history", "query")!.label.doing;
  assert.equal(toolSummary("mcp__ash__capability_call", "other", { member: "service:history", word: "query", body: {} }), label);
  assert.equal(toolSummary("mcp__ash__capability_call", "other", { member: "device:nope", word: "nope" }), "在用手机/设备能力");
  assert.equal(toolSummary("mcp__ash__capability_call", "other"), "在用手机/设备能力");
  assert.equal(toolSummary("mcp__ash__human_say"), "在回你");
  assert.equal(toolSummary("mcp__ash__history_query"), "在翻记录");
  assert.equal(toolSummary("mcp__ash__agent_ask"), "在和别的 agent 协作");
  assert.equal(toolSummary("mcp__ash__agent_tell"), "在和别的 agent 协作");
  assert.equal(toolSummary("mcp__ash__device_screen_tap"), "在用手机/设备能力");
  assert.equal(toolSummary("mcp__ash__something_new"), "在处理");
  assert.equal(toolSummary("mcp__other__thing", "execute"), "在处理");
});
