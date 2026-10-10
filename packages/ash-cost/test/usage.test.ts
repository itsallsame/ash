import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const cost: any = await import(pathToFileURL(fileURLToPath(new URL("../index.mjs", import.meta.url))).href);

// What DSH hands the llm/stream waterfall: a request's options, and the chunks of its stream.
async function* stream(chunks: unknown[], fail = false) { for (const c of chunks) yield c; if (fail) throw Object.assign(new Error("boom"), { code: "rate_limited" }); }
const drain = async (it: AsyncIterable<unknown>) => { try { for await (const _ of it); } catch { /* the caller's problem, not ours */ } };
const usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 };

test("since(t) lists records that ended after t, oldest first, as copies", async () => {
  const collector = cost.collector;
  const start = Date.now();
  await drain(collector.tap({ provider: "deepseek", model: "m1", purpose: "session-title" }, stream([{ type: "usage", usage }])));
  await new Promise((r) => setTimeout(r, 5));
  const mid = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  await drain(collector.tap({ provider: "deepseek", model: "m2", purpose: "compaction" }, stream([{ type: "usage", usage }])));

  const all = collector.since(start - 1);
  assert.deepEqual(all.map((r: any) => r.model), ["m1", "m2"]);
  assert.deepEqual(all.map((r: any) => r.scope), ["title", "compaction"]);
  assert.equal(all[0].input, 10);
  assert.equal(all[0].cacheRead, 2);
  assert.ok(all[1].done >= all[0].done);
  assert.deepEqual(collector.since(mid).map((r: any) => r.model), ["m2"]);
  assert.deepEqual(collector.since(Date.now() + 1000), []);
  all[0].model = "changed"; // a puller cannot rewrite what was recorded
  assert.equal(collector.since(start - 1)[0].model, "m1");
});

test("failed calls that reported usage are kept with ok:false; calls with no usage leave no record", async () => {
  const collector = cost.collector;
  const t = Date.now() - 1;
  await drain(collector.tap({ provider: "p", model: "failed" }, stream([{ type: "usage", usage }], true)));
  await drain(collector.tap({ provider: "p", model: "silent" }, stream([{ type: "text" }])));
  const mine = collector.since(t).filter((r: any) => r.model === "failed" || r.model === "silent");
  assert.deepEqual(mine.map((r: any) => [r.model, r.ok]), [["failed", false]]);
});

test("lastBalance is null until a balance read succeeds, then holds it with the time it was read", async () => {
  const collector = cost.collector;
  assert.equal(collector.lastBalance(), null);
  const key = "FAKE_COST_TEST_KEY";
  const realFetch = globalThis.fetch;
  let auth = "";
  globalThis.fetch = (async (_url: string, init: any) => { auth = init.headers.authorization; return new Response(JSON.stringify({ is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: "9.50", granted_balance: "0", topped_up_balance: "9.50" }] })); }) as typeof fetch;
  collector.attach({ get: () => ({ resolve: async () => ({ value: "fake-key-value" }) }) });
  try {
    const before = Date.now();
    const result = await collector.balance({ credential: key });
    assert.equal(auth, "Bearer fake-key-value");
    const last = collector.lastBalance();
    assert.deepEqual({ available: last.available, balances: last.balances }, result);
    assert.ok(last.at >= before);
    assert.ok(!JSON.stringify(last).includes("fake-key-value"));
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await assert.rejects(collector.balance({ credential: key }));
    assert.equal(collector.lastBalance().at, last.at); // a failed read leaves the last good one alone
  } finally { globalThis.fetch = realFetch; }
});

test("apply publishes the collector for the control plugin and takes it back on dispose", () => {
  const hooks: Record<string, unknown> = {};
  cost.apply({ on: (event: string, fn: unknown) => { hooks[event] = fn; } });
  assert.equal((globalThis as any)[cost.COLLECTOR_KEY], cost.collector);
  assert.equal(typeof hooks["llm/stream"], "function");
  (hooks.dispose as () => void)();
  assert.equal((globalThis as any)[cost.COLLECTOR_KEY], undefined);
});
