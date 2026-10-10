import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HandClient } from "../../../../link/src/hand";
import { connectorOver } from "../../../../link/test/fixtures/fake-gateway";
import { eventually } from "../../fixtures/wait";
import { agent, msg, owner, startWorld } from "./control-harness";
import { connect, connected, newIdentity } from "./harness";

const sha256b64u = (text: string) => createHash("sha256").update(text).digest("base64url");

test("a device the relay reports online with a non-web permission gets a /link tunnel and becomes a hand; one with only web permissions does not", async (t) => {
  const w = await startWorld(t);
  const mac = await w.device({ name: "Mac", permissions: ["expose_capability"] });
  const web = await w.device({ name: "Laptop browser", kind: "browser", permissions: ["web_ui", "chat"], lend: false, web_ui: true });

  await eventually(() => w.hub.hands.online(mac.id), "the Mac to come in through the tunnel");
  assert.equal(w.hub.hands.via(mac.id), "gateway");
  assert.equal(w.gw.streams.size, 1, "one tunnel, to the Mac");
  assert.deepEqual([...w.gw.streams.values()].map((s) => s.device), [mac.id]);
  assert.equal(w.hub.hands.online(web.id), false);
});

test("a device that comes online later is reached when the relay says so", async (t) => {
  const w = await startWorld(t);
  const mac = await w.device({ name: "Mac", permissions: ["expose_capability"], online: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(w.gw.streams.size, 0, "offline: no tunnel");
  w.gw.setDevice(mac.id, { online: true });
  await eventually(() => w.hub.hands.online(mac.id), "the Mac after coming online");
});

test("the hub's own record still decides: a device the relay would let through but the owner never allowed to lend or run agents gets no tunnel", async (t) => {
  const w = await startWorld(t);
  const mac = await w.device({ name: "Mac", permissions: ["expose_capability"], lend: false, local_agents: false });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(w.gw.streams.size, 0);
  assert.equal(w.hub.hands.online(mac.id), false);
});

test("a permission taken away at the relay ends the tunnel and it is not opened again; given back, it is", async (t) => {
  const w = await startWorld(t);
  const mac = await w.device({ name: "Mac", permissions: ["expose_capability"] });
  await eventually(() => w.hub.hands.online(mac.id), "the Mac");

  await w.control.pairing.setExpose!(mac.id, false);
  await eventually(() => !w.hub.hands.online(mac.id), "the tunnel to end");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(w.gw.streams.size, 0, "no tunnel without the permission");

  await w.control.pairing.setExpose!(mac.id, true);
  await eventually(() => w.hub.hands.online(mac.id), "the tunnel to come back");
});

test("a browser the relay lets in gets the human channel only; a path other than /link is refused", async (t) => {
  const w = await startWorld(t);
  const identity = await newIdentity();
  w.hub.hands.register({ id: identity.handId, name: "Chrome", kind: "browser", public_key: identity.publicKey, paired_by: "gateway", web_ui: true });

  const endpoint = w.gw.openBrowser(identity.handId, "/link");
  const browser = new HandClient({
    url: "relay://browser/link", connector: connectorOver(endpoint), hand: { kind: "browser", name: "Chrome", version: "1", platform: "web" },
    channels: { human: { label: "web", surfaces: ["chat"] }, device: {}, agent: { runtimes: [] } } as never,
  });
  t.after(() => browser.stop());
  browser.start();
  const welcome = await browser.ready();
  assert.equal(welcome.hand_id, identity.handId);
  assert.deepEqual([welcome.channels.human && "client" in welcome.channels.human, (welcome.channels.human as { local: boolean }).local], [true, false]);
  assert.equal((welcome.channels.device as { accepted: boolean }).accepted, false);
  assert.equal((welcome.channels.agent as { accepted: boolean }).accepted, false);
  const listed = (await w.link("list")).connections;
  assert.deepEqual(listed.map((c: any) => [c.hand, c.channels, c.via]), [[identity.handId, ["human"], "gateway"]]);

  const wrongPath = w.gw.openBrowser(identity.handId, "/api/send");
  await eventually(() => wrongPath.closedWith, "the refusal");
  assert.equal(wrongPath.closedWith!.code, 4404);
  assert.equal(wrongPath.opened, false);
  const query = w.gw.openBrowser(identity.handId, "/link/../mcp");
  await eventually(() => query.closedWith, "the refusal of a trick path");
  assert.equal(query.closedWith!.code, 4404);
});

test("a browser without the web permission is turned away at the handshake, and the owner can see the refusal", async (t) => {
  const w = await startWorld(t);
  const identity = await newIdentity();
  w.hub.hands.register({ id: identity.handId, name: "Guest", kind: "browser", public_key: identity.publicKey, paired_by: "gateway", web_ui: false });
  const endpoint = w.gw.openBrowser(identity.handId, "/link");
  const browser = new HandClient({
    url: "relay://browser/link", connector: connectorOver(endpoint), hand: { kind: "browser", name: "Guest", version: "1", platform: "web" },
    channels: { human: { label: "web", surfaces: ["chat"] } } as never,
  });
  t.after(() => browser.stop());
  browser.start();
  const welcome = await browser.ready();
  assert.equal((welcome.channels.human as { accepted?: boolean }).accepted, false);
});

test("pairing: a non-web permission (lend, body or local agents) gets the relay's expose_capability; the web page alone does not", async (t) => {
  const w = await startWorld(t);
  const code = async (kind: "computer" | "browser", name: string) => {
    const { pair_id } = (await w.devices.handle(msg("service:devices", "pair_start", { kind, name }), owner) as any).data;
    const { code: ticket, url } = (await w.devices.handle(msg("service:devices", "pair_code", { pair_id }), owner) as any).data;
    assert.equal(url, `${w.gw.url}/p/${ticket}`, "the install page address");
    assert.ok(w.gw.tickets.includes(sha256b64u(ticket)), "the relay holds the code's hash, not the code");
    return { pair_id, ticket };
  };
  const pairWith = async (name: string, kind: "computer" | "browser", approve: Record<string, unknown>) => {
    const identity = await newIdentity();
    const { pair_id, ticket } = await code(kind, name);
    w.gw.pairRequest({ request_id: `r-${name}`, client_id: identity.handId, name, pubkey: identity.publicKey, ticket_hash: sha256b64u(ticket) });
    await eventually(() => w.devices.pairs.get(pair_id)!.state === "requested", "the request");
    await w.devices.handle(msg("service:devices", "pair_approve", { pair_id, ...approve }), owner);
    return w.gw.devices.get(identity.handId)!.permissions;
  };

  assert.deepEqual(await pairWith("lender", "computer", { lend: true }), ["expose_capability"]);
  assert.deepEqual(await pairWith("body", "computer", { lend: false, body: true }), ["expose_capability"]);
  assert.ok(w.hub.router.sent.some((s) => s.msg.to === "service:bodies" && s.msg.word === "bind"), "the body box binds through service:bodies");
  assert.deepEqual(await pairWith("agents", "computer", { lend: false, local_agents: true }), ["expose_capability"]);
  assert.deepEqual(await pairWith("chat only", "computer", { lend: false, web_ui: true }), ["chat", "web_ui"]);
  assert.deepEqual(await pairWith("everything", "computer", { lend: true, local_agents: true, body: true, web_ui: true }), ["expose_capability", "chat", "web_ui"]);
  assert.deepEqual(await pairWith("browser", "browser", {}), ["chat", "web_ui"]);
});

test("pairing: a request is matched to its pairing by the code's hash; without the hash only an unambiguous one is", async (t) => {
  const w = await startWorld(t);
  const start = async (name: string) => (await w.devices.handle(msg("service:devices", "pair_start", { kind: "computer", name }), owner) as any).data.pair_id as string;
  const first = await start("one");

  const a = await newIdentity();
  w.gw.pairRequest({ request_id: "r1", client_id: a.handId, name: "one", pubkey: a.publicKey });
  await eventually(() => w.devices.pairs.get(first)!.state === "requested", "the only waiting pairing to take the request");

  const second = await start("two");
  const third = await start("three");
  const b = await newIdentity();
  w.gw.pairRequest({ request_id: "r2", client_id: b.handId, name: "two", pubkey: b.publicKey });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual([w.devices.pairs.get(second)!.state, w.devices.pairs.get(third)!.state], ["waiting", "waiting"], "two are waiting and the relay did not say which: nothing is guessed");
});

test("access_set tells the relay when the device starts or stops needing a tunnel", async (t) => {
  const w = await startWorld(t);
  const identity = await newIdentity();
  const { pair_id } = (await w.devices.handle(msg("service:devices", "pair_start", { kind: "computer", name: "Mac" }), owner) as any).data;
  const ticket = ((await w.devices.handle(msg("service:devices", "pair_code", { pair_id }), owner)) as any).data.code;
  w.gw.pairRequest({ request_id: "r1", client_id: identity.handId, name: "Mac", pubkey: identity.publicKey, ticket_hash: sha256b64u(ticket) });
  await eventually(() => w.devices.pairs.get(pair_id)!.state === "requested", "the request");
  await w.devices.handle(msg("service:devices", "pair_approve", { pair_id, lend: false, web_ui: true }), owner);
  const permissions = () => w.gw.devices.get(identity.handId)!.permissions;
  assert.deepEqual(permissions(), ["chat", "web_ui"]);

  await w.devices.handle(msg("service:devices", "access_set", { device: `device:${identity.handId}`, lend: true }), owner);
  assert.deepEqual(permissions(), ["chat", "web_ui", "expose_capability"]);
  await w.devices.handle(msg("service:devices", "access_set", { device: `device:${identity.handId}`, local_agents: true, lend: false }), owner);
  assert.ok(permissions().includes("expose_capability"), "still needed for the local agents");
  await w.devices.handle(msg("service:devices", "access_set", { device: `device:${identity.handId}`, local_agents: false }), owner);
  assert.deepEqual(permissions(), ["chat", "web_ui"]);
});

test("list, describe, disconnect: what is connected, how, and the last time it closed; no credential is in any of it", async (t) => {
  const w = await startWorld(t);
  const phone = await connected(w.hub, { kind: "phone", name: "Find X8" });
  const mac = await w.device({ name: "Mac", permissions: ["expose_capability"] });
  await eventually(() => w.hub.hands.online(mac.id), "the Mac");

  const { connections } = await w.link("list");
  const byHand = Object.fromEntries(connections.map((c: any) => [c.hand, c]));
  assert.deepEqual([byHand[phone.identity.handId].via, byHand[phone.identity.handId].channels, byHand[phone.identity.handId].name], ["local", ["device"], "Find X8"]);
  assert.deepEqual([byHand[mac.id].via, byHand[mac.id].channels, byHand[mac.id].kind], ["gateway", ["device"], "computer"]);
  assert.ok(byHand[mac.id].since > 0);

  const detail = await w.link("describe", { hand: phone.identity.handId });
  assert.equal(detail.conn, byHand[phone.identity.handId].conn);
  assert.deepEqual(detail.grants.device, { accepted: true });
  assert.equal(await w.refused("describe", {}), "bad_request");
  assert.equal(await w.refused("describe", { conn: "s_nope" }), "not_found");

  assert.equal((await w.link("disconnect", { conn: detail.conn, reason: "testing" })).closed, true);
  assert.equal((await w.link("disconnect", { conn: detail.conn })).closed, false, "already gone");
  await eventually(() => w.events("disconnected").length > 0, "the disconnected event");
  const gone = w.events("disconnected").find((e: any) => e.hand === phone.identity.handId);
  assert.deepEqual([gone.code, gone.reason], [1000, "testing"]);
  await eventually(() => w.events("connected").length >= 2, "the connected events");

  // the hand reconnects by itself; the last close is remembered in describe
  await eventually(async () => (await w.link("list")).connections.some((c: any) => c.hand === phone.identity.handId), "the phone back", 10_000);
  const again = await w.link("describe", { hand: phone.identity.handId });
  assert.equal(again.last_disconnect.code, 1000);
  assert.match(again.last_disconnect.meaning, /normally/);

  const everything = JSON.stringify([await w.link("list"), again, await w.link("diagnose", {}), await w.link("gateway.status")]);
  assert.ok(!everything.includes(w.hub.token), "the local token is in no result");
});

test("diagnose names what is wrong: a refused handshake with its meaning, a hand that is not there, the relay", async (t) => {
  const w = await startWorld(t);
  await connect(w.hub, { token: "wrong-token", name: "Intruder" });
  await eventually(() => w.events("handshake_failed").length > 0, "the failure to be reported");
  assert.deepEqual(w.events("handshake_failed")[0], { code: 4001, reason: "bad token" });

  const report = await w.link("diagnose", {});
  assert.equal(report.ok, true, "a refused stranger is not a fault of the link");
  const codes = report.findings.map((f: any) => f.code);
  assert.ok(codes.includes("relay.connected"));
  assert.ok(codes.includes("handshake.4001"));
  assert.match(report.findings.find((f: any) => f.code === "handshake.4001").message, /identity was not proven/);

  const mac = await w.device({ name: "Mac", permissions: ["expose_capability"], online: false });
  const offline = await w.link("diagnose", { hand: mac.id });
  assert.equal(offline.ok, false);
  assert.ok(offline.findings.some((f: any) => f.code === "hand.offline"));

  assert.equal(await w.refused("diagnose", { hand: "x".repeat(22) }), "not_found");
});

test("diagnose finds a device that may be reached but has no tunnel; the relay down is a problem", async (t) => {
  const w = await startWorld(t);
  const mac = await w.device({ name: "Mac", permissions: ["expose_capability"], lend: false, local_agents: false });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const report = await w.link("diagnose", { hand: mac.id });
  assert.ok(report.findings.some((f: any) => f.code === "tunnel.missing"), "online and allowed at the relay, no tunnel");

  await w.gw.stop();
  await eventually(async () => !(await w.link("gateway.status")).connected, "the relay to be seen down");
  const down = await w.link("diagnose", {});
  assert.equal(down.ok, false);
  assert.ok(down.findings.some((f: any) => f.code === "relay.down"));
  w.gw.stop = async () => {};
});

test("reconnect and refresh_manifest: a local hand is closed normally and comes back; a device behind the relay gets a fresh tunnel", async (t) => {
  const w = await startWorld(t);
  const closes: number[] = [];
  const phone = await connected(w.hub, { kind: "phone", name: "Find X8", handlers: { closed: (info) => closes.push(info.code) } });
  assert.equal((await w.link("reconnect", { hand: phone.identity.handId })).requested, true);
  await eventually(() => closes.includes(1000), "the normal close");
  assert.equal((await w.link("refresh_manifest", { hand: phone.identity.handId })).requested, false, "nothing to ask while it is away");
  await eventually(() => w.hub.hands.online(phone.identity.handId), "the phone to reconnect by itself", 10_000);
  assert.equal((await w.link("refresh_manifest", { hand: phone.identity.handId })).requested, true);
  await eventually(() => closes.length === 2, "the second close");

  const mac = await w.device({ name: "Mac", permissions: ["expose_capability"] });
  await eventually(() => w.hub.hands.online(mac.id), "the Mac");
  const before = mac.clients.length;
  assert.equal((await w.link("reconnect", { hand: mac.id })).requested, true);
  await eventually(() => mac.clients.length === before + 1 && w.hub.hands.online(mac.id), "a second tunnel to carry the Mac");

  assert.equal(await w.refused("reconnect", { hand: "z".repeat(22) }), "not_found");
});

test("gateway.status and gateway.use: what the relay is, and switching to another; a stranger's relay and a plain-http one are refused", async (t) => {
  const w = await startWorld(t, { gateway: false });
  assert.deepEqual(await w.link("gateway.status"), { configured: false, connected: false });

  assert.equal(await w.refused("gateway.use", { url: "http://relay.example.com" }), "bad_request", "http only for this machine");
  assert.equal(await w.refused("gateway.use", { url: "not a url" }), "bad_request");
  assert.equal(await w.refused("gateway.use", { url: "https://user:pw@relay.example.com" }), "bad_request");
  assert.equal(await w.refused("gateway.use", { url: "http://127.0.0.1:1" }), "unavailable");

  const { FakeGateway } = await import("../../../../link/test/fixtures/fake-gateway");
  const stranger = await FakeGateway.start({ claimedBy: { id: "someone-else-entirely-1", key: "x" } });
  t.after(() => stranger.stop());
  assert.equal(await w.refused("gateway.use", { url: stranger.url }), "forbidden");

  const used = await w.link("gateway.use", { url: `${w.gw.url}/anything?x=1` });
  assert.equal(used.url, w.gw.url, "the address is kept as an origin");
  assert.ok(await w.control.gateway.connected(5000));
  const status = await w.link("gateway.status");
  assert.deepEqual([status.configured, status.url, status.claimed, status.connected], [true, w.gw.url, true, true]);
  assert.ok(!JSON.stringify(status).includes(w.hub.token));
});

test("an unclaimed relay of the owner's own is claimed with the secret in the vault (gateway.bootstrap), never one passed in a word", async (t) => {
  const w = await startWorld(t, { gateway: false });
  const { FakeGateway } = await import("../../../../link/test/fixtures/fake-gateway");
  const fresh = await FakeGateway.start({ secret: "claim-secret-123" });
  t.after(() => fresh.stop());
  assert.equal(await w.refused("gateway.use", { url: fresh.url }), "forbidden", "no secret: cannot claim");
  w.vault.set("gateway.bootstrap", "claim-secret-123");
  await w.link("gateway.use", { url: fresh.url });
  assert.equal(fresh.claimed, true);
  assert.ok(await w.control.gateway.connected(5000));
});

test("the relay is told the network changed: env.changed connects again", async (t) => {
  const w = await startWorld(t);
  const before = w.gw.ownerConnections;
  await w.control.member.handle({ ...msg("service:link", "env.changed", { what: "network", network: { proxy: null }, online: true }), kind: "event" }, owner);
  await eventually(() => w.gw.ownerConnections === before + 1 && w.control.gateway.status().connected, "a new connection");
});

test("the words are the contract's, every one, and agents may use them", async (t) => {
  const w = await startWorld(t, { gateway: false });
  const words = w.control.member.words().map((x) => x.word);
  for (const word of ["list", "describe", "diagnose", "disconnect", "reconnect", "refresh_manifest", "gateway.status", "gateway.setup.start", "gateway.setup.status", "gateway.setup.deploy", "gateway.setup.cancel", "gateway.use", "connected", "disconnected", "handshake_failed"]) {
    assert.ok(words.includes(word), word);
  }
  assert.deepEqual(await w.link("list", {}, agent), { connections: [] });
});
