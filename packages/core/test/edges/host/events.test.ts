import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { HostEvent } from "../../../../sdk/src/host";
import { createHostPipe, parseHostEvent } from "../../../src/edges/host";
import { PassThrough } from "node:stream";
import { FakeHost } from "../../fixtures/host";

let host: FakeHost | undefined;
afterEach(async () => { await host?.stop(); host = undefined; });

describe("host events", () => {
  it("parses wake.fired", () => {
    assert.deepEqual(parseHostEvent('{"event":"wake.fired","at":1791234567000}'), { ok: true, event: { event: "wake.fired", at: 1791234567000 } });
  });
  it("parses env.changed for the network, with and without a proxy", () => {
    assert.deepEqual(parseHostEvent('{"event":"env.changed","what":"network","network":{"proxy":null},"online":true}'),
      { ok: true, event: { event: "env.changed", what: "network", network: { proxy: null }, online: true } });
    assert.deepEqual(parseHostEvent('{"event":"env.changed","what":"network","network":{"proxy":{"http":"http://p:1","no_proxy":"x"}},"online":false}'),
      { ok: true, event: { event: "env.changed", what: "network", network: { proxy: { http: "http://p:1", no_proxy: "x" } }, online: false } });
  });
  it("parses env.changed for power saving", () => {
    assert.deepEqual(parseHostEvent('{"event":"env.changed","what":"power","saver":true}'), { ok: true, event: { event: "env.changed", what: "power", saver: true } });
  });
  it("parses lifecycle.stop", () => {
    assert.deepEqual(parseHostEvent('{"event":"lifecycle.stop","deadline":1791234597000,"reason":"system_shutdown"}'),
      { ok: true, event: { event: "lifecycle.stop", deadline: 1791234597000, reason: "system_shutdown" } });
  });
  it("refuses malformed and unknown events with a reason", () => {
    for (const line of [
      "not json", "[]", '{"event":5}', '{"event":"wake.fired"}', '{"event":"wake.fired","at":"soon"}',
      '{"event":"env.changed","what":"network","network":{"proxy":3},"online":true}', '{"event":"env.changed","what":"network","network":{"proxy":null}}',
      '{"event":"env.changed","what":"power"}', '{"event":"env.changed","what":"light"}', '{"event":"lifecycle.stop","deadline":1}', '{"event":"mystery"}',
    ]) {
      const parsed = parseHostEvent(line);
      assert.equal(parsed.ok, false, line);
    }
  });

  it("delivers good event lines from the pipe in order, skips and logs bad ones, survives a throwing handler", async () => {
    host = new FakeHost();
    const got: HostEvent[] = [];
    const logs: string[] = [];
    let throwOnce = true;
    const conn = host.connect();
    const pipe = createHostPipe(conn.stdin, new PassThrough(), (line) => logs.push(line));
    await pipe.boot();
    const reader = pipe.events((event) => {
      if (event.event === "wake.fired" && throwOnce) { throwOnce = false; throw new Error("handler broke"); }
      got.push(event);
    });
    host.sendEvent({ event: "wake.fired", at: 1 });
    host.sendRaw("this is not json");
    host.sendRaw("");
    host.sendEvent({ event: "mystery" });
    host.sendEvent({ event: "wake.fired", at: 2 });
    host.sendEvent({ event: "env.changed", what: "power", saver: false });
    host.sendEvent({ event: "lifecycle.stop", deadline: 9, reason: "r" });
    await new Promise((resolve) => setImmediate(resolve));
    conn.close();
    await reader.done;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(got.map((event) => event.event), ["wake.fired", "env.changed", "lifecycle.stop"]);
    assert.equal((got[0] as { at: number }).at, 2);
    assert.equal(logs.filter((line) => /skipped/.test(line)).length, 2);
    assert.equal(logs.filter((line) => /handler failed for wake\.fired/.test(line)).length, 1);
  });
});
