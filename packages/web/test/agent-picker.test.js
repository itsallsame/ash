import assert from "node:assert/strict";
import test from "node:test";
import { agentPicker } from "../js/agent-picker.js";
import { startKernel } from "./kernel.js";
import { netFor, until } from "./support.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.value = ""; this.placeholder = "跟 Ash 说点什么…"; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  before(child) { this.before_ = child; }
  replaceChildren(...children) { this.children = children; this.text = ""; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text ?? "") + this.children.map((child) => child.textContent).join(""); }
  focus() {}
}

const setup = async (agents) => {
  const kernel = startKernel();
  kernel.on("service:agents", "list", { agents });
  const { net } = netFor(kernel);
  net.start();
  const primary = agents.find((agent) => agent.primary)?.id;
  await until(() => net.status === "online" && net.primary === primary, 2000, "online with the primary agent known");
  globalThis.document = { createElement: (tag) => new Element(tag) };
  const form = new Element("form");
  const input = new Element("input");
  return { kernel, net, form, input, stop: () => { delete globalThis.document; net.stop(); kernel.close(); } };
};

test("the recipient is the hub's primary agent until the owner picks another", async () => {
  const agents = [{ id: "agent:ash", name: "小舟", summary: "", state: "idle", primary: true }, { id: "agent:other", name: "帮手", summary: "查资料", state: "idle" }];
  const t = await setup(agents);
  try {
    let redraws = 0;
    const picker = agentPicker(t.form, t.input, t.net, () => { redraws++; });
    assert.equal(picker.target(), "agent:ash");
    await picker.refresh();
    assert.equal(redraws, 1);
    assert.equal(picker.name("agent:ash"), "小舟");
    assert.equal(picker.name("agent:gone"), "gone");
    const control = t.form.children[0];
    assert.equal(control.textContent, "@ 小舟");
    await control.onclick();
    await until(() => t.form.before_.children.length === 2);
    const panel = t.form.before_;
    assert.match(panel.textContent, /帮手 · 查资料/);
    panel.children[1].onclick();
    assert.equal(picker.target(), "agent:other");
    assert.equal(control.textContent, "@ 帮手");
    assert.equal(t.input.placeholder, "跟 帮手 说点什么…");
    assert.equal(panel.hidden, true);
    assert.ok(t.kernel.requests.some((request) => request.to === "service:agents" && request.word === "list"));
  } finally { t.stop(); }
});

test("a picked agent that is gone from the list falls back to the primary agent; unavailable agents cannot be picked", async () => {
  const agents = [{ id: "agent:ash", name: "小舟", summary: "", state: "idle", primary: true }, { id: "agent:other", name: "帮手", summary: "", state: "stopped", available: false, reachable: false }, { id: "agent:slow", name: "慢热", summary: "", state: "starting", available: false, reachable: true }];
  const t = await setup(agents);
  try {
    const picker = agentPicker(t.form, t.input, t.net);
    const control = t.form.children[0];
    await control.onclick();
    await until(() => t.form.before_.children.length === 3);
    assert.equal(t.form.before_.children[1].disabled, true, "a stopped agent is shown but not selectable");
    assert.equal(t.form.before_.children[2].disabled, false, "one that is starting takes messages (they wait in its inbox): selectable");
    assert.match(t.form.before_.children[2].textContent, /启动中/);
    t.kernel.on("service:agents", "list", { agents: [agents[0], { id: "agent:third", name: "第三", summary: "", state: "idle" }] });
    t.form.before_.children[0].onclick();
    assert.equal(picker.target(), "agent:ash");
    // Pick the third, then have it disappear.
    await control.onclick();
    await until(() => t.form.before_.children.length === 2);
    t.form.before_.children[1].onclick();
    assert.equal(picker.target(), "agent:third");
    t.kernel.on("service:agents", "list", { agents: [agents[0]] });
    await picker.refresh();
    assert.equal(picker.target(), t.net.primary);
    assert.equal(control.textContent, "@ 小舟");
    assert.equal(t.input.placeholder, "跟 Ash 说点什么…");
  } finally { t.stop(); }
});

test("a list that cannot be read says so and keeps the recipient", async () => {
  const t = await setup([{ id: "agent:main", name: "Ash", summary: "", state: "idle", primary: true }]);
  try {
    const picker = agentPicker(t.form, t.input, t.net);
    t.kernel.on("service:agents", "list", { ok: false, error: { code: "unavailable", message: "down" } });
    await t.form.children[0].onclick();
    await until(() => /暂时无法读取名单/.test(t.form.before_.textContent));
    assert.equal(picker.target(), "agent:main");
    await picker.refresh();
    assert.equal(picker.target(), "agent:main");
  } finally { t.stop(); }
});

test("a picker made on the first connection waits for the primary agent and then names it, not '…'", async () => {
  const kernel = startKernel();
  kernel.on("service:agents", "list", { agents: [{ id: "agent:ash", name: "小舟", summary: "", state: "idle", primary: true }] });
  const { net } = netFor(kernel);
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const form = new Element("form");
    const picker = agentPicker(form, new Element("input"), net);
    assert.match(form.children[0].text, /…/, "nothing is known yet");
    net.start();
    await until(() => net.status === "online", 2000, "online");
    await picker.refresh();
    assert.equal(form.children[0].text, "@ 小舟");
  } finally { delete globalThis.document; net.stop(); kernel.close(); }
});
