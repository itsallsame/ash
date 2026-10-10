/**
 * REGRESSION-0.3 §1: the conversation. A person on a human channel talks to agent:main (a scripted driver); everything is
 * seen as frames the person gets and messages the driver is given.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN, OWNER, accepted, bodyOf, deferred, ownerMessage, quiet, startScenario, textOf, toOwner, dataOf } from "./harness";
import { eventually } from "../fixtures/wait";

test("S057 (agent 1): the owner speaks, agent:main takes a front-lane turn and answers the owner", async (t) => {
  const s = await startScenario(t);
  s.driver.script((turn) => turn.say("你好，我在。"));
  const owner = await s.human();

  accepted(await owner.say("你好"));

  const reply = await owner.next(toOwner("say", MAIN), "agent:main's answer reaches the owner");
  assert.equal(textOf(reply), "你好，我在。");
  const turn = await s.driver.turn((r) => r.agent === MAIN, "a turn of agent:main");
  assert.equal(turn.key, "front", "the owner's words go to the front lane");
  assert.ok(turn.messages.some(ownerMessage("你好")), "the turn was given the owner's message");
});

test("S001, S011: the same client_id is one message, not two", async (t) => {
  const s = await startScenario(t);
  s.driver.script((turn) => turn.say("收到"));
  const owner = await s.human();

  const first = accepted(await owner.say("只发一次", { clientId: "retry-1" }));
  const second = accepted(await owner.say("只发一次", { clientId: "retry-1" }));

  assert.equal(second.message.id, first.message.id);
  assert.equal(second.duplicate, true);
  await owner.next(toOwner("say", MAIN), "the answer");
  await quiet();
  assert.equal(s.driver.messages().filter(ownerMessage("只发一次")).length, 1, "the agent saw the message once");
});

test("S002, S003: a message that comes while the agent is busy waits for the next turn; the running turn goes on", async (t) => {
  const s = await startScenario(t);
  const hold = deferred();
  s.driver.script(async (turn) => {
    if (turn.messages.some(ownerMessage("第一件事"))) await turn.until(hold.promise);
    turn.say(`做完了：${turn.messages.map((m) => m.text).join(" / ")}`);
  });
  const owner = await s.human();

  accepted(await owner.say("第一件事"));
  const first = await s.driver.turn((r) => r.messages.some(ownerMessage("第一件事")), "the first turn");
  accepted(await owner.say("顺便还有一件事"));

  const { delivery } = await s.driver.delivery(ownerMessage("顺便还有一件事"), "the second message reaching the driver");
  assert.equal(delivery.via, "followup", "with no way to judge it, the message is queued for the next turn");
  assert.equal(first.outcome, "running", "the running turn was not stopped");
  hold.resolve();
  await first.done;
  assert.equal(first.outcome, "completed");
  await owner.seen((m) => textOf(m).includes("顺便还有一件事") && m.from === MAIN, "an answer that took the second message into account");
});

test("S004: the owner says stop while the agent is busy: the turn is interrupted", async (t) => {
  const s = await startScenario(t);
  const hold = deferred();
  s.driver.script(async (turn) => { await turn.until(hold.promise); });
  const owner = await s.human();

  accepted(await owner.say("开始一件很长的事"));
  const turn = await s.driver.turn((r) => r.agent === MAIN, "the long turn");
  accepted(await owner.say("停下"));

  await turn.done;
  assert.equal(turn.outcome, "interrupted");
  assert.deepEqual(s.driver.interrupts, [{ agent: MAIN, key: "front" }]);
  hold.resolve();
});

test("S005-S009: a failed turn tells the owner and offers [retry]; picking it is an ordinary reply and runs the turn again", async (t) => {
  const s = await startScenario(t);
  let attempts = 0;
  s.driver.script((turn) => {
    attempts += 1;
    if (attempts === 1) throw new Error("model unavailable");
    turn.say("这次好了");
  });
  const owner = await s.human();

  accepted(await owner.say("会失败的一件事"));

  await owner.seen(toOwner("say"), "a failure notice (say)");
  const card = await owner.seen(toOwner("show"), "a card with a retry option");
  const options = (bodyOf(card).card as { options: { id: string; text: string }[] }).options;
  const retry = options.find((o) => /重试|retry/i.test(o.text)) ?? options[0]!;
  accepted(await owner.say("", { inReplyTo: card.id, optionId: retry.id }));

  await owner.seen((m) => m.word === "say" && textOf(m) === "这次好了", "the answer of the second try");
  assert.equal(attempts, 2);
});

test("S016: an option card the agent shows; the owner's pick reaches the agent as a reply to that card", async (t) => {
  const s = await startScenario(t);
  s.driver.script(async (turn) => {
    if (turn.messages.some(ownerMessage("帮我选"))) {
      await turn.tool("human_show", { card: { type: "options", prompt: "选哪个？", options: [{ id: "a", text: "方案A" }, { id: "b", text: "方案B" }] } });
    }
  });
  const owner = await s.human();

  accepted(await owner.say("帮我选"));
  const card = await owner.seen(toOwner("show", MAIN), "the option card");
  accepted(await owner.say("", { inReplyTo: card.id, optionId: "b" }));

  const { message } = await s.driver.delivery((m) => m.text.startsWith(`[answers ${card.id}, option b]`), "the pick reaching the agent");
  assert.ok(message.text.includes(card.id), "the reply names the card it answers");
  assert.equal(message.from, OWNER);
});

test("S017: the agent reacts to a message of the owner", async (t) => {
  const s = await startScenario(t);
  s.driver.script(async (turn) => {
    const said = turn.messages.find(ownerMessage("今天通过了面试"));
    if (said) await turn.call(OWNER, "react", { message_id: said.id, emoji: "🎉" });
  });
  const owner = await s.human();

  accepted(await owner.say("今天通过了面试"));

  const react = await owner.seen(toOwner("react", MAIN), "a reaction");
  assert.equal(bodyOf(react).emoji, "🎉");
});

test("人场景 4: the owner can list the agents; the primary one is marked", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();

  const reply = await owner.call("service:agents", "list");

  assert.ok(reply.ok, "list is answered");
  const agents = (dataOf(reply) as { agents: { id: string; primary?: boolean }[] }).agents;
  assert.equal(agents.find((a) => a.id === MAIN)?.primary, true, "a fresh hub has agent:main, and it is the primary one");
});

test("人场景 5: while the owner is typing to an agent, its inbox waits for them to finish before opening a turn", async (t) => {
  const s = await startScenario(t);
  s.driver.script((turn) => turn.say("好"));
  const owner = await s.human();

  owner.presence({ typing: true, agent: MAIN });
  accepted(await owner.say("还没打完"));
  await quiet();
  assert.equal(s.driver.turns.length, 0, "no turn opens while the owner is still typing");

  owner.presence({ typing: false, agent: MAIN });
  await s.driver.turn((r) => r.messages.some(ownerMessage("还没打完")), "the turn after typing stopped");
});

test("S015, S019, S025: a new channel sees what was said; scrolling up pages backward", async (t) => {
  const s = await startScenario(t);
  s.driver.script((turn) => turn.say(`收到 ${turn.messages.length}`));
  const owner = await s.human();
  for (const [i, text] of ["第1句", "第2句", "第3句"].entries()) {
    accepted(await owner.say(text));
    await eventually(() => s.driver.turns.length === i + 1 && s.driver.turns[i]!.outcome === "completed", `turn ${i + 1} to end`);
  }
  await owner.seen((m) => m.from === MAIN && textOf(m).startsWith("收到"), "the agent's answers");

  const late = await s.human({ name: "the web page opened later" });
  await late.seen((m) => textOf(m) === "第3句", "the last sentence in the history of a new channel");
  const seqs = late.messages.map((m) => m.seq).sort((a, b) => a - b);
  const top = seqs[seqs.length - 1]!;
  const page = await late.page({ before: top, limit: 2 });

  assert.ok(page.messages.length <= 2 && page.messages.length > 0);
  const expected = seqs.filter((q) => q < top).slice(-page.messages.length);
  assert.deepEqual(page.messages.map((m) => (m as { seq: number }).seq).sort((a, b) => a - b), expected, "the page is the messages right before");
});

test("S114-S118: the owner stops one task from the island or the capsule: that turn is interrupted", async (t) => {
  const s = await startScenario(t);
  const hold = deferred();
  s.driver.script(async (turn) => { await turn.until(hold.promise); });
  const owner = await s.human();
  accepted(await owner.say("一件长任务"));
  const turn = await s.driver.turn((r) => r.agent === MAIN, "the running turn");

  const stopped = await owner.call("service:reflex", "task.stop", { turn: turn.turn });

  assert.ok(stopped.ok);
  await turn.done;
  assert.equal(turn.outcome, "interrupted");
  hold.resolve();
});
