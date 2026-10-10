import assert from "node:assert/strict";
import test from "node:test";
import { drawsConversation } from "../js/project.js";

const row = (seq, patch) => ({ seq, id: `m${seq}`, ts: seq * 1000, kind: "event", from: "agent:main", to: null, word: "agent.tool", body: {}, ...patch });

test("rows that only feed presence, progress and the activity sheet never ask for the conversation to be redrawn", () => {
  assert.equal(drawsConversation(row(1, { word: "agent.tool", turn: "t_abc", body: { turn: "t_abc", name: "read", phase: "start" } })), false);
  assert.equal(drawsConversation(row(2, { from: "service:cost", word: "usage.recorded", body: { input_tokens: 1, output_tokens: 2 } })), false);
  assert.equal(drawsConversation(row(3, { word: "turn.ended", turn: "t_abc", body: { turn: "t_abc", lane: "front", outcome: "completed" } })), false);
  assert.equal(drawsConversation(row(4, { kind: "request", to: "service:clock", word: "set", turn: "t_abc", body: { at: 1, to: "agent:main", word: "wake", body: {}, label: "x" } })), false);
  assert.equal(drawsConversation({ seq: 6, id: "m6" }), false, "an unknown row draws nothing");
});

test("rows that put a bubble in the conversation, or change one, do", () => {
  assert.equal(drawsConversation(row(1, { kind: "request", word: "say", from: "person:owner", to: "agent:main", body: { text: "hi" } })), true);
  assert.equal(drawsConversation(row(2, { kind: "request", word: "say", from: "agent:main", to: "person:owner", body: { text: "好", kind: "reply" } })), true);
  assert.equal(drawsConversation(row(3, { kind: "request", word: "react", from: "agent:main", to: "person:owner", body: { message_id: "m1", emoji: "👍" } })), true);
  assert.equal(drawsConversation(row(4, { word: "turn.started", turn: "t_abc", body: { turn: "t_abc", lane: "front", ids: ["m1"] } })), true, "it marks the messages it was given as read");
});
