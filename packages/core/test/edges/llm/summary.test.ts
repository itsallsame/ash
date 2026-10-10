import assert from "node:assert/strict";
import test from "node:test";
import { createSummarizer, summaryRequest, SUMMARY_CALLER } from "../../../src/edges/llm/summary";

const ask = (answer: () => Promise<{ text: string }>, model?: string) => {
  const seen: { caller: string; request: any }[] = [];
  const summarize = createSummarizer({ llm: { complete: async (caller, request) => { seen.push({ caller, request }); return { ...(await answer()), usage: { input_tokens: 0, output_tokens: 0 } }; } }, ...(model ? { model } : {}) });
  return { seen, summarize };
};

test("the summary asks as service:summary with the steps, one per line, and returns the trimmed text", async () => {
  const { seen, summarize } = ask(async () => ({ text: "  在整理日程\n" }), "deepseek-flash");
  assert.equal(await summarize(["做a", "做b"]), "在整理日程");
  assert.equal(SUMMARY_CALLER, "service:summary");
  assert.equal(seen[0]!.caller, "service:summary");
  assert.deepEqual(seen[0]!.request, { ...summaryRequest(["做a", "做b"]), model: "deepseek-flash" });
  assert.equal(seen[0]!.request.messages[1].content, "做a\n做b");
});

test("a failing model or an empty answer is no summary, and nothing is thrown", async () => {
  assert.equal(await ask(async () => { throw new Error("model down"); }).summarize(["x"]), null);
  assert.equal(await ask(async () => ({ text: " \n " })).summarize(["x"]), null);
});
