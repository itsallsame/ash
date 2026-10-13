import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { checkCapabilitySpec } from "../../sdk/src/link";
import { WordError } from "../../sdk/src/message";
import { BROWSER_ACTIONS, isExtensionName, standardAction } from "../../sdk/src/namespaces";
import { KimiBridge, KimiBrowser, pageFromSnapshot } from "../src/kimi";

const dir = () => mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-kimi-"));
const refused = (code: string) => (error: unknown) => error instanceof WordError && error.code === code;

/**
 * An extension that answers like the installed one is believed to: tab ids from `navigate`, snapshot trees whose nodes
 * carry `@eN` references, evaluate results as `{value}`. (The real snapshot layout is not verified, see kimi.ts.)
 */
async function extension(t: { after(fn: () => unknown): void }) {
  const bridge = new KimiBridge();
  await bridge.start([0]);
  t.after(() => bridge.close());
  const changes: boolean[] = [];
  bridge.onChange(() => changes.push(bridge.online));
  const socket = new WebSocket(bridge.url, { origin: "chrome-extension://" + "a".repeat(32) });
  t.after(() => socket.terminate());
  await once(socket, "open");
  const calls: { name: string; args: any }[] = [];
  let tab = 100;
  const pages = new Map<number, string>();
  socket.on("message", (bytes) => {
    const f = JSON.parse(bytes.toString());
    if (f.type !== "tool_call") return;
    const { name, args } = f.payload;
    calls.push({ name, args });
    let data: unknown = { success: true };
    if (name === "navigate") { const id = args._tabId ?? ++tab; pages.set(id, args.url); data = { tabId: id }; }
    else if (name === "snapshot") data = { tree: [{ tag: "heading", name: "Welcome" }, { tag: "a", ref: "@e1", name: "Login", href: "/login" }, { tag: "input", type: "password", ref: "@e2", name: "Password" }, { tag: "input", type: "text", ref: "@e3", name: "Search" }] };
    else if (name === "evaluate") {
      if (String(args.code).includes("location.href")) data = { value: JSON.stringify({ url: pages.get(args._tabId) ?? "", title: "Example", y: 0, height: 800 }) };
      else if (args.code === "BIG") data = { value: "x".repeat(60_000) };
      else data = { value: 42 };
    } else if (name === "screenshot") data = { format: "png", data: Buffer.from("png-fixture").toString("base64") };
    socket.send(JSON.stringify({ type: "tool_result", responseToRequestId: f.requestId, payload: { data } }));
  });
  socket.send(JSON.stringify({ type: "hello", payload: { extensionVersion: "fixture" } }));
  await once(socket, "message");
  return { bridge, socket, calls, changes };
}

test("the manifest has the standard browser actions and the two extensions only while the extension is connected", async (t) => {
  const bridge = new KimiBridge();
  await bridge.start([0]);
  t.after(() => bridge.close());
  const browser = new KimiBrowser(bridge, await dir());
  assert.deepEqual(browser.capabilities(), []);
  const { bridge: live, changes } = await extension(t);
  const online = new KimiBrowser(live, await dir()).capabilities();
  assert.deepEqual(changes, [true]);
  assert.equal(online.length, BROWSER_ACTIONS.length + 2);
  for (const capability of online) {
    assert.equal(checkCapabilitySpec(capability), null, capability.name);
    const standard = standardAction(capability.name);
    if (standard) {
      assert.deepEqual([capability.input_schema, capability.result_schema, capability.effect], [standard.input_schema, standard.result_schema, standard.effect], capability.name);
      // a hand may raise the risk, never lower it
      assert.ok(capability.risk === standard.risk || capability.risk === "structure", capability.name);
    } else assert.ok(isExtensionName(capability.name), capability.name);
  }
  const risk = (name: string) => online.find((c) => c.name === name)!.risk;
  assert.deepEqual(["browser.click", "browser.type", "browser.evaluate", "browser.read", "browser.open"].map(risk), ["structure", "structure", "structure", "none", "none"]);
  assert.deepEqual(online.filter((c) => c.name.startsWith("x.")).map((c) => c.name), ["x.kimi.browser.upload", "x.kimi.browser.network"]);
});

test("open and read return the standard page; each caller's space is its own tab; the extension is never told another's tab", async (t) => {
  const { bridge, calls } = await extension(t);
  const browser = new KimiBrowser(bridge, await dir());
  const opened = await browser.call("browser.open", { url: "https://example.com/a", space: "work" }, "agent:a");
  assert.ok(opened.ok);
  const page = opened.data as any;
  assert.deepEqual([page.space, page.url, page.title], ["work", "https://example.com/a", "Example"]);
  assert.deepEqual(page.elements.map((e: any) => [e.ref, e.tag, e.text]), [[1, "a", "Login"], [2, "input", "Password"], [3, "input", "Search"]]);
  assert.equal(page.elements[0].href, "/login");
  assert.match(page.text, /Welcome/);
  await assert.rejects(browser.call("browser.read", { space: "work" }, "agent:b"), refused("not_found"));
  await browser.call("browser.open", { url: "https://example.com/b", space: "work" }, "agent:b");
  const navigations = calls.filter((c) => c.name === "navigate");
  assert.deepEqual(navigations.map((c) => [c.args.newTab, c.args._tabId]), [[true, undefined], [true, undefined]]);
  await browser.call("browser.read", { space: "work" }, "agent:a");
  const snapshots = calls.filter((c) => c.name === "snapshot").map((c) => c.args._tabId);
  assert.deepEqual(snapshots.slice(-1), [101]);
  await assert.rejects(browser.call("browser.open", { url: "file:///etc/passwd" }, "agent:a"), refused("bad_request"));
  await assert.rejects(browser.call("browser.read", { space: "Bad Space" }, "agent:a"), refused("bad_request"));
});

test("click and type are checked against the last page of that space: the control, the site and its name", async (t) => {
  const { bridge, calls } = await extension(t);
  const browser = new KimiBrowser(bridge, await dir());
  await browser.call("browser.open", { url: "https://www.example.com/", space: "main" }, "agent:a");
  const click = (over: Record<string, unknown>) => browser.call("browser.click", { ref: 1, site: "example.com", label: "Login", ...over }, "agent:a");
  await assert.rejects(click({ ref: 9 }), refused("conflict"));
  await assert.rejects(click({ site: "evil.com" }), refused("conflict"));
  await assert.rejects(click({ label: "Delete everything" }), refused("conflict"));
  assert.equal(calls.filter((c) => c.name === "click").length, 0, "a refused click never reaches the browser");
  const clicked = await click({});
  assert.ok(clicked.ok);
  assert.deepEqual(calls.find((c) => c.name === "click")!.args, { selector: "@e1", _tabId: 101 });
  // the click's answer is the page afterwards: its numbers are the ones that count now
  assert.deepEqual(calls.filter((c) => c.name === "snapshot").length, 2);
  await assert.rejects(browser.call("browser.type", { ref: 2, site: "example.com", label: "Password", text: "hunter2" }, "agent:a"), refused("forbidden"));
  await browser.call("browser.type", { ref: 3, site: "example.com", label: "Search", text: "ash", submit: true }, "agent:a");
  const fill = calls.find((c) => c.name === "fill")!;
  assert.deepEqual(fill.args, { selector: "@e3", value: "ash", _tabId: 101 });
  assert.ok(calls.some((c) => c.name === "evaluate" && String(c.args.code).includes("requestSubmit")));
  // another space's snapshot takes the numbers away from this one
  await browser.call("browser.open", { url: "https://example.com/other", space: "other" }, "agent:a");
  await assert.rejects(browser.call("browser.click", { ref: 1, site: "example.com", label: "Login", space: "main" }, "agent:a"), refused("conflict"));
});

test("scroll, back, evaluate, screenshot, spaces and close", async (t) => {
  const { bridge, calls } = await extension(t);
  const state = await dir();
  const browser = new KimiBrowser(bridge, state);
  await browser.call("browser.open", { url: "https://example.com/" }, "agent:a");
  const scrolled = await browser.call("browser.scroll", { direction: "up" }, "agent:a");
  assert.ok(scrolled.ok);
  assert.match(calls.filter((c) => c.name === "evaluate").find((c) => String(c.args.code).includes("scrollBy"))!.args.code, /scrollBy\(0, -/);
  assert.ok((scrolled.data as any).scroll);
  await browser.call("browser.back", {}, "agent:a");
  assert.ok(calls.some((c) => c.name === "evaluate" && c.args.code === "history.back()"));

  const value = await browser.call("browser.evaluate", { code: "1+1" }, "agent:a");
  assert.deepEqual(value.ok && value.data, { space: "main", value: 42 });
  const big = await browser.call("browser.evaluate", { code: "BIG" }, "agent:a");
  assert.ok(big.ok && (big.data as any).truncated === true);

  const shot = await browser.call("browser.screenshot", {}, "agent:a");
  assert.ok(shot.ok);
  assert.equal(await readFile((shot.data as any).path, "utf8"), "png-fixture");
  assert.deepEqual(shot.content.find((c) => c.type === "image"), { type: "image", mime: "image/png", b64: Buffer.from("png-fixture").toString("base64") });
  assert.deepEqual([(shot.data as any).space, (shot.data as any).url, (shot.data as any).mime], ["main", "https://example.com/", "image/png"]);

  await browser.call("browser.open", { url: "https://example.com/2", space: "two" }, "agent:a");
  const listed = await browser.call("browser.spaces", {}, "agent:a");
  assert.deepEqual((listed.ok && (listed.data as any).spaces).map((s: any) => s.space), ["two", "main"], "most recent first");
  assert.deepEqual((await browser.call("browser.spaces", {}, "agent:b")).ok && ((await browser.call("browser.spaces", {}, "agent:b")) as any).data.spaces, [], "a caller sees only its own");
  assert.deepEqual((await browser.call("browser.close", { space: "two" }, "agent:a") as any).data, { closed: ["two"] });
  assert.deepEqual((await browser.call("browser.close", { space: "*" }, "agent:a") as any).data, { closed: ["main"] });
  await assert.rejects(browser.call("browser.read", {}, "agent:a"), refused("not_found"));
});

test("a caller keeps at most four spaces: the one used longest ago is forgotten", async (t) => {
  const { bridge } = await extension(t);
  let now = 1000;
  const browser = new KimiBrowser(bridge, await dir(), () => ++now);
  for (const space of ["s1", "s2", "s3", "s4", "s5"]) await browser.call("browser.open", { url: `https://example.com/${space}`, space }, "agent:a");
  const list = ((await browser.call("browser.spaces", {}, "agent:a")) as any).data.spaces.map((s: any) => s.space);
  assert.deepEqual(list.sort(), ["s2", "s3", "s4", "s5"]);
});

test("the extension's own commands go through x.kimi.browser.*, scoped to the caller's tab", async (t) => {
  const { bridge, calls } = await extension(t);
  const browser = new KimiBrowser(bridge, await dir());
  await assert.rejects(browser.call("x.kimi.browser.network", { args: { cmd: "list" } }, "agent:a"), refused("not_found"));
  await browser.call("browser.open", { url: "https://example.com/" }, "agent:a");
  await browser.call("x.kimi.browser.network", { args: { cmd: "list", _tabId: 999, newTab: true } }, "agent:a");
  assert.deepEqual(calls.find((c) => c.name === "network")!.args, { cmd: "list", _tabId: 101 });
});

test("an unreachable extension is unavailable; a result that never came is result_unknown", async (t) => {
  const { bridge, socket, changes } = await extension(t);
  const browser = new KimiBrowser(bridge, await dir());
  const pending = browser.call("browser.open", { url: "https://example.com/" }, "agent:a");
  socket.removeAllListeners("message");
  socket.terminate();
  await assert.rejects(pending, refused("result_unknown"));
  await assert.rejects(browser.call("browser.open", { url: "https://example.com/" }, "agent:a"), refused("unavailable"));
  assert.deepEqual(changes, [true, false]);
});

test("a snapshot in text lines is read the same way, and what cannot be read leaves only text", () => {
  const page = pageFromSnapshot("main", { tree: '- heading "Hi"\n- button "Buy" [ref=e7]\n- link "More" @e8\nplain text' }, { url: "https://x.test/", title: "T" });
  assert.deepEqual(page.elements.map((e) => [e.ref, e.tag, e.text]), [[7, "button", "Buy"], [8, "link", "More"]]);
  assert.match(page.text, /plain text/);
  assert.deepEqual(pageFromSnapshot("main", { odd: true }, { url: "", title: "" }).elements, []);
});
