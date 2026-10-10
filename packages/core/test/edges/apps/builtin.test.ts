// Built-in apps follow the release: a newer release replaces a folder nobody changed, keeps (and says so) one the agent
// changed, and the grants follow the app.json in the folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_MARKER, installBuiltinOrgans, RELEASE_DIR, type BuiltinKept } from "../../../src/edges/apps";
import { call, dataOf, installFixtureFolder, stubMember, tempDir, until, world } from "./helpers";

/** A release folder with one app "fixture" at `version` (its server.mjs ends with a line saying which release it is). */
function release(version: string, edit?: (app: Record<string, any>) => void): string {
  const source = tempDir("release-");
  const dir = installFixtureFolder(source, (app) => { app.version = version; edit?.(app); });
  writeFileSync(join(dir, "server.mjs"), `${readFileSync(join(dir, "server.mjs"), "utf8")}\n// release ${version}\n`);
  return source;
}
const marker = (root: string) => JSON.parse(readFileSync(join(root, "fixture", BUILTIN_MARKER), "utf8"));
const text = (root: string, file: string) => readFileSync(join(root, "fixture", file), "utf8");

test("first copy: the folder arrives with a record of what the release brought", () => {
  const root = tempDir();
  const kept: BuiltinKept[] = [];
  assert.deepEqual(installBuiltinOrgans(release("1.0.0"), root, kept), ["fixture"]);
  assert.deepEqual(kept, []);
  const record = marker(root);
  assert.equal(record.version, "1.0.0");
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.ok(text(root, "server.mjs").endsWith("// release 1.0.0\n"));
});

test("a newer release replaces a folder nobody changed, and keeps the app's data", () => {
  const root = tempDir();
  installBuiltinOrgans(release("1.0.0"), root);
  mkdirSync(join(root, "fixture", "data"), { recursive: true });
  writeFileSync(join(root, "fixture", "data", "state.json"), "{\"mine\":1}");
  const kept: BuiltinKept[] = [];
  installBuiltinOrgans(release("1.1.0"), root, kept);
  assert.deepEqual(kept, []);
  assert.ok(text(root, "server.mjs").endsWith("// release 1.1.0\n"));
  assert.equal(JSON.parse(text(root, "app.json")).version, "1.1.0");
  assert.equal(marker(root).version, "1.1.0");
  assert.equal(text(root, "data/state.json"), "{\"mine\":1}", "the owner's data is not part of the release");
  assert.ok(!existsSync(join(root, ".new-fixture")) && !existsSync(join(root, ".old-fixture")));
  // The data does not change the record: a later release still replaces.
  installBuiltinOrgans(release("1.2.0"), root, kept);
  assert.ok(text(root, "server.mjs").endsWith("// release 1.2.0\n"));
});

test("a newer release does not overwrite what the agent changed: the old app stays, the main agent is told once", async () => {
  const root = tempDir();
  installBuiltinOrgans(release("1.0.0"), root);
  writeFileSync(join(root, "fixture", "server.mjs"), `${text(root, "server.mjs")}// the agent was here\n`);

  const kept: BuiltinKept[] = [];
  const source = release("1.1.0");
  const builtinApps = installBuiltinOrgans(source, root, kept);
  assert.deepEqual(kept, [{ id: "fixture", shipped: "1.1.0", current: "1.0.0" }]);
  assert.ok(text(root, "server.mjs").includes("the agent was here"));
  assert.equal(marker(root).version, "1.0.0", "the record still says what was brought before");
  assert.ok(existsSync(join(root, RELEASE_DIR, "fixture", "app.json")), "the new release is left where the agent can read it");

  const w = world({ root, fixture: false, builtinApps, builtinKept: kept });
  const agent = stubMember("agent:main", "agent", [{ word: "tell", callers: ["owner", "agent", "app"] }]);
  w.registry.add(agent);
  await w.apps.start();
  const told = await until(() => agent.received[0], "the tell to the main agent");
  assert.equal(told.word, "tell");
  assert.equal(told.from, "service:apps");
  assert.match(String((told.body as { text: string }).text), /fixture.*1\.1\.0.*你改过/s);
  await until(() => marker(root).notified === "1.1.0", "the tell is recorded");

  // The next start does not tell again.
  const again: BuiltinKept[] = [];
  installBuiltinOrgans(source, root, again);
  assert.deepEqual(again, []);
  // A still newer release does.
  const newer: BuiltinKept[] = [];
  installBuiltinOrgans(release("1.2.0"), root, newer);
  assert.deepEqual(newer.map((item) => item.shipped), ["1.2.0"]);
});

test("the same release, or an older one, leaves the folder alone", () => {
  const root = tempDir();
  installBuiltinOrgans(release("1.1.0"), root);
  const before = text(root, "server.mjs");
  writeFileSync(join(root, "fixture", "server.mjs"), `${before}// the agent was here\n`);
  const kept: BuiltinKept[] = [];
  installBuiltinOrgans(release("1.1.0"), root, kept);
  installBuiltinOrgans(release("1.0.0"), root, kept);
  assert.deepEqual(kept, []);
  assert.ok(text(root, "server.mjs").includes("the agent was here"));
  assert.equal(marker(root).version, "1.1.0");
});

test("a folder from before the record counts as changed: kept, not overwritten", () => {
  const root = tempDir();
  installFixtureFolder(root, (app) => { app.version = "1.0.0"; });
  const kept: BuiltinKept[] = [];
  installBuiltinOrgans(release("1.1.0"), root, kept);
  assert.equal(kept.length, 1);
  assert.equal(JSON.parse(text(root, "app.json")).version, "1.0.0");
});

test("grants follow the built-in app: a changed version or needs are granted again without a card", async () => {
  const root = tempDir();
  const dbPath = join(tempDir(), "ash.db");
  const first = world({ root, dbPath, fixture: false, builtinApps: installBuiltinOrgans(release("1.0.0"), root) });
  await first.apps.start();
  let info = dataOf(await call(first, "service:apps", "apps.describe", { id: "fixture" }));
  assert.equal(info.version, "1.0.0");
  assert.deepEqual(info.needs.map((n: { member: string }) => n.member), ["device:*"]);
  await first.apps.stopAll(Date.now() + 3000);
  first.ledger.close();

  const wider = release("1.1.0", (app) => { app.needs = [...app.needs, { member: "service:senses", words: ["query"], why: "Look at recent records." }]; });
  const second = world({ root, dbPath, fixture: false, builtinApps: installBuiltinOrgans(wider, root) });
  await second.apps.start();
  info = dataOf(await call(second, "service:apps", "apps.describe", { id: "fixture" }));
  assert.equal(info.version, "1.1.0");
  assert.deepEqual(info.needs.map((n: { member: string }) => n.member).sort(), ["device:*", "service:senses"]);
  assert.equal(info.origin, "builtin");
  assert.equal(second.router.cards.length, 0, "no card: the release decides");

  // Same version and needs: the grant is not rewritten; and a disabled app stays disabled when it is granted again.
  const at = second.apps.runtime.grants.get("fixture")!.granted_at;
  second.apps.runtime.seedBuiltin("fixture");
  assert.equal(second.apps.runtime.grants.get("fixture")!.granted_at, at);
  second.apps.runtime.grants.setEnabled("fixture", false);
  writeFileSync(join(root, "fixture", "app.json"), JSON.stringify({ ...JSON.parse(text(root, "app.json")), version: "1.2.0" }));
  await second.apps.runtime.refresh();
  second.apps.runtime.seedBuiltin("fixture");
  assert.equal(second.apps.runtime.grants.get("fixture")!.version, "1.2.0");
  assert.equal(second.apps.runtime.grants.get("fixture")!.enabled, false);
});
