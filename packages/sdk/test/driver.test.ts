import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ASH_BUSY_CODE, ASH_METHODS, DYNAMIC_MODULE_IDS, MODULE_IDS, STATIC_MODULE_IDS, type AgentDriver, type AgentEvent } from "../src/driver";

test("every _ash/* method the driver contract names is one the dsh-ash-control plugin answers", () => {
  const plugin = readFileSync(new URL("../../dsh-ash-control/index.mjs", import.meta.url), "utf8");
  for (const method of Object.values(ASH_METHODS)) assert.ok(plugin.includes(`"${method}"`), `${method} is not in the plugin`);
  assert.ok(plugin.includes(`const BUSY = ${ASH_BUSY_CODE}`));
});

test("the six prompt modules are split into two static and four dynamic ones", () => {
  assert.deepEqual([...STATIC_MODULE_IDS], ["identity", "rules"]);
  assert.deepEqual([...DYNAMIC_MODULE_IDS], ["user", "skills", "environment", "lane"]);
  assert.deepEqual([...MODULE_IDS].sort(), ["environment", "identity", "lane", "rules", "skills", "user"]);
});

test("the module ids are the ones a declaration may list (words.ts)", async () => {
  const { wordContract } = await import("../src/words");
  const items = (wordContract("service:agents", "declare")!.input_schema.properties.modules as { items: { enum: string[] } }).items.enum;
  assert.deepEqual([...items].sort(), [...MODULE_IDS].sort());
});

test("the contract has every operation of SPEC-08 §2.4 and every event of §2.4 (type-level: this file only compiles if it does)", () => {
  const operations: (keyof AgentDriver)[] = ["start", "stop", "status", "restart", "session", "send", "followup", "steer", "inject", "interrupt", "configure", "plugins"];
  const sessionOps: (keyof AgentDriver["session"])[] = ["get", "set", "new", "reload", "compact"];
  const events: AgentEvent["event"][] = ["turn.started", "turn.ended", "output", "thought", "tool", "handle.updated", "error", "ended"];
  assert.equal(operations.length + sessionOps.length + events.length, 25);
});
