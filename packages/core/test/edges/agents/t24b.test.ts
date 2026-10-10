/**
 * T24b: what the two acceptance rounds of T24 and T17h found. A key the owner has just saved is in the runtime before the next
 * turn opens; a corrected key is written over the wrong one; the end of a turn is told before its failure notice; a lane that
 * cannot be ended does not keep a process from being stopped; a hub that is closing starts nothing from the turns it cuts; only
 * the agent's own process going away is named as such.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { failureCause } from "../../../src/edges/agents/failure";
import { caller, fixture, settle, waitFor, type FakeDriver } from "./helpers";

const M = "agent:main";
const KEY = "DEEPSEEK_API_KEY";
const vault = caller("service:vault", "service");
const sends = (d: FakeDriver, key: string) => d.of("send").filter((c) => c[2] === key);
const ended = (f: ReturnType<typeof fixture>) => f.router.events("turn.ended").map((e) => e.msg.body as { turn: string; lane: string; outcome: string });

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

test("a key being saved is written before the turn that comes at the same time opens: the owner's words and a wake both wait for it", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-fake-old" } });
  await f.start();
  const d = f.driver();
  const slow = gate();
  d.credentialsGate = slow.promise;
  f.secrets[KEY] = "sk-fake-new";

  const saved = f.service("vault.changed", { ref: KEY, action: "saved" }, vault); // not awaited: the runtime is slow to take the key
  const wake = f.call(M, "wake", { reason: "first meeting" }, { member: "service:semantic", via: "service", local: true });
  const said = f.call(M, "say", { text: "你好" });
  await settle();
  assert.equal(d.of("credentialsSet").length, 2, "the new key is being written");
  assert.equal(d.of("send").length, 0, "no turn opens while the key is on its way");

  slow.open();
  await Promise.all([saved, wake, said]);
  await waitFor(() => d.of("send").length === 2, "both lanes");
  assert.equal(d.credentials.get(KEY), "sk-fake-new");
  const lastSet = d.calls.map((c) => c[0]).lastIndexOf("credentialsSet");
  const firstSend = d.calls.findIndex((c) => c[0] === "send");
  assert.ok(lastSet < firstSend, "the key went in before the first turn");
});

test("a wrong key the owner corrects is written over the old one; a runtime that holds none gets it too", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-fake-wrong" } });
  await f.start();
  const d = f.driver();
  assert.equal(d.credentials.get(KEY), "sk-fake-wrong");
  f.secrets[KEY] = "sk-fake-right";
  await f.service("vault.changed", { ref: KEY, action: "saved" }, vault);
  assert.equal(d.credentials.get(KEY), "sk-fake-right");
  d.credentials.clear();
  await f.service("vault.changed", { ref: KEY, action: "saved" }, vault);
  assert.equal(d.credentials.get(KEY), "sk-fake-right");
});

test("a failed turn tells turn.ended first and the failure notice after it", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "做点事" });
  await waitFor(() => sends(d, "front").length === 1);
  const turn = d.running.get(`${M}/front`)!.turn;
  d.finish(M, "front", "error");
  await waitFor(() => f.router.to("person:owner", "show").length === 1);
  const at = (pred: (s: (typeof f.router.sent)[number]) => boolean) => f.router.sent.findIndex(pred);
  const endedAt = at((s) => s.msg.to === null && s.msg.word === "turn.ended" && (s.msg.body as any).turn === turn);
  const noticeAt = at((s) => s.msg.to === "person:owner" && s.msg.word === "say");
  const cardAt = at((s) => s.msg.to === "person:owner" && s.msg.word === "show");
  assert.ok(endedAt >= 0 && noticeAt > endedAt && cardAt > endedAt, `turn.ended ${endedAt}, notice ${noticeAt}, card ${cardAt}`);
});

test("a lane whose turn cannot be ended does not keep the others, or the stop of the process, from happening", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "前台" });
  await f.call(M, "wake", { reason: "pulse" }, { member: "service:pulse", via: "service", local: true });
  await waitFor(() => sends(d, "front").length === 1 && sends(d, "back").length === 1);
  const front = d.running.get(`${M}/front`)!.turn;
  const back = d.running.get(`${M}/back`)!.turn;

  const inbox = f.agents.manager.inbox;
  const byTurn = inbox.byTurn.bind(inbox);
  inbox.byTurn = (turn: string) => { if (turn === front) throw new Error("ledger is unwell"); return byTurn(turn); };

  await f.agents.manager.stopAgent(M, "by hand");
  await settle();

  assert.equal(d.of("stop").length, 1, "the process was stopped");
  assert.deepEqual(ended(f).filter((e) => e.turn === back).map((e) => e.outcome), ["interrupted"], "the other lane was ended");
  assert.ok(f.logs.some((l) => /ending the turn of agent:main\/front/.test(String(l[0])) && /ledger is unwell/.test(String(l[0]))));
  assert.notEqual(f.agents.manager.stateOf(M), "working");
  // the agent starts again with the lanes free
  inbox.byTurn = byTurn;
  await f.service("start", { agent: M });
  await settle();
  await f.call(M, "say", { text: "再来" });
  await waitFor(() => sends(d, "front").length === 2);
});

test("a hub that is closing: the turns it cuts start no other lane and ask for no screen reconcile", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  f.router.on("service:reflex/screen.plan", () => ({ ok: true, result: { data: { mode: "foreground_task", inject: "real screen" } } }));
  f.router.on("service:reflex/screen.reconcile", () => ({ ok: true, result: { data: { acted: [] } } }));
  await f.service("declare", { id: "agent:r", name: "r", summary: "reflective", brief: "reflect",
    lanes: { front: { from: ["person:owner"] }, reflect: { on: ["front:turn.ended"], speak: false } } });
  await settle();
  await f.call("agent:r", "say", { text: "忙着" });
  await waitFor(() => d.of("send").some((c) => c[1] === "agent:r"));
  assert.equal(f.router.to("service:reflex", "screen.reconcile").length, 0);

  await f.agents.stopAll();
  await settle();

  assert.ok(ended(f).some((e) => e.lane === "front" && e.outcome === "interrupted"), "the turn was ended");
  assert.equal(f.agents.manager.inbox.pending("agent:r", "reflect").length, 0, "nothing was filed for the reflect lane");
  assert.equal(f.router.to("service:reflex", "screen.reconcile").length, 0);
});

test("only the agent's own process going away is named as that: a tool's 'process exited' is not", () => {
  const away = "负责思考的进程中途退出了";
  assert.equal(failureCause("the agent process ended (process exited (SIGKILL))"), away);
  assert.equal(failureCause("process exited (SIGKILL)"), away); // the driver's word for it, at the start of the text
  assert.equal(failureCause("stdin failed: EPIPE"), away);
  assert.equal(failureCause("process failed: spawn ENOENT"), away);
  assert.notEqual(failureCause("tool bash failed: the build process exited with code 2"), away);
  assert.equal(failureCause("the build process exited with code 2"), "出了点意外的错误");
  assert.equal(failureCause("the helper's stdin failed to open"), "出了点意外的错误");
});
