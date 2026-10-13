import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createHostPipe, HostPipeError } from "../../../src/edges/host";
import { FAKE_SEAL_KEY, FakeHost } from "../../fixtures/host";

const run = (options?: ConstructorParameters<typeof FakeHost>[0]) => {
  const host = new FakeHost(options);
  const conn = host.connect();
  const logs: string[] = [];
  return { host, conn, logs, pipe: createHostPipe(conn.stdin, conn.stdout, (line) => logs.push(line)) };
};

test("pipe: the secrets come on the first line and nowhere else", async () => {
  const { pipe, conn } = run();
  assert.equal((await pipe.boot()).sealKey.toString("base64url"), FAKE_SEAL_KEY);
  conn.close();
});

test("pipe: a malformed seal key, a pipe closed before the secrets, or no boot line in time is refused", async () => {
  const short = run({ sealKey: "short" });
  await assert.rejects(short.pipe.boot(), /32 bytes/);
  const gone = run({ sealKey: null });
  gone.conn.close();
  await assert.rejects(gone.pipe.boot(), /closed the pipe before the secrets/);
  const silent = run({ sealKey: null });
  await assert.rejects(silent.pipe.boot(20), /no secrets from the host within 20 ms/);
  silent.conn.close();
});

test("pipe: a call goes out as one line and its answer is matched by id, also out of order", async () => {
  const { host, pipe, conn } = run();
  await pipe.boot();
  host.results.set("identity.sign", async (body: any) => { await new Promise((r) => setTimeout(r, 20)); return { sig: `late:${body.data}` }; });
  const slow = pipe.request("identity.sign", { data: "a" }, 1000);
  const fast = pipe.request("identity.key", {}, 1000);
  assert.deepEqual(await fast, { ok: true, result: { id: "fakeid0123456789abcdef", public_key: "fake-public-key" } });
  assert.deepEqual(await slow, { ok: true, result: { sig: "late:a" } });
  conn.close();
});

test("pipe: no answer in time is a TimeoutError, a closed pipe a ClosedError, also for calls still waiting", async () => {
  const { host, pipe, conn } = run();
  await pipe.boot();
  host.hangs.add("wake.at");
  await assert.rejects(pipe.request("wake.at", { at: 1 }, 20), (e: unknown) => e instanceof HostPipeError && e.name === "TimeoutError");
  const waiting = pipe.request("wake.at", { at: 2 }, 5000);
  conn.close();
  await assert.rejects(waiting, (e: unknown) => e instanceof HostPipeError && e.name === "ClosedError");
  await assert.rejects(pipe.request("wake.at", { at: 3 }, 1000), (e: unknown) => e instanceof HostPipeError && e.name === "ClosedError");
});

test("pipe: events that came before anyone listened are handed over first; replies to no call are logged", async () => {
  const { host, pipe, conn, logs } = run();
  await pipe.boot();
  host.sendEvent({ event: "wake.fired", at: 7 });
  host.sendRaw('{"reply":99,"ok":true,"result":{}}');
  await new Promise((r) => setTimeout(r, 10));
  const got: unknown[] = [];
  const reader = pipe.events((event) => { got.push(event); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, [{ event: "wake.fired", at: 7 }]);
  assert.ok(logs.some((l) => /reply to no call/.test(l)));
  reader.close();
  host.sendEvent({ event: "wake.fired", at: 8 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1, "after close, events are dropped");
  assert.deepEqual(await pipe.request("identity.key", {}, 1000), { ok: true, result: { id: "fakeid0123456789abcdef", public_key: "fake-public-key" } }, "calls still work");
  conn.close();
});

test("pipe: the kernel's output carries only call lines", async () => {
  const host = new FakeHost();
  const conn = host.connect();
  const out = new PassThrough();
  const written: string[] = [];
  out.on("data", (chunk) => written.push(String(chunk)));
  const pipe = createHostPipe(conn.stdin, out);
  await pipe.boot();
  void pipe.request("status.set", { text: "x", state: "running" }, 50).catch(() => {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written.join("").trim().split("\n").map((l) => JSON.parse(l)), [{ call: 1, method: "status.set", params: { text: "x", state: "running" } }]);
  conn.close();
});
