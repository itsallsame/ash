import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStream } from "ash-gateway/client/client";
import { handId } from "../../sdk/src/ids";
import { signatureHolds, spkiBytes } from "../../core/src/edges/link-server/auth";
import type { SocketEvents } from "../../link/src/hand";
import { GatewayLine, helloHand, loadIdentity, TunnelPort, LINK_PATH } from "../src/link";
import { eventually } from "./kernel";

const dir = () => mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-link-"));

test("the identity is made once, kept owner-only, and its id is the hash of its key; the hub's check accepts its signature", async () => {
  const state = await dir();
  const identity = await loadIdentity(join(state, "s"));
  assert.equal((await stat(join(state, "s", "device.jwk"))).mode & 0o777, 0o600);
  assert.equal(identity.id, await handId(spkiBytes(identity.publicKey)!));
  assert.equal(identity.id.length, 22);
  const nonce = "Zm9v-nonce_123";
  assert.ok(signatureHolds(identity.publicKey, nonce, identity.signNonce(nonce)));
  assert.ok(!signatureHolds(identity.publicKey, nonce + "x", identity.signNonce(nonce)));
  const again = await loadIdentity(join(state, "s"));
  assert.deepEqual([again.id, again.publicKey], [identity.id, identity.publicKey]);
  const hand = helloHand(identity, { name: "Mac", version: "0.2.0" });
  assert.deepEqual([hand.kind, hand.name, hand.version, hand.public_key], ["computer", "Mac", "0.2.0", identity.publicKey]);
  assert.match(hand.platform, /^[a-z0-9]+-[a-z0-9]+$/);
});

// -- the port ----------------------------------------------------------------------------------------------------------

/** A tunnel stream the test can talk into, and what the program wrote to it. */
function tunnel(label: string) {
  const out: string[] = [];
  const closes: { code: number; reason: string }[] = [];
  const stream = new DeviceStream(`o-${label}-xxxxxxxxxxxxxxxxxxxx`, "kernel", LINK_PATH, (frame) => {
    if (frame.op === "ws.msg") out.push(String(frame.text));
    if (frame.op === "ws.close") closes.push({ code: Number(frame.code), reason: String(frame.reason) });
  }, () => {});
  return { stream, out, closes, say: (text: string) => stream.accept({ op: "ws.msg", text, more: false, from: "kernel" }), hangUp: (code = 1006, reason = "gone") => stream.finish({ code, reason }) };
}
function socketEvents() {
  const got: { kind: string; data?: unknown; code?: number; reason?: string }[] = [];
  const events: SocketEvents = {
    open: () => got.push({ kind: "open" }),
    message: (data) => got.push({ kind: "message", data }),
    close: (code, reason) => got.push({ kind: "close", code, reason }),
  };
  return { events, got };
}

test("a tunnel that comes first waits for the client, and what the hub said meanwhile is not lost", () => {
  const port = new TunnelPort();
  const t = tunnel("a");
  port.adopt(t.stream);
  t.say("challenge");
  const { events, got } = socketEvents();
  const socket = port.connector("relay://x", {}, events);
  return eventually(() => got.length === 2, "the tunnel being bound").then(() => {
    assert.deepEqual(got.map((g) => [g.kind, g.data]), [["open", undefined], ["message", "challenge"]]);
    socket.send("hello");
    assert.deepEqual(t.out, ["hello"]);
  });
});

test("a client that asks first waits for the tunnel", async () => {
  const port = new TunnelPort();
  const { events, got } = socketEvents();
  port.connector("relay://x", {}, events);
  assert.equal(got.length, 0);
  const t = tunnel("b");
  port.adopt(t.stream);
  t.say("challenge");
  assert.deepEqual(got.map((g) => g.kind), ["open", "message"]);
  t.hangUp(4003, "revoked");
  assert.deepEqual(got.at(-1), { kind: "close", code: 4003, reason: "revoked" });
});

test("closing the socket closes the tunnel with that code", () => {
  const port = new TunnelPort();
  const { events } = socketEvents();
  const socket = port.connector("relay://x", {}, events);
  const t = tunnel("c");
  port.adopt(t.stream);
  socket.close(4400, "bad frame");
  assert.deepEqual(t.closes, [{ code: 4400, reason: "bad frame" }]);
});

test("a newer tunnel closes the one in use; the client's next socket is bound to the newest; a tunnel that died waiting is forgotten", async () => {
  const port = new TunnelPort();
  const first = socketEvents();
  port.connector("relay://x", {}, first.events);
  const t1 = tunnel("d1");
  port.adopt(t1.stream);
  const t2 = tunnel("d2");
  const t3 = tunnel("d3");
  port.adopt(t2.stream);
  assert.deepEqual(t1.closes, [{ code: 1000, reason: "replaced by a newer tunnel" }]);
  assert.deepEqual(first.got.at(-1), { kind: "close", code: 1000, reason: "replaced by a newer tunnel" });
  // another one arrives before the client asked again: the older stash is dropped
  port.adopt(t3.stream);
  assert.deepEqual(t2.closes, [{ code: 1000, reason: "replaced by a newer tunnel" }]);
  const second = socketEvents();
  port.connector("relay://x", {}, second.events);
  t3.say("challenge");
  await eventually(() => second.got.some((g) => g.kind === "message"), "the newest tunnel");
  // a tunnel that dies while it waits is not handed out
  const port2 = new TunnelPort();
  const dead = tunnel("e");
  port2.adopt(dead.stream);
  dead.hangUp();
  const third = socketEvents();
  port2.connector("relay://x", {}, third.events);
  assert.equal(third.got.length, 0);
});

test("a tunnel that arrives while the client sleeps between attempts says so", () => {
  const port = new TunnelPort();
  let told = 0;
  port.onIdleTunnel = () => { told++; };
  port.adopt(tunnel("f").stream);
  assert.equal(told, 1);
});

// -- the relay -----------------------------------------------------------------------------------------------------------

test("the relay's tunnel frames: only /link is opened; messages count only from the hub's side; close ends the tunnel", async () => {
  const state = await dir();
  const identity = await loadIdentity(state);
  const port = new TunnelPort();
  const line = new GatewayLine("https://relay.example", identity, port, () => {});
  const frames: Record<string, unknown>[] = [];
  const conn = { send: (frame: Record<string, unknown>) => frames.push(frame) } as never;
  const feed = (frame: Record<string, unknown>) => (line as any).tunnelFrame(conn, frame);
  const { events, got } = socketEvents();
  port.connector("relay://x", {}, events);

  feed({ t: "tun", op: "ws.open", sid: "o-wrong", path: "/ash/device/stream", from: "kernel" });
  assert.deepEqual(frames, [{ t: "tun", op: "ws.error", sid: "o-wrong", message: "unsupported path" }]);
  assert.equal(got.length, 0);

  feed({ t: "tun", op: "ws.open", sid: "o-link", path: LINK_PATH, from: "kernel" });
  assert.deepEqual(frames.at(-1), { t: "tun", op: "ws.opened", sid: "o-link" });
  feed({ t: "tun", op: "ws.msg", sid: "o-link", text: "from the hub", more: false, from: "kernel" });
  feed({ t: "tun", op: "ws.msg", sid: "o-link", text: "from someone else", more: false, from: "intruder" });
  feed({ t: "tun", op: "ws.msg", sid: "o-unknown", text: "nobody's", more: false, from: "kernel" });
  assert.deepEqual(got.filter((g) => g.kind === "message").map((g) => g.data), ["from the hub"]);
  feed({ t: "tun", op: "ws.close", sid: "o-link", code: 1001, reason: "bye" });
  assert.deepEqual(got.at(-1), { kind: "close", code: 1001, reason: "bye" });
  feed({ t: "other" });
  feed({ t: "tun" });
});
