import assert from "node:assert/strict";
import test from "node:test";
import { IdentityName, nameFromIdentity } from "../js/identity-name.js";
import { startKernel } from "./kernel.js";
import { netFor, tick, until } from "./support.js";

const identity = (content) => ({ files: [{ file: "IDENTITY.md", content, version: "v1" }] });
const online = async () => {
  const kernel = startKernel();
  const handle = netFor(kernel);
  handle.net.start();
  await until(() => handle.net.status === "online", 2000, "online");
  return { kernel, ...handle, stop: () => { handle.net.stop(); kernel.close(); } };
};

test("identity name parser keeps only one short visible field", () => {
  assert.equal(nameFromIdentity("# 我的名片\n- 名字：ash（初次见面时可以换成你喜欢的名字）\n- 签名表情：🌿\n"), "ash");
  assert.equal(nameFromIdentity("- 名字：小舟\n"), "小舟");
  assert.equal(nameFromIdentity("- Name: River\n"), "River");
  assert.equal(nameFromIdentity("- 名字：小舟（副本）\n"), "小舟（副本）");
  assert.equal(nameFromIdentity("- Name: Ash (Beta)\n"), "Ash (Beta)");
  assert.equal(nameFromIdentity("- 名字：\n"), null);
  assert.equal(nameFromIdentity("- 名字：一\n- Name: Two\n"), null);
  assert.equal(nameFromIdentity(`- 名字：${"x".repeat(33)}`), null);
  assert.equal(nameFromIdentity(`- 名字：小舟\n${".".repeat(65_537)}`), null);
  assert.equal(nameFromIdentity("- 名字：<script>"), null);
  assert.equal(nameFromIdentity("plain prose"), null);
});

test("the page reads the name from IDENTITY.md through the persona member, and again only when asked", async () => {
  const { kernel, net, stop } = await online();
  try {
    let content = "- 名字：小舟\n";
    kernel.on("service:persona", "get", () => identity(content));
    const visible = [];
    const name = new IdentityName(net, (value) => visible.push(value));
    await name.refresh();
    assert.equal(visible.at(-1), "小舟");
    const reads = kernel.requests.filter((r) => r.to === "service:persona");
    assert.deepEqual(reads.map((r) => [r.word, r.body]), [["get", { file: "IDENTITY.md" }]]);
    content = "- Name: River\n";
    assert.equal(visible.at(-1), "小舟", "nothing changes until refresh is called");
    await name.refresh();
    assert.equal(visible.at(-1), "River");
    assert.equal(kernel.requests.filter((r) => r.to === "service:persona").length, 2);
  } finally { stop(); }
});

test("a refresh on the same connection keeps the name shown until the new one is read, then fails closed", async () => {
  const { kernel, net, stop } = await online();
  try {
    let release = null;
    let answer = identity("- 名字：小舟\n");
    kernel.on("service:persona", "get", () => release ? new Promise((resolve) => { release = () => resolve(answer); }) : answer);
    const visible = [];
    const name = new IdentityName(net, (value) => visible.push(value));
    await name.refresh();
    assert.equal(visible.at(-1), "小舟");
    release = () => {};
    answer = identity("- 名字：小舟（副本）\n");
    const pending = name.refresh();
    await until(() => kernel.requests.filter((r) => r.to === "service:persona").length === 2);
    assert.equal(visible.at(-1), "小舟", "the previous verified name stays while reading");
    release();
    await pending;
    assert.equal(visible.at(-1), "小舟（副本）");
    release = null;
    kernel.on("service:persona", "get", { ok: false, error: { code: "internal", message: "down" } });
    await name.refresh();
    assert.equal(visible.at(-1), "Ash");
  } finally { stop(); }
});

test("the newer read wins over an older answer that arrives late", async () => {
  const { kernel, net, stop } = await online();
  try {
    let calls = 0;
    kernel.on("service:persona", "get", async () => {
      const mine = ++calls;
      if (mine === 1) await new Promise((resolve) => setTimeout(resolve, 60));
      return identity(mine === 1 ? "- 名字：旧名字\n" : "- 名字：新名字\n");
    });
    const visible = [];
    const name = new IdentityName(net, (value) => visible.push(value));
    const old = name.refresh();
    await until(() => calls === 1);
    await name.refresh();
    assert.equal(visible.at(-1), "新名字");
    await old;
    assert.equal(visible.at(-1), "新名字");
  } finally { stop(); }
});

test("a reset, a lost connection, a missing or malformed identity never keep the old name", async () => {
  const { kernel, net, stop } = await online();
  try {
    let release;
    kernel.on("service:persona", "get", () => new Promise((resolve) => { release = () => resolve(identity("- 名字：旧账户\n")); }));
    const visible = [];
    const name = new IdentityName(net, (value) => visible.push(value));
    const pending = name.refresh();
    await until(() => release);
    name.reset();
    release();
    await pending;
    assert.equal(visible.at(-1), "Ash", "an answer after reset is not shown");

    kernel.on("service:persona", "get", identity("- 名字：小舟\n"));
    await name.refresh();
    assert.equal(visible.at(-1), "小舟");
    kernel.on("service:persona", "get", identity("- 名字：\n"));
    await name.refresh();
    assert.equal(visible.at(-1), "Ash");
    kernel.on("service:persona", "get", { files: [] });
    await name.refresh();
    assert.equal(visible.at(-1), "Ash");

    kernel.on("service:persona", "get", identity("- 名字：小舟\n"));
    await name.refresh();
    assert.equal(visible.at(-1), "小舟");
    kernel.on("service:persona", "get", async () => { await tick(40); return identity("- 名字：别的连接\n"); });
    const lost = name.refresh();
    kernel.drop();
    await lost;
    assert.equal(visible.at(-1), "小舟", "the late answer of the old connection is not shown (the app resets on the state change)");
    await name.refresh();
    kernel.on("service:persona", "get", { files: [] });
    await name.refresh();
    assert.equal(visible.at(-1), "Ash", "a refresh on another connection starts from the default name");
  } finally { stop(); }
});

test("without a connection nothing is asked", async () => {
  const kernel = startKernel();
  const { net } = netFor(kernel);
  const visible = [];
  const name = new IdentityName(net, (value) => visible.push(value));
  await name.refresh();
  assert.deepEqual(visible, ["Ash", "Ash"]);
  assert.equal(kernel.requests.length, 0);
  kernel.close();
});

test("every reader of the name on one connection hears a name any of them read, and a reader on another connection does not", async () => {
  const { kernel, net, stop } = await online();
  const other = await online();
  try {
    let content = "- 名字：小舟\n";
    kernel.on("service:persona", "get", () => identity(content));
    const bar = [];
    const home = [];
    const elsewhere = [];
    const barName = new IdentityName(net, (value) => bar.push(value));
    const homeName = new IdentityName(net, (value) => home.push(value));
    new IdentityName(other.net, (value) => elsewhere.push(value));
    await barName.refresh();
    assert.equal(home.at(-1), "小舟", "the second reader follows the first without asking");
    content = "- 名字：River\n";
    await homeName.refresh();
    assert.equal(bar.at(-1), "River", "renamed on one page, the other follows at once");
    assert.equal(elsewhere.at(-1), "Ash", "another connection's reader is not told");
  } finally { stop(); other.stop(); }
});

test("a subscriber hears each name the reader shows until it unsubscribes", async () => {
  const { kernel, net, stop } = await online();
  try {
    let content = "- 名字：小舟\n";
    kernel.on("service:persona", "get", () => identity(content));
    const name = new IdentityName(net, () => {});
    const heard = [];
    const off = name.subscribe((value) => heard.push(value));
    await name.refresh();
    content = "- 名字：River\n";
    await name.refresh();
    off();
    content = "- 名字：Mira\n";
    await name.refresh();
    assert.equal(heard.at(-1), "River");
    assert.ok(heard.includes("小舟"));
    assert.equal(heard.includes("Mira"), false);
  } finally { stop(); }
});
