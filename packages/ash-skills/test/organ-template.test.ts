import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkManifest } from "../../core/src/edges/apps/check";

/** The sensor-organ skill's template is a real app: its manifest passes the app checks, and its rule wakes the primary agent. */
const template = join(dirname(fileURLToPath(import.meta.url)), "../skills/sensor-organ/template");

test("the template's app.json passes the app checks and asks only for what the template uses", () => {
  const checked = checkManifest(readFileSync(join(template, "app.json"), "utf8"), "my-sense-rule");
  assert.deepEqual(checked.problems, []);
  assert.deepEqual(checked.manifest?.listens, ["sense.geofence", "sense.notification"]);
  assert.deepEqual(checked.manifest?.needs?.map((need) => "member" in need ? `${need.member}/${need.words.join(",")}` : "?"), ["agent:*/wake", "service:agents/list", "service:llm/complete"]);
});

test("the template's server speaks MCP, takes ash.on_event at once and wakes the primary agent on the back lane", async () => {
  const calls: { member: string; word: string; body: Record<string, unknown> }[] = [];
  const hub = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const { params } = JSON.parse(raw) as { params: { name: string; arguments: { member: string; word: string; body: Record<string, unknown> } } };
    calls.push(params.arguments);
    const result = params.arguments.word === "list" ? { ok: true, result: { agents: [{ id: "agent:main", primary: true }, { id: "agent:other" }] } } : { ok: true, result: {} };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: result } }));
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [join(template, "server.mjs")], { stdio: ["pipe", "pipe", "inherit"],
    env: { PATH: process.env.PATH ?? "", ASH_MCP_URL: `http://127.0.0.1:${(hub.address() as AddressInfo).port}/mcp`, ASH_MCP_TOKEN: "t" } });
  const replies = new Map<number, (message: { result?: { tools?: { name: string }[] } }) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => { const message = JSON.parse(line); replies.get(message.id)?.(message); });
  const ask = (id: number, method: string, params?: unknown) => new Promise<{ result?: { tools?: { name: string }[] } }>((resolve) => {
    replies.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await ask(1, "initialize", { protocolVersion: "2025-03-26" });
    const listed = await ask(2, "tools/list");
    assert.deepEqual(listed.result?.tools?.map((tool) => tool.name), ["recent", "ash.on_event"]);
    await ask(3, "tools/call", { name: "ash.on_event", arguments: { word: "sense.geofence", body: { name: "家", transition: "exit", ts: 1 } } });
    await ask(4, "tools/call", { name: "ash.on_event", arguments: { word: "sense.geofence", body: { name: "家", transition: "enter", ts: 2 } } });
    for (let i = 0; i < 100 && !calls.some((call) => call.word === "wake"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls.map((call) => `${call.member}/${call.word}`), ["service:agents/list", "agent:main/wake"], "leaving does nothing; arriving wakes the primary");
    assert.deepEqual(calls[1]!.body, { lane: "back", reason: "arrived_家", context: { place: "家", at: 2 } });
  } finally { child.kill(); await new Promise<void>((resolve) => { hub.close(() => resolve()); hub.closeAllConnections(); }); }
});
