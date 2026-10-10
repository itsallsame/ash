import assert from "node:assert/strict";
import test from "node:test";
import { CLOUDFLARE_REF, RelaySetup } from "../../../src/edges/link-server/control/setup";
import { eventually } from "../../fixtures/wait";
import { agent, listening, owner, startWorld, type World } from "./control-harness";

async function build(t: test.TestContext, o: { bundle?: boolean; loginMs?: number; expiresIn?: number } = {}) {
  const w = await startWorld(t, { gateway: false, fresh: true, cloudflare: o });
  return { w, cf: w.cf, setup: w.control.setup, port: w.port, card: w.card };
}

/** Every string the hub produced about the setup: results, messages, cards, the ledger-bound traffic. */
const everythingSaid = (w: World) => JSON.stringify(w.hub.router.sent.map((s) => s.msg));

test("the whole way: sign-in card, PKCE return, deploy in the owner's account, claim, connect; the agent that started it is told at each step, and no credential is in any of it", async (t) => {
  const { w, cf, setup, port, card } = await build(t);
  assert.equal(await listening(port), false, "no listener before a setup");

  const started = await setup.start("agent:main");
  assert.deepEqual(started.state, "waiting_login");
  assert.equal(await listening(port), true, "the listener exists while the owner is signing in");
  const link = card()!;
  assert.deepEqual([link.type, /cloudflare/i.test(link.title)], ["link", true]);
  const url = new URL(link.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), `http://127.0.0.1:${port}/oauth/callback`);
  assert.equal(url.searchParams.get("client_id"), "54d11594-84e4-41aa-b438-e81b8fa78ee7");

  const page = await cf.signIn(link.url);
  assert.equal(page.status, 200);
  assert.match(page.body, /授权成功/);
  await eventually(() => setup.status(started.setup_id).state === "authorized", "authorized");
  assert.equal(await listening(port), false, "the listener is gone once the owner is back");
  assert.ok(w.vault.use(CLOUDFLARE_REF), "the sign-in is in the vault");
  assert.ok(JSON.parse(w.vault.use(CLOUDFLARE_REF)!).refresh_token);

  const deploying = setup.deploy(started.setup_id, "my-relay");
  assert.equal(deploying.state, "deploying");
  await eventually(() => setup.status(started.setup_id).state === "connected", "connected");

  // what was built
  assert.equal(cf.uploads.length, 1);
  const upload = cf.uploads[0]!;
  assert.equal(upload.script, "my-relay");
  assert.equal(upload.metadata.main_module, "worker.mjs");
  assert.deepEqual(upload.metadata.bindings.map((b: any) => [b.type, b.name]), [["durable_object_namespace", "HUB"], ["secret_text", "BOOTSTRAP_SECRET"]]);
  assert.deepEqual(upload.metadata.migrations, { new_tag: "v1", new_sqlite_classes: ["GatewayHub"] });
  assert.match(upload.source, /GatewayHub/);
  assert.deepEqual(cf.enabled, ["my-relay"]);
  assert.match(cf.subdomain!, /^ash-[0-9a-f]{8}$/, "the account had no workers.dev name, one was made");
  // claimed with the hub's own key, connected
  assert.equal(w.gw.ownerId, w.key.id);
  const status = await w.link("gateway.status");
  assert.deepEqual([status.configured, status.url, status.claimed, status.connected, status.account_email], [true, w.gw.url, true, true, cf.email]);

  // told at each step, only the agent, only as background messages to it
  const told = w.tell().filter((m) => m.text.includes(started.setup_id));
  assert.ok(told.every((m) => m.to === "agent:main"));
  assert.equal(told.length, 5, "waiting, authorized, deploying, claimed, connected");
  assert.match(told[0]!.text, /waiting for the owner to sign in/);
  assert.match(told[1]!.text, /sign-in; deploy it/);
  assert.match(told[2]!.text, /deploying/);
  assert.match(told[3]!.text, /deployed and claimed/);
  assert.match(told.at(-1)!.text, /done: the hub is connected/);
  assert.ok(told.every((m) => m.text.includes("service:link/gateway.setup.status")), "and where to look");
  assert.ok(!w.hub.router.sent.some((s) => s.msg.to === "person:owner" && s.msg.word === "say"), "nothing goes into the owner's conversation");

  // no credential anywhere
  const said = everythingSaid(w);
  const secrets = [...cf.issued, w.gw.secret!, cf.uploads[0]!.metadata.bindings[1].text];
  for (const secret of secrets) assert.ok(!said.includes(secret) && !JSON.stringify([status, setup.status(started.setup_id)]).includes(secret), "no credential in messages or results");
  assert.ok(w.gw.secret && w.gw.secret.length > 20);
  assert.ok(!(w.hub.db.prepare("SELECT * FROM link_setups").all().map((r) => JSON.stringify(r)).join()).includes(cf.issued[0]!), "nor in the setup table");
});

test("the words: an agent starts a setup and gets a setup_id; the owner and the agent read the status; deploying is the agent's to ask for", async (t) => {
  const { w } = await build(t);
  const start = (ctx = agent) => w.link("gateway.setup.start", { provider: "cloudflare" }, ctx);
  const started = await start();
  assert.equal(started.state, "waiting_login");
  assert.deepEqual(await w.link("gateway.setup.status", { setup_id: started.setup_id }, owner), { setup_id: started.setup_id, state: "waiting_login" });
  assert.equal(await w.refused("gateway.setup.status", { setup_id: "rs_nope" }), "not_found");
  assert.equal(await w.refused("gateway.setup.deploy", { setup_id: started.setup_id }), "conflict", "not authorized yet");
  assert.equal(await w.refused("gateway.setup.start", { provider: "cloudflare" }, agent), "conflict", "one at a time");
  const cancelled = await w.link("gateway.setup.cancel", { setup_id: started.setup_id });
  assert.deepEqual(cancelled, { setup_id: started.setup_id, state: "failed", reason: "cancelled" });
});

test("the listener lives only while a setup waits: cancel, timeout, a refused sign-in and a finished one all close it", async (t) => {
  const a = await build(t);
  const one = await a.setup.start("person:owner");
  assert.equal(await listening(a.port), true);
  a.setup.cancel(one.setup_id);
  assert.equal(await listening(a.port), false, "cancelled");
  assert.equal(a.setup.status(one.setup_id).reason, "cancelled");

  const b = await build(t, { loginMs: 60 });
  const two = await b.setup.start("agent:main");
  await eventually(() => b.setup.status(two.setup_id).state === "failed", "the timeout");
  assert.equal(await listening(b.port), false, "timed out");
  assert.match(b.setup.status(two.setup_id).reason!, /not finished in time/);
  assert.match(b.w.tell().at(-1)!.text, /failed: the sign-in was not finished in time/);

  const c = await build(t);
  const three = await c.setup.start("person:owner");
  const denied = await c.cf.signIn(c.card()!.url, { deny: true });
  assert.equal(denied.status, 400);
  assert.equal(c.setup.status(three.setup_id).state, "failed");
  assert.equal(await listening(c.port), false, "denied");
  assert.ok(!c.w.hub.router.sent.some((s) => s.msg.word === "tell"), "the owner started it: no background message");
});

test("only the sign-in that was asked for is taken: a wrong state is refused and the setup goes on waiting; a code is used once", async (t) => {
  const { cf, setup, card, port } = await build(t);
  const started = await setup.start("person:owner");
  const forged = await cf.signIn(card()!.url, { state: "forged" });
  assert.equal(forged.status, 400);
  assert.equal(setup.status(started.setup_id).state, "waiting_login");
  assert.equal(await listening(port), true);
  const other = await fetch(`http://127.0.0.1:${port}/elsewhere`);
  assert.equal(other.status, 404);

  assert.equal((await cf.signIn(card()!.url)).status, 200);
  await eventually(() => setup.status(started.setup_id).state === "authorized", "authorized");
  assert.equal(await listening(port), false);
});

test("a second setup cannot start while one waits or deploys, and an old authorized one is replaced", async (t) => {
  const { cf, setup, card, w } = await build(t);
  const first = await setup.start("agent:main");
  await assert.rejects(setup.start("agent:main"), (e: { code: string }) => e.code === "conflict");
  await cf.signIn(card()!.url);
  await eventually(() => setup.status(first.setup_id).state === "authorized", "authorized");
  const second = await setup.start("agent:main");
  assert.notEqual(second.setup_id, first.setup_id);
  assert.deepEqual(setup.status(first.setup_id), { setup_id: first.setup_id, state: "failed", reason: "replaced by a newer setup" });
  assert.ok(w.tell().some((m) => m.text.includes(first.setup_id) && m.text.includes("replaced")));
});

test("a failure in Cloudflare is told in Cloudflare's words, without any credential, and the setup ends", async (t) => {
  const { cf, setup, card, w } = await build(t);
  const started = await setup.start("agent:main");
  await cf.signIn(card()!.url);
  await eventually(() => setup.status(started.setup_id).state === "authorized", "authorized");
  cf.failures.set("PUT /accounts/acc1/workers/scripts/ash-gateway", { status: 400, message: "Worker exceeded the size limit" });
  setup.deploy(started.setup_id);
  await eventually(() => setup.status(started.setup_id).state === "failed", "failed");
  const reason = setup.status(started.setup_id).reason!;
  assert.match(reason, /Worker exceeded the size limit/);
  for (const secret of cf.issued) assert.ok(!reason.includes(secret) && !everythingSaid(w).includes(secret));
  assert.match(w.tell().at(-1)!.text, /failed: .*size limit/);
  assert.equal(w.gw.claimed, false, "nothing was claimed");
});

test("deploying needs the packaged relay program; without it the setup stays authorized and says why", async (t) => {
  const { cf, setup, card } = await build(t, { bundle: false });
  const started = await setup.start("person:owner");
  await cf.signIn(card()!.url);
  await eventually(() => setup.status(started.setup_id).state === "authorized", "authorized");
  assert.throws(() => setup.deploy(started.setup_id), (e: { code: string; message: string }) => e.code === "unavailable" && /packaged relay program/.test(e.message));
  assert.throws(() => setup.deploy(started.setup_id, "Bad Name"), (e: { code: string }) => e.code === "bad_request");
  assert.equal(setup.status(started.setup_id).state, "authorized");
});

test("an expired sign-in is renewed with the refresh token before deploying; a redeploy to an existing script does not migrate again", async (t) => {
  const { cf, setup, card, w } = await build(t, { expiresIn: 1 });
  const started = await setup.start("person:owner");
  await cf.signIn(card()!.url);
  await eventually(() => setup.status(started.setup_id).state === "authorized", "authorized");
  const before = JSON.parse(w.vault.use(CLOUDFLARE_REF)!).access_token;
  cf.scripts.push("ash-gateway");
  setup.deploy(started.setup_id);
  await eventually(() => setup.status(started.setup_id).state === "connected", "connected");
  assert.ok(cf.refreshes >= 1, "refreshed");
  assert.notEqual(JSON.parse(w.vault.use(CLOUDFLARE_REF)!).access_token, before);
  assert.equal(cf.uploads[0]!.metadata.migrations, undefined);
});

test("a setup that was waiting when the hub stopped is ended and its initiator told", async (t) => {
  const { setup, w } = await build(t);
  const started = await setup.start("agent:main");
  setup.stop();
  const next = new RelaySetup({ db: w.hub.db, router: w.hub.router, vault: w.vault, activate: async () => {}, connected: async () => false });
  next.recover();
  assert.deepEqual(next.status(started.setup_id), { setup_id: started.setup_id, state: "failed", reason: "the hub restarted" });
  assert.match(w.tell().at(-1)!.text, /the hub restarted/);
});
