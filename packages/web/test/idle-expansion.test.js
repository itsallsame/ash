import assert from "node:assert/strict";
import test from "node:test";
import { IdleExpansion } from "../js/idle-expansion.js";

function clock() {
  let at = 0, sequence = 0;
  const timers = new Map();
  return { now: () => at, timer: (callback, wait) => { const id = ++sequence; timers.set(id, { callback, at: at + wait }); return id; }, clear: id => timers.delete(id),
    async advance(ms) { at += ms; for (const [id, task] of [...timers]) if (task.at <= at) { timers.delete(id); task.callback(); } await Promise.resolve(); await Promise.resolve(); } };
}
const item = { id: "old", full: "hash" };

test("fast scrolling does not restore text; stopping for 150ms starts exactly one restoration", async () => {
  const time = clock(); let started = 0, finish;
  const restore = new IdleExpansion({ ...time, candidates: () => [item, { id: "other", full: "other" }], contains: () => true,
    restore: () => { started++; return new Promise(resolve => { finish = resolve; }); } });
  restore.wake();
  for (let i = 0; i < 20; i++) { await time.advance(50); restore.scroll(); }
  assert.equal(started, 0);
  await time.advance(149); assert.equal(started, 0);
  await time.advance(1); assert.equal(started, 1);
  await time.advance(1000); assert.equal(started, 1);
  restore.dispose(); finish();
});

test("leaving the canonical window cancels a late source read, without forgetting expansion elsewhere", async () => {
  const time = clock(); let loaded = true, finish, committed = false, signal;
  const restore = new IdleExpansion({ ...time, candidates: () => loaded ? [item] : [], contains: () => loaded,
    restore: async (_item, abort) => { signal = abort; await new Promise(resolve => { finish = resolve; }); if (!abort.aborted) committed = true; } });
  restore.wake(); await time.advance(150);
  loaded = false; restore.wake(); assert.equal(signal.aborted, true);
  finish(); await time.advance(0);
  assert.equal(committed, false); assert.equal(restore.attempts.size, 0);
  restore.dispose();
});

test("resuming scrolling pauses construction admission and cancels a read that has not mounted", async () => {
  const time = clock(); let signal, finish;
  const restore = new IdleExpansion({ ...time, candidates: () => [item], contains: () => true,
    restore: async (_item, abort) => { signal = abort; await new Promise(resolve => { finish = resolve; }); } });
  restore.wake(); await time.advance(150); assert.equal(restore.idle(), true);
  restore.scroll(); assert.equal(restore.idle(), false); assert.equal(signal.aborted, true);
  restore.dispose(); finish();
});
