import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The plugin is plain JavaScript that ships as a single file, so it is loaded by URL rather than type-checked.
const load = async (name: string): Promise<any> => import(pathToFileURL(fileURLToPath(new URL(`../../${name}/index.mjs`, import.meta.url))).href);
const { createAshMethods, inject } = await load("dsh-ash-control");

const SECRET = "fake-secret-value-123456";

function fakeCredentials(initial: Record<string, { value: string; source: string }> = {}) {
  const store = new Map(Object.entries(initial));
  const sets: [string, string][] = [];
  return { sets, service: {
    resolve: async (ref: string) => store.get(ref),
    set: async (ref: string, value: string) => { sets.push([ref, value]); store.set(ref, { value, source: "file" }); },
  } };
}
const fail = (code: number) => (e: any) => e.code === code;

test("the plugin asks DSH for its credential service", () => { assert.ok(inject.includes("credentials")); });

test("credentials.has reports presence and source, and never the value", async () => {
  const c = fakeCredentials({ DEEPSEEK_API_KEY: { value: SECRET, source: "file" } });
  const methods = createAshMethods({ credentials: c.service }, () => undefined);
  const yes = await methods["_ash/credentials.has"]({ ref: "DEEPSEEK_API_KEY" });
  assert.deepEqual(yes, { has: true, source: "file" });
  assert.ok(!JSON.stringify(yes).includes(SECRET));
  assert.deepEqual(await methods["_ash/credentials.has"]({ ref: "OPENROUTER_API_KEY" }), { has: false });
});

test("an empty stored value counts as absent, a lookup failure is an error that holds no value", async () => {
  const empty = createAshMethods({ credentials: { resolve: async () => ({ value: "", source: "env" }) } }, () => undefined);
  assert.deepEqual(await empty["_ash/credentials.has"]({ ref: "A" }), { has: false });
  const broken = createAshMethods({ credentials: { resolve: async () => { throw new Error(`boom ${SECRET}`); } } }, () => undefined);
  await assert.rejects(broken["_ash/credentials.has"]({ ref: "A" }), (e: any) => e.code === -32603 && !e.message.includes(SECRET));
});

test("credentials.set stores through DSH's own service, replies ok only, and has then sees it", async () => {
  const c = fakeCredentials();
  const methods = createAshMethods({ credentials: c.service }, () => undefined);
  const out = await methods["_ash/credentials.set"]({ ref: "OPENROUTER_API_KEY", value: SECRET });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(c.sets, [["OPENROUTER_API_KEY", SECRET]]);
  assert.deepEqual(await methods["_ash/credentials.has"]({ ref: "OPENROUTER_API_KEY" }), { has: true, source: "file" });
});

test("credentials.set refuses a bad ref or value without touching the store, and a store failure does not echo the value", async () => {
  const c = fakeCredentials();
  const methods = createAshMethods({ credentials: c.service }, () => undefined);
  for (const params of [{}, { ref: "bad ref", value: SECRET }, { ref: "1ABC", value: SECRET }, { ref: "A" }, { ref: "A", value: "" }, { ref: "A", value: 5 }])
    await assert.rejects(methods["_ash/credentials.set"](params), fail(-32602));
  await assert.rejects(methods["_ash/credentials.has"]({ ref: "../x" }), fail(-32602));
  assert.deepEqual(c.sets, []);
  const shadowed = createAshMethods({ credentials: { set: async () => { throw new Error(`read-only source shadows it (${SECRET})`); } } }, () => undefined);
  await assert.rejects(shadowed["_ash/credentials.set"]({ ref: "A", value: SECRET }), (e: any) => e.code === -32603 && !e.message.includes(SECRET) && /read-only/.test(e.message));
});

test("without a credential service the methods fail cleanly", async () => {
  const methods = createAshMethods({}, () => undefined);
  await assert.rejects(methods["_ash/credentials.has"]({ ref: "A" }), fail(-32603));
  await assert.rejects(methods["_ash/credentials.set"]({ ref: "A", value: "x" }), fail(-32603));
});

function fakeCollector(records: { at: number; done: number; model: string }[], balance: any = null, balanceFetch?: () => Promise<unknown>) {
  let last = balance;
  let fetched = 0;
  return { fetched: () => fetched,
    since: (t: number) => records.filter((r) => r.done > t),
    lastBalance: () => last,
    balance: async () => { fetched++; if (!balanceFetch) throw new Error("offline"); const b = await balanceFetch(); last = { ...(b as object), at: Date.now() }; return b; } };
}

test("usage returns only the records after since, with the latest known balance", async () => {
  const rows = [{ at: 90, done: 100, model: "a" }, { at: 190, done: 200, model: "b" }, { at: 290, done: 300, model: "c" }];
  const balance = { available: true, balances: [{ currency: "CNY", total: "10.00" }], at: Date.now() };
  const collector = fakeCollector(rows, balance);
  const methods = createAshMethods({}, () => collector);
  const out = await methods["_ash/usage"]({ since: 150 });
  assert.deepEqual(out.records.map((r: any) => r.model), ["b", "c"]);
  assert.deepEqual(out.balance, balance);
  assert.deepEqual((await methods["_ash/usage"]({ since: 300 })).records, []);
  assert.equal((await methods["_ash/usage"]({})).records.length, 3);
  assert.equal(collector.fetched(), 0); // a fresh balance is not fetched again
});

test("usage refreshes a missing balance, and leaves it out when the provider cannot be reached", async () => {
  const live = fakeCollector([], null, async () => ({ available: true, balances: [] }));
  const got = await createAshMethods({}, () => live)["_ash/usage"]({ since: 0 });
  assert.equal(live.fetched(), 1);
  assert.equal(got.balance.available, true);
  const offline = fakeCollector([{ at: 1, done: 5, model: "a" }]);
  const out = await createAshMethods({}, () => offline)["_ash/usage"]({ since: 0 });
  assert.equal(out.records.length, 1);
  assert.ok(!("balance" in out));
});

test("usage rejects a bad since, and says so when ash-cost is not loaded", async () => {
  const methods = createAshMethods({}, () => fakeCollector([]));
  for (const since of ["x", -1, Number.NaN]) await assert.rejects(methods["_ash/usage"]({ since }), fail(-32602));
  await assert.rejects(createAshMethods({}, () => undefined)["_ash/usage"]({ since: 0 }), fail(-32603));
});

test("usage finds the collector ash-cost publishes in this process", async () => {
  const cost = await load("ash-cost");
  const hooks: Record<string, () => void> = {};
  cost.apply({ on: (event: string, fn: () => void) => { hooks[event] = fn; } });
  const methods = createAshMethods({});
  assert.deepEqual((await methods["_ash/usage"]({ since: Date.now() + 1000 })).records, []);
  hooks.dispose!();
  await assert.rejects(methods["_ash/usage"]({ since: 0 }), fail(-32603));
});
