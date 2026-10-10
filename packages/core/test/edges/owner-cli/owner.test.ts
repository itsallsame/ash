/**
 * T13a: the owner's command line (tools/e2e/owner.mjs), the bundled file, against a hub started the way a host starts it.
 * It connects as the owner does on a phone: the hub's local token and a signed challenge, nothing else.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { buildOwner } from "../../../../../tools/e2e/build-owner.mjs";
import { MAIN, OWNER, byOwnerText, dataOf, isApprovalAsk, ownerMessage, startScenario, textOf, toOwner, type Scenario } from "../../scenarios/harness";
import { eventually } from "../../fixtures/wait";

const here = fileURLToPath(new URL(".", import.meta.url));
const committed = join(here, "../../../../../tools/e2e/owner.mjs");
const work = mkdtempSync(join(tmpdir(), "ash-owner-cli-"));
const bundle = await buildOwner(join(work, "owner.mjs"));
test.after(() => rmSync(work, { recursive: true, force: true }));

interface Run { code: number | null; out: string; err: string }

/** Runs the bundled tool. The hub lives in this process, so the child must not block it: spawn, never execSync. */
function owner(s: Scenario, args: string[], o: { stdin?: string; token?: string; state?: string; withToken?: boolean } = {}): Promise<Run> {
  const tokenFile = join(work, `token-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tokenFile, `${o.token ?? s.token()}\n`, { mode: 0o600 });
  const base = ["--url", s.linkUrl(), "--state", o.state ?? join(work, "state"), ...(o.withToken === false ? [] : ["--token-file", tokenFile])];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, ...base, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(o.stdin ?? "");
  });
}

/** `key=value` fields of the first line of [kind]. */
function fields(out: string, kind: string, nth = 0): Record<string, string> {
  const lines = out.split("\n").filter((l) => new RegExp(`^\\S+ ${kind}( |$)`).test(l));
  const found = lines[nth];
  assert.ok(found, `a ${kind} line in:\n${out}`);
  const result: Record<string, string> = {};
  for (const m of found.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) result[m[1]!] = m[2]!.startsWith('"') ? JSON.parse(m[2]!) : m[2]!;
  return result;
}

const everyLineIsTimed = (out: string) => out.split("\n").filter(Boolean).every((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \S+/.test(l));

test("the committed bundle is what the source builds", async () => {
  assert.ok(existsSync(committed), "tools/e2e/owner.mjs is committed");
  assert.equal(readFileSync(committed, "utf8"), readFileSync(bundle, "utf8"), "run: node tools/e2e/build-owner.mjs");
  assert.ok(!/\bfrom\s+["']ws["']/.test(readFileSync(bundle, "utf8")), "no import of a package is left in the bundle");
});

test("say: the reply of the agent is printed, each line timed", async (t: TestContext) => {
  const s = await startScenario(t);
  s.driver.script((turn) => turn.say("你好，我在。"));

  const run = await owner(s, ["say", "你好"]);

  assert.equal(run.code, 0, run.err + run.out);
  assert.ok(everyLineIsTimed(run.out), run.out);
  const reply = fields(run.out, "msg");
  assert.equal(reply.from, MAIN);
  assert.equal(reply.to, OWNER);
  assert.equal(reply.word, "say");
  assert.equal(reply.text, "你好，我在。");
  assert.equal(fields(run.out, "sent").to, MAIN);
  assert.ok(s.driver.messages().some(ownerMessage("你好")), "the agent was given the owner's words");
});

test("say: several bubbles of one round are all printed; no reply times out with exit 2", async (t: TestContext) => {
  const s = await startScenario(t);
  s.driver.script((turn) => {
    if (turn.messages.some(ownerMessage("两句"))) { turn.say("第一句"); turn.say("第二句"); }
  });

  const two = await owner(s, ["say", "两句", "--settle", "0.8"]);
  assert.equal(two.code, 0, two.err + two.out);
  assert.deepEqual([0, 1].map((n) => fields(two.out, "msg", n).text), ["第一句", "第二句"]);

  const none = await owner(s, ["say", "没人回", "--timeout", "1.5"]);
  assert.equal(none.code, 2, none.out);
  assert.equal(fields(none.out, "timeout").replies, "0");
});

test("a wrong token is refused with 4001 and the tool says so, exit 1", async (t: TestContext) => {
  const s = await startScenario(t);
  const run = await owner(s, ["say", "hi"], { token: "not-the-token" });
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /error message=.*4001/);
});

test("the token is never an argument: without a file or stdin the tool does not connect", async (t: TestContext) => {
  const s = await startScenario(t);
  const none = await owner(s, ["say", "hi"], { withToken: false });
  assert.equal(none.code, 64);
  assert.match(none.err, /token/);
  const asArgument = await owner(s, ["say", "hi", "--token", s.token()], { withToken: false });
  assert.equal(asArgument.code, 64, "there is no --token option");
  const stdin = await owner(s, ["--token-stdin", "call", "service:admin", "status"], { withToken: false, stdin: `${s.token()}\n` });
  assert.equal(stdin.code, 0, stdin.err + stdin.out);
});

test("watch prints what arrives while it listens; answer picks an option on a card", async (t: TestContext) => {
  const s = await startScenario(t);
  s.driver.script(async (turn) => {
    if (turn.messages.some(ownerMessage("帮我选"))) {
      await turn.tool("human_show", { card: { type: "options", prompt: "选哪个？", options: [{ id: "a", text: "方案A" }, { id: "b", text: "方案B" }] } });
    }
  });
  const human = await s.human();

  const watching = owner(s, ["watch", "4"]);
  await eventually(() => human.client.state === "ready", "the test's own channel");
  await new Promise((r) => setTimeout(r, 1500)); // the tool connects after it is spawned
  await human.say("帮我选");
  const card = await human.seen(toOwner("show", MAIN), "the option card");
  const run = await watching;

  assert.equal(run.code, 0, run.err + run.out);
  assert.ok(everyLineIsTimed(run.out), run.out);
  const seen = fields(run.out, "card");
  assert.equal(seen.id, card.id);
  assert.equal(seen.type, "options");
  assert.equal(seen.options, "a:方案A,b:方案B");

  const picked = await owner(s, ["answer", card.id, "b"]);
  assert.equal(picked.code, 0, picked.err + picked.out);
  assert.equal(fields(picked.out, "answered").card, card.id);
  const { message } = await s.driver.delivery((m) => m.text.startsWith(`[answers ${card.id}, option b]`), "the pick reaching the agent");
  assert.equal(message.from, OWNER);
});

test("an approval card shows in say, answer once lets the request through", async (t: TestContext) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  s.driver.script(async (turn) => {
    if (turn.messages.some(ownerMessage("打开笔记"))) await turn.call(phone.member, "apps.open", { app: "com.example.notes" }, { purpose: "open notes" });
    else if (turn.messages.some((m) => m.word === "tell")) {
      const pending = turn.messages.map((m) => /pend\w*_\w+|p_\w+/.exec(m.text)?.[0]).find(Boolean);
      if (pending) await turn.tool("human_pending_redeem", { id: pending });
    }
  });

  const run = await owner(s, ["say", "打开笔记"]);

  assert.equal(run.code, 0, run.err + run.out);
  const ask = fields(run.out, "ask");
  assert.equal(ask.from, "service:gate");
  assert.deepEqual(ask.options.split(",").map((o) => o.split(":")[0]).sort(), ["always", "deny", "once"]);
  assert.equal((await s.human().then((h) => h.ledger())).filter(isApprovalAsk).length, 1);

  const answered = await owner(s, ["answer", ask.id, "once"]);
  assert.equal(answered.code, 0, answered.err + answered.out);
  assert.equal(fields(answered.out, "answered").choice, "once");
  await s.driver.delivery((m) => m.from === "service:gate" && m.word === "tell", "the answer reaching the asker");
  const again = await owner(s, ["answer", ask.id, "deny"]);
  assert.equal(again.code, 3, "the second answer is a conflict");
});

test("call: a word as the owner, with the body from the argument, a file or stdin; a refusal exits 3", async (t: TestContext) => {
  const s = await startScenario(t);

  const status = await owner(s, ["call", "service:admin", "status"]);
  assert.equal(status.code, 0, status.err + status.out);
  const result = fields(status.out, "result");
  assert.equal(result.ok, "true");
  assert.equal(JSON.parse(result.data!).paused, false);

  const listed = await owner(s, ["call", "service:agents", "list", "{}"]);
  assert.equal(listed.code, 0);
  assert.ok(JSON.parse(fields(listed.out, "result").data!).agents.some((a: { id: string }) => a.id === MAIN));

  const file = join(work, "body.json");
  writeFileSync(file, '{"limit": 5}');
  const history = await owner(s, ["call", "service:history", "query", `@${file}`]);
  assert.equal(history.code, 0, history.err + history.out);
  const fromStdin = await owner(s, ["call", "service:history", "query", "-"], { stdin: '{"limit": 5}' });
  assert.equal(fromStdin.code, 0, fromStdin.err + fromStdin.out);

  const refused = await owner(s, ["call", "service:nothing", "at-all", "{}"]);
  assert.equal(refused.code, 3);
  assert.equal(fields(refused.out, "result").ok, "false");

  const json = await owner(s, ["--json", "call", "service:admin", "status"]);
  const objects = json.out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(objects.every((o) => typeof o.at === "string" && typeof o.kind === "string"));
  assert.equal(objects.find((o) => o.kind === "result").ok, true);
});

test("set-key: the key comes from stdin or a file, is saved in the vault, and is printed nowhere", async (t: TestContext) => {
  const s = await startScenario(t);
  const secret = "sk-test-0123456789abcdef";

  const viaStdin = await owner(s, ["set-key"], { stdin: `${secret}\n` });
  assert.equal(viaStdin.code, 0, viaStdin.err + viaStdin.out);
  assert.ok(!viaStdin.out.includes(secret) && !viaStdin.err.includes(secret), "the key is not echoed");
  const human = await s.human();
  const entries = (dataOf(await human.call("service:vault", "list")) as { entries: { ref: string; configured: boolean }[] }).entries;
  assert.equal(entries.find((e) => e.ref === "DEEPSEEK_API_KEY")?.configured, true);

  const keyFile = join(work, "key.txt");
  writeFileSync(keyFile, `${secret}2`, { mode: 0o600 });
  const viaFile = await owner(s, ["set-key", "OPENROUTER_API_KEY", "--key-file", keyFile]);
  assert.equal(viaFile.code, 0, viaFile.err + viaFile.out);
  assert.ok(!viaFile.out.includes(secret));
  const after = (dataOf(await human.call("service:vault", "list")) as { entries: { ref: string; configured: boolean }[] }).entries;
  assert.equal(after.find((e) => e.ref === "OPENROUTER_API_KEY")?.configured, true);

  const ledger = JSON.stringify(await human.ledger());
  assert.ok(!ledger.includes(secret), "the key never reached the ledger");

  const empty = await owner(s, ["set-key"], { stdin: "\n" });
  assert.equal(empty.code, 64);
});

test("the channel keeps its identity between runs: one hand, not one per run", async (t: TestContext) => {
  const s = await startScenario(t);
  const state = join(work, "stable-state");
  const first = await owner(s, ["call", "service:admin", "status"], { state });
  const second = await owner(s, ["call", "service:admin", "status"], { state });
  assert.equal(fields(first.out, "conn").hand, fields(second.out, "conn").hand);
  const other = await owner(s, ["call", "service:admin", "status"], { state: join(work, "other-state") });
  assert.notEqual(fields(other.out, "conn").hand, fields(first.out, "conn").hand);
});
