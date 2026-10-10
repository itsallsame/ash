import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import { WordError, type Caller, type Message } from "../../../../sdk/src/message";
import { compileSchema } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { createLlm, type Complete, type LlmUsageReport } from "../../../src/edges/llm";
import { createLlmService } from "../../../src/edges/llm/service";

const reply = (text = "four", patch: Partial<AssistantMessage> = {}): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }],
  api: "openai-completions", provider: "deepseek", model: "m", stopReason: "stop", timestamp: 1,
  usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...patch });

function service(complete: Complete = async () => reply(), key: string | null = "fake-key-0001") {
  const reports: LlmUsageReport[] = [];
  const seen: { model: Model<Api>; context: Context; options: Record<string, unknown> }[] = [];
  const llm = createLlm({ key: () => key, report: (usage) => { reports.push(usage); }, clock: { now: () => 5 },
    complete: async (model, context, options) => { seen.push({ model, context, options }); return complete(model, context, options); } });
  return { member: createLlmService(llm), reports, seen };
}
const msg = (word: string, body: unknown): Message => ({ seq: 1, id: "m_1", ts: 1, from: "app:fixture", to: "service:llm", kind: "request", word, body });
const ctx = (member: string, via: Caller["via"]) => ({ signal: new AbortController().signal, caller: { member, via, local: false } as Caller, raw: undefined });
const ask = { messages: [{ role: "user" as const, content: "2+2?" }], max_tokens: 20 };

test("service:llm speaks the words of its contract", () => {
  const { member } = service();
  assert.equal(member.id, "service:llm");
  assert.equal(member.kind, "service");
  assert.deepEqual(member.words().map((word) => word.word), ["complete", "usage.recorded"]);
  assert.deepEqual(member.words(), wordsOf("service:llm"));
});

test("complete: the text comes back, the model is the default one, and the use is counted against the caller", async () => {
  const { member, reports, seen } = service();
  const out = await member.handle(msg("complete", ask), ctx("app:fixture", "app"));
  assert.deepEqual(out, { data: { text: "four", model: "deepseek-flash", usage: { input_tokens: 11, output_tokens: 7 } } });
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.caller, "app:fixture");
  assert.equal(reports[0]!.ok, true);
  assert.equal(seen[0]!.options.maxTokens, 20);
  const check = compileSchema(wordsOf("service:llm")[0]!.result_schema!);
  assert.equal(check((out as { data: unknown }).data), true, JSON.stringify(check.errors));
});

test("complete: whoever calls, the use is theirs (the owner, an agent, an app)", async () => {
  const { member, reports } = service();
  for (const [who, via] of [["person:owner", "human"], ["agent:main", "agent"], ["app:sense-rules", "app"]] as const) await member.handle(msg("complete", ask), ctx(who, via));
  assert.deepEqual(reports.map((report) => report.caller), ["person:owner", "agent:main", "app:sense-rules"]);
});

test("complete: a named model is used and echoed back", async () => {
  const { member, seen } = service();
  const out = await member.handle(msg("complete", { ...ask, model: "openrouter:vendor/small" }), ctx("agent:main", "agent")) as { data: { model: string } };
  assert.equal(out.data.model, "openrouter:vendor/small");
  assert.equal(seen[0]!.model.id, "vendor/small");
  assert.equal(seen[0]!.model.provider, "openrouter");
});

test("complete: failures carry the contract's error codes", async () => {
  const code = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { assert.ok(error instanceof WordError); return error.code; } return "none"; };
  const ok = service();
  assert.equal(await code(() => ok.member.handle(msg("complete", { messages: [] }), ctx("app:a", "app"))), "bad_request");
  assert.equal(await code(() => ok.member.handle(msg("complete", { ...ask, model: "nonsense" }), ctx("app:a", "app"))), "bad_request");
  assert.equal(await code(() => service(undefined, null).member.handle(msg("complete", ask), ctx("app:a", "app"))), "unavailable");
  assert.equal(await code(() => service(async () => { throw new Error("upstream down"); }).member.handle(msg("complete", ask), ctx("app:a", "app"))), "failed");
  assert.equal(await code(() => ok.member.handle(msg("nothing", ask), ctx("app:a", "app"))), "not_found");
  const failed = service(async () => { throw new Error("upstream down"); });
  await failed.member.handle(msg("complete", ask), ctx("app:a", "app")).catch(() => {});
  assert.equal(failed.reports[0]!.ok, false, "a failed call is still reported");
});

test("complete: no key is ever in an error", async () => {
  const { member } = service(async () => { throw new Error("401 bad key fake-key-0001"); });
  try { await member.handle(msg("complete", ask), ctx("app:a", "app")); assert.fail("should throw"); } catch (error) { assert.doesNotMatch((error as Error).message, /fake-key-0001/); }
});
