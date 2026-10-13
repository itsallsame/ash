import assert from "node:assert/strict";
import test from "node:test";
import { readInlineAttachment } from "../js/inline-attachment.js";

test("attachment reads select bytes from only the known message and do not retain raw fields", async () => {
  const item = { id: "one", seq: 19, attachments: [{ source: "inline", index: 0 }, { source: "inline", index: 1 }] };
  const net = {
    data: async (to, word, body) => {
      assert.equal(to, "service:history"); assert.equal(word, "read"); assert.deepEqual(body, { from_seq: 19, to_seq: 19 });
      return { messages: [{ id: "one", seq: 19, from: "person:owner", to: "agent:main", kind: "request", word: "say",
        body: { secret: "not-returned", attachments: [{ name: "a.png", mime_type: "image/png", data: "QUJD", secret: "not-returned" }, { name: "b.png", mime_type: "image/png", data: { $blob: "hash" } }] } }] };
    },
    readBlob: async hash => { assert.equal(hash, "hash"); return { data: new TextEncoder().encode("QUJD") }; },
  };
  assert.deepEqual(await readInlineAttachment(net, item, "one", 0), { name: "a.png", mime_type: "image/png", data: "QUJD" });
  assert.deepEqual(await readInlineAttachment(net, item, "one", 1), { name: "b.png", mime_type: "image/png", data: "QUJD" });
  assert.equal(await readInlineAttachment(net, item, "one", 2), null);
  assert.equal(await readInlineAttachment(net, null, "one", 0), null);
  net.data = async () => ({ messages: [{ id: "one", seq: 19, from: "service:tool", to: "person:owner", kind: "request", word: "say", body: { attachments: [{ data: "QUJD", name: "tool", mime_type: "image/png" }] } }] });
  assert.equal(await readInlineAttachment(net, item, "one", 0), null);
});
