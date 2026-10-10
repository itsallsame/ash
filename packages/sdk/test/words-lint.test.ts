import assert from "node:assert/strict";
import test from "node:test";
import { standardContracts } from "../src/namespaces";
import { SERVICE_NAMES, WORD_CONTRACTS, wordContract, wordsOf } from "../src/words";
import {
  CALLER_KINDS, DEFAULT_CALLERS, EFFECTS, LINT_RULES, RESERVED_INPUT_NAMES, RISKS, effectRiskProblem, lintWord, lintWords, secret, sensitive, wordEffect,
  type LintRule, type WordContract,
} from "../src/word";

const ALL = [...WORD_CONTRACTS, ...standardContracts()];

// The name of the private project this was split from must not appear in public text; spelled out in pieces so this file itself is clean.
const FORBIDDEN_NAME = new RegExp(["at", "oll"].join(""), "i");

test("every word passes lint", () => {
  assert.deepEqual(lintWords(ALL), []);
  assert.ok(WORD_CONTRACTS.length > 150 && ALL.length > 250);
});

test("labels are the one present-continuous label; descriptions say when to use the word", () => {
  for (const word of ALL) {
    assert.match(word.label.doing, /^在/, `${word.member}/${word.word}`);
    assert.ok([...word.description].length >= 20, `${word.member}/${word.word}`);
  }
});

test("no contract names an agent or the old fixed members", () => {
  const text = JSON.stringify(ALL);
  for (const gone of ["agent:main", "agent:keeper", "device:phone", "screen:*", "service:self", "service:files", "service:work", "service:post", "worker:"]) assert.ok(!text.includes(gone), gone);
  assert.ok(!ALL.some((word) => word.member === "service:self" || word.member === "service:post" || word.member.startsWith("worker:")));
  assert.ok(!("agents" in ALL[0]!), "the contract has no agents field");
  assert.ok(!FORBIDDEN_NAME.test(text));
});

test("the services of SPEC-02 §4.1 are all there, and the removed ones are not", () => {
  for (const service of ["admin", "gate", "vault", "devices", "link", "agents", "apps", "clock", "llm", "persona", "widgets", "pulse", "cost", "reflex", "senses", "directory", "history", "blobs", "host", "bodies"]) {
    assert.ok(SERVICE_NAMES.includes(`service:${service}`), service);
  }
  assert.equal(SERVICE_NAMES.length, 20);
  const has = (member: string, ...words: string[]) => words.forEach((word) => assert.ok(wordContract(member, word), `${member}/${word}`));
  has("service:gate", "rules.list", "rules.set", "rules.revoke", "mode.set", "audit", "history", "pending.list", "pending.get", "pending.redeem", "pending.skip", "pending.withdraw");
  has("service:vault", "list", "describe", "set", "delete");
  has("service:devices", "list", "describe", "pair_start", "pair_status", "pair_pending", "pair_approve", "pair_reject", "revoke", "rename", "access_set", "update", "pair_code", "restore");
  has("service:link", "list", "describe", "diagnose", "disconnect", "reconnect", "refresh_manifest", "gateway.status", "gateway.setup.start", "gateway.setup.status", "gateway.setup.deploy", "gateway.setup.cancel", "gateway.use", "connected", "disconnected", "handshake_failed");
  has("service:agents", "list", "runtimes", "threads", "thread.stop", "describe", "ask", "tell", "answer", "declare", "update", "start", "stop", "restart", "remove", "configure", "plugins", "spawn", "primary.set",
    "session.get", "session.set", "session.new", "session.reload", "session.compact", "session.send", "session.followup", "session.steer", "session.inject", "session.interrupt", "session.restart");
  has("service:bodies", "list", "describe", "bind", "unbind");
  has("service:history", "query", "read", "turn", "activity");
  has("service:blobs", "read", "get");
  has("service:host", "wake.at", "wake.clear", "power.hold", "power.release", "hands.handoff", "update.install");
  has("service:cost", "usage.get", "balance.get", "quota.check");
  has("service:persona", "get", "propose");
  has("service:directory", "list", "describe");
  has("service:apps", "surface", "icon", "apps.install", "apps.validate");
  has("service:llm", "complete");
  has("service:admin", "pause", "resume", "settings.get", "settings.set", "model.set", "plugins.list", "plugins.op", "status", "logs");
  has("person:owner", "say", "react", "show", "ask", "open");
  has("agent:main", "say", "tell", "ask", "wake");
  has("agent:w-3f9a1c", "wake");
  assert.equal(wordContract("service:post", "deliver"), undefined);
  assert.equal(wordContract("service:widgets", "widget.bind")?.kind, "event");
});

test("the events SPEC-02 names exist, and the ones that go in the ledger are marked", () => {
  const events = WORD_CONTRACTS.filter((word) => word.kind === "event");
  for (const [member, word] of [["agent:main", "typing"], ["service:widgets", "widget.rendered"], ["service:vault", "vault.changed"]]) assert.equal(wordContract(member!, word!)?.kind, "event", `${member}/${word}`);
  const recorded = events.filter((word) => word.record).map((word) => `${word.member}/${word.word}`).sort();
  assert.deepEqual(recorded, [
    "agent:*/agent.tool", "agent:*/turn.ended", "agent:*/turn.started", "service:admin/settings.changed",
    "service:devices/pair.changed", "service:link/connected", "service:link/disconnected",
  ]);
  for (const word of events) assert.deepEqual([word.effect, word.risk], ["read", "none"]);
  assert.ok(!WORD_CONTRACTS.some((word) => word.kind === "event" && /^sense\./.test(word.word) && word.record), "sense.* is not recorded");
});

test("wake, say and the kernel-only words have the callers the spec gives", () => {
  const wake = wordContract("agent:main", "wake")!;
  assert.deepEqual([wake.effect, wake.risk], ["act", "none"]);
  assert.ok(wake.callers.includes("app") && wake.callers.includes("kernel"));
  assert.deepEqual(wordContract("service:vault", "set")?.callers, ["owner"]);
  assert.equal(wordContract("service:vault", "set")?.local_only, true);
  assert.equal(wordContract("service:admin", "resume")?.local_only, true);
  assert.equal(wordContract("service:admin", "logs")?.local_only, true);
  assert.equal(wordContract("service:devices", "pair_code")?.local_only, true);
  assert.deepEqual(wordContract("service:pulse", "pulse.due")?.callers, ["kernel"]);
  assert.deepEqual(wordContract("service:cost", "quota.check")?.callers, ["kernel"]);
  assert.deepEqual(wordContract("service:gate", "rules.set")?.callers, ["owner", "agent"]);
  assert.deepEqual(wordContract("service:gate", "pending.redeem")?.callers, ["agent"]);
  assert.equal(wordContract("service:llm", "complete")?.effect, "read");
  assert.equal(wordContract("service:llm", "complete")?.risk, "none");
  assert.deepEqual(wordContract("device:x", "sense.configure"), undefined);
  assert.equal(standardContracts().find((word) => word.word === "sense.configure")?.risk, "none");
  for (const word of standardContracts().filter((item) => item.word.startsWith("decision."))) assert.deepEqual(word.callers, ["kernel"]);
});

test("secrets and masks sit where SPEC-01 §10.0 says", () => {
  const set = wordContract("service:vault", "set")!;
  assert.equal(set.input_schema.properties.value["x-ash-secret"], true);
  assert.ok(!JSON.stringify(set.result_schema).includes("x-ash-secret"));
  assert.ok(JSON.stringify(wordContract("service:devices", "list")!.result_schema).includes('"x-ash-sensitive":{"mask":"ip"}'));
  assert.ok(JSON.stringify(wordContract("service:link", "gateway.status")!.result_schema).includes('"mask":"email"'));
  for (const word of wordsOf("service:vault")) assert.ok(!/value/.test(JSON.stringify(word.result_schema ?? {})) || word.word === "set", word.word);
});

test("effect and risk: the one set of values and the two constraints", () => {
  assert.deepEqual([...EFFECTS], ["read", "write", "act", "execute"]);
  assert.deepEqual([...RISKS], ["none", "outward", "structure"]);
  for (const effect of EFFECTS) for (const risk of RISKS) {
    const problem = effectRiskProblem(effect, risk);
    const legal = effect === "read" ? risk === "none" : effect === "execute" ? risk === "structure" : true;
    assert.equal(problem === null, legal, `${effect}/${risk}`);
  }
  assert.ok(effectRiskProblem("send", "none") && effectRiskProblem("read", "bogus"));
  // wordEffect: the declared effect, or one derived from the risk; a lying "read" is treated by its risk
  assert.equal(wordEffect({ effect: "execute", risk: "structure" }), "execute");
  assert.equal(wordEffect({ effect: "act", risk: "none" }), "act");
  assert.equal(wordEffect({ risk: "none" }), "read");
  assert.equal(wordEffect({ risk: "outward" }), "act");
  assert.equal(wordEffect({ risk: "structure" }), "write");
  assert.equal(wordEffect({ effect: "send", risk: "outward" }), "act");
  assert.equal(wordEffect({ effect: "read", risk: "outward" }), "act");
  assert.equal(wordEffect({ effect: "read", risk: "structure" }), "write");
  assert.equal(wordEffect({}), "read");
  for (const word of ALL) assert.equal(wordEffect(word), word.effect, `${word.member}/${word.word}`);
});

// ---- one deliberate violation per lint rule ------------------------------------------------------------------------

const GOOD: WordContract = {
  member: "service:test", word: "ping.now", kind: "request", direction: "in",
  description: "Ping the thing and report how long it took, in milliseconds.",
  input_schema: { type: "object", properties: { count: { type: "integer" } }, additionalProperties: false },
  result_schema: { type: "object", properties: { ms: { type: "number" } } },
  effect: "act", risk: "none", callers: ["owner", "agent"], label: { doing: "在测延迟" },
};
const EVENT: WordContract = { ...GOOD, word: "ping.done", kind: "event", direction: "out", effect: "read", risk: "none", callers: ["kernel"] };
const bad = (patch: Record<string, unknown>, base: WordContract = GOOD): WordContract => ({ ...base, ...patch }) as WordContract;

const VIOLATIONS: Record<LintRule, [string, WordContract][]> = {
  "member": [["not an id", bad({ member: "Service:test" })], ["unknown kind", bad({ member: "worker:extract" })], ["a client is not a member", bad({ member: "client:abc" })]],
  "word-name": [["upper case", bad({ word: "Ping" })], ["empty", bad({ word: "" })], ["trailing dot", bad({ word: "ping." })]],
  "description": [["missing", bad({ description: undefined })], ["too short", bad({ description: "Ping it." })], ["blank", bad({ description: " ".repeat(40) })]],
  "label": [["missing", bad({ label: undefined })], ["empty doing", bad({ label: { doing: "" } })], ["a plain string", bad({ label: "在测延迟" })], ["extra key", bad({ label: { doing: "在测延迟", done: "x" } })]],
  "input-schema": [["missing", bad({ input_schema: undefined })], ["not an object schema", bad({ input_schema: { type: "string" } })], ["does not compile", bad({ input_schema: { type: "object", properties: { a: { type: "nope" } } } })]],
  "result-schema": [["not a schema", bad({ result_schema: "x" })], ["does not compile", bad({ result_schema: { type: "bogus" } })]],
  "effect-risk": [["read with risk", bad({ effect: "read", risk: "outward" })], ["execute without structure", bad({ effect: "execute", risk: "none" })], ["old effect value", bad({ effect: "send" })], ["old effect structure", bad({ effect: "structure" })], ["unknown risk", bad({ risk: "high" })]],
  "kind-direction": [["a request that goes out", bad({ direction: "out" })], ["unknown kind", bad({ kind: "response" })], ["no direction", bad({ direction: undefined })]],
  "event-shape": [["event with an effect", bad({ effect: "act" }, EVENT)], ["event with risk", bad({ effect: "read", risk: "outward" }, EVENT)], ["event with foreground", bad({ foreground: true }, EVENT)]],
  "callers": [["missing", bad({ callers: undefined })], ["empty", bad({ callers: [] })], ["unknown caller", bad({ callers: ["owner", "robot"] })], ["repeated", bad({ callers: ["owner", "owner"] })], ["the old audience field is not callers", bad({ callers: "all" })]],
  "local-only": [["without owner", bad({ local_only: true, callers: ["agent"] })], ["false is not a value", bad({ local_only: false })]],
  "record": [["on a request", bad({ record: true })], ["false is not a value", bad({ record: false }, EVENT)]],
  "flags": [["per_call_risk on a read", bad({ effect: "read", per_call_risk: true })], ["per_call_risk on risk none", bad({ per_call_risk: true })], ["foreground not a boolean", bad({ foreground: "yes" })]],
  "timeout": [["zero", bad({ timeout_ms: 0 })], ["fraction", bad({ timeout_ms: 1.5 })], ["string", bad({ timeout_ms: "5" })]],
  "reserved-name": RESERVED_INPUT_NAMES.map((name): [string, WordContract] => [name, bad({ input_schema: { type: "object", properties: { [name]: { type: "string" } } } })]),
  "secret": [["secret on a result", bad({ result_schema: { type: "object", properties: { key: secret({ type: "string" }) } } })], ["secret that is not true", bad({ input_schema: { type: "object", properties: { key: { type: "string", "x-ash-secret": "yes" } } } })]],
  "sensitive": [["sensitive on an input", bad({ input_schema: { type: "object", properties: { ip: sensitive({ type: "string" }, "ip") } } })], ["unknown mask", bad({ result_schema: { type: "object", properties: { ip: { type: "string", "x-ash-sensitive": { mask: "stars" } } } } })]],
};

test("the good example and the event example pass", () => {
  assert.deepEqual(lintWord(GOOD), []);
  assert.deepEqual(lintWord(EVENT), []);
  assert.deepEqual(lintWord(bad({ callers: [...DEFAULT_CALLERS] })), []);
  assert.deepEqual(lintWord(bad({ local_only: true, record: undefined })), []);
  assert.deepEqual(lintWord(bad({ effect: "write", risk: "structure", per_call_risk: true })), []);
  assert.deepEqual(lintWord(bad({ input_schema: { type: "object", properties: { key: secret({ type: "string" }) } }, result_schema: { type: "object", properties: { ip: sensitive({ type: "string" }, "ip") } } })), []);
  assert.deepEqual(lintWord(bad({ member: "agent:*" })), []);
  assert.deepEqual(lintWord(bad({ member: "device:*", word: "x.kimi.browser.upload" })), []);
  assert.deepEqual([...CALLER_KINDS], ["owner", "agent", "app", "kernel"]);
});

test("every lint rule rejects its deliberate violation", () => {
  assert.deepEqual(Object.keys(VIOLATIONS).sort(), [...LINT_RULES].sort(), "a rule has no counter-example");
  for (const [rule, cases] of Object.entries(VIOLATIONS)) {
    assert.ok(cases.length > 0, rule);
    for (const [what, contract] of cases) {
      const issues = lintWord(contract);
      assert.ok(issues.some((issue) => issue.rule === rule), `${rule}: ${what} should be rejected by that rule, got ${JSON.stringify(issues.map((issue) => issue.rule))}`);
    }
  }
});

test("a word defined twice is rejected, and so is a nested reserved name only when it is a top-level field", () => {
  assert.ok(lintWords([GOOD, GOOD]).some((issue) => /twice/.test(issue.message)));
  const nested = bad({ input_schema: { type: "object", properties: { card: { type: "object", properties: { purpose: { type: "string" } } } } } });
  assert.deepEqual(lintWord(nested), []);
  const viaAnyOf = bad({ input_schema: { type: "object", anyOf: [{ required: ["wait"], properties: { wait: { type: "boolean" } } }] } });
  assert.ok(lintWord(viaAnyOf).some((issue) => issue.rule === "reserved-name"));
});

test("the lint also covers a hand-written contract with the old fields", () => {
  const old = { ...GOOD, audience: "owner", label: "看提醒" } as unknown as WordContract;
  assert.ok(lintWord(old).some((issue) => issue.rule === "label"));
});
