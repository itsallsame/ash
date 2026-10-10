import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { wordsOf } from "../../../../sdk/src/words";
import { AGENT, call, dataOf, installFixtureFolder, until, world, type World } from "./helpers";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
async function installed(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = world({ contract: { doc: "# Contract doc for tests", docPath: "/root/apps/APP-CONTRACT.md" }, ...options });
  await w.apps.start();
  const reply = await call(w, "service:apps", "apps.install", { id: "fixture" });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return w;
}
const words = (w: World, word: string, body: unknown = {}, caller?: Parameters<typeof call>[4]) => call(w, "service:apps", word, body, caller);

test("service:apps speaks every word its contract lists, and no word more", async () => {
  const w = await installed();
  const names = wordsOf("service:apps").map((word) => word.word);
  assert.equal(names.length, 16);
  assert.ok(["apps.list", "apps.describe", "apps.install", "apps.enable", "apps.disable", "apps.revoke", "apps.refresh", "apps.restart", "apps.logs", "apps.reset",
    "apps.remove", "apps.contract", "apps.scaffold", "apps.validate", "apps.surface", "apps.icon"].every((name) => names.includes(name)));
  assert.deepEqual(w.apps.service.words().map((word) => word.word), names);
  for (const word of names) {
    const reply = await words(w, word, { id: "no-such-app", surface: "home", name: "x" });
    if (!reply.ok) assert.notEqual(reply.error.message, `service:apps has no word ${word}`, word);
  }
  const unknown = await words(w, "apps.nothing");
  assert.equal(unknown.ok === false && unknown.error.code, "not_found");
});

test("list, describe, refresh: what is in the folder and what the owner installed", async () => {
  const w = await installed();
  const listed = dataOf(await words(w, "apps.list")).apps;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "fixture");
  assert.equal(listed[0].running, true);
  assert.deepEqual(listed[0].tools.sort(), ["fixture.add", "fixture.ash", "fixture.await", "fixture.emit", "fixture.exit", "fixture.list"]);
  assert.equal(listed[0].origin, "other");
  assert.equal(listed[0].path, `${w.root}/fixture`);
  const described = dataOf(await words(w, "apps.describe", { id: "fixture" }));
  assert.deepEqual(described.events, ["fixture.ping", "fixture.alert"]);
  assert.equal(described.needs[0].member, "device:*");
  const missing = await words(w, "apps.describe", { id: "nope" });
  assert.equal(missing.ok === false && missing.error.code, "not_found");
  installFixtureFolder(w.root, (app) => { app.id = "second"; }, "second");
  const refreshed = dataOf(await words(w, "apps.refresh")).apps;
  assert.deepEqual(refreshed.map((app: { id: string; running: boolean }) => [app.id, app.running]), [["fixture", true], ["second", false]]);
});

test("disable stops the app and keeps its grants; enable starts it again; revoke narrows, revoking everything stops it", async () => {
  const w = await installed();
  const off = dataOf(await words(w, "apps.disable", { id: "fixture" }));
  assert.deepEqual([off.enabled, off.granted, off.running], [false, true, false]);
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null);
  const on = dataOf(await words(w, "apps.enable", { id: "fixture" }));
  assert.deepEqual([on.enabled, on.running], [true, true]);
  const narrowed = dataOf(await words(w, "apps.revoke", { id: "fixture", need: "device:*" }));
  assert.deepEqual(narrowed.needs, []);
  assert.equal(narrowed.running, true);
  const gone = dataOf(await words(w, "apps.revoke", { id: "fixture" }));
  assert.deepEqual([gone.granted, gone.running], [false, false]);
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null);
  const enable = await words(w, "apps.enable", { id: "fixture" });
  assert.equal(enable.ok, false, "a revoked app has to be installed again");
});

test("restart: edits to the server take effect; a wider app.json is refused until it is installed again", async () => {
  const w = await installed();
  const server = join(w.root, "fixture", "server.mjs");
  writeFileSync(server, readFileSync(server, "utf8").replace('{ name: "fixture.exit"', '{ name: "fixture.extra", title: "Extra", description: "Added by an edit.", inputSchema: object(), annotations: { readOnlyHint: true } },\n  { name: "fixture.exit"')
    .replace('case "fixture.exit"', 'case "fixture.extra": return { extra: true };\n    case "fixture.exit"'));
  assert.equal(w.registry.find("app:fixture", "fixture.extra"), null);
  const restarted = dataOf(await words(w, "apps.restart", { id: "fixture" }));
  assert.equal(restarted.running, true);
  assert.deepEqual(dataOf(await call(w, "app:fixture", "fixture.extra")), { extra: true });
  const file = join(w.root, "fixture", "app.json");
  const app = JSON.parse(readFileSync(file, "utf8"));
  app.needs.push({ notify: true, why: "to remind you" });
  writeFileSync(file, JSON.stringify(app));
  const refused = await words(w, "apps.restart", { id: "fixture" });
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused), /apps\.install/);
  const broken = await words(w, "apps.restart", { id: "nope" });
  assert.equal(broken.ok === false && broken.error.code, "not_found");
});

test("logs: the starts, stderr and exits; reset empties the data folder and restarts; remove deletes (or keeps the data)", async () => {
  const w = await installed();
  const logs = dataOf(await words(w, "apps.logs", { id: "fixture", lines: 50 }));
  assert.equal(logs.running, true);
  assert.ok(logs.lines.some((line: string) => /启动 1\.0\.0/.test(line)));
  await call(w, "app:fixture", "fixture.add", { text: "milk" });
  const cleared = dataOf(await words(w, "apps.reset", { id: "fixture" }));
  assert.equal(cleared.cleared, `${w.root}/fixture/data`);
  assert.deepEqual(dataOf(await call(w, "app:fixture", "fixture.list")).notes, []);
  assert.equal(dataOf(await words(w, "apps.describe", { id: "fixture" })).running, true);
  const kept = dataOf(await words(w, "apps.remove", { id: "fixture", keep_data: true }));
  assert.deepEqual([kept.removed, kept.kept], [true, `${w.root}/fixture`]);
  assert.ok(existsSync(join(w.root, "fixture")));
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null);
  assert.equal(w.apps.runtime.grants.get("fixture"), null);
  const removed = dataOf(await words(w, "apps.remove", { id: "fixture" }));
  assert.deepEqual([removed.removed, removed.kept], [true, null]);
  assert.ok(!existsSync(join(w.root, "fixture")));
});

test("reset needs a data_dir", async () => {
  const w = await installed({ fixture: (app) => { delete app.data_dir; } });
  const reply = await words(w, "apps.reset", { id: "fixture" });
  assert.equal(reply.ok === false && reply.error.code, "failed");
  assert.match(JSON.stringify(reply), /data_dir/);
});

test("surface gives the page of a running app; icon gives the file; both say what is wrong", async () => {
  const w = await installed({ fixture: (app) => { app.icon = "icon.png"; } });
  writeFileSync(join(w.root, "fixture", "icon.png"), PNG);
  const page = dataOf(await words(w, "apps.surface", { id: "fixture", surface: "home" }));
  assert.equal(page.mime, "text/html;profile=mcp-app");
  assert.match(page.html, /<h1>Fixture<\/h1>/);
  assert.deepEqual(page.csp, { connectDomains: ["https://api.example"], resourceDomains: [] });
  assert.equal((await words(w, "apps.surface", { id: "fixture", surface: "other" })).ok, false);
  const icon = dataOf(await words(w, "apps.icon", { id: "fixture" }));
  assert.equal(icon.mime, "image/png");
  assert.deepEqual(Buffer.from(icon.data, "base64"), PNG);
  await words(w, "apps.disable", { id: "fixture" });
  const down = await words(w, "apps.surface", { id: "fixture", surface: "home" });
  assert.equal(down.ok === false && down.error.code, "offline");
  const none = world();
  await none.apps.start();
  assert.equal((await words(none, "apps.icon", { id: "fixture" })).ok, false);
});

test("validate: a good app is ok with warnings; a bad server is an error with the last stderr; a path works as well as an id", async () => {
  const w = world({ contract: { doc: "d" } });
  await w.apps.start();
  const ok = dataOf(await words(w, "apps.validate", { id: "fixture" }));
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.deepEqual(ok.surfaces, ["home"]);
  assert.ok(ok.tools.includes("fixture.list"));
  assert.ok(!ok.tools.includes("ash.on_event"));
  assert.ok(ok.problems.every((problem: { level: string }) => problem.level === "warning"));
  assert.ok(ok.problems.some((problem: { where: string }) => /icon/.test(problem.where)));
  const byPath = dataOf(await words(w, "apps.validate", { path: `${w.root}/fixture` }));
  assert.equal(byPath.ok, true);
  const outside = dataOf(await words(w, "apps.validate", { path: "/etc" }));
  assert.equal(outside.ok, false);
  writeFileSync(join(w.root, "fixture", "server.mjs"), 'console.error("boom: cannot start");\nprocess.exit(1);\n');
  const bad = dataOf(await words(w, "apps.validate", { id: "fixture" }));
  assert.equal(bad.ok, false);
  assert.match(bad.problems.find((problem: { level: string }) => problem.level === "error").problem, /boom: cannot start/);
  const neither = await words(w, "apps.validate", {});
  assert.equal(neither.ok === false && neither.error.code, "bad_request");
});

test("validate: listens without the reserved tool ash.on_event is an error", async () => {
  const w = world();
  await w.apps.start();
  const server = join(w.root, "fixture", "server.mjs");
  writeFileSync(server, readFileSync(server, "utf8").replace('"ash.on_event"', '"ash.other"'));
  const report = dataOf(await words(w, "apps.validate", { id: "fixture" }));
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.problems), /ash\.on_event/);
});

test("contract: the document, the schema and a runnable example", async () => {
  const w = world({ contract: { doc: "# Contract doc for tests", docPath: "/root/apps/APP-CONTRACT.md" } });
  const out = dataOf(await words(w, "apps.contract"));
  assert.equal(out.contract, "ash-app/1");
  assert.equal(out.doc, "# Contract doc for tests");
  assert.equal(out.doc_path, "/root/apps/APP-CONTRACT.md");
  assert.equal(out.schema.title, "Ash app description (ash-app/1)");
  assert.ok("app.json" in out.example.files && "server.mjs" in out.example.files);
});

test("scaffold: writes an app that validates, installs and works; it refuses to overwrite", async () => {
  const w = world({ fixture: false });
  await w.apps.start();
  const made = dataOf(await call(w, "service:apps", "apps.scaffold", { id: "todo", name: "Todo", summary: "A list of things to do.", tools: [{ name: "todo.archive", read_only: false }] }, { member: "agent:main", via: "agent", local: false }));
  assert.equal(made.id, "todo");
  assert.ok(made.files.includes("app.json") && made.files.includes("server.mjs") && made.files.includes("ui/home.html"));
  const manifest = JSON.parse(readFileSync(join(w.root, "todo", "app.json"), "utf8"));
  assert.equal(manifest.publisher, "agent:main", "written by the agent that asked");
  const report = dataOf(await words(w, "apps.validate", { id: "todo" }));
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.ok(report.tools.includes("todo.archive"));
  assert.deepEqual(report.surfaces, ["home"]);
  const info = dataOf(await words(w, "apps.install", { id: "todo" }, AGENT));
  assert.equal(info.running, true);
  assert.match(w.router.cards[0]!.detail!, /Ash 自己写的/);
  await call(w, "app:todo", "todo.add", { text: "buy milk" });
  const items = dataOf(await call(w, "app:todo", "todo.list")).items;
  assert.equal(items[0].text, "buy milk");
  assert.equal((await words(w, "apps.surface", { id: "todo", surface: "home" })).ok, true);
  const again = await words(w, "apps.scaffold", { id: "todo", name: "Todo" });
  assert.equal(again.ok === false && again.error.code, "conflict");
  const dup = await words(w, "apps.scaffold", { id: "dup", name: "Dup", tools: [{ name: "a.b" }, { name: "a.b" }] });
  assert.equal(dup.ok === false && dup.error.code, "bad_request");
});

test("stopAll through the service's runtime leaves nothing registered", async () => {
  const w = await installed();
  await until(() => w.registry.find("app:fixture", "fixture.list"), "running");
  const started = Date.now();
  await w.apps.stopAll(started + 3000);
  assert.ok(Date.now() - started < 3000);
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null);
});
