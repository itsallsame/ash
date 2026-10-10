/**
 * The link control module with a hub around it: the real link server and hand registry, a fake relay (the owner's side of
 * `ash-gw/1`), and devices and browsers that reach the hub through that relay's tunnels.
 */
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { base64url, handId } from "../../../../sdk/src/ids";
import type { HandKind } from "../../../../sdk/src/link";
import { WordError, type HandleContext, type Message } from "../../../../sdk/src/message";
import type { CapabilitySpec } from "../../../../sdk/src/link";
import { HandClient } from "../../../../link/src/hand";
import { Endpoint, FakeGateway, connectorOver } from "../../../../link/test/fixtures/fake-gateway";
import { createLinkControl, type LinkControl, type LinkControlDeps } from "../../../src/edges/link-server/control/words";
import type { OwnerIdentity } from "../../../src/edges/link-server/control/gateway";
import { Devices } from "../../../src/edges/link-server/hands/devices";
import { FakeCloudflare } from "./fake-cloudflare";
import { startHub, newIdentity, type Hub, type Identity } from "./harness";

export const owner: HandleContext = { signal: new AbortController().signal, caller: { member: "person:owner", via: "human", local: true }, raw: undefined };
export const agent: HandleContext = { ...owner, caller: { member: "agent:main", via: "agent", local: false } };

export const freePort = () => new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
});
/** Whether something accepts connections on the port. */
export const listening = (port: number) => new Promise<boolean>((resolve) => {
  const socket = connect(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

export class MemoryVault {
  readonly values = new Map<string, string>();
  set(ref: string, value: string): void { this.values.set(ref, value); }
  use(ref: string): string | null { return this.values.get(ref) ?? null; }
}

/** The hub's own key, as the host holds it: only signing is asked of it. */
export async function hubKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const identity: OwnerIdentity = {
    key: async () => ({ id: await handId(spki), public_key: base64url(spki) }),
    sign: async (data) => ({ sig: base64url(signBytes("sha256", Buffer.from(data, "base64url"), { key: privateKey, dsaEncoding: "der" })) }),
  };
  return { identity, id: await handId(spki), publicKey: base64url(spki) };
}

let n = 0;
export const msg = (to: string, word: string, body: unknown = {}, from = "person:owner"): Message =>
  ({ seq: ++n, id: `m${n}`, ts: 0, from, to, kind: "request", word, body });

export interface World {
  hub: Hub;
  gw: FakeGateway;
  /** The hub's own key (what the relay knows the owner by). */
  key: { id: string; publicKey: string };
  vault: MemoryVault;
  control: LinkControl;
  devices: Devices;
  /** Calls a word of `service:link` as the owner (or as [ctx]). */
  link(word: string, body?: unknown, ctx?: HandleContext): Promise<any>;
  /** The error code of a refused call. */
  refused(word: string, body?: unknown, ctx?: HandleContext): Promise<string>;
  /** A device that the owner paired (`lend`: may lend capabilities), known to the relay with [permissions]. It speaks `ash-link/1` on every tunnel the hub opens to it. */
  device(o: { capabilities?: CapabilitySpec[]; name: string; kind?: HandKind; permissions: string[]; lend?: boolean; local_agents?: boolean; web_ui?: boolean; online?: boolean }): Promise<{ identity: Identity; clients: HandClient[]; id: string }>;
  tell(): { to: string; text: string }[];
  events(word: string): any[];
  /** Cloudflare and the sign-in's return port, when the world was asked for them. */
  cf: FakeCloudflare;
  port: number;
  /** The card that asks the owner to sign in to Cloudflare, once shown. */
  card(): { type: string; url: string; title: string } | undefined;
}

/** What the gateway's `npm run build:bundle` writes beside the program (scripts/build-bundle.ts there). */
export const RELAY_METADATA = {
  main_module: "ash-gateway.mjs",
  compatibility_date: "2026-09-01",
  compatibility_flags: ["enable_request_signal"],
  bindings: [
    { type: "durable_object_namespace", name: "HUB", class_name: "GatewayHub" },
    { type: "plain_text", name: "INSTALL_SCRIPT_URL", text: "https://example.test/install.sh" },
  ],
  migrations: { new_tag: "v1", new_sqlite_classes: ["GatewayHub"] },
  keep_bindings: ["plain_text", "secret_text"],
  observability: { enabled: true },
};

export async function startWorld(t: { after(fn: () => unknown): void }, o: { gateway?: boolean; /** A relay nobody has claimed yet. */ fresh?: boolean; control?: Partial<LinkControlDeps>; cloudflare?: { bundle?: boolean; loginMs?: number; expiresIn?: number } } = {}): Promise<World> {
  const hub = await startHub();
  const key = await hubKey();
  const gw = await FakeGateway.start(o.fresh ? { secret: null } : { claimedBy: { id: key.id, key: key.publicKey } });
  const vault = new MemoryVault();
  const cf = await FakeCloudflare.start(gw);
  if (o.cloudflare?.expiresIn !== undefined) cf.expiresIn = o.cloudflare.expiresIn;
  const port = await freePort();
  const control = createLinkControl({
    db: hub.db, router: hub.router, link: hub.server, hands: hub.hands, vault, identity: key.identity, retryMs: 20,
    cloudflare: cf.endpoints, callbackPort: port, callbackHost: "127.0.0.1", loginMs: o.cloudflare?.loginMs, reachable: { maxMs: 2000, everyMs: 10 },
    bundle: o.cloudflare?.bundle === false ? undefined : async () => ({ source: "export default { fetch() { return new Response('relay') } }; export class GatewayHub {}", metadata: RELAY_METADATA }),
    ...o.control,
  });
  const devices = new Devices({ hands: hub.hands, router: hub.router, bodies: hub.bodies, gateway: control.pairing });
  control.bindDevices(devices);
  const clients: HandClient[] = [];
  t.after(async () => { for (const c of clients) c.stop(); control.stop(); await cf.stop(); await gw.stop(); await hub.stop(); });
  await control.start();
  if (o.gateway !== false) {
    await control.gateway.use(gw.url);
    if (!await control.gateway.connected(5000)) throw new Error("the hub did not connect to the fake relay");
  }

  const identities = new Map<string, { identity: Identity; kind: HandKind; name: string; clients: HandClient[]; capabilities?: CapabilitySpec[] }>();
  gw.onDeviceStream = (id, endpoint: Endpoint) => {
    const who = identities.get(id);
    if (!who) return endpoint.close(4404, "no such device");
    const client = new HandClient({
      url: "relay://tunnel/link", connector: connectorOver(endpoint),
      hand: { kind: who.kind, name: who.name, version: "0.0.1", platform: "test", public_key: who.identity.publicKey },
      channels: { device: {} }, sign: (nonce) => who.identity.sign(nonce),
    });
    clients.push(client);
    who.clients.push(client);
    endpoint.onClose(() => client.stop());
    client.start();
    if (who.capabilities) void client.ready().then(() => client.setManifest(who.capabilities!)).catch(() => {});
  };

  const call = async (word: string, body: unknown, ctx: HandleContext) => ((await control.member.handle(msg("service:link", word, body), ctx)) as { data: any } | void)?.data;
  return {
    hub, gw, key, vault, control, devices,
    link: (word, body = {}, ctx = owner) => call(word, body, ctx),
    async refused(word, body = {}, ctx = owner) {
      try { await call(word, body, ctx); } catch (error) { if (error instanceof WordError) return error.code; throw error; }
      return "none";
    },
    async device(d) {
      const identity = await newIdentity();
      const kind = d.kind ?? "computer";
      hub.hands.register({ id: identity.handId, name: d.name, kind, public_key: identity.publicKey, paired_by: "gateway", lend: d.lend ?? true, local_agents: d.local_agents ?? false, web_ui: d.web_ui ?? false });
      const who = { identity, kind, name: d.name, clients: [] as HandClient[], capabilities: d.capabilities };
      identities.set(identity.handId, who);
      gw.setDevice(identity.handId, { name: d.name, permissions: d.permissions, online: d.online ?? true });
      return { identity, clients: who.clients, id: identity.handId };
    },
    tell: () => hub.router.sent.filter((s) => s.msg.word === "tell").map((s) => ({ to: s.msg.to!, text: String((s.msg.body as { text: string }).text) })),
    events: (word) => hub.router.sent.filter((s) => s.msg.kind === "event" && s.msg.to === "service:link" && s.msg.word === word).map((s) => s.msg.body),
    cf, port,
    card: () => {
      const sent = hub.router.sent.filter((s) => s.msg.to === "person:owner" && s.msg.word === "show");
      return (sent.at(-1)?.msg.body as { card: { type: string; url: string; title: string } } | undefined)?.card;
    },
  };
}
