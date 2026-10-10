import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDshDriver } from "../../core/src/edges/agents/dsh";
import type { AgentStartSpec } from "../../sdk/src/driver";

const load = async (name: string): Promise<any> => import(pathToFileURL(fileURLToPath(new URL(`../../${name}/index.mjs`, import.meta.url))).href);
const { createModelMemory, selectionOf } = await load("dsh-ash-control");
// The patch the container ships (plain JavaScript, like the plugin).
const { CONTAINER_PATCH } = (await import(pathToFileURL(fileURLToPath(new URL("../../../tools/container-sources.mjs", import.meta.url))).href)) as { CONTAINER_PATCH: string };

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const PRO = JSON.stringify(["deepseek-official", "deepseek-v4-pro"]);
const FLASH = JSON.stringify(["deepseek-official", "deepseek-flash"]);
const options = (model: string, effort = "high") => [{ id: "model", currentValue: model }, { id: "reasoning_effort", currentValue: effort }];

// -- the plugin's memory, against a fake session --------------------------------------------------------------------

/** Just enough of a DSH session: an event log, the header fold, and the flush the plugin waits for. */
function fakeSession(events: { type: string; data: unknown }[] = [], adapterDefaults = false) {
  const log = [...events];
  const session = {
    snapshotEvents: () => log,
    requestHeader: () => { const h = [...log].reverse().find((e) => e.type === "request/header"); return h ? { config: (h.data as any).header.config, adapterDefaults: { reasoningEffort: adapterDefaults } } : undefined; },
    append: (type: string, data: unknown) => { log.push({ type, data }); },
  };
  const flushed: unknown[] = [];
  const ctx = { agents: { get: (id: string) => (id === "s1" ? { session } : undefined) }, sessions: { flush: async (s: unknown) => { flushed.push(s); return true; } } };
  return { log, ctx, flushed, session };
}
const header = (provider: string, model: string, reasoningEffort?: string) => ({ type: "request/header", data: { header: { config: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } } } });

test("selectionOf reads the model pair and the effort from ACP's options, and nothing from anything else", () => {
  assert.deepEqual(selectionOf(options(PRO, "low")), { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "low" });
  assert.deepEqual(selectionOf([{ id: "model", currentValue: PRO }]), { provider: "deepseek-official", model: "deepseek-v4-pro" });
  assert.equal(selectionOf([]), undefined);
  assert.equal(selectionOf(undefined), undefined);
  assert.equal(selectionOf([{ id: "model", currentValue: "not json" }]), undefined);
});

test("remember: a choice is appended to the session log and flushed; one the log already says is not written twice", async () => {
  const f = fakeSession();
  const memory = createModelMemory(f.ctx);
  await memory.remember("s1", options(PRO));
  assert.deepEqual(f.log, [{ type: "model/selection", data: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high" } }]);
  assert.equal(f.flushed.length, 1);
  await memory.remember("s1", options(PRO));
  assert.equal(f.log.length, 1);
  await memory.remember("s1", options(FLASH));
  assert.equal(f.log.length, 2, "going back to the first model is a new choice");
  await memory.remember("nobody", options(PRO));
  await memory.remember("s1", []);
  assert.equal(f.log.length, 2);
});

test("remember: what the latest request header already holds is not repeated, and an adapter-default effort is not a choice", async () => {
  const f = fakeSession([header("deepseek-official", "deepseek-flash", "high")], true);
  await createModelMemory(f.ctx).remember("s1", options(FLASH, "high"));
  assert.equal(f.log.length, 1);
  const g = fakeSession([header("deepseek-official", "deepseek-flash", "high")], false);
  await createModelMemory(g.ctx).remember("s1", options(FLASH, "low"));
  assert.equal(g.log.length, 2, "an effort that differs from an explicit one is a choice");
});

test("restore: sets back a choice that no request has used yet, and leaves a session alone when a request header is newer", async () => {
  const sets: [string, string][] = [];
  const set = async (id: string, value: string) => { sets.push([id, value]); return { configOptions: id === "model" ? options(value) : options(PRO, value) }; };
  const pending = fakeSession([header("deepseek-official", "deepseek-flash"), { type: "model/selection", data: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "low" } }]);
  const out = await createModelMemory(pending.ctx).restore("s1", { configOptions: options(FLASH) }, set);
  assert.deepEqual(sets, [["model", PRO], ["reasoning_effort", "low"]]);
  assert.equal(selectionOf(out.configOptions).model, "deepseek-v4-pro");
  assert.equal(selectionOf(out.configOptions).reasoningEffort, "low");
  sets.length = 0;
  const used = fakeSession([{ type: "model/selection", data: { provider: "deepseek-official", model: "deepseek-v4-pro" } }, header("deepseek-official", "deepseek-flash")]);
  const same = { configOptions: options(FLASH) };
  assert.equal(await createModelMemory(used.ctx).restore("s1", same, set), same);
  assert.equal((await createModelMemory(fakeSession().ctx).restore("s1", same, set)), same, "a session that never chose has nothing to restore");
  assert.deepEqual(sets, []);
});

test("restore: a failing set returns what the session already offered, and logs it", async () => {
  const f = fakeSession([{ type: "model/selection", data: { provider: "deepseek-official", model: "gone" } }]);
  const logged: string[] = [];
  const result = { configOptions: options(FLASH) };
  assert.equal(await createModelMemory(f.ctx, (t: string) => logged.push(t)).restore("s1", result, async () => { throw new Error("unknown model option"); }), result);
  assert.match(logged[0]!, /could not restore the model choice: unknown model option/);
});

// -- the real DSH ---------------------------------------------------------------------------------------------------

const DSH_ROOT = [process.env.ASH_TEST_DSH_ROOT, join(homedir(), "ashwork/dsh020/linux/lib/node_modules/@deepseek-ai/dsh")].filter(Boolean).find((r) => existsSync(join(r!, "lib/bin.js")));
const skip = DSH_ROOT ? false : "no installed DSH (set ASH_TEST_DSH_ROOT)";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A DSH home that outlives the processes started on it, run with the container's patch pointed at this checkout. */
function dshHome() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dsh-model-"));
  dirs.push(dir);
  for (const sub of ["home", "work"]) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, "patch.yml"), CONTAINER_PATCH.replaceAll("/opt/ash/", `${ROOT}/packages/`));
  const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), DSH_HOME: join(dir, "home", ".dsh"), DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "placeholder" };
  const argv = ["dsh", "--profile", "acp", "--patch", join(dir, "patch.yml")];
  return { cwd: join(dir, "work"), spawn: (args: string[] = argv) => spawn(process.execPath, [join(DSH_ROOT!, "lib/bin.js"), ...args.slice(1)], { cwd: join(dir, "work"), env }), argv };
}

/** A tiny ACP client over one DSH process. */
function acp(child: ReturnType<typeof spawn>) {
  const waiting = new Map<number, (m: any) => void>();
  let buf = "", n = 0, stderr = "";
  child.stderr!.on("data", (d) => { stderr += d; });
  child.stdout!.on("data", (d) => { buf += d; for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* not a reply */ } } });
  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const id = ++n;
    const timer = setTimeout(() => rej(new Error(`${method} timed out; dsh said: ${stderr.slice(0, 500)}`)), 30_000);
    waiting.set(id, (m) => { clearTimeout(timer); res(m); });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { call, kill: async () => { const gone = new Promise((r) => child.once("exit", r)); child.kill("SIGKILL"); await gone; } };
}
const current = (result: any, id = "model") => result.configOptions.find((o: any) => o.id === id)?.currentValue;

test("real DSH: a model set before any turn survives a hard kill and a resume; a new session is still the default", { skip, timeout: 120_000 }, async () => {
  const home = dshHome();
  const first = acp(home.spawn());
  await first.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const made = (await first.call("session/new", { cwd: home.cwd, mcpServers: [] })).result;
  assert.equal(current(made), FLASH);
  const set = await first.call("session/set_config_option", { sessionId: made.sessionId, configId: "model", value: PRO });
  assert.equal(current(set.result), PRO);
  const effort = await first.call("session/set_config_option", { sessionId: made.sessionId, configId: "reasoning_effort", value: "low" });
  assert.equal(current(effort.result, "reasoning_effort"), "low");
  await first.kill(); // no turn ran: DSH has no request/header for the choice

  const second = acp(home.spawn());
  await second.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const resumed = await second.call("session/resume", { sessionId: made.sessionId, cwd: home.cwd, mcpServers: [] });
  assert.equal(current(resumed.result), PRO, "the resumed session is still on the model that was chosen");
  assert.equal(current(resumed.result, "reasoning_effort"), "low");
  const fresh = (await second.call("session/new", { cwd: home.cwd, mcpServers: [] })).result;
  assert.equal(current(fresh), FLASH, "a new session is the default");
  // Choosing the default again is remembered too, and a second restart keeps it.
  await second.call("session/set_config_option", { sessionId: made.sessionId, configId: "model", value: FLASH });
  await second.kill();
  const third = acp(home.spawn());
  await third.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(current((await third.call("session/resume", { sessionId: made.sessionId, cwd: home.cwd, mcpServers: [] })).result), FLASH);
  await third.kill();
});

/** The least an MCP client needs of a streamable-HTTP server: it initializes, lists no tools, and takes notifications. */
async function stubMcp() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let msg: any = {};
      try { msg = JSON.parse(body); } catch { /* answered below */ }
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const result = msg.method === "initialize" ? { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } : msg.method === "tools/list" ? { tools: [] } : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, close: () => server.close() };
}

test("real DSH, through the driver: the model an agent declares and one set by configure survive a restart and a new process", { skip, timeout: 120_000 }, async () => {
  const home = dshHome();
  const mcp = await stubMcp();
  const errors: string[] = [];
  const drivers: ReturnType<typeof createDshDriver>[] = [];
  const make = () => {
    const driver = createDshDriver({ report: (e) => { if (e.event === "error") errors.push(e.message); }, spawn: (argv) => home.spawn(argv), writeFile: async () => {}, argv: home.argv });
    drivers.push(driver);
    return driver;
  };
  const spec = (runtime: AgentStartSpec["runtime"], sessions: Record<string, string> = {}): AgentStartSpec => ({
    runtime, native: { on: "body:main", cwd: home.cwd }, tools: { mcp_url: mcp.url, tokens: { front: "tok" }, allowed: [] },
    modules: { static: [] }, lanes: ["front"], sessions,
  });
  const modelOf = async (driver: ReturnType<typeof createDshDriver>) => (await driver.configure("agent:t", "front", {}))["model"];
  try {
    // The agent declares v4-pro: applied to the new session, and kept by a restart before any turn ran.
    const one = make();
    await one.start("agent:t", spec({ kind: "dsh", model: "deepseek-v4-pro" }));
    assert.equal(await modelOf(one), PRO);
    const handle = one.session.get("agent:t", "front")!;
    await one.restart("agent:t");
    assert.equal(await modelOf(one), PRO, "restart resumes on the declared model");
    // The hub itself restarts: a new process and driver, and the declaration no longer names a model.
    await one.stop("agent:t", "test");
    const two = make();
    await two.start("agent:t", spec({ kind: "dsh" }, { front: handle }));
    assert.equal(await modelOf(two), PRO, "the model is DSH's, not the declaration's");
    // model.set is configure: back to flash, then killed and resumed.
    await two.configure("agent:t", "front", { model: "deepseek-flash" });
    await two.restart("agent:t");
    assert.equal(await modelOf(two), FLASH);
    // A new session on the lane starts from the default, not from the last choice.
    await two.configure("agent:t", "front", { model: "deepseek-v4-pro" });
    await two.session.new("agent:t", "front");
    assert.equal(await modelOf(two), FLASH);
    assert.deepEqual(errors, []);
  } finally { for (const d of drivers) await d.stop("agent:t", "test").catch(() => {}); mcp.close(); }
});
