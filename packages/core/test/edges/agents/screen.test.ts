import assert from "node:assert/strict";
import test from "node:test";
import { fixture, settle, waitFor } from "./helpers";

const M = "agent:main";
const plan = (mode: string, inject?: string) => () => ({ ok: true as const, result: { data: { mode, ...(inject ? { inject } : {}) } } });

test("screen.plan is asked before the owner's turn opens and its text goes into the session ahead of the send", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  f.router.on("service:reflex/screen.plan", plan("virtual_task", "use the virtual screen"));
  await f.call(M, "say", { text: "在闲鱼帮我查价格" });
  await waitFor(() => d.of("send").length === 1);
  const asked = f.router.to("service:reflex", "screen.plan");
  assert.equal(asked.length, 1);
  assert.deepEqual((asked[0]!.msg.body as any), { agent: M, lane: "front", ids: [(asked[0]!.msg.body as any).ids[0]] });
  assert.equal((asked[0]!.msg.body as any).ids.length, 1);
  const order = d.calls.map((c) => c[0]);
  const text = d.calls.find((c) => c[0] === "inject" && (c[3] as any).text);
  assert.deepEqual((text![3] as any), { text: "use the virtual screen" });
  assert.ok(order.indexOf("inject") < order.indexOf("send"));
});

test("mode none, an error, or no reflex at all: nothing is injected and the turn runs", async () => {
  for (const setup of [(f: ReturnType<typeof fixture>) => f.router.on("service:reflex/screen.plan", plan("none")),
    (f: ReturnType<typeof fixture>) => f.router.on("service:reflex/screen.plan", () => ({ ok: false, error: { code: "unavailable", message: "x" } })),
    (f: ReturnType<typeof fixture>) => f.router.on("service:reflex/screen.plan", () => { throw new Error("boom"); }),
    () => {}]) {
    const f = fixture();
    await f.start();
    setup(f);
    await f.call(M, "say", { text: "hi" });
    await waitFor(() => f.driver().of("send").length === 1);
    assert.equal(f.driver().of("inject").filter((c) => (c[3] as any).text).length, 0);
  }
});

test("a turn that is not the owner's is not planned", async () => {
  const f = fixture();
  await f.start();
  await f.call(M, "wake", { reason: "pulse" }, { member: "service:pulse", via: "service", local: true });
  await waitFor(() => f.driver().of("send").length === 1);
  assert.equal(f.router.to("service:reflex", "screen.plan").length, 0);
});

test("screen.reconcile is asked when a planned turn ends, once, with the turn, lane and outcome; an unplanned turn does not ask", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  f.router.on("service:reflex/screen.plan", plan("foreground_task", "real screen"));
  f.router.on("service:reflex/screen.reconcile", () => ({ ok: true, result: { data: { acted: [] } } }));
  await f.call(M, "say", { text: "go" });
  await waitFor(() => d.of("send").length === 1);
  assert.equal(f.router.to("service:reflex", "screen.reconcile").length, 0); // not before the turn ends
  const turn = d.running.get(`${M}/front`)!.turn;
  d.finish(M, "front");
  await waitFor(() => f.router.to("service:reflex", "screen.reconcile").length === 1);
  assert.deepEqual(f.router.to("service:reflex", "screen.reconcile")[0]!.msg.body, { turn, agent: M, lane: "front", outcome: "completed" });
  // the next turn gets no plan from reflex (it is offline now): no reconcile
  f.router.handlers.delete("service:reflex/screen.plan");
  await f.call(M, "say", { text: "again" });
  await waitFor(() => d.of("send").length === 2);
  d.finish(M, "front");
  await settle();
  assert.equal(f.router.to("service:reflex", "screen.reconcile").length, 1);
});

test("a reflex that refuses the reconcile does not disturb the lane: the next batch still goes", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  f.router.on("service:reflex/screen.plan", plan("virtual_task", "v"));
  f.router.on("service:reflex/screen.reconcile", () => { throw new Error("down"); });
  await f.call(M, "say", { text: "one" });
  await waitFor(() => d.of("send").length === 1);
  d.finish(M, "front");
  await waitFor(() => f.router.to("service:reflex", "screen.reconcile").length === 1);
  await f.call(M, "say", { text: "two" });
  await waitFor(() => d.of("send").length === 2);
});
