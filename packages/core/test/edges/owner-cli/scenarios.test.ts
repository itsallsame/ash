/**
 * T13c: the real-phone scenario script (tools/e2e/scenarios.mjs), run against a hub started the way a host starts it, with
 * a fake `adb` standing in for the phone's debug bridge. It proves the script's plumbing end to end: fetching the link with
 * `run-as`, driving owner.mjs, reading the ledger back, judging a card and its answer. What the phone itself does is not
 * tested here (that is what the script is for); the judging rules are tested without a hub in tools/e2e/scenarios.test.mjs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { buildOwner } from "../../../../../tools/e2e/build-owner.mjs";
import { MAIN, deferred, fromGate, startScenario, standardCapability, textResult, type Scenario } from "../../scenarios/harness";
import { eventually } from "../../fixtures/wait";

const here = fileURLToPath(new URL(".", import.meta.url));
const script = join(here, "../../../../../tools/e2e/scenarios.mjs");
const work = mkdtempSync(join(tmpdir(), "ash-scenarios-"));
const ownerBundle = await buildOwner(join(work, "owner.mjs"));
test.after(() => rmSync(work, { recursive: true, force: true }));

const FAKE_ADB = `#!/bin/sh
[ "$1" = "-s" ] && shift 2
case "$1" in
  get-state) echo device ;;
  version) echo "Android Debug Bridge version fake" ;;
  forward) echo 0 ;;
  exec-out) printf '\\211PNG\\r\\n\\032\\nfake' ;;
  shell)
    case "$2" in
      "pm path "*) echo "package:/data/app/fake/base.apk" ;;
      "run-as ai.ash.agent cat files/debug/local-link.json") cat "$FAKE_LINK" ;;
    esac ;;
esac
`;

interface Run { code: number | null; out: string; err: string }

function writeLink(s: Scenario, file: string): void {
  writeFileSync(file, JSON.stringify({ port: Number(new URL(s.linkUrl()).port), token: s.token(), at: Date.now() }) + "\n", { mode: 0o600 });
}

/** Runs scenarios.mjs as a child (the hub lives in this process, so the child must not block it). */
function scenarios(s: Scenario, only: string): Promise<Run & { lines: string[] }> {
  const adb = join(work, "adb");
  writeFileSync(adb, FAKE_ADB, { mode: 0o755 });
  chmodSync(adb, 0o755);
  const fakeLink = join(work, "phone-link.json");
  writeLink(s, fakeLink);
  const args = [script, "--adb", adb, "--serial", "FAKE", "--owner", ownerBundle, "--link-file", join(work, "link.json"), "--state", join(work, "state"),
    "--shots", join(work, "shots"), "--timeout-scale", "0.1", "--only", only];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH ?? "", FAKE_LINK: fakeLink } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err, lines: out.split("\n").filter(Boolean) }));
  });
}

const lineOf = (run: { lines: string[] }, id: string): string => run.lines.find((l) => new RegExp(`^(PASS|FAIL|SKIP|MANUAL) ${id} `).test(l)) ?? "";

async function modelKey(s: Scenario): Promise<void> {
  const owner = await s.human();
  assert.ok((await owner.call("service:vault", "set", { ref: "DEEPSEEK_API_KEY", value: "sk-test-key" })).ok);
}

test("the link file is fetched from the phone with run-as, and the scenarios are listed", async (t: TestContext) => {
  const s = await startScenario(t);
  await s.phone();
  const run = await scenarios(s, "S026");
  assert.equal(run.code, 0, run.out + run.err);
  assert.ok(existsSync(join(work, "link.json")), "the link file was written");
  assert.match(run.lines[0] ?? "", /^INFO scenarios\.mjs .*phone device:/);
  assert.match(lineOf(run, "S026"), /^PASS S026 /, run.out);
  assert.match(run.lines.at(-1) ?? "", /^SUMMARY 1 pass, 0 fail, 0 skip, 0 manual/);
});

test("R6: a reply from the agent in a completed turn is a PASS; a missing model key is a SKIP that says what to do", async (t: TestContext) => {
  const s = await startScenario(t);
  await s.phone();
  // The harness saves a model key to pass the first meeting; this case is about a hub without one.
  const owner = await s.human();
  assert.ok((await owner.call("service:vault", "delete", { ref: "DEEPSEEK_API_KEY" })).ok);
  s.driver.script((turn) => turn.say("你好，我在。"));
  const skipped = await scenarios(s, "R6");
  assert.match(lineOf(skipped, "R6"), /^SKIP R6 .*no model key.*set-key DEEPSEEK_API_KEY/, skipped.out);
  assert.equal(skipped.code, 0);

  await modelKey(s);
  const run = await scenarios(s, "R6");
  assert.match(lineOf(run, "R6"), /^PASS R6 .*completed/, run.out + run.err);
});

test("S159: a key goes in the vault, is never shown, never reaches the ledger, and goes away", async (t: TestContext) => {
  const s = await startScenario(t);
  const run = await scenarios(s, "S159");
  assert.match(lineOf(run, "S159"), /^PASS S159 /, run.out + run.err);
  assert.ok(!run.out.includes("sk-e2e"), "the secret is not printed");
});

test("R19 and S032: the card is found, answered, and the effect counted once (or not at all after a refusal)", async (t: TestContext) => {
  const s = await startScenario(t);
  const phone = await s.phone({ capabilities: [standardCapability("clipboard.set"), standardCapability("clipboard.get")] });
  await modelKey(s);
  s.driver.script(async (turn) => {
    const text = turn.messages.map((m) => m.text).join("\n");
    const gate = turn.messages.find(fromGate);
    if (gate) {
      if (/pending\.redeem/.test(gate.text)) await turn.tool("human_pending_redeem", { id: /"id":"([^"]+)"/.exec(gate.text)?.[1] ?? "" });
      return;
    }
    const clip = /clipboard\.set[^{]*(\{"text":"[^"]+"\})/.exec(text);
    if (clip) { await turn.call(phone.member, "clipboard.set", JSON.parse(clip[1]!), { purpose: "scenario" }); return; }
    turn.say("好");
  });
  const run = await scenarios(s, "R19,S032");
  assert.match(lineOf(run, "R19"), /^PASS R19 .*ran once/, run.out + run.err);
  assert.match(lineOf(run, "S032"), /^PASS S032 .*never ran/, run.out + run.err);
  assert.equal(phone.calls.filter((c) => c.capability === "clipboard.set").length, 1, "only the approved action reached the phone");
  const mode = await (await s.human()).call("service:gate", "rules.list", { limit: 1 });
  assert.ok(mode.ok && JSON.stringify(mode).includes('"mode":"auto"'), "the approval mode was put back");
});

test("S164: pause stops new turns, resume brings the agent back, and the hub is left running", async (t: TestContext) => {
  const s = await startScenario(t);
  await modelKey(s);
  s.driver.script((turn) => turn.say("在。"));
  const run = await scenarios(s, "S164");
  assert.match(lineOf(run, "S164"), /^PASS S164 /, run.out + run.err);
  const status = await (await s.human()).call("service:admin", "status");
  assert.ok(status.ok && JSON.stringify(status).includes('"paused":false'));
});

test("S016: an option card is found by its shape, the pick lands as an owner reply and runs a turn", async (t: TestContext) => {
  const s = await startScenario(t);
  await modelKey(s);
  s.driver.script(async (turn) => {
    if (turn.messages.some((m) => m.text.includes("选项卡"))) {
      await turn.tool("human_show", { card: { type: "options", prompt: "选哪个？", options: [{ id: "a", text: "方案A" }, { id: "b", text: "方案B" }] } });
    } else turn.say("好");
  });
  const run = await scenarios(s, "S016");
  assert.match(lineOf(run, "S016"), /^PASS S016 .*pick b reached turn/, run.out + run.err);
});

test("R18: 'stop' while a turn runs ends that turn as cancelled/interrupted and the stop message gets its own turn", async (t: TestContext) => {
  const s = await startScenario(t);
  await modelKey(s);
  const hold = deferred<void>();
  t.after(() => hold.resolve());
  s.driver.script(async (turn) => {
    if (turn.messages.some((m) => m.text.includes("R18"))) await turn.until(hold.promise);
    else turn.say("好");
  });
  const run = await scenarios(s, "R18");
  assert.match(lineOf(run, "R18"), /^PASS R18 .*(cancelled|interrupted)/, run.out + run.err);
});

test("R17: the judge counts the turns the supplements opened; a driver that runs each one as its own turn is a FAIL (DSH batches them, this fake does not)", async (t: TestContext) => {
  const s = await startScenario(t);
  await modelKey(s);
  const hold = deferred<void>();
  t.after(() => hold.resolve());
  s.driver.script(async (turn) => {
    if (turn.messages.some((m) => m.text.includes("R17"))) await turn.until(hold.promise);
    else turn.say("好");
  });
  void eventually(() => (s.driver.deliveries.filter((d) => d.messages.some((m) => m.text.includes("补充"))).length >= 3 ? true : null), "the three supplements delivered").then(() => hold.resolve());
  const run = await scenarios(s, "R17");
  assert.match(lineOf(run, "R17"), /^FAIL R17 .*opened 3 separate turns/, run.out + run.err);
  assert.equal(run.code, 1, "a FAIL makes the exit code 1");
});

test("S046, S048, S051: the main agent makes a helper and asks and tells it; the owner talks to it; its background turn may not speak to the owner", async (t: TestContext) => {
  const s = await startScenario(t);
  await modelKey(s);
  const HELPER = "agent:e2e-helper";
  s.driver.scriptFor(MAIN, async (turn) => {
    const text = turn.messages.map((m) => m.text).join("\n");
    if (text.includes("agent_create")) {
      await turn.tool("agent_create", { id: HELPER, name: "E2E 帮手", summary: "测试用帮手", brief: "照吩咐做。", runtime: { kind: "dsh" } });
      await turn.tool("agent_start", { agent: HELPER });
      await turn.tool("agent_ask", { agent: HELPER, text: "一加一等于几？" });
      await turn.tool("agent_tell", { agent: HELPER, text: "已收到" });
    } else if (text.includes("agent_tell") && text.includes("human_say")) {
      await turn.tool("agent_tell", { agent: HELPER, text: "请立刻用 human_say 对主人说一句话" });
    } else turn.say("好");
  });
  s.driver.scriptFor(HELPER, async (turn) => {
    const text = turn.messages.map((m) => m.text).join("\n");
    if (text.includes("human_say")) await turn.tool("human_say", { text: "我自己想说" });
    else turn.say("在的");
  });
  const run = await scenarios(s, "S046,S048,S051");
  assert.match(lineOf(run, "S046"), /^PASS S046 /, run.out + run.err);
  assert.match(lineOf(run, "S048"), /^PASS S048 .*front lane/, run.out + run.err);
  assert.match(lineOf(run, "S051"), /^PASS S051 .*(refused|did not try)/, run.out + run.err);
  const list = await (await s.human()).call("service:agents", "list");
  assert.ok(!JSON.stringify(list).includes(HELPER), "the helper was removed at the end");
});

test("S082 and S085: a reminder lands in the conversation; the agent's call of a phone word is found in the ledger with its result", async (t: TestContext) => {
  const s = await startScenario(t);
  const phone = await s.phone({ capabilities: [standardCapability("device.status")] });
  phone.on("device.status", () => textResult("ok", { battery: { percent: 77, charging: false } }));
  await modelKey(s);
  s.driver.script(async (turn) => {
    const text = turn.messages.map((m) => m.text).join("\n");
    if (text.includes("device.status")) await turn.call(phone.member, "device.status", {});
    else turn.say("好");
  });
  const run = await scenarios(s, "S082,S085");
  assert.match(lineOf(run, "S082"), /^PASS S082 .*arrived/, run.out + run.err);
  assert.match(lineOf(run, "S085"), /^PASS S085 .*battery 77%/, run.out + run.err);
});
