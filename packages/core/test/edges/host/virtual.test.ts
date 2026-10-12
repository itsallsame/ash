import assert from "node:assert/strict";
import test from "node:test";
import { createVirtualScreen } from "../../../src/edges/host/virtual";

/** A host that answers every vscreen call; create says whether it reused the screen. */
const host = (reused = () => false, has = () => true) => {
  const calls: string[] = [];
  const client = {
    has,
    phone: (async (word: string) => {
      calls.push(word);
      return { supported: true, result: word === "vscreen.create" ? { reused: reused() } : {} };
    }) as any,
  };
  return { calls, virtual: createVirtualScreen(client) };
};

test("virtual screen: the turn that made it may close it once, at the generation it saw", async () => {
  const { calls, virtual } = host();
  await virtual.call("vscreen.create", {}, "t1");
  const seen = virtual.state();
  assert.deepEqual({ open: seen.open, owner: seen.owner }, { open: true, owner: "t1" });
  assert.equal(await virtual.close(seen.generation, "t1", "d1"), true);
  assert.equal(virtual.state().open, false);
  assert.equal(await virtual.close(seen.generation, "t1", "d1"), false, "a decision acts once");
  assert.deepEqual(calls, ["vscreen.create", "vscreen.close"]);
});

test("virtual screen: another turn using or recreating it keeps an old decision from closing it", async () => {
  const { virtual } = host();
  await virtual.call("vscreen.create", {}, "t1");
  const original = virtual.state().generation;
  await virtual.call("vscreen.tap", { x: 1, y: 1 }, "t2");
  assert.equal(await virtual.close(original, "t1", "d1"), false);
  await virtual.call("vscreen.create", {}, "t2");
  assert.equal(await virtual.close(virtual.state().generation, "t1", "d2"), false);
});

test("virtual screen: a screen reused by a new turn cannot be claimed by it; looking does not move the generation", async () => {
  let reused = false;
  const { virtual } = host(() => reused);
  await virtual.call("vscreen.create", {}, "");
  reused = true;
  await virtual.call("vscreen.create", {}, "t1");
  assert.equal(await virtual.close(virtual.state().generation, "t1", "d1"), false);
  const g = virtual.state().generation;
  await virtual.call("vscreen.see", {}, "t9");
  await virtual.call("vscreen.status", {}, "t9");
  assert.equal(virtual.state().generation, g);
});

test("virtual screen: available follows the host's vscreen capability", () => {
  assert.equal(host(undefined, () => false).virtual.available(), false);
  assert.equal(host().virtual.available(), true);
});

test("virtual screen: looking does not wait for the actions in front of it, and listeners hear it made and closed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: string[] = [];
  const client = { has: () => true, phone: (async (word: string) => {
    calls.push(word);
    if (word === "vscreen.tap") await gate;
    return { supported: true, result: word === "vscreen.create" ? { reused: false } : {} };
  }) as any };
  const virtual = createVirtualScreen(client);
  const heard: boolean[] = [];
  virtual.subscribe((open) => heard.push(open));
  await virtual.call("vscreen.create", {}, "t1");
  const tap = virtual.call("vscreen.tap", { x: 1, y: 1 }, "t1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await virtual.call("vscreen.see", {}, "");
  assert.deepEqual(calls, ["vscreen.create", "vscreen.tap", "vscreen.see"], "see went through while the tap was still out");
  release();
  await tap;
  await virtual.call("vscreen.close", {}, "t1");
  assert.deepEqual(heard, [true, false]);
  virtual.noteScreenChanged();
  assert.equal(virtual.screenChanges(), 1);
});
