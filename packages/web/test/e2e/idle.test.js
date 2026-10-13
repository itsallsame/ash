// A page at rest asks for nothing: after it is connected, ten seconds of quiet are ten seconds without a request or a new row.
import assert from "node:assert/strict";
import test from "node:test";
import { openPage, withBrowser } from "./support.js";

const historyReads = (kernel) => kernel.requests.filter((request) => request.to === "service:history").length;

test(...withBrowser("after connecting, the page at rest for ten seconds asks the history for nothing more and the ledger does not grow", async ({ kernel, browser }) => {
  kernel.append({ from: "agent:main", to: "person:owner", kind: "request", word: "say", body: { text: "你好", kind: "reply" } });
  await openPage(browser, kernel);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const reads = historyReads(kernel), rows = kernel.ledger.length;
  assert.ok(reads >= 2, "it read its first window and the current state");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  assert.equal(historyReads(kernel), reads, "no read of the history while nothing happens");
  assert.equal(kernel.ledger.length, rows, "no row appended by the page's own reading");
}));
