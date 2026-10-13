/**
 * Not part of the suite (name has no .test): the real RelaySetup.deploy against the real Cloudflare API, with the sign-in
 * taken from a 0600 file instead of a browser login. Usage:
 *   CF_TOKEN_FILE=… CF_NAME=ash-relay-e2e-… RELAY_DIST=… node --import tsx cf-real.e2e.ts
 */
import { readFileSync } from "node:fs";
import { startHub } from "./harness";
import { createLinkControl } from "../../../src/edges/link-server/control/words";
import { CLOUDFLARE_REF } from "../../../src/edges/link-server/control/setup";
import { relayBundleFile } from "../../../src/edges/link-server/control/bundle";
import { Devices } from "../../../src/edges/link-server/hands/devices";
import { MemoryVault, hubKey, owner } from "./control-harness";

const name = process.env.CF_NAME!;
const hub = await startHub();
const key = await hubKey();
const vault = new MemoryVault();
vault.set(CLOUDFLARE_REF, readFileSync(process.env.CF_TOKEN_FILE!, "utf8"));
const bundle = relayBundleFile(`${process.env.RELAY_DIST}/ash-gateway.mjs`);
const control = createLinkControl({
  db: hub.db, router: hub.router, link: hub.server, hands: hub.hands, vault, identity: key.identity,
  bundle: bundle.read, bundleMissing: bundle.missing, callbackPort: 0, log: (m, e) => console.log("LOG", m, e instanceof Error ? e.message : e ?? ""),
});
control.bindDevices(new Devices({ hands: hub.hands, router: hub.router, bodies: hub.bodies, gateway: control.pairing }));
await control.start();
const call = async (word: string, body: unknown = {}) => {
  const r = await (control.member as any).handle({ seq: 1, id: "m", ts: 0, from: "person:owner", to: "service:link", kind: "request", word, body }, owner);
  return r?.data;
};
const started = await call("gateway.setup.start");
console.log("start", started);
// the browser leg is not exercised here: mark the setup authorized as the callback would
hub.db.prepare("UPDATE link_setups SET state='authorized' WHERE setup_id=?").run(started.setup_id);
console.log("deploy", await call("gateway.setup.deploy", { setup_id: started.setup_id, name }));
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const s = await call("gateway.setup.status", { setup_id: started.setup_id });
  console.log(new Date().toISOString(), s);
  if (s.state === "connected" || s.state === "failed") break;
}
console.log("gateway.status", await call("gateway.status"));
console.log("hub id", key.id);
if (process.env.HOLD) await new Promise((r) => setTimeout(r, Number(process.env.HOLD) * 1000));
control.stop();
await hub.stop();
process.exit(0);
