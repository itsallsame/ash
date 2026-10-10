import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import type { Message } from "../../../../sdk/src/message";
import type { WordContract } from "../../../../sdk/src/word";
import { createLlm, LlmError, type Complete, type LlmRequest } from "../../../src/edges/llm";
import { createReviewer, REVIEW_SYSTEM_PROMPT } from "../../../src/edges/llm/review";

const req = { seq: 1, id: "r1", ts: 1, from: "agent:main", to: "body:main", kind: "request", word: "workspace.bash",
  body: { command: "ls -la" } } as unknown as Message;
const contract = { member: "body:*", word: "workspace.bash", kind: "request", direction: "in", description: "Run a shell command on the machine.",
  input_schema: {}, effect: "execute", risk: "structure", callers: ["agent"], label: { doing: "在运行命令" } } as unknown as WordContract;

const fakeLlm = (text: string | (() => Promise<{ text: string }>), seen: { caller?: string; request?: LlmRequest }[] = []) => ({
  async complete(caller: string, request: LlmRequest) {
    seen.push({ caller, request });
    const out = typeof text === "string" ? { text } : await text();
    return { text: out.text, usage: { input_tokens: 1, output_tokens: 1 } };
  },
});

test("an allow answer allows, and the call goes out as service:gate with the facts and fenced body", async () => {
  const seen: { caller?: string; request?: LlmRequest }[] = [];
  const review = createReviewer({ llm: fakeLlm('{"decision":"allow","reason":"read only"}', seen), model: "deepseek-flash" });
  assert.equal(await review(req, contract), "allow");
  assert.equal(seen[0]!.caller, "service:gate");
  assert.equal(seen[0]!.request!.model, "deepseek-flash");
  assert.equal(seen[0]!.request!.timeout_ms, 5000);
  assert.equal(seen[0]!.request!.messages[0]!.content, REVIEW_SYSTEM_PROMPT);
  const user = seen[0]!.request!.messages[1]!.content;
  assert.match(user, /"word":"workspace.bash"/);
  assert.match(user, /<untrusted_data>\n\{"command":"ls -la"\}\n<\/untrusted_data>/);
});

test("an ask answer asks; a fenced JSON answer is read", async () => {
  assert.equal(await createReviewer({ llm: fakeLlm('{"decision":"ask","reason":"deletes"}') })(req, contract), "ask");
  assert.equal(await createReviewer({ llm: fakeLlm('```json\n{"decision":"allow","reason":"ok"}\n```') })(req, contract), "allow");
});

test("timeout, model error, and bad answers all give ask and never throw", async () => {
  const hang = createReviewer({ llm: fakeLlm(() => new Promise(() => {})), timeoutMs: 20 });
  assert.equal(await hang(req, contract), "ask");
  const failing = createReviewer({ llm: { async complete() { throw new LlmError("failed", "boom"); } } });
  assert.equal(await failing(req, contract), "ask");
  const syncThrow = createReviewer({ llm: { complete() { throw new Error("sync"); } } });
  assert.equal(await syncThrow(req, contract), "ask");
  for (const bad of ["", "allow", "I think yes", "[]", "null", '{"decision":"yes","reason":"x"}', '{"decision":"allow"}',
    '{"decision":"allow","reason":" "}', '{"decision":"allow","reason":"x","extra":1}', '{"decision":"allow","reason":"x"} trailing',
    'Sure! {"decision":"allow","reason":"x"}', '{"decision":"ALLOW","reason":"x"}'])
    assert.equal(await createReviewer({ llm: fakeLlm(bad) })(req, contract), "ask", `answer ${JSON.stringify(bad)}`);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.equal(await createReviewer({ llm: fakeLlm('{"decision":"allow","reason":"x"}') })({ ...req, body: circular }, contract), "ask");
});

test("no key set: the real llm reports unavailable and the reviewer asks", async () => {
  let called = false;
  const llm = createLlm({ key: () => null, report: () => {}, complete: async () => { called = true; throw new Error("not reached"); } });
  assert.equal(await createReviewer({ llm })(req, contract), "ask");
  assert.equal(called, false);
});

test("through the real llm with a fake provider: allow and a provider failure", async () => {
  const msg = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }],
    api: "openai-completions", provider: "deepseek", model: "m", stopReason, timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const make = (complete: Complete) => createLlm({ key: () => "fake-key-0001", report: () => {}, complete });
  const ok = make(async (_m: Model<Api>, _c: Context) => msg('{"decision":"allow","reason":"fine"}'));
  assert.equal(await createReviewer({ llm: ok })(req, contract), "allow");
  const bad = make(async () => msg("", "error"));
  assert.equal(await createReviewer({ llm: bad })(req, contract), "ask");
});
