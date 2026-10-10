/**
 * REGRESSION-0.3 §3 (agent 和子 agent), SPEC-08 §5, HUB-MODULES §2.5: declarations, sub-agents, lanes, restarts, pausing,
 * the first meeting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN, OWNER, accepted, bodyOf, byOwnerText, deferred, errorCode, extensionCapability, ownerMessage, quiet, resultOf,
  startScenario, textOf, toOwner, type ToolResult, dataOf } from "./harness";
import { eventually } from "../fixtures/wait";

const HELPER = "agent:helper";
const helper = (extra: Record<string, unknown> = {}) => ({
  id: HELPER, name: "帮手", summary: "做小事的帮手", brief: "照吩咐做小事，做完说一句。", runtime: { kind: "scripted" }, ...extra,
});

test("S046-S051: an agent declares a sub-agent, asks it, and the answer comes back; the owner hears nothing of it", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const state: { created?: ToolResult; asked?: ToolResult } = {};
  s.driver.scriptFor(HELPER, (turn) => turn.say("答案是 42"));
  s.driver.scriptFor(MAIN, byOwnerText({
    "找帮手问问": async (turn) => {
      state.created = await turn.tool("agent_create", helper());
      await turn.tool("agent_start", { agent: HELPER });
      state.asked = await turn.tool("agent_ask", { agent: HELPER, text: "生命的意义是什么" });
    },
  }));
  const owner = await s.human();

  accepted(await owner.say("找帮手问问"));

  await eventually(() => state.asked, "the answer from the helper");
  assert.equal(state.created!.isError, false);
  assert.equal(resultOf(state.asked!).answer, "答案是 42");
  await quiet();
  assert.ok(!owner.messages.some((m) => m.to === OWNER && m.word === "say" && m.from === HELPER), "a sub-agent does not speak to the owner on its own");
  const list = await owner.call("service:agents", "list");
  assert.ok(list.ok && JSON.stringify(dataOf(list)).includes(HELPER), "the declaration is in the list");
});

test("SPEC-08 §5.7: a sub-agent cannot be given more than its maker has (declare is narrowed to the caller's tools)", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const state: { within?: ToolResult; beyond?: ToolResult } = {};
  s.driver.scriptFor(HELPER, async (turn) => {
    state.within = await turn.tool("agent_create", { ...helper({ id: "agent:child-a" }), tools: ["human_say"] });
    state.beyond = await turn.tool("agent_create", { ...helper({ id: "agent:child-b" }), tools: ["human_say", "timer_set"] });
  });
  const owner = await s.human();
  const made = await owner.call("service:agents", "declare", { ...helper(), tools: ["agent_create", "human_say"] });
  assert.ok(made.ok, "the owner may declare any agent");
  await owner.call("service:agents", "start", { agent: HELPER });

  const told = await owner.call("service:agents", "tell", { agent: HELPER, text: "试着派两个下属" });
  assert.ok(told.ok);

  await eventually(() => state.beyond, "the helper's attempts");
  assert.equal(state.within!.isError, false, "a subset is allowed");
  assert.equal(state.beyond!.isError, true);
  assert.equal(errorCode(state.beyond!), "forbidden", "more than the caller has is forbidden, not a question to the owner");
});

test("SPEC-08 §5.7 (spawn): a temporary agent does one task and is gone; the ledger keeps what it did", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const state: { spawned?: ToolResult } = {};
  s.driver.script(async (turn) => {
    if (turn.agent !== MAIN) { turn.say("结果是 7"); return; }
    if (turn.messages.some(ownerMessage("派个临时工"))) {
      state.spawned = await turn.call("service:agents", "spawn", { task: "算 3 + 4", runtime: { kind: "scripted" } });
    }
  });
  const owner = await s.human();

  accepted(await owner.say("派个临时工"));

  await eventually(() => state.spawned, "the result of the temporary agent");
  assert.equal(resultOf(state.spawned!).answer, "结果是 7");
  const worker = s.driver.turns.find((r) => r.agent !== MAIN);
  assert.ok(worker && /^agent:w-/.test(worker.agent), "the temporary agent is named agent:w-<id>");
  await eventually(async () => {
    const list = await owner.call("service:agents", "list");
    return list.ok && !JSON.stringify(dataOf(list)).includes(worker.agent) ? true : null;
  }, "the temporary agent being removed");
  const ledger = await owner.ledger();
  assert.ok(ledger.some((m) => m.from === worker.agent || m.to === worker.agent), "what it did is still in the ledger");
});

test("SPEC-08 §5.8: the front and back lanes of one agent run at the same time", async (t) => {
  const s = await startScenario(t);
  const hold = deferred();
  s.driver.script(async (turn) => {
    if (turn.key === "front") await turn.until(hold.promise);
    else turn.say("后台那边我看到了");
  });
  const owner = await s.human();

  accepted(await owner.say("占着前台"));
  const front = await s.driver.turn((r) => r.key === "front", "the front turn");
  const told = await owner.call("service:agents", "tell", { agent: MAIN, text: "后台有事" });
  assert.ok(told.ok);

  const back = await s.driver.turn((r) => r.key === "back" && r.messages.some((m) => m.text.includes("后台有事")), "a back-lane turn");
  assert.equal(front.outcome, "running", "the front turn is still running");
  await back.done;
  assert.equal(back.outcome, "completed");
  await quiet();
  assert.ok(!owner.messages.some((m) => m.from === MAIN && textOf(m) === "后台那边我看到了"), "what the back lane says does not go to the owner");
  hold.resolve();
});

test("S170, S171, SPEC-00 §6.5: the hub restarts in the middle of a turn: the batch is not sent again; the agent is told, and a call in flight is not replayed", async (t) => {
  const s = await startScenario(t);
  const hand = await s.hand({ capabilities: [extensionCapability("x.test.act", { effect: "act", risk: "none" })] });
  const held = hand.hold("x.test.act");
  s.driver.script(byOwnerText({ "做一件慢事": async (turn) => { await turn.call(hand.member, "x.test.act", {}); } }));
  const owner = await s.human();
  accepted(await owner.say("做一件慢事"));
  await held.started;
  const before = s.driver.deliveries.length;

  await s.restart();

  const { message } = await s.driver.delivery((m) => m.lane === "back" && /中断|interrupt/i.test(m.text), "the note that the last turn was interrupted");
  assert.notEqual(message.from, OWNER);
  assert.equal(s.driver.deliveries.slice(before).filter((d) => d.messages.some(ownerMessage("做一件慢事"))).length, 0, "the owner's message was not given again");
  assert.equal(hand.calls.length, 1, "the call in flight was not replayed");
});

test("S164, S165: pausing stops the running turns of every agent; resuming is the owner's, from this machine", async (t) => {
  const s = await startScenario(t);
  const hold = deferred();
  s.driver.script(async (turn) => { await turn.until(hold.promise); });
  const owner = await s.human();
  accepted(await owner.say("忙着"));
  const turn = await s.driver.turn((r) => r.agent === MAIN, "a running turn");

  const paused = await owner.call("service:admin", "pause");
  assert.ok(paused.ok);

  await turn.done;
  assert.equal(turn.outcome, "interrupted");
  const resumed = await owner.call("service:admin", "resume", { confirmed: true });
  assert.ok(resumed.ok && (dataOf(resumed) as { paused: boolean }).paused === false);
  hold.resolve();
});

test("S028 (first_meeting): the first time the owner connects, the primary agent is woken once; a later connection does not wake it again", async (t) => {
  const s = await startScenario(t, { firstMeeting: true });
  await s.human();

  const { message } = await s.driver.delivery((m) => m.word === "wake" && m.text.startsWith("Wake · first_meeting"), "the first-meeting wake");
  assert.equal(message.lane, "back");

  await s.human({ name: "another channel of the owner" });
  await quiet();
  const wakes = s.driver.messages().filter((m) => m.word === "wake" && m.text.startsWith("Wake · first_meeting"));
  assert.equal(wakes.length, 1);
});

test("SPEC-08 §5.7: primary.set hands the primary role to another agent", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const owner = await s.human();
  const made = await owner.call("service:agents", "declare", helper());
  assert.ok(made.ok);

  const set = await owner.call("service:agents", "primary.set", { agent: HELPER });

  assert.ok(set.ok);
  const list = await owner.call("service:agents", "list");
  const agents = (dataOf(list) ?? { agents: [] }) as { agents: { id: string; primary?: boolean }[] };
  assert.equal(agents.agents.find((a) => a.id === HELPER)?.primary, true);
  assert.notEqual(agents.agents.find((a) => a.id === MAIN)?.primary, true);
});

test("S046: the owner talks to a sub-agent directly; in that turn it may answer the owner, and only there", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  s.driver.scriptFor(HELPER, (turn) => turn.say("我是帮手，听到了"));
  const owner = await s.human();
  assert.ok((await owner.call("service:agents", "declare", helper())).ok);
  assert.ok((await owner.call("service:agents", "start", { agent: HELPER })).ok);

  accepted(await owner.say("帮手你好", { to: HELPER }));

  const answer = await owner.seen(toOwner("say", HELPER), "the helper answering the owner");
  assert.equal(textOf(answer), "我是帮手，听到了");
});
