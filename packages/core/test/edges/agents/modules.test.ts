import assert from "node:assert/strict";
import test from "node:test";
import { ENV_GRACE_MS } from "../../../src/edges/agents/modules";
import { caller, dummy, fixture, settle, waitFor, type FakeDriver, type FakeRegistry } from "./helpers";

const M = "agent:main";
const sends = (d: FakeDriver, key?: string) => d.of("send").filter((c) => !key || c[2] === key);
const injects = (d: FakeDriver, key = "front") => d.of("inject").filter((c) => c[2] === key).map((c) => ((c[3] as any).modules as { id: string; content: string }[]).map((m) => m.id));
const decl = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.slice(6), summary: "a helper agent", brief: "help", ...extra });
const turn = async (f: ReturnType<typeof fixture>, text: string, key = "front") => {
  const before = sends(f.driver(), key).length;
  await f.call(M, key === "front" ? "say" : "wake", key === "front" ? { text } : { reason: text }, key === "front" ? undefined : caller("service:pulse", "service"));
  await waitFor(() => sends(f.driver(), key).length === before + 1);
  f.driver().finish(M, key);
  await settle();
};

test("static modules go in the first lines at start; the dynamic ones are injected before the first turn of each lane", async () => {
  const f = fixture({ files: { "USER.md": "owner likes tea", "MEMORY.md": "met on monday", "PULSE.md": "check the day" }, persona: [{ file: "SOUL.md", content: "soul" }, { file: "IDENTITY.md", content: "identity" }] });
  f.skills.push({ path: "skills/tea/SKILL.md", text: "name: tea" }, { path: "skills/tea/SKILL.md", text: "description: brew tea" });
  await f.start();
  const d = f.driver();
  const statics = (d.of("start")[0]![2] as any).modules.static;
  assert.match(statics[0].content, /## SOUL\.md\nsoul\n\n## IDENTITY\.md\nidentity/);
  assert.equal(injects(d).length, 0); // nothing before a turn
  await turn(f, "hi");
  assert.deepEqual(injects(d), [["user", "skills", "environment"]]);
  const sent = (d.of("inject")[0]![3] as any).modules;
  assert.match(sent[0].content, /^\[Ash user · v [0-9a-f]{6}\]\n## USER\.md\nowner likes tea\n\n## MEMORY\.md\nmet on monday$/);
  assert.match(sent[1].content, /- tea: brew tea \(skills\/tea\/SKILL\.md\)/);
  await turn(f, "go", "back"); // the back lane has its own session: all of it, and its guide
  assert.deepEqual(injects(d, "back"), [["user", "skills", "environment", "lane"]]);
  assert.match(((d.of("inject").at(-1)![3] as any).modules.at(-1)).content, /## Lane back\ncheck the day/);
  // the inject happens before the send
  const order = d.calls.map((c) => c[0]).filter((n) => n === "inject" || n === "send");
  assert.deepEqual(order.slice(0, 2), ["inject", "send"]);
});

test("a module is injected again only when its content changed (MEMORY.md here), and after a new session", async () => {
  const f = fixture({ files: { "MEMORY.md": "one" } });
  await f.start();
  const d = f.driver();
  await turn(f, "a");
  await turn(f, "b");
  assert.equal(injects(d).length, 1); // second turn: nothing changed
  f.files["MEMORY.md"] = "one\ntwo";
  await turn(f, "c");
  assert.deepEqual(injects(d), [["user", "environment"], ["user"]]);
  assert.match((d.of("inject").at(-1)![3] as any).modules[0].content, /one\ntwo/);
  await f.service("session.new", { agent: M, key: "front" });
  await turn(f, "d");
  assert.deepEqual(injects(d).at(-1), ["user", "environment"]); // the new session has seen none of it
  // refreshModules puts a change in now, between turns
  f.files["MEMORY.md"] = "three";
  await f.agents.refreshModules(M, "front");
  assert.deepEqual(injects(d).at(-1), ["user"]);
  await f.agents.refreshModules(M, "front");
  assert.equal(injects(d).length, 4); // unchanged: nothing more
});

test("everything is put in again every twenty turns even if unchanged", async () => {
  const f = fixture({ files: { "MEMORY.md": "one" } });
  await f.start();
  const d = f.driver();
  for (let i = 0; i < 21; i++) await turn(f, `t${i}`);
  assert.equal(injects(d).length, 2);
  assert.deepEqual(injects(d)[1], ["user", "environment"]);
});

test("an agent that does not load user never sees MEMORY.md; modules not listed are not built", async () => {
  const f = fixture({ files: { "USER.md": "private", "MEMORY.md": "private too" } });
  await f.start();
  await f.service("declare", decl("agent:outside", { modules: ["identity", "rules", "environment"] }));
  const d = f.driver();
  await f.call("agent:outside", "say", { text: "hello from a group" });
  await waitFor(() => sends(d, "front").some((c) => c[1] === "agent:outside"));
  const all = JSON.stringify(d.of("inject").filter((c) => c[1] === "agent:outside"));
  assert.ok(!all.includes("private"));
  assert.deepEqual(d.of("inject").filter((c) => c[1] === "agent:outside").map((c) => (c[3] as any).modules.map((m: any) => m.id)), [["environment"]]);
  assert.ok(!JSON.stringify(d.of("start").filter((c) => c[1] === "agent:outside")).includes("private"));
  // and identity stays out of an agent that does not list it
  await f.service("declare", decl("agent:blank", { modules: ["environment"] }));
  assert.deepEqual((d.of("start").find((c) => c[1] === "agent:blank")![2] as any).modules.static, []);
});

test("environment: coarse facts about who is here, in the agent's own view; the hash changes only when the facts do", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  f.registry.add(dummy("device:Kq3LabcdefghijklmnopqR", "MacBook Pro", ["browser.open", "shell.run"]));
  f.registry.add(dummy("app:todo", "todo"));
  await turn(f, "a");
  const envOf = (n: number) => d.of("inject").filter((c) => c[2] === "front").map((c) => (c[3] as any).modules.find((m: any) => m.id === "environment")).filter(Boolean)[n];
  const first = envOf(0);
  assert.match(first.content, /^\[Ash environment · v [0-9a-f]{6}\]\n你：agent:main（primary） · 这一路：front · 委托深度 0\/3 · 可以派子 agent/m);
  assert.match(first.content, /手：device:Kq3LabcdefghijklmnopqR MacBook Pro · browser、shell/);
  assert.match(first.content, /器官：app:todo/);
  assert.ok(!/电量|battery/.test(first.content));
  await turn(f, "b");
  assert.equal(injects(d).length, 1, "no change, no injection");
  // a hand drops and comes back inside a minute: not a change
  f.registry.remove("device:Kq3LabcdefghijklmnopqR");
  f.clock.t += 30_000;
  f.registry.add(dummy("device:Kq3LabcdefghijklmnopqR", "MacBook Pro", ["browser.open", "shell.run"]));
  await turn(f, "c");
  assert.equal(injects(d).length, 1);
  // gone for less than a minute and asked again: still counted as here
  f.registry.remove("device:Kq3LabcdefghijklmnopqR");
  f.clock.t += ENV_GRACE_MS - 1000;
  await turn(f, "d");
  assert.equal(injects(d).length, 1);
  // gone for a minute: that is a change
  f.clock.t += 2000;
  await turn(f, "e");
  assert.deepEqual(injects(d).at(-1), ["environment"]);
  assert.ok(!envOf(1).content.includes("MacBook"));
  assert.notEqual(envOf(1).version, first.version);
  // a new member: a change
  f.registry.add(dummy("device:Zzzzzzzzzzzzzzzzzzzzzz", "Phone", ["screen.tap"]));
  await turn(f, "f");
  assert.equal(injects(d).length, 3);
});

test("environment is filtered by what the agent may reach: a restricted agent does not see hands, bodies or apps it has no words for", async () => {
  const f = fixture();
  await f.start();
  f.registry.add(dummy("device:Kq3LabcdefghijklmnopqR", "MacBook Pro", ["browser.open"]));
  f.registry.add(dummy("app:todo", "todo", ["todo.add"]));
  f.registry.add(dummy("body:main", "main body", ["workspace.read"]));
  await f.service("declare", decl("agent:narrow", { words: ["app:todo/*", "service:agents/ask"] }));
  const d = f.driver();
  await f.call("agent:narrow", "say", { text: "hi" });
  await waitFor(() => sends(d, "front").some((c) => c[1] === "agent:narrow"));
  const env = (d.of("inject").find((c) => c[1] === "agent:narrow")![3] as any).modules.find((m: any) => m.id === "environment").content as string;
  assert.match(env, /器官：app:todo/);
  assert.ok(!/MacBook|device:|身体|body:main/.test(env));
  assert.match(env, /你：agent:narrow · 这一路：front · 委托深度 0\/3/);
  assert.ok(!/其他 agent/.test(env)); // agent:main is not reachable by its words
  // and it cannot spawn without the word
  assert.match(env, /不能派子 agent/);
});

test("the delegation depth and the lane show in the environment of a deeper agent", async () => {
  const f = fixture();
  await f.start();
  await f.service("declare", decl("agent:a1"));
  await f.service("declare", decl("agent:a2"), caller("agent:a1"));
  await f.service("declare", decl("agent:a3"), caller("agent:a2"));
  await f.service("declare", decl("agent:a4"), caller("agent:a3"));
  const d = f.driver();
  await f.call("agent:a4", "say", { text: "hi" });
  await waitFor(() => sends(d, "front").some((c) => c[1] === "agent:a4"));
  const env = (d.of("inject").find((c) => c[1] === "agent:a4")![3] as any).modules.find((m: any) => m.id === "environment").content as string;
  assert.match(env, /委托深度 3\/3 · 不能派子 agent/);
});

test("static modules do not move mid-session: a changed persona is not injected", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await turn(f, "a");
  f.persona.files[0]!.content = "a different soul";
  await turn(f, "b");
  assert.ok(!JSON.stringify(d.of("inject")).includes("different soul"));
  await f.service("session.reload", { agent: M, key: "front" });
  assert.match(JSON.stringify(d.of("session.reload")), /a different soul/);
});
