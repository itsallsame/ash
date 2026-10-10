import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { lintWords } from "../../../../sdk/src/word";
import type { Message, Outgoing, Reply } from "../../../../sdk/src/message";
import { createHostService } from "../../../src/edges/host";

const setup = (offline: string[] = []) => {
  const sent: { msg: Outgoing; from: string }[] = [];
  const calls: unknown[][] = [];
  const stops: unknown[][] = [];
  const logs: string[] = [];
  const supported = <R>(result: R) => ({ supported: true as const, result });
  const client = {
    wakeAt: async (at: number) => { calls.push(["wakeAt", at]); return supported({}); },
    wakeClear: async () => { calls.push(["wakeClear"]); return { supported: false as const }; },
    powerHold: async (ms: number, reason: string) => { calls.push(["powerHold", ms, reason]); return supported({}); },
    powerRelease: async () => supported({}),
    handsHandoff: async (port: number, token: string) => { calls.push(["handoff", port, token]); return supported({ delivered: ["x"] }); },
    updateInstall: async () => supported({}),
  };
  const router = {
    send: async (msg: Outgoing, caller: { member: string }): Promise<Reply> => {
      sent.push({ msg, from: caller.member });
      return offline.includes(msg.to ?? "") ? { ok: false, error: { code: "offline", message: "off" } } : { ok: true };
    },
  };
  const service = createHostService({ client, router, onStop: (deadline, reason) => { stops.push([deadline, reason]); }, log: (m) => logs.push(m) });
  return { service, sent, calls, stops, logs };
};
const msg = (word: string, body: unknown): Message => ({ seq: 1, id: "m1", ts: 1, from: "service:clock", to: "service:host", kind: "request", word, body });
const ctx = { signal: new AbortController().signal, caller: { member: "service:clock", via: "service" as const, local: true }, raw: undefined };
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("service:host: its words are the host client's calls; what the host lacks answers unavailable", async () => {
  const s = setup();
  assert.equal(s.service.member.id, "service:host");
  assert.deepEqual(lintWords(s.service.member.words()), []);
  assert.deepEqual(await s.service.member.handle(msg("wake.at", { at: 5 }), ctx), { data: {} });
  assert.deepEqual(await s.service.member.handle(msg("hands.handoff", { port: 9, token: "t" }), ctx), { data: { delivered: ["x"] } });
  await assert.rejects(s.service.member.handle(msg("wake.clear", {}), ctx), (e: any) => e.code === "unavailable");
  await assert.rejects(s.service.member.handle(msg("nope", {}), ctx), (e: any) => e.code === "not_found");
  assert.deepEqual(s.calls, [["wakeAt", 5], ["handoff", 9, "t"], ["wakeClear"]]);
});

test("host events become words sent as service:host; a missing service:link is not an error; lifecycle.stop reaches onStop", async () => {
  const s = setup(["service:link"]);
  const input = new PassThrough();
  const reader = s.service.listen(input);
  input.write('{"event":"wake.fired","at":1791234567000}\n');
  input.write('{"event":"env.changed","what":"power","saver":true}\n');
  input.write('{"event":"lifecycle.stop","deadline":1791234597000,"reason":"system_shutdown"}\n');
  input.write("not json\n");
  await settle();
  reader.close();
  assert.deepEqual(s.sent.map((x) => [x.from, x.msg.kind, x.msg.to, x.msg.word, x.msg.body]), [
    ["service:host", "event", "service:clock", "wake.fired", { at: 1791234567000 }],
    ["service:host", "event", "service:agents", "env.changed", { what: "power", saver: true }],
    ["service:host", "event", "service:link", "env.changed", { what: "power", saver: true }],
  ]);
  assert.deepEqual(s.stops, [[1791234597000, "system_shutdown"]]);
  assert.equal(s.logs.length, 1, "only the bad line is logged");
});
