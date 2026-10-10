import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The plugin is plain JavaScript that ships as a single file, so it is loaded by URL rather than type-checked.
const load = async (name: string): Promise<any> => import(pathToFileURL(fileURLToPath(new URL(`../../${name}/index.mjs`, import.meta.url))).href);
const { createAshMethods, inject } = await load("dsh-ash-control");

const SECRET = "fake-secret-value-123456";
const fail = (code: number) => (e: any) => e.code === code;
/** A ctx whose services are looked up by name, as DSH's ctx.get does. */
const ctxWith = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] });

/** A credential service that, like DSH's, describes a key without ever handing out its value from describe(). */
function fakeCredentials(initial: Record<string, { value: string; source: string; writable?: boolean }> = {}) {
  const store = new Map(Object.entries(initial));
  const sets: [string, string][] = [];
  let resolved = 0;
  return { sets, resolveCalls: () => resolved, service: {
    resolve: async (ref: string) => { resolved++; return store.get(ref); },
    describe: async (ref: string) => { const hit = store.get(ref); return hit ? { configured: true, source: hit.source, writable: hit.writable ?? true } : { configured: false, writable: true }; },
    set: async (ref: string, value: string) => { sets.push([ref, value]); store.set(ref, { value, source: "file" }); },
  } };
}

test("neither service is injected: a missing one fails that method, never the ACP bridge", () => {
  assert.ok(!inject.includes("credentials"));
  assert.ok(!inject.includes("ashCost"));
});

test("credentials.has reports presence, source and writability from describe, and never reads or returns the value", async () => {
  const c = fakeCredentials({ DEEPSEEK_API_KEY: { value: SECRET, source: "env", writable: false } });
  const methods = createAshMethods(ctxWith({ credentials: c.service }));
  const yes = await methods["_ash/credentials.has"]({ ref: "DEEPSEEK_API_KEY" });
  assert.deepEqual(yes, { has: true, source: "env", writable: false });
  assert.ok(!JSON.stringify(yes).includes(SECRET));
  assert.deepEqual(await methods["_ash/credentials.has"]({ ref: "OPENROUTER_API_KEY" }), { has: false, writable: true });
  assert.equal(c.resolveCalls(), 0);
});

test("a lookup failure is an error that holds no value", async () => {
  const broken = createAshMethods(ctxWith({ credentials: { describe: async () => { throw new Error(`boom ${SECRET}`); } } }));
  await assert.rejects(broken["_ash/credentials.has"]({ ref: "A" }), (e: any) => e.code === -32603 && !e.message.includes(SECRET));
});

test("credentials.set stores through DSH's own service, replies ok only, and has then sees it", async () => {
  const c = fakeCredentials();
  const methods = createAshMethods(ctxWith({ credentials: c.service }));
  const out = await methods["_ash/credentials.set"]({ ref: "OPENROUTER_API_KEY", value: SECRET });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(c.sets, [["OPENROUTER_API_KEY", SECRET]]);
  assert.deepEqual(await methods["_ash/credentials.has"]({ ref: "OPENROUTER_API_KEY" }), { has: true, source: "file", writable: true });
});

test("credentials.set refuses a bad ref or value without touching the store, and a store failure does not echo the value", async () => {
  const c = fakeCredentials();
  const methods = createAshMethods(ctxWith({ credentials: c.service }));
  for (const params of [{}, { ref: "bad ref", value: SECRET }, { ref: "1ABC", value: SECRET }, { ref: "A" }, { ref: "A", value: "" }, { ref: "A", value: 5 }])
    await assert.rejects(methods["_ash/credentials.set"](params), fail(-32602));
  await assert.rejects(methods["_ash/credentials.has"]({ ref: "../x" }), fail(-32602));
  assert.deepEqual(c.sets, []);
  const shadowed = createAshMethods(ctxWith({ credentials: { set: async () => { throw new Error(`read-only source shadows it (${SECRET})`); } } }));
  await assert.rejects(shadowed["_ash/credentials.set"]({ ref: "A", value: SECRET }), (e: any) => e.code === -32603 && !e.message.includes(SECRET) && /read-only/.test(e.message));
});

test("without a credential service the methods answer -32603", async () => {
  for (const ctx of [ctxWith({}), {}]) {
    const methods = createAshMethods(ctx);
    await assert.rejects(methods["_ash/credentials.has"]({ ref: "A" }), fail(-32603));
    await assert.rejects(methods["_ash/credentials.set"]({ ref: "A", value: "x" }), fail(-32603));
  }
});

function fakeCollector(records: { at: number; done: number; model: string }[], balance?: () => Promise<unknown>) {
  let fetched = 0;
  return { fetched: () => fetched, since: (t: number) => records.filter((r) => r.done > t),
    balance: async (options: { timeoutMs?: number }) => { fetched++; assert.equal(options.timeoutMs, 5000); if (!balance) throw new Error("offline"); return balance(); } };
}
const rows = [{ at: 90, done: 100, model: "a" }, { at: 190, done: 200, model: "b" }, { at: 290, done: 300, model: "c" }];

test("usage returns only the records after since, and asks for the balance on every pull", async () => {
  const collector = fakeCollector(rows, async () => ({ available: true, balances: [{ currency: "CNY", total: "10.00" }] }));
  const methods = createAshMethods(ctxWith({ ashCost: collector }));
  const out = await methods["_ash/usage"]({ since: 150 });
  assert.deepEqual(out.records.map((r: any) => r.model), ["b", "c"]);
  assert.deepEqual([out.balance.available, out.balance.balances], [true, [{ currency: "CNY", total: "10.00" }]]);
  assert.equal(typeof out.balance.at, "number");
  assert.deepEqual((await methods["_ash/usage"]({ since: 300 })).records, []);
  assert.equal((await methods["_ash/usage"]({})).records.length, 3);
  assert.equal(collector.fetched(), 3);
});

test("usage leaves the balance out when the provider cannot be reached", async () => {
  const offline = fakeCollector(rows.slice(0, 1));
  const out = await createAshMethods(ctxWith({ ashCost: offline }))["_ash/usage"]({ since: 0 });
  assert.equal(out.records.length, 1);
  assert.ok(!("balance" in out));
});

test("usage rejects a bad since, and answers -32603 when ash-cost is not loaded", async () => {
  const methods = createAshMethods(ctxWith({ ashCost: fakeCollector([]) }));
  for (const since of ["x", -1, Number.NaN]) await assert.rejects(methods["_ash/usage"]({ since }), fail(-32602));
  await assert.rejects(createAshMethods(ctxWith({}))["_ash/usage"]({ since: 0 }), fail(-32603));
});

test("usage reads the collector ash-cost provides through DSH's service registry", async () => {
  const cost = await load("ash-cost");
  const provided: Record<string, unknown> = {};
  cost.apply({ on() {}, provide: (name: string, value: unknown) => { provided[name] = value; } });
  assert.equal(provided.ashCost, cost.collector);
  const out = await createAshMethods(ctxWith(provided))["_ash/usage"]({ since: Date.now() + 1000 });
  assert.deepEqual(out.records, []);
});

/** The agents DSH holds (ctx.agents) and a compaction service shaped like dsh-compaction's. */
function compactCtx(opts: { status?: string; result?: unknown; error?: unknown; noAgent?: boolean; noService?: boolean }) {
  const calls: unknown[][] = [];
  const agent = { status: opts.status ?? "idle" };
  const compaction = { compactNow: async (...args: unknown[]) => { calls.push(args); if (opts.error) throw opts.error; return opts.result ?? null; } };
  return { calls, agent, ctx: { agents: { get: (id: string) => (opts.noAgent || id !== "s1" ? undefined : agent) }, get: (name: string) => (name === "compaction" && !opts.noService ? compaction : undefined) } };
}

test("compact is declared as injected, and compacts an idle session the way /compact does", async () => {
  assert.ok(inject.includes("compaction"));
  const c = compactCtx({ result: { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 900, summarySeq: 4 } });
  const out = await createAshMethods(c.ctx)["_ash/compact"]({ sessionId: "s1" });
  assert.deepEqual(out, { compacted: true, shadowed: 3, tokens: 900, detail: "compacted 3 history items (~900 tokens)" });
  assert.equal(c.calls[0]![0], c.agent);
  assert.ok(c.calls[0]![1] instanceof AbortSignal);
});

test("compact: nothing to compact is a normal answer", async () => {
  const out = await createAshMethods(compactCtx({ result: null }).ctx)["_ash/compact"]({ sessionId: "s1" });
  assert.equal(out.compacted, false);
});

test("compact: a session in a turn, or a compaction already running, answers busy (-32002) and compacts nothing", async () => {
  const running = compactCtx({ status: "running" });
  await assert.rejects(createAshMethods(running.ctx)["_ash/compact"]({ sessionId: "s1" }), fail(-32002));
  assert.equal(running.calls.length, 0);
  const racing = compactCtx({ error: Object.assign(new Error("x"), { code: "busy" }) });
  await assert.rejects(createAshMethods(racing.ctx)["_ash/compact"]({ sessionId: "s1" }), fail(-32002));
});

test("compact: bad session, missing service and other failures", async () => {
  await assert.rejects(createAshMethods(compactCtx({}).ctx)["_ash/compact"]({}), fail(-32602));
  await assert.rejects(createAshMethods(compactCtx({}).ctx)["_ash/compact"]({ sessionId: "nope" }), fail(-32602));
  await assert.rejects(createAshMethods(compactCtx({ noService: true }).ctx)["_ash/compact"]({ sessionId: "s1" }), fail(-32603));
  await assert.rejects(createAshMethods(compactCtx({ error: Object.assign(new Error("m"), { code: "summary" }) }).ctx)["_ash/compact"]({ sessionId: "s1" }), (e: any) => e.code === -32603 && /summary/.test(e.message));
});
