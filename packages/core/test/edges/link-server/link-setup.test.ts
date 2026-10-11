import assert from "node:assert/strict";
import test from "node:test";
import { CLOUDFLARE_REF, RelaySetup } from "../../../src/edges/link-server/control/setup";
import { eventually } from "../../fixtures/wait";
import { agent, listening, owner, RELAY_METADATA, startWorld, type World } from "./control-harness";

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
  // the gateway's own metadata, plus the claim secret
  assert.deepEqual({ ...upload.metadata, bindings: undefined }, { ...RELAY_METADATA, bindings: undefined });
  assert.deepEqual(upload.metadata.bindings, [...RELAY_METADATA.bindings, { type: "secret_text", name: "BOOTSTRAP_SECRET", text: upload.metadata.bindings[2].text }]);
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
  const secrets = [...cf.issued, w.gw.secret!, cf.uploads[0]!.metadata.bindings[2].text];
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
  cf.failures.set("PUT /accounts/acc1/workers/scripts/my-relay", { status: 400, message: "Worker exceeded the size limit" });
  setup.deploy(started.setup_id, "my-relay");
  await eventually(() => setup.status(started.setup_id).state === "failed", "failed");
  const reason = setup.status(started.setup_id).reason!;
  assert.match(reason, /Worker exceeded the size limit/);
  for (const secret of cf.issued) assert.ok(!reason.includes(secret) && !everythingSaid(w).includes(secret));
  assert.match(w.tell().at(-1)!.text, /failed: .*size limit/);
  assert.equal(w.gw.claimed, false, "nothing was claimed");
});

test("without the packaged relay program a setup does not even start: unavailable, no sign-in card, no listener, and gateway.status says why", async (t) => {
  const w = await startWorld(t, { gateway: false, fresh: true, cloudflare: { bundle: false } });
  await assert.rejects(w.control.setup.start("person:owner"), (e: { code: string; message: string }) => e.code === "unavailable" && /packaged relay program/.test(e.message));
  assert.equal(w.card(), undefined, "the owner was not asked to sign in");
  assert.equal(await listening(w.port), false);
  assert.match((await w.link("gateway.status")).setup_unavailable, /packaged relay program/);
  assert.equal(await w.refused("gateway.setup.start", { provider: "cloudflare" }), "unavailable");
});

test("a packaged relay program that is not there (bundleMissing) stops start and deploy with its reason, and works once the file appears", async (t) => {
  let missing: string | null = "the packaged relay program is not at /app/ash-gateway.mjs";
  const w = await startWorld(t, { gateway: false, fresh: true, control: { bundleMissing: () => missing } });
  await assert.rejects(w.control.setup.start("person:owner"), (e: { code: string; message: string; recovery_hint?: string }) =>
    e.code === "unavailable" && /not at \/app\/ash-gateway\.mjs/.test(e.message) && /gateway\.use/.test(e.recovery_hint ?? ""));
  assert.equal((await w.link("gateway.status")).setup_unavailable, "the packaged relay program is not at /app/ash-gateway.mjs");
  missing = null;
  assert.equal((await w.link("gateway.status")).setup_unavailable, undefined, "the file is there now");
  const started = await w.control.setup.start("person:owner");
  await w.cf.signIn(w.card()!.url);
  await eventually(() => w.control.setup.status(started.setup_id).state === "authorized", "authorized");
  missing = "the packaged relay program is not at /app/ash-gateway.mjs";               // gone again before the deploy
  assert.throws(() => w.control.setup.deploy(started.setup_id), (e: { code: string }) => e.code === "unavailable");
  assert.throws(() => w.control.setup.deploy(started.setup_id, "Bad Name"), (e: { code: string }) => e.code === "unavailable" || e.code === "bad_request");
  assert.equal(w.control.setup.status(started.setup_id).state, "authorized", "nothing was started");
  missing = null;
  assert.equal(w.control.setup.deploy(started.setup_id).state, "deploying");
  await eventually(() => w.control.setup.status(started.setup_id).state === "connected", "connected");
});

test("an expired sign-in is renewed with the refresh token before deploying; a redeploy of the Worker this hub built does not migrate again", async (t) => {
  const { cf, setup, card, w } = await build(t, { expiresIn: 1 });
  const first = await setup.start("person:owner");
  await cf.signIn(card()!.url);
  await eventually(() => setup.status(first.setup_id).state === "authorized", "authorized");
  setup.deploy(first.setup_id, "my-relay");
  await eventually(() => setup.status(first.setup_id).state === "connected", "connected");
  assert.ok(cf.uploads[0]!.metadata.migrations, "the first deploy creates the Durable Object");
  const before = JSON.parse(w.vault.use(CLOUDFLARE_REF)!).access_token;
  const second = await setup.start("person:owner");
  await cf.signIn(card()!.url);
  await eventually(() => setup.status(second.setup_id).state === "authorized", "authorized again");
  setup.deploy(second.setup_id, "my-relay");
  await eventually(() => setup.status(second.setup_id).state === "connected", "connected again");
  assert.ok(cf.refreshes >= 1, "refreshed");
  assert.notEqual(JSON.parse(w.vault.use(CLOUDFLARE_REF)!).access_token, before);
  assert.equal(cf.uploads.length, 2);
  assert.equal(cf.uploads[1]!.metadata.migrations, undefined);
  assert.deepEqual(cf.uploads[1]!.metadata.keep_bindings, RELAY_METADATA.keep_bindings, "a redeploy keeps what the gateway's metadata says it keeps");
});

async function authorized(t: test.TestContext, o: { expiresIn?: number } = {}) {
  const b = await build(t, o);
  const started = await b.setup.start("person:owner");
  await b.cf.signIn(b.card()!.url);
  await eventually(() => b.setup.status(started.setup_id).state === "authorized", "authorized");
  return { ...b, id: started.setup_id };
}

test("without a name the Worker gets a made-up one, never ash-gateway; a Worker the owner already has is never written over", async (t) => {
  const { cf, setup, id } = await authorized(t);
  cf.scripts.push("ash-gateway", "my-site");
  setup.deploy(id);
  await eventually(() => setup.status(id).state === "connected", "connected");
  assert.equal(cf.uploads.length, 1);
  assert.match(cf.uploads[0]!.script, /^ash-relay-[0-9a-f]{6}$/);
  assert.deepEqual(cf.scripts.filter((n) => !n.startsWith("ash-relay-")), ["ash-gateway", "my-site"], "the owner's Workers are as they were");
});

test("a name that is taken by a Worker Ash did not build is refused in words, with nothing uploaded and nothing claimed", async (t) => {
  for (const taken of ["ash-gateway", "my-site"]) {
    const { cf, setup, id, w } = await authorized(t);
    cf.scripts.push(taken);
    setup.deploy(id, taken);
    await eventually(() => setup.status(id).state === "failed", "failed");
    assert.match(setup.status(id).reason!, new RegExp(`already has a Worker called ${taken} that Ash did not build, and Ash does not write over it; choose another name`));
    assert.equal(cf.uploads.length, 0);
    assert.equal(w.gw.claimed, false);
  }
});

test("several Cloudflare accounts under one sign-in: they are listed, none is guessed, and the one chosen is the only one touched", async (t) => {
  const { cf, setup, id, w } = await authorized(t);
  cf.accounts = [{ id: "acc1", name: "Personal" }, { id: "acc2", name: "I AM ZY" }];
  cf.scriptsBy.set("acc2", []);
  // the sign-in's accounts are read when it is authorized: this one was authorized with the single account, so list again through a new sign-in
  const again = await setup.start("person:owner");
  await cf.signIn(w.card()!.url);
  await eventually(() => setup.status(again.setup_id).state === "authorized", "authorized with two accounts");
  assert.deepEqual(setup.status(again.setup_id).accounts, [{ id: "acc1", name: "Personal" }, { id: "acc2", name: "I AM ZY" }]);
  assert.deepEqual((await w.link("gateway.setup.status", { setup_id: again.setup_id })).accounts?.map((a: { id: string }) => a.id), ["acc1", "acc2"]);
  assert.equal(await w.refused("gateway.setup.deploy", { setup_id: again.setup_id, name: "my-relay" }), "bad_request", "no account chosen");
  assert.equal(await w.refused("gateway.setup.deploy", { setup_id: again.setup_id, account: "acc9" }), "bad_request", "an account the sign-in cannot see");
  assert.equal(setup.status(again.setup_id).state, "authorized", "refusing leaves the setup waiting for the choice");
  assert.deepEqual(cf.calls.filter((c) => /accounts\/acc2\/workers/.test(c)), [], "nothing was asked of the other account");
  await w.link("gateway.setup.deploy", { setup_id: again.setup_id, account: "acc1", name: "my-relay" });
  await eventually(() => setup.status(again.setup_id).state === "connected", "connected");
  assert.deepEqual(cf.uploads.map((u) => [u.account, u.script]), [["acc1", "my-relay"]]);
  assert.deepEqual(cf.calls.filter((c) => /accounts\/acc2\/workers/.test(c)), [], "the other account was never touched");
});

test("one Cloudflare account is used without asking, and then the status lists nothing to choose", async (t) => {
  const { cf, setup, id } = await authorized(t);
  assert.deepEqual(setup.status(id).accounts, [{ id: "acc1", name: "Owner's account" }]);
  setup.deploy(id, "my-relay");
  await eventually(() => setup.status(id).state === "connected", "connected");
  assert.deepEqual(cf.uploads.map((u) => u.account), ["acc1"]);
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
