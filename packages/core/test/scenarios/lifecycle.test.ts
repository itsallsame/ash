/**
 * SPEC-07 §7: the host stops the kernel (`lifecycle.stop` on its standard input) or the entry program asks the hub to stop;
 * either way `hub.closed` tells when it is over, the port is gone and a second `stop()` is harmless.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startScenario } from "./harness";
import { eventually } from "../fixtures/wait";

const listening = (url: string) => fetch(url, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);

test("lifecycle.stop from the host stops the hub: closed resolves and the port is closed", async (t) => {
  const s = await startScenario(t);
  const hub = s.hub;
  assert.ok(await listening(hub.url), "the hub answers while it runs");

  s.hostEvent({ event: "lifecycle.stop", deadline: Date.now() + 5000, reason: "system_shutdown" });

  await hub.closed;
  assert.ok(!(await listening(hub.url)), "nothing is listening any more");
  await hub.stop();
});

test("stop() twice is one stop, and closed resolves once it is done", async (t) => {
  const s = await startScenario(t);
  const hub = s.hub;
  let closed = false;
  void hub.closed.then(() => { closed = true; });

  await Promise.all([hub.stop(), hub.stop()]);

  await eventually(() => closed, "closed to resolve");
  assert.ok(!(await listening(hub.url)));
});
