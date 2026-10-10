import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import { createLlm, LlmError, type Complete, type LlmUsageReport } from "../../../src/edges/llm";

const FAKE_DEEPSEEK = "fake-deepseek-key-0001";
const FAKE_OPENROUTER = "fake-openrouter-key-0002";
const keys: Record<string, string> = { DEEPSEEK_API_KEY: FAKE_DEEPSEEK, OPENROUTER_API_KEY: FAKE_OPENROUTER };

const reply = (patch: Partial<AssistantMessage> = {}): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: "ok" }],
  api: "openai-completions", provider: "deepseek", model: "m", stopReason: "stop", timestamp: 1,
  usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } }, ...patch });

interface Seen { model: Model<Api>; context: Context; options: Record<string, unknown> }
function fixture(complete: Complete, key: (ref: string) => string | null = (ref) => keys[ref] ?? null) {
  const seen: Seen[] = [];
  const reports: LlmUsageReport[] = [];
  const asked: string[] = [];
  const llm = createLlm({ key: (ref) => { asked.push(ref); return key(ref); }, report: (usage) => { reports.push(usage); },
    complete: async (model, context, options) => { seen.push({ model, context, options }); return complete(model, context, options); },
    clock: { now: () => 1234 } });
  return { llm, seen, reports, asked };
}
const hello = { messages: [{ role: "system" as const, content: "be brief" }, { role: "user" as const, content: "hi" }] };

test("no model named: DeepSeek's default model with the DeepSeek key, and the call is reported", async () => {
  const f = fixture(async () => reply());
  const out = await f.llm.complete("hub:reviewer", hello);
  assert.equal(out.text, "ok");
  assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 7, cost: 0.002 });
  assert.deepEqual(f.asked, ["DEEPSEEK_API_KEY"]);
  assert.equal(f.seen[0]!.model.provider, "deepseek");
  assert.equal(f.seen[0]!.model.id, "deepseek-flash");
  assert.equal(f.seen[0]!.options.apiKey, FAKE_DEEPSEEK);
  assert.equal(f.seen[0]!.context.systemPrompt, "be brief");
  assert.equal(f.seen[0]!.context.messages.length, 1);
  assert.deepEqual(f.reports, [{ caller: "hub:reviewer", provider: "deepseek", model: "deepseek-flash", input_tokens: 11, output_tokens: 7, cost: 0.002, ok: true, at: 1234 }]);
});

test("openrouter: prefix picks the provider, its key ref and its model; unlisted ids still route to OpenRouter", async () => {
  const f = fixture(async () => reply());
  await f.llm.complete("hub:jev", { ...hello, model: "openrouter:typesafe/jev-1.13", max_tokens: 50 });
  await f.llm.complete("agent:main", { ...hello, model: "openrouter:deepseek/deepseek-chat" });
  assert.deepEqual(f.asked, ["OPENROUTER_API_KEY", "OPENROUTER_API_KEY"]);
  assert.deepEqual(f.seen.map((s) => [s.model.provider, s.model.id, s.model.baseUrl]),
    [["openrouter", "typesafe/jev-1.13", "https://openrouter.ai/api/v1"], ["openrouter", "deepseek/deepseek-chat", "https://openrouter.ai/api/v1"]]);
  assert.equal(f.seen[0]!.options.apiKey, FAKE_OPENROUTER);
  assert.equal(f.seen[0]!.options.maxTokens, 50);
  assert.deepEqual(f.reports.map((r) => [r.caller, r.provider, r.model]), [["hub:jev", "openrouter", "typesafe/jev-1.13"], ["agent:main", "openrouter", "deepseek/deepseek-chat"]]);
});

test("a bare model id is a DeepSeek model; an id DeepSeek does not have is unknown_model and still reported", async () => {
  const f = fixture(async () => reply());
  await f.llm.complete("a", { ...hello, model: "deepseek-v4-flash" });
  assert.equal(f.seen[0]!.model.id, "deepseek-v4-flash");
  await assert.rejects(f.llm.complete("a", { ...hello, model: "deepseek:no-such-model" }), (e: LlmError) => e.code === "unknown_model");
  assert.equal(f.seen.length, 1);
  assert.deepEqual(f.reports.map((r) => r.ok), [true, false]);
});

test("assistant turns in the request reach the provider as assistant messages", async () => {
  const f = fixture(async () => reply());
  await f.llm.complete("a", { messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }] });
  assert.deepEqual(f.seen[0]!.context.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(f.seen[0]!.context.systemPrompt, undefined);
});

test("a provider failure becomes a failed error, is reported ok:false, and the message holds no key", async () => {
  const f = fixture(async () => { throw new Error(`401 bad key ${FAKE_DEEPSEEK} rejected`); });
  await assert.rejects(f.llm.complete("hub:progress", hello), (e: LlmError) => {
    assert.equal(e.code, "failed");
    assert.ok(!e.message.includes(FAKE_DEEPSEEK), e.message);
    return true;
  });
  assert.equal(f.reports.length, 1);
  assert.deepEqual([f.reports[0]!.caller, f.reports[0]!.ok, f.reports[0]!.input_tokens, f.reports[0]!.output_tokens], ["hub:progress", false, 0, 0]);
});

test("a reply that stopped on an error is a failure with the provider's reason, key blanked out", async () => {
  const f = fixture(async () => reply({ stopReason: "error", errorMessage: `upstream said ${FAKE_DEEPSEEK}`, content: [] }));
  await assert.rejects(f.llm.complete("a", hello), (e: LlmError) => e.code === "failed" && !e.message.includes(FAKE_DEEPSEEK) && /upstream said/.test(e.message));
  assert.equal(f.reports[0]!.ok, false);
  assert.equal(f.reports[0]!.input_tokens, 11); // the provider still billed those tokens
});

test("timeout_ms bounds the call, even when the provider ignores the abort signal", async () => {
  let aborted = false;
  const f = fixture((_m, _c, options) => new Promise<AssistantMessage>(() => { (options.signal as AbortSignal).addEventListener("abort", () => { aborted = true; }); }));
  const started = Date.now();
  await assert.rejects(f.llm.complete("a", { ...hello, timeout_ms: 30 }), (e: LlmError) => e.code === "timeout");
  assert.ok(Date.now() - started < 1000);
  assert.equal(aborted, true);
  assert.deepEqual(f.reports.map((r) => r.ok), [false]);
});

test("the default timeout is 5 s and the request can raise it", async () => {
  const f = fixture(async () => reply());
  const real = global.setTimeout;
  const delays: number[] = [];
  global.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => { delays.push(ms ?? 0); return real(fn, ms, ...rest); }) as typeof setTimeout;
  try {
    await f.llm.complete("a", hello);
    await f.llm.complete("a", { ...hello, timeout_ms: 9000 });
  } finally { global.setTimeout = real; }
  assert.deepEqual(delays, [5000, 9000]);
});

test("no key: unavailable, the provider is never called, the attempt is still reported, nothing printed", async () => {
  const f = fixture(async () => reply(), () => null);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
  try {
    await assert.rejects(f.llm.complete("hub:reviewer", hello), (e: LlmError) => e.code === "unavailable" && /deepseek/.test(e.message));
  } finally { console.error = original; }
  assert.equal(f.seen.length, 0);
  assert.deepEqual(f.reports.map((r) => [r.caller, r.provider, r.ok]), [["hub:reviewer", "deepseek", false]]);
  assert.deepEqual(logged, []);
});

test("only the key of the chosen provider is read", async () => {
  const f = fixture(async () => reply(), (ref) => ref === "DEEPSEEK_API_KEY" ? FAKE_DEEPSEEK : null);
  await f.llm.complete("a", hello);
  await assert.rejects(f.llm.complete("a", { ...hello, model: "openrouter:x/y" }), (e: LlmError) => e.code === "unavailable" && !e.message.includes(FAKE_DEEPSEEK));
  assert.deepEqual(f.asked, ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"]);
});

test("bad requests are rejected before any key is read, and a throwing reporter never changes the answer", async () => {
  const f = fixture(async () => reply());
  for (const bad of [{ messages: [] }, { messages: [{ role: "system", content: "x" }] }, { messages: [{ role: "tool", content: "x" }] },
    { ...hello, max_tokens: 0 }, { ...hello, timeout_ms: 1.5 }]) {
    await assert.rejects(f.llm.complete("a", bad as never), (e: LlmError) => e.code === "bad_request");
  }
  assert.deepEqual(f.asked, []);
  const llm = createLlm({ key: () => FAKE_DEEPSEEK, report: () => { throw new Error("cost is down"); }, complete: async () => reply() });
  assert.equal((await llm.complete("a", hello)).text, "ok");
});
