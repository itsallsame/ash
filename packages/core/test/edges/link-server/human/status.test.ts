import assert from "node:assert/strict";
import test from "node:test";
import { eventually } from "../../../fixtures/wait";
import { AGENT, APPROVAL, Channel, GATE, quiet, startHumanHub } from "./helpers";

const frames = (c: Channel) => c.presented("status", "frame").map((f) => f.body as Record<string, any>);
const last = (c: Channel) => frames(c).at(-1)!;

test("a turn on the front lane makes status frames: thinking, the tools as steps, the replies, and the end", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const island = await Channel.open(hub, { surfaces: ["chat", "status"] });
  await eventually(() => frames(island).length === 1, "the idle frame on connect");
  assert.equal(last(island).state, "idle");

  hub.mini.announce("turn.started", { turn: "t1", lane: "front", ids: [] });
  await eventually(() => last(island).state === "thinking", "thinking");
  assert.equal(last(island).can_stop, true);
  assert.equal(last(island).agent, "agent:main");

  hub.mini.announce("agent.tool", { turn: "t1", name: "calendar", phase: "start", summary: "在看日程" });
  await eventually(() => last(island).state === "working", "working");
  assert.equal(last(island).text, "在看日程");
  hub.mini.announce("agent.tool", { turn: "t1", name: "calendar", phase: "end", summary: "在看日程", ok: true });
  await eventually(() => last(island).steps.includes("✓ 在看日程"), "the step done");

  await hub.mini.send({ to: "person:owner", kind: "request", word: "say", body: { text: "明天有会" } }, { ...AGENT, turn: "t1" });
  await eventually(() => last(island).reply === "明天有会", "the reply");

  hub.mini.announce("turn.ended", { turn: "t1", lane: "front", outcome: "completed" });
  await eventually(() => last(island).state === "done", "done");
  assert.equal(last(island).can_stop, false);
  assert.equal(last(island).text, "本轮回复");
  const revisions = frames(island).map((f) => f.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));
  assert.equal(new Set(revisions).size, revisions.length);
});

test("a turn on another lane is not shown; an open question makes the frame wait for the owner and goes away when answered", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const island = await Channel.open(hub, { surfaces: ["chat", "status"] }); island.follow();
  await eventually(() => frames(island).length === 1, "the idle frame");

  hub.mini.announce("turn.started", { turn: "b1", lane: "back", ids: [] });
  await quiet();
  assert.equal(last(island).state, "idle");

  hub.mini.announce("turn.started", { turn: "t1", lane: "front", ids: [] });
  const asking = hub.mini.send({ to: "person:owner", kind: "request", word: "ask", body: { title: "要发邮件", options: APPROVAL, expires_at: Date.now() + 60_000 } }, GATE);
  await eventually(() => last(island).state === "waiting_you", "waiting for the owner");
  const card = last(island).cards[0];
  assert.deepEqual([card.title, card.to, card.options.map((o: { id: string }) => o.id)], ["要发邮件", "service:gate", ["once", "always", "deny"]]);

  const ask = await island.seen((m) => m.kind === "request" && m.word === "ask", "the card");
  await island.answer(ask, "once");
  await asking;
  await eventually(() => last(island).cards.length === 0 && last(island).state === "thinking", "the card gone");
});

test("the process summary comes from the injected small model, once a burst of tools has settled", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const island = await Channel.open(hub, { surfaces: ["chat", "status"] });
  hub.mini.announce("turn.started", { turn: "t1", lane: "front", ids: [] });
  for (const name of ["a", "b", "c"]) {
    hub.mini.announce("agent.tool", { turn: "t1", name, phase: "start", summary: `做${name}` });
    hub.mini.announce("agent.tool", { turn: "t1", name, phase: "end", summary: `做${name}`, ok: true });
  }

  await eventually(() => last(island).text === "在整理日程", "the summary as the line");
  assert.equal(hub.summaries.length, 1, "asked once for the burst");
  assert.deepEqual(hub.summaries[0], ["做a", "做b", "做c"]);
});
