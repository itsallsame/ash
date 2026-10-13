import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WordError } from "../../sdk/src/message";
import { checkCapabilitySpec } from "../../sdk/src/link";
import { isExtensionName } from "../../sdk/src/namespaces";
import { Browser, EGO_CAPABILITY } from "../src/browser";

test("browser scripts are actions, persist per-caller task spaces and spill long output to a readable path", async () => {
  assert.equal(EGO_CAPABILITY.effect, "act");
  assert.equal(EGO_CAPABILITY.name, "x.ego.browser.script");
  assert.ok(isExtensionName(EGO_CAPABILITY.name)); assert.equal(checkCapabilitySpec(EGO_CAPABILITY), null);
  const dir = await mkdtemp(join(tmpdir(), "ash-browser-")), scripts: string[] = []; let space = 40;
  const run = async (script: string) => {
    scripts.push(script);
    const marker = script.match(/console\.log\("(ash-space-[^"]+)"/);
    return marker ? marker[1] + ++space : script.includes("LONG") ? "x".repeat(70000) : "page result";
  };
  let browser = new Browser(dir, "fixture", run);
  assert.equal((await browser.call({ task: "search", script: "console.log(await task.page('p1').snapshot())" }, "agent:a")).ok, true);
  assert.match(scripts[1], /taskSpace\(41\)/);
  browser = new Browser(dir, "fixture", run);
  await browser.call({ task: "search", script: "console.log('continued')" }, "agent:a");
  assert.match(scripts[2], /taskSpace\(41\)/);
  await browser.call({ task: "search", script: "console.log('other')" }, "agent:b");
  assert.match(scripts[4], /taskSpace\(42\)/);
  const result = await browser.call({ task: "search", script: "// LONG", finish: true }, "agent:a");
  assert.ok(result.ok);
  const data = result.data as { path: string; truncated: boolean };
  assert.equal(data.truncated, true); assert.equal((await readFile(data.path, "utf8")).length, 70000);
  assert.match(scripts.at(-1)!, /finish\(\{keep:\[\]\}\)/);
  await assert.rejects(browser.call({ task: "a", script: "", dangerous: true }, "agent:a"), (e: unknown) => e instanceof WordError && e.code === "bad_request");
});

test("failed scripts do not echo source or replay the action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ash-browser-failure-")); let actions = 0;
  const browser = new Browser(dir, "fixture", async script => {
    const marker = script.match(/console\.log\("(ash-space-[^"]+)"/);
    if (marker) return marker[1] + "7";
    actions++; throw new Error("SECRET_SOURCE");
  });
  const error = await browser.call({ task: "write", script: "SECRET_SOURCE" }, "agent:a").then(() => null, (e: unknown) => e);
  assert.ok(error instanceof WordError); assert.equal(error.code, "result_unknown"); assert.equal(actions, 1); assert.doesNotMatch(error.message, /SECRET_SOURCE/);
});
