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
  assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 7 }); // deepseek-flash has no known rates: no cost is claimed
  assert.deepEqual(f.asked, ["DEEPSEEK_API_KEY"]);
  assert.equal(f.seen[0]!.model.provider, "deepseek");
  assert.equal(f.seen[0]!.model.id, "deepseek-flash");
  assert.equal(f.seen[0]!.options.apiKey, FAKE_DEEPSEEK);
  assert.equal(f.seen[0]!.context.systemPrompt, "be brief");
  assert.equal(f.seen[0]!.context.messages.length, 1);
  assert.deepEqual(f.reports, [{ caller: "hub:reviewer", provider: "deepseek", model: "deepseek-flash", input_tokens: 11, output_tokens: 7, ok: true, at: 1234 }]);
});

test("a model with known rates reports the cost pi-ai priced; a zero price is never reported as a cost", async () => {
  const f = fixture(async () => reply());
  const out = await f.llm.complete("a", { ...hello, model: "deepseek-v4-flash" });
  assert.equal(f.seen[0]!.model.id, "deepseek-v4-flash");
  assert.ok(Object.values(f.seen[0]!.model.cost).some((rate) => rate > 0));
  assert.equal(out.usage.cost, 0.002);
  assert.equal(f.reports[0]!.cost, 0.002);
  await f.llm.complete("a", { ...hello, model: "openrouter:vendor/unlisted" });
  assert.ok(!("cost" in f.reports[1]!));
});

test("openrouter: prefix picks the provider, its key ref and its model; unlisted ids still route to OpenRouter", async () => {
  const f = fixture(async () => reply());
  await f.llm.complete("hub:other", { ...hello, model: "openrouter:vendor/unlisted-1", max_tokens: 50 });
  await f.llm.complete("agent:main", { ...hello, model: "openrouter:deepseek/deepseek-chat" });
  assert.deepEqual(f.asked, ["OPENROUTER_API_KEY", "OPENROUTER_API_KEY"]);
  assert.deepEqual(f.seen.map((s) => [s.model.provider, s.model.id, s.model.baseUrl]),
    [["openrouter", "vendor/unlisted-1", "https://openrouter.ai/api/v1"], ["openrouter", "deepseek/deepseek-chat", "https://openrouter.ai/api/v1"]]);
  assert.equal(f.seen[0]!.options.apiKey, FAKE_OPENROUTER);
  assert.equal(f.seen[0]!.options.maxTokens, 50);
  assert.deepEqual(f.reports.map((r) => [r.caller, r.provider, r.model]), [["hub:other", "openrouter", "vendor/unlisted-1"], ["agent:main", "openrouter", "deepseek/deepseek-chat"]]);
});

test("a bare model id is a DeepSeek model; an id DeepSeek does not have is unknown_model and still reported", async () => {
  const f = fixture(async () => reply());
  await f.llm.complete("a", { ...hello, model: "deepseek-v4-flash" });
  assert.equal(f.seen[0]!.model.id, "deepseek-v4-flash");
  await assert.rejects(f.llm.complete("a", { ...hello, model: "deepseek:no-such-model" }), (e: LlmError) => e.code === "unknown_model");
  await assert.rejects(f.llm.complete("a", { ...hello, model: "openrouter:" }), (e: LlmError) => e.code === "unknown_model"); // no hidden default model
  assert.equal(f.seen.length, 1);
  assert.deepEqual(f.reports.map((r) => r.ok), [true, false, false]);
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


// post(): the JEV judge's decisions endpoint, forwarded as it is.
interface Sent { url: string; init: RequestInit }
function postFixture(respond: (sent: Sent) => Promise<Response> | Response, key: (ref: string) => string | null = (ref) => keys[ref] ?? null) {
  const sent: Sent[] = [];
  const reports: LlmUsageReport[] = [];
  const asked: string[] = [];
  const llm = createLlm({ key: (ref) => { asked.push(ref); return key(ref); }, report: (u) => { reports.push(u); }, clock: { now: () => 99 },
    fetch: (async (url: URL, init: RequestInit) => { const s = { url: String(url), init }; sent.push(s); return respond(s); }) as unknown as typeof fetch });
  return { llm, sent, reports, asked };
}
const jevRequest = { provider: "openrouter" as const, path: "/api/alpha/decisions", body: { model: "typesafe/jev-1.13", state: { a: 1 }, questions: { q: { type: "choice" } } } };

test("post forwards the body to the provider's fixed host with that provider's key and returns the JSON untouched", async () => {
  const answer = { answers: { q: { choice: "x", confidence: 0.9 } } };
  const f = postFixture(() => new Response(JSON.stringify(answer)));
  assert.deepEqual(await f.llm.post("hub:jev", jevRequest), answer);
  assert.equal(f.sent[0]!.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(f.sent[0]!.init.method, "POST");
  assert.equal((f.sent[0]!.init.headers as Record<string, string>).authorization, `Bearer ${FAKE_OPENROUTER}`);
  assert.deepEqual(JSON.parse(String(f.sent[0]!.init.body)), jevRequest.body);
  assert.deepEqual(f.asked, ["OPENROUTER_API_KEY"]);
  assert.deepEqual(f.reports, [{ caller: "hub:jev", provider: "openrouter", model: "typesafe/jev-1.13", input_tokens: 0, output_tokens: 0, ok: true, at: 99 }]);
});

test("post reports the tokens the answer states, under either field naming", async () => {
  const f = postFixture(() => new Response(JSON.stringify({ answers: {}, usage: { prompt_tokens: 30, completion_tokens: 5, cost: 0.0004 } })));
  await f.llm.post("hub:jev", jevRequest);
  const g = postFixture(() => new Response(JSON.stringify({ usage: { input_tokens: 8, output_tokens: 2 } })));
  await g.llm.post("a", { provider: "deepseek", path: "/user/balance", body: {} });
  assert.deepEqual([f.reports[0]!.input_tokens, f.reports[0]!.output_tokens, f.reports[0]!.cost], [30, 5, 0.0004]);
  assert.deepEqual([g.reports[0]!.input_tokens, g.reports[0]!.output_tokens, g.reports[0]!.provider, g.reports[0]!.model, "cost" in g.reports[0]!], [8, 2, "deepseek", "/user/balance", false]);
  assert.equal(g.sent[0]!.url, "https://api.deepseek.com/user/balance");
});

test("post takes a path only: another host, a scheme, a double slash or a dot segment never reaches fetch", async () => {
  const f = postFixture(() => new Response("{}"));
  for (const path of ["https://evil.example/x", "//evil.example/x", "evil.example/x", "/a/../b", "/a b", "/x@evil.example", "", "\\evil.example"])
    await assert.rejects(f.llm.post("a", { ...jevRequest, path }), (e: LlmError) => e.code === "bad_request");
  await assert.rejects(f.llm.post("a", { ...jevRequest, provider: "other" as never }), (e: LlmError) => e.code === "bad_request");
  await assert.rejects(f.llm.post("a", { ...jevRequest, timeout_ms: 0 }), (e: LlmError) => e.code === "bad_request");
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.asked, []);
  assert.equal(f.reports.length, 10); // every attempt is still reported
});

test("post: an error status, a non-JSON answer and a transport failure are failed errors, reported ok:false, with no key in the message", async () => {
  for (const respond of [() => new Response(`denied ${FAKE_OPENROUTER}`, { status: 401 }), () => new Response("<html>"), () => { throw new Error(`connect failed with ${FAKE_OPENROUTER}`); }]) {
    const f = postFixture(respond);
    await assert.rejects(f.llm.post("hub:jev", jevRequest), (e: LlmError) => e.code === "failed" && !e.message.includes(FAKE_OPENROUTER));
    assert.deepEqual(f.reports.map((r) => r.ok), [false]);
  }
});

test("post: no key is unavailable and fetch is never called; the timeout applies and aborts the request", async () => {
  const none = postFixture(() => new Response("{}"), () => null);
  await assert.rejects(none.llm.post("hub:jev", jevRequest), (e: LlmError) => e.code === "unavailable" && /openrouter/.test(e.message));
  assert.equal(none.sent.length, 0);
  assert.deepEqual(none.reports.map((r) => [r.provider, r.ok]), [["openrouter", false]]);
  let aborted = false;
  const slow = postFixture((s) => new Promise<Response>(() => { (s.init.signal as AbortSignal).addEventListener("abort", () => { aborted = true; }); }));
  await assert.rejects(slow.llm.post("hub:jev", { ...jevRequest, timeout_ms: 30 }), (e: LlmError) => e.code === "timeout");
  assert.equal(aborted, true);
  assert.deepEqual(slow.reports.map((r) => r.ok), [false]);
});

test("baseUrl: complete and post both go to that origin, keep their own paths, and use the same keys and reports", async () => {
  const seen: Model<Api>[] = [];
  const sent: string[] = [];
  const reports: LlmUsageReport[] = [];
  // The path of the override itself ("/fake") does not count: only protocol, host and port are taken from it.
  const llm = createLlm({ key: (ref) => keys[ref] ?? null, report: (u) => { reports.push(u); }, baseUrl: "http://127.0.0.1:9/fake/",
    complete: async (model) => { seen.push(model); return reply(); },
    fetch: (async (url: unknown) => { sent.push(String(url)); return new Response(JSON.stringify({ answers: {} })); }) as unknown as typeof fetch });
  await llm.complete("a", hello);
  await llm.post("hub:jev", jevRequest);
  assert.equal(seen[0]!.baseUrl, "http://127.0.0.1:9");
  assert.deepEqual(sent, ["http://127.0.0.1:9/api/alpha/decisions"]);
  assert.equal(reports.length, 2);
});

test("baseUrl: DeepSeek (no path) and OpenRouter (/api/v1) keep the model's own path in complete, and post sends the same path", async () => {
  const seen: string[] = [];
  const sent: string[] = [];
  const llm = createLlm({ key: (ref) => keys[ref] ?? null, report: () => {}, baseUrl: "http://127.0.0.1:9",
    complete: async (model) => { seen.push(model.baseUrl); return reply(); },
    fetch: (async (url: unknown) => { sent.push(String(url)); return new Response(JSON.stringify({})); }) as unknown as typeof fetch });
  await llm.complete("a", { ...hello, model: "deepseek-flash" });
  await llm.complete("a", { ...hello, model: "openrouter:vendor/unlisted-1" });
  await llm.post("a", { provider: "deepseek", path: "/chat/completions", body: {} });
  await llm.post("a", { provider: "openrouter", path: "/api/v1/chat/completions", body: {} });
  assert.deepEqual(seen, ["http://127.0.0.1:9", "http://127.0.0.1:9/api/v1"]);
  assert.deepEqual(sent, ["http://127.0.0.1:9/chat/completions", "http://127.0.0.1:9/api/v1/chat/completions"]);
});

// ---- key health: what the providers say about the keys --------------------------------------------------------------
function healthFixture(respond: (sent: Sent) => Promise<Response> | Response, store: Record<string, string | null> = { ...keys }, complete?: Complete, verifyTimeoutMs?: number) {
  const sent: Sent[] = [];
  let now = 1000;
  const llm = createLlm({ key: (ref) => store[ref] ?? null, report: () => {}, clock: { now: () => now },
    fetch: (async (url: URL, init: RequestInit) => { const s = { url: String(url), init }; sent.push(s); return respond(s); }) as unknown as typeof fetch,
    ...(complete ? { complete } : {}), ...(verifyTimeoutMs ? { verifyTimeoutMs } : {}) });
  return { llm, sent, store, tick: (ms: number) => { now += ms; } };
}
const status = (llm: { keys(): ReturnType<ReturnType<typeof healthFixture>["llm"]["keys"]> }, provider: string) => llm.keys().find((k) => k.provider === provider)!;

test("keys: before anything is known both keys are unknown, and a missing key is not configured", () => {
  const f = healthFixture(() => new Response("{}"), { DEEPSEEK_API_KEY: FAKE_DEEPSEEK, OPENROUTER_API_KEY: null });
  assert.deepEqual(f.llm.keys(), [
    { provider: "deepseek", ref: "DEEPSEEK_API_KEY", configured: true, status: "unknown" },
    { provider: "openrouter", ref: "OPENROUTER_API_KEY", configured: false, status: "unknown" },
  ]);
  assert.equal(f.sent.length, 0, "reading the status never touches the network");
});

test("verify: a free authenticated GET on each provider's fixed host; accepted means ok, with the time", async () => {
  const f = healthFixture(() => new Response('{"is_available":true}'));
  const one = await f.llm.verify("deepseek");
  const two = await f.llm.verify("openrouter");
  assert.deepEqual([one.status, one.checked_at, two.status], ["ok", 1000, "ok"]);
  assert.deepEqual(f.sent.map((s) => [s.url, s.init.method]), [["https://api.deepseek.com/user/balance", "GET"], ["https://openrouter.ai/api/v1/key", "GET"]]);
  assert.equal((f.sent[0]!.init.headers as Record<string, string>).authorization, `Bearer ${FAKE_DEEPSEEK}`);
  assert.equal(f.sent[0]!.init.body, undefined);
  assert.doesNotMatch(JSON.stringify(f.llm.keys()), /fake-(deepseek|openrouter)-key/, "the status never holds a key");
});

test("verify: 401 and 403 are rejected with the provider's words; expired, revoked and plain invalid get their own short reason", async () => {
  const say = (status: number, message: string) => () => new Response(JSON.stringify({ error: { message, code: status } }), { status });
  const expired = await healthFixture(say(401, "API key expired")).llm.verify("openrouter");
  assert.deepEqual([expired.status, expired.reason, expired.detail], ["rejected", "已过期", "API key expired"]);
  const invalid = await healthFixture(say(401, `Authentication Fails, Your api key: ${FAKE_DEEPSEEK} is invalid`)).llm.verify("deepseek");
  assert.deepEqual([invalid.status, invalid.reason], ["rejected", "无效"]);
  assert.doesNotMatch(String(invalid.detail), new RegExp(FAKE_DEEPSEEK), "should the provider echo the key, it is blanked out");
  const revoked = await healthFixture(say(403, "key was revoked")).llm.verify("deepseek");
  assert.deepEqual([revoked.status, revoked.reason], ["rejected", "已被停用"]);
  const forbidden = await healthFixture(say(403, "nope")).llm.verify("deepseek");
  assert.equal(forbidden.reason, "没有权限");
  const bare = await healthFixture(() => new Response("<html>", { status: 401 })).llm.verify("deepseek");
  assert.deepEqual([bare.status, bare.reason, bare.detail], ["rejected", "无效", undefined]);
});

test("verify: a network error, a timeout or a 5xx says nothing about the key (unknown)", async () => {
  const outcomes: Array<() => Response | Promise<Response>> = [() => { throw new Error("connect failed"); }, () => new Response("busy", { status: 503 })];
  let n = 0;
  const f = healthFixture(() => outcomes[n++]!());
  const first = await f.llm.verify("deepseek");
  assert.deepEqual([first.status, first.reason], ["unknown", "连不上服务商"]);
  const second = await f.llm.verify("deepseek");
  assert.equal(second.status, "unknown");
  assert.match(String(second.reason), /HTTP 503/);
  const hung = healthFixture(() => new Promise<Response>(() => {}), { ...keys }, undefined, 20);
  const timedOut = await hung.llm.verify("deepseek");
  assert.deepEqual([timedOut.status, timedOut.reason], ["unknown", "连接服务商超时"]);
});

test("verify: not reaching the provider never replaces a verdict already known", async () => {
  const outcomes: Array<() => Response> = [() => new Response("{}"), () => { throw new Error("offline"); }, () => new Response("expired", { status: 401 }), () => new Response("busy", { status: 503 })];
  let n = 0;
  const f = healthFixture(() => outcomes[n++]!());
  assert.equal((await f.llm.verify("deepseek")).status, "ok");
  assert.equal((await f.llm.verify("deepseek")).status, "ok", "offline: still what it was");
  assert.equal((await f.llm.verify("deepseek")).status, "rejected");
  const after = await f.llm.verify("deepseek");
  assert.deepEqual([after.status, after.reason], ["rejected", "无效"], "a 503 does not clear a refusal");
});

test("verify: a check already running is shared; an unconfigured key is not asked about; forget wipes what was known", async () => {
  let release!: () => void;
  const f = healthFixture(() => new Promise<Response>((resolve) => { release = () => resolve(new Response("{}")); }));
  const a = f.llm.verify("deepseek"), b = f.llm.verify("deepseek");
  await new Promise((r) => setImmediate(r));
  release();
  assert.equal(await a, await b);
  assert.equal(f.sent.length, 1);
  assert.equal(status(f.llm, "deepseek").status, "ok");
  f.llm.forget("deepseek");
  assert.equal(status(f.llm, "deepseek").status, "unknown");
  assert.equal(status(f.llm, "deepseek").checked_at, undefined);
  const none = healthFixture(() => new Response("{}"), { DEEPSEEK_API_KEY: null });
  assert.equal((await none.llm.verify("deepseek")).configured, false);
  assert.equal(none.sent.length, 0);
  await assert.rejects(none.llm.verify("nope" as "deepseek"), (e: LlmError) => e.code === "bad_request");
});

test("verify: an answer about a key the owner has replaced meanwhile is dropped", async () => {
  let release!: () => void;
  const f = healthFixture(() => new Promise<Response>((resolve) => { release = () => resolve(new Response("expired", { status: 401 })); }));
  const running = f.llm.verify("openrouter");
  await new Promise((r) => setImmediate(r));
  f.store.OPENROUTER_API_KEY = "fake-new-key-9999";
  f.llm.forget("openrouter");
  release();
  await running;
  assert.equal(status(f.llm, "openrouter").status, "unknown", "the old key's refusal does not count against the new key");
});

test("use: a 401 from post marks the provider's key rejected with the time and reason; the next success clears it", async () => {
  let answer: () => Response = () => new Response(JSON.stringify({ error: { message: "API key expired", code: 401 } }), { status: 401 });
  const f = healthFixture(() => answer());
  await assert.rejects(f.llm.post("hub:jev", jevRequest), (e: LlmError) => e.code === "failed" && /HTTP 401/.test(e.message));
  const rejected = status(f.llm, "openrouter");
  assert.deepEqual([rejected.status, rejected.reason, rejected.detail, rejected.checked_at], ["rejected", "已过期", "API key expired", 1000]);
  assert.equal(status(f.llm, "deepseek").status, "unknown", "only the provider that was called");
  f.tick(500);
  answer = () => new Response("{}", { status: 200 });
  await f.llm.post("hub:jev", jevRequest);
  const cleared = status(f.llm, "openrouter");
  assert.deepEqual([cleared.status, cleared.reason, cleared.checked_at], ["ok", undefined, 1500]);
});

test("use: a timeout, a 5xx or a transport failure never changes the status, rejected or not", async () => {
  let answer: () => Response | Promise<Response> = () => new Response("nope", { status: 401 });
  const f = healthFixture(() => answer());
  await assert.rejects(f.llm.post("hub:jev", jevRequest));
  const before = status(f.llm, "openrouter");
  for (const next of [() => new Response("boom", { status: 502 }), () => { throw new Error("offline"); }, () => new Promise<Response>(() => {})]) {
    answer = next;
    await assert.rejects(f.llm.post("hub:jev", { ...jevRequest, timeout_ms: 20 }));
    assert.deepEqual(status(f.llm, "openrouter"), before);
  }
  const fresh = healthFixture(() => new Response("boom", { status: 500 }));
  await assert.rejects(fresh.llm.post("hub:jev", jevRequest));
  assert.equal(status(fresh.llm, "openrouter").status, "unknown", "a failure that is not a refusal does not even create a status");
});

test("use: complete reads the provider's '401 ...' error the same way, and a good reply clears it", async () => {
  let fail = true;
  const f = healthFixture(() => new Response("{}"), { ...keys }, async () => fail ? reply({ stopReason: "error", errorMessage: "401 API key expired", content: [] }) : reply());
  await assert.rejects(f.llm.complete("hub:reviewer", { model: "openrouter:vendor/m", messages: [{ role: "user", content: "hi" }] }), (e: LlmError) => e.code === "failed" && /401/.test(e.message));
  assert.deepEqual([status(f.llm, "openrouter").status, status(f.llm, "openrouter").reason], ["rejected", "已过期"]);
  fail = false;
  await f.llm.complete("hub:reviewer", { model: "openrouter:vendor/m", messages: [{ role: "user", content: "hi" }] });
  assert.equal(status(f.llm, "openrouter").status, "ok");
  const server = healthFixture(() => new Response("{}"), { ...keys }, async () => reply({ stopReason: "error", errorMessage: "500 internal error", content: [] }));
  await assert.rejects(server.llm.complete("hub:reviewer", { messages: [{ role: "user", content: "hi" }] }));
  assert.equal(status(server.llm, "deepseek").status, "unknown");
});

test("use: a 402 or a 403 (a spent budget, a guardrail, a moderation block) never marks the key rejected; a 403 only sends the key check, which decides", async () => {
  const say = (status: number, message: string) => new Response(JSON.stringify({ error: { message, code: status } }), { status });
  // the call is refused, the key check passes: the key is fine
  for (const [code, message] of [[402, "Insufficient credits"], [403, "Key limit exceeded: budget spent"], [403, "Your request was flagged by moderation"], [403, "Blocked by guardrail"]] as const) {
    const f = healthFixture((s) => s.url.endsWith("/api/v1/key") ? new Response("{}") : say(code, message));
    await assert.rejects(f.llm.post("hub:jev", jevRequest), (e: LlmError) => e.code === "failed" && new RegExp(`HTTP ${code}`).test(e.message));
    await new Promise((r) => setImmediate(r));
    const after = status(f.llm, "openrouter");
    assert.notEqual(after.status, "rejected", `${code} ${message}`);
    assert.deepEqual(f.sent.map((s) => s.init.method), ["POST", "GET"], "one call, then the key check");
    assert.equal(after.status, "ok");
  }
  // the call is refused with a 403 and the key check says the key itself is refused: now it is rejected
  const bad = healthFixture((s) => s.url.endsWith("/api/v1/key") ? say(401, "API key expired") : say(403, "forbidden"));
  await assert.rejects(bad.llm.post("hub:jev", jevRequest));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([status(bad.llm, "openrouter").status, status(bad.llm, "openrouter").reason], ["rejected", "已过期"]);
  // a check that cannot reach the provider leaves it unknown
  const down = healthFixture((s) => { if (s.url.endsWith("/api/v1/key")) throw new Error("offline"); return say(403, "forbidden"); });
  await assert.rejects(down.llm.post("hub:jev", jevRequest));
  await new Promise((r) => setImmediate(r));
  assert.equal(status(down.llm, "openrouter").status, "unknown");
  // 402 and 403 on an already rejected key do not clear it either
  let calls = 0;
  const keep = healthFixture((s) => s.url.endsWith("/api/v1/key") ? new Response("expired", { status: 401 }) : calls++ === 0 ? new Response("expired", { status: 401 }) : say(402, "Insufficient credits"));
  await assert.rejects(keep.llm.post("hub:jev", jevRequest));
  await assert.rejects(keep.llm.post("hub:jev", jevRequest));
  assert.equal(status(keep.llm, "openrouter").status, "rejected");
});

test("use: 403s in a row cause one key check per cooldown, not one each", async () => {
  const f = healthFixture((s) => s.url.endsWith("/api/v1/key") ? new Response("{}") : new Response("no", { status: 403 }));
  for (let i = 0; i < 4; i++) await assert.rejects(f.llm.post("hub:jev", jevRequest));
  await new Promise((r) => setImmediate(r));
  assert.equal(f.sent.filter((s) => s.init.method === "GET").length, 1);
});

test("verify: DeepSeek's balance answer decides between ok and low_balance (not a rejected key); a later good call clears it", async () => {
  let available = false;
  const f = healthFixture(() => new Response(JSON.stringify({ is_available: available, balance_infos: [] })));
  const low = await f.llm.verify("deepseek");
  assert.deepEqual([low.status, low.reason], ["low_balance", "余额不足"]);
  available = true;
  assert.equal((await f.llm.verify("deepseek")).status, "ok");
  // OpenRouter's key info has no such field
  const other = healthFixture(() => new Response(JSON.stringify({ is_available: false })));
  assert.equal((await other.llm.verify("openrouter")).status, "ok");
  // an unreadable body is still an accepted key
  const odd = healthFixture(() => new Response("OK"));
  assert.equal((await odd.llm.verify("deepseek")).status, "ok");
});

test("verify with maxAgeMs: a check made that recently is not repeated; the owner's (no limit) always asks", async () => {
  const f = healthFixture(() => new Response("{}"));
  await f.llm.verify("deepseek", { maxAgeMs: 30_000 });
  f.tick(10_000);
  const again = await f.llm.verify("deepseek", { maxAgeMs: 30_000 });
  assert.equal(f.sent.length, 1);
  assert.deepEqual([again.status, again.checked_at], ["ok", 1000], "the last answer, with its time");
  await f.llm.verify("deepseek");
  assert.equal(f.sent.length, 2);
  f.tick(40_000);
  await f.llm.verify("deepseek", { maxAgeMs: 30_000 });
  assert.equal(f.sent.length, 3);
  f.llm.forget("deepseek");
  await f.llm.verify("deepseek", { maxAgeMs: 30_000 });
  assert.equal(f.sent.length, 4, "a new key is always checked");
});
