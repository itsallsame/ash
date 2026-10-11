import assert from "node:assert/strict";
import test from "node:test";
import { FullTexts } from "../js/full-texts.js";

test("revisiting expanded rows remembers choices while text and choices stay finite", async () => {
  const cache = new FullTexts({ maxBytes: 100, maxChoices: 4 });
  let reads = 0;
  const read = async () => { reads++; return "汉".repeat(20); };
  for (let i = 0; i < 10000; i++) {
    await cache.load(`m${i}`, `h${i}`, read);
    cache.retain([{ full: `h${i}` }]);
    assert.ok(cache.bytes <= 100);
    assert.ok(cache.choices.size <= 4);
  }
  assert.equal(cache.expanded("m9996"), true);
  assert.equal(cache.expanded("m9995"), false);
  await cache.load("m9996", "h9996", read);
  cache.retain([{ full: "h9996" }]);
  assert.equal(reads, 10001);
  assert.equal(cache.get("h9996"), "汉".repeat(20));
});

test("concurrent reads share one request and an old dataset cannot repopulate the cache", async () => {
  const cache = new FullTexts();
  let finish, reads = 0;
  const read = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  const first = cache.load("one", "hash", read), second = cache.load("two", "hash", read);
  await Promise.resolve();
  cache.reset(); finish("old");
  assert.equal(await first, null); assert.equal(await second, null);
  assert.equal(reads, 1); assert.equal(cache.bytes, 0); assert.equal(cache.values.size, 0);
});

test("shared hashes do not turn one expansion choice into another message's choice", async () => {
  const cache = new FullTexts(); let reads = 0;
  await cache.load("first", "same", async () => { reads++; return "complete text"; });
  assert.equal(cache.has("same", "first"), true); assert.equal(cache.has("same", "second"), false);
  await cache.load("second", "same", async () => { reads++; return "complete text"; });
  assert.equal(reads, 1); assert.equal(cache.has("same", "second"), true);
});
