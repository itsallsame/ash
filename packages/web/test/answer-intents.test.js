import assert from "node:assert/strict";
import test from "node:test";
import { AnswerIntents } from "../js/answer-intents.js";

test("unknown receipts keep their original client id, even as pages leave the window", () => {
  const intents = new AnswerIntents(2);
  const original = { choice: "yes", clientId: "unchanged", status: "uncertain" };
  intents.set("old", original);
  intents.set("new", { choice: "no", clientId: "other", status: "pending" });
  intents.prune(new Set());
  assert.equal(intents.get("old"), original);
  assert.throws(() => intents.set("third", { choice: "yes", status: "pending" }));
  assert.equal(intents.size, 2);
  original.status = "confirmed"; intents.prune(new Set());
  intents.set("third", { choice: "yes", status: "pending" });
  assert.equal(intents.size, 2);
});
