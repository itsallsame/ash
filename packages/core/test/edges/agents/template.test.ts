import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileTemplates, readDecl } from "../../../src/edges/agents/runs";

const TEMPLATES = new URL("../../../../ash-skills/agents", import.meta.url).pathname;

test("ash-skills ships the main template: a primary declaration on the dsh runtime that lives in the main body", () => {
  const raw = fileTemplates(TEMPLATES).read("main");
  const decl = readDecl(raw, "service:agents", 0);
  assert.equal(decl.id, "agent:main");
  assert.equal((raw as any).primary, true);
  assert.deepEqual(decl.runtime, { kind: "dsh" });
  assert.deepEqual(decl.native, { on: "body:main", cwd: "/root/work" });
  assert.deepEqual(Object.keys(decl.lanes!), ["front", "back"]);
  assert.equal(fileTemplates(TEMPLATES).read("../main"), null);
  assert.equal(fileTemplates(TEMPLATES).read("missing"), null);
});

test("no agent's name is written in the agents module's code", () => {
  const dir = new URL("../../../src/edges/agents", import.meta.url).pathname;
  const files = [...readdirSync(dir).map((f) => join(dir, f)).filter((f) => f.endsWith(".ts")), ...readdirSync(join(dir, "dsh")).map((f) => join(dir, "dsh", f))];
  for (const file of files) assert.ok(!/agent:(main|keeper)\b/.test(readFileSync(file, "utf8")), `${file} names an agent`);
});
