import assert from "node:assert/strict";
import test from "node:test";
import type { HostNetwork } from "../../../../sdk/src/host";
import { fixture, FakeDriver, settle, waitFor } from "./helpers";

const M = "agent:main";
const OLD: HostNetwork = { proxy: { http: "http://10.0.2.2:7890" } };
const changed = (f: ReturnType<typeof fixture>, network: HostNetwork) => f.service("env.changed", { what: "network", network, online: true });
const starts = (f: ReturnType<typeof fixture>, agent = M) => f.driver().of("start").filter((c) => c[1] === agent).length;
const sends = (d: FakeDriver, key: string) => d.of("send").filter((c) => c[2] === key);

test("the proxy changed: an idle agent's process is restarted and its sessions resume", async () => {
  const f = fixture({ network: OLD });
  await f.start();
  const handles = { ...f.agents.manager.runs.get(M)!.spec.sessions };
  await changed(f, { proxy: null });
  await settle();
  assert.equal(starts(f), 2);
  assert.deepEqual(f.driver().of("stop").map((c) => c[1]), [M]);
  assert.deepEqual((f.driver().of("start")[1]![2] as any).sessions, handles, "the same sessions are resumed");
  assert.ok(f.registry.members.has(M));
});

test("the proxy did not change: nothing restarts, whether the host says so again or only the power state changed", async () => {
  const f = fixture({ network: OLD });
  await f.start();
  await changed(f, { proxy: { http: "http://10.0.2.2:7890" } });
  await changed(f, { proxy: { http: "http://10.0.2.2:7890", no_proxy: "  " } });
  await f.service("env.changed", { what: "power", saver: true });
  await settle();
  assert.equal(starts(f), 1);
  // no proxy before and none now is no change either; a later change back to the first one is a change
  const g = fixture();
  await g.start();
  await changed(g, { proxy: null });
  await changed(g, { proxy: {} });
  await settle();
  assert.equal(starts(g), 1);
  await changed(g, OLD);
  await settle();
  assert.equal(starts(g), 2);
  await changed(g, OLD);
  await settle();
  assert.equal(starts(g), 2);
});

test("an agent in a turn finishes it first; no other lane starts a turn meanwhile; then it restarts and the waiting words go to the new process", async () => {
  const f = fixture({ network: OLD });
  await f.start();
  const d = f.driver();
  await f.call(M, "wake", { reason: "pulse" }, { member: "service:pulse", via: "service", local: true });
  await waitFor(() => sends(d, "back").length === 1);
  await changed(f, { proxy: { http: "http://10.0.2.2:7891" } });
  await settle();
  assert.equal(starts(f), 1, "the turn on back is not cut");
  assert.equal(d.of("stop").length, 0);
  await f.call(M, "say", { text: "hello" }, { member: "person:owner", via: "human", local: true, client: "client:a" });
  await settle();
  assert.equal(sends(d, "front").length, 0, "front takes no turn before the restart");
  d.finish(M, "back");
  await waitFor(() => starts(f) === 2);
  assert.equal(d.of("stop").length, 1);
  await waitFor(() => sends(d, "front").length === 1);
  assert.equal(((sends(d, "front")[0]![3]) as any)[0].text, "hello");
});

test("a change while the agent was still starting restarts it as soon as it is up", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const made: FakeDriver[] = [];
  class SlowFirst extends FakeDriver {
    async start(agent: string, spec: Parameters<FakeDriver["start"]>[1]) { if (!this.of("start").length) await gate; return super.start(agent, spec); }
  }
  const f = fixture({ network: OLD, drivers: { dsh: (report) => { const d = new SlowFirst(report); made.push(d); return d; } } });
  const started = f.agents.startAll();
  await waitFor(() => f.agents.manager.liveOf(M)?.state === "starting");
  await changed(f, { proxy: null });
  open();
  await started;
  await waitFor(() => made[0]!.of("start").length === 2);
  assert.equal(made[0]!.of("stop").length, 1);
});

test("an agent that runs on a computer is left alone", async () => {
  const made: FakeDriver[] = [];
  const make = (report: ConstructorParameters<typeof FakeDriver>[0]) => { const d = new FakeDriver(report); made.push(d); return d; };
  const f = fixture({ network: OLD, drivers: { dsh: make, codex: make } });
  await f.start();
  await f.service("declare", { id: "agent:far", name: "far", summary: "on a computer", brief: "work", runtime: { kind: "codex" }, native: { on: "computer:laptop" } });
  const of = (agent: string) => made.flatMap((d) => d.of("start")).filter((c) => c[1] === agent).length;
  await changed(f, { proxy: null });
  await settle();
  assert.equal(of(M), 2);
  assert.equal(of("agent:far"), 1);
  assert.equal(made.flatMap((d) => d.of("stop")).filter((c) => c[1] === "agent:far").length, 0);
});
