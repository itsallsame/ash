/**
 * The hub died with its agents (the phone's system killed the host): the ledger still shows their turns as open, and the chat
 * says "working" for ever. When an agent starts, every turn of it the ledger still shows open belongs to a process that is gone,
 * and the manager writes its end: `interrupted`, with the lane of its start.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, settle, waitFor } from "./helpers";

const M = "agent:main";
const turn = (word: "turn.started" | "turn.ended", id: string, lane: string, from = M) => ({ from, to: null, kind: "event" as const, word, body: { turn: id, lane } });
const ended = (f: ReturnType<typeof fixture>) => f.router.events("turn.ended").map((e) => e.msg.body as { turn: string; lane: string; outcome: string; error?: string });

test("each turn the ledger shows open gets one end, interrupted, on its own lane; an ended turn and another agent's are left alone", async () => {
  const f = fixture();
  f.ledger.append(turn("turn.started", "t_done", "front"));
  f.ledger.append(turn("turn.ended", "t_done", "front"));
  f.ledger.append(turn("turn.started", "t_front", "front")); // (a second open turn on the same lane could not exist: the ledger closes the older one)
  f.ledger.append(turn("turn.started", "t_back", "back"));
  f.ledger.append(turn("turn.started", "t_front_2", "reply", "agent:elsewhere"));

  await f.start();
  await waitFor(() => ended(f).length >= 2);
  await settle();

  const got = ended(f).sort((a, b) => a.turn.localeCompare(b.turn));
  assert.deepEqual(got.map((e) => [e.turn, e.lane, e.outcome, e.error]), [
    ["t_back", "back", "interrupted", "the hub restarted"],
    ["t_front", "front", "interrupted", "the hub restarted"],
  ]);
});

test("nothing is open: nothing is written", async () => {
  const f = fixture();
  await f.start();
  await settle();
  assert.deepEqual(ended(f), []);
});
