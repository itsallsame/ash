import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { writeBundledApps } from "../../../../apps/bundle.mjs";
import { installBuiltinOrgans } from "../../../src/edges/apps";
import { call, dataOf, tempDir, world } from "./helpers";

const FIRST_PARTY = join(import.meta.dirname, "../../../../apps");

test("a first-party app is bundled the way the payload carries it, and the hub installs it as a built-in app without a card", async () => {
  const payloadApps = tempDir();
  const ids = await writeBundledApps(FIRST_PARTY, payloadApps);
  assert.ok(ids.includes("health"));
  assert.deepEqual(readdirSync(join(payloadApps, "health")).sort(), ["app.json", "icon.svg", "server.mjs"]);

  const root = tempDir();
  const builtin = installBuiltinOrgans(payloadApps, root);
  assert.ok(builtin.includes("health"));
  const w = world({ root, fixture: false, builtinApps: builtin });
  await w.apps.start();
  assert.equal(w.router.cards.length, 0, "no install card for a built-in app");
  const info = dataOf(await call(w, "service:apps", "apps.describe", { id: "health" }));
  assert.equal(info.origin, "builtin");
  assert.equal(info.running, true);
  assert.ok(w.registry.members.get("app:health")!.words().some((c: { word: string }) => c.word === "health.today"));

  // The second start does not copy it again over what the agent may have changed.
  assert.deepEqual(installBuiltinOrgans(payloadApps, root), builtin);
  assert.ok(existsSync(join(root, "health", "server.mjs")));
});

test("without a payload (running from the sources) there is nothing to install and nothing breaks", () => {
  assert.deepEqual(installBuiltinOrgans(join(tempDir(), "no-such-folder"), tempDir()), []);
});
