import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { lintWords } from "../../../../sdk/src/word";
import type { Message, Outgoing, Reply, WordResult } from "../../../../sdk/src/message";
import { createHostPipe, createHostService, createVirtualScreen } from "../../../src/edges/host";

const capOfMethod = (m: string) => (m.startsWith("vscreen.") ? "vscreen" : m === "input.key" ? "input" : "apps");
const PHONE_RESULTS: Record<string, unknown> = {
  "vscreen.create": { displayId: 3, width: 720, height: 1280, dpi: 320, reused: false, message: "Virtual screen created." },
  "vscreen.see": { jpeg: "AAAA", displayId: 3, screenW: 720, screenH: 1280, imageW: 360, imageH: 640 },
  "vscreen.tap": { message: "Tapped." },
  "input.key": { message: "Media key play_pause sent." },
  "apps.open": { package: "com.x", opened: true, message: "started and confirmed in front (com.x)" },
};
const setup = (offline: string[] = [], onNetwork?: (network: unknown, online: boolean) => void, phoneCaps: string[] = ["vscreen", "input", "apps"]) => {
  const sent: { msg: Outgoing; from: string }[] = [];
  const calls: unknown[][] = [];
  const stops: unknown[][] = [];
  const logs: string[] = [];
  const supported = <R>(result: R) => ({ supported: true as const, result });
  const caps = new Set<string>(["wake", "power", "hands", "update", ...phoneCaps]);
  const client = {
    wakeAt: async (at: number) => { calls.push(["wakeAt", at]); return supported({}); },
    wakeClear: async () => { calls.push(["wakeClear"]); return { supported: false as const }; },
    powerHold: async (ms: number, reason: string) => { calls.push(["powerHold", ms, reason]); return supported({}); },
    powerRelease: async () => supported({}),
    handsHandoff: async (port: number, token: string) => { calls.push(["handoff", port, token]); return supported({ delivered: ["x"] }); },
    updateInstall: async () => supported({}),
    has: (cap: string) => caps.has(cap),
    phone: async (method: string, req: unknown): Promise<any> => {
      calls.push(["phone", method, req]);
      if (!caps.has(capOfMethod(method))) return { supported: false as const };
      return supported(PHONE_RESULTS[method] ?? { message: "ok" });
    },
    lifecycleRestart: async (reason: string) => { calls.push(["restart", reason]); return {}; },
  };
  const router = {
    send: async (msg: Outgoing, caller: { member: string }): Promise<Reply> => {
      sent.push({ msg, from: caller.member });
      return offline.includes(msg.to ?? "") ? { ok: false, error: { code: "offline", message: "off" } } : { ok: true };
    },
  };
  const service = createHostService({ client, router, virtual: createVirtualScreen(client), onStop: (deadline, reason) => { stops.push([deadline, reason]); }, ...(onNetwork ? { onNetwork } : {}), log: (m) => logs.push(m) });
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

test("service:host: phone actions are forwarded to the host and shaped (data, the host's message, the see JPEG)", async () => {
  const s = setup();
  assert.deepEqual(await s.service.member.handle(msg("input.key", { key: "play_pause" }), ctx), { content: [{ type: "text", text: "Media key play_pause sent." }] });
  assert.deepEqual(await s.service.member.handle(msg("apps.open", { app: "x" }), ctx), { data: { package: "com.x", opened: true }, content: [{ type: "text", text: "started and confirmed in front (com.x)" }] });
  assert.deepEqual(await s.service.member.handle(msg("vscreen.create", { short_edge: 720 }), ctx), { data: { displayId: 3, width: 720, height: 1280, dpi: 320, reused: false }, content: [{ type: "text", text: "Virtual screen created." }] });
  const see = await s.service.member.handle(msg("vscreen.see", {}), ctx) as WordResult;
  assert.deepEqual(see.content?.[1], { type: "image", mime: "image/jpeg", b64: "AAAA" });
  assert.match((see.content?.[0] as { text: string }).text, /display 3\) 720x1280; image 360x640: multiply image coordinates by 2\.0000/);
  assert.deepEqual(s.calls, [["phone", "input.key", { key: "play_pause" }], ["phone", "apps.open", { app: "x" }], ["phone", "vscreen.create", { short_edge: 720 }], ["phone", "vscreen.see", {}]]);
});

test("service:host: a phone word is listed only while the host has its group, and answers unavailable otherwise", async () => {
  const s = setup([], undefined, ["input"]); // host can do media/volume keys (unpaired), but no virtual screen, no launching
  const listed = s.service.member.words().map((w) => w.word);
  assert.ok(listed.includes("input.key"), "input.key is listed");
  assert.ok(!listed.some((w) => w.startsWith("vscreen.")), "no vscreen word is listed");
  assert.ok(!listed.includes("apps.open") && !listed.includes("apps.open_url"), "apps.open is not listed");
  await assert.rejects(s.service.member.handle(msg("vscreen.create", {}), ctx), (e: any) => e.code === "unavailable");
  assert.deepEqual(await s.service.member.handle(msg("input.key", { key: "play_pause" }), ctx), { content: [{ type: "text", text: "Media key play_pause sent." }] });
});

test("host events become words sent as service:host; a missing service:link is not an error; lifecycle.stop reaches onStop", async () => {
  const s = setup(["service:link"]);
  const input = new PassThrough();
  const reader = s.service.listen(createHostPipe(input, new PassThrough(), (line) => s.logs.push(line)));
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

test("env.changed/network also reaches onNetwork, with the proxy as the host gave it; power changes do not", async () => {
  const seen: unknown[][] = [];
  const s = setup([], (network, online) => seen.push([network, online]));
  const input = new PassThrough();
  const reader = s.service.listen(createHostPipe(input, new PassThrough(), (line) => s.logs.push(line)));
  input.write('{"event":"env.changed","what":"network","network":{"proxy":{"http":"http://10.0.2.2:7890","no_proxy":"a.b"}},"online":true}\n');
  input.write('{"event":"env.changed","what":"power","saver":true}\n');
  input.write('{"event":"env.changed","what":"network","network":{"proxy":null},"online":false}\n');
  await settle();
  reader.close();
  assert.deepEqual(seen, [[{ proxy: { http: "http://10.0.2.2:7890", no_proxy: "a.b" } }, true], [{ proxy: null }, false]]);
  assert.equal(s.sent.filter((x) => x.msg.to === "service:agents").length, 3, "the words still go out as before");
});

test("service:host restart: the answer goes first, the host is asked to restart a moment later; apps and the owner may ask, an agent may not", async () => {
  const s = setup();
  assert.deepEqual(await s.service.member.handle(msg("restart", { reason: "the owner asked in her status" }), ctx), { data: { restarting: true } });
  assert.deepEqual(s.calls, [], "not before the answer is out");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(s.calls, [["restart", "the owner asked in her status"]]);
  assert.deepEqual(s.service.member.words().find((w) => w.word === "restart")!.callers, ["owner", "app"]);
});
