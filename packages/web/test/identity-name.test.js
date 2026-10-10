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
