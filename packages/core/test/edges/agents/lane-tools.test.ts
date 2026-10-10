import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import type { Message } from "../../../../sdk/src/message";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAgents } from "../../../src/edges/agents";
import { createToolsEdge, TOOL_NAMES, toolWords } from "../../../src/edges/tools";
import { createGate, GateStore } from "../../../src/kernel/gate";
import { createRedact } from "../../../src/kernel/redact";
import { createRegistry } from "../../../src/kernel/registry";
import { createRouter } from "../../../src/kernel/router";
import { openLedger } from "../../kernel/ledger/helpers";
import { fakeOwner } from "../../kernel/router/world";
import { FakeDriver, MAIN_TEMPLATE, OWNER, settle, waitFor } from "./helpers";

// The hub's real router, registry, agents module and tool surface (over HTTP, with real MCP clients), and a driver the
// test plays by hand. Two lanes of one agent are in a turn at once; the tool tokens are the only thing that says which.

const M = "agent:main";
const closers: (() => Promise<void> | void)[] = [];
after(async () => { for (const close of closers.reverse()) await close(); });

async function hub() {
  const { ledger } = openLedger();
  const registry = createRegistry();
  const store = new GateStore(ledger, () => 1_000_000);
  const gate = createGate({ tier: () => "full", mode: () => store.mode(), review: async () => ({ verdict: "allow" }) }, store, { now: () => 1_000_000 });
  const late: { agents?: ReturnType<typeof createAgents> } = {};
  const router = createRouter({
    ledger, registry, gate, redact: createRedact(), store, now: Date.now, onParked: () => {}, onError: () => {},
    agentPolicy: (id) => late.agents?.policyOf(id) ?? null, toolWords,
    // The rule the hook is for: an agent speaks to the owner only in a turn of the lane that is talking with the owner.
    mayTalkToOwner: (who) => who.turn !== undefined && late.agents?.currentTurn(who.member, "front") === who.turn,
  });
  const tools = createToolsEdge({
    router, registry, ledger, agentPolicy: (id) => late.agents?.policyOf(id) ?? null, currentTurn: (id, lane) => late.agents?.currentTurn(id, lane) ?? null,
    fastPathMs: 500, maxWaitMs: 2000, settleMs: 40,
  });
  const server = createServer((req, res) => tools.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const issued: Record<string, Record<string, string>> = {};
  const drivers: FakeDriver[] = [];
  const agents = late.agents = createAgents({
    router, registry, ledger, vault: { use: () => null },
    drivers: { dsh: (report) => { const d = new FakeDriver(report); drivers.push(d); return d; } },
    templates: { read: (name) => (name === "main" ? MAIN_TEMPLATE : null) },
    tools: (agent, lanes, allowed) => ({ mcp_url: url, tokens: (issued[agent] = tools.issueTokens(agent, lanes)), allowed: allowed ?? [...TOOL_NAMES] }),
    rules: () => "rules",
  });
  const owner = fakeOwner();
  registry.add(owner);
  const clients: Client[] = [];
  const client = async (token: string) => {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  closers.push(async () => {
    await agents.stopAll();
    tools.close();
    for (const c of clients) await c.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  registry.add(agents.service);
  await agents.startAll();
  await settle();
  return { ledger, router, registry, agents, tools, owner, drivers, issued, client, url };
}

type Call = (c: Client, name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any; text: string }>;
const call: Call = async (c, name, args = {}) => {
  const res = (await c.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; structuredContent?: any; isError?: boolean };
  return { isError: Boolean(res.isError), data: res.structuredContent, text: (res.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n") };
};
const turnsOf = (ledger: ReturnType<typeof openLedger>["ledger"], from: string, word: string) =>
  (ledger.db().prepare(`SELECT turn FROM messages WHERE "from" = ? AND word = ? AND kind = 'request' ORDER BY seq`).all(from, word) as { turn: string | null }[]).map((r) => r.turn);

test("front and back in a turn at once: each lane's tool calls are recorded in its own turn, and the token is what says which", async () => {
  const h = await hub();
  const d = h.drivers[0]!;
  assert.deepEqual(Object.keys(h.issued[M]!), ["front", "back"], "one token per lane of the declaration");
  assert.notEqual(h.issued[M]!.front, h.issued[M]!.back);

  await h.router.send({ to: M, kind: "request", word: "say", body: { text: "hello" } }, OWNER);
  h.agents.manager.enqueue(M, { id: "w1", from: "service:clock", word: "wake", text: "Wake · pulse", attachments: [], at: Date.now() }, "back");
  await waitFor(() => d.running.size === 2, "both lanes in a turn");
  const front = d.running.get(`${M}/front`)!.turn, back = d.running.get(`${M}/back`)!.turn;
  assert.notEqual(front, back);
  assert.equal(h.agents.currentTurn(M, "front"), front);
  assert.equal(h.agents.currentTurn(M, "back"), back);

  const onFront = await h.client(h.issued[M]!.front!), onBack = await h.client(h.issued[M]!.back!);
  assert.equal((await call(onBack, "agent_list")).isError, false);
  assert.equal((await call(onFront, "agent_list")).isError, false);
  assert.equal((await call(onBack, "agent_list")).isError, false);
  // the ledger has each call with the turn of the lane whose token made it, whatever order the lanes spoke in
  assert.deepEqual(turnsOf(h.ledger, M, "list"), [back, front, back]);
});

test("a back-lane call cannot use the front lane's turn to speak to the owner, nor be a call at all while the back lane has no turn", async () => {
  const h = await hub();
  const d = h.drivers[0]!;
  await h.router.send({ to: M, kind: "request", word: "say", body: { text: "hello" } }, OWNER);
  await waitFor(() => d.running.has(`${M}/front`), "the front turn");
  const front = d.running.get(`${M}/front`)!.turn;
  const onFront = await h.client(h.issued[M]!.front!), onBack = await h.client(h.issued[M]!.back!);

  // front is in a turn, back is not: the back token gets no turn at all (it is not lent the front's)
  const idle = await call(onBack, "human_say", { text: "psst" });
  assert.equal(idle.isError, true);
  assert.equal(idle.data.error.code, "forbidden");
  assert.match(idle.data.error.message, /no turn is running/);
  assert.deepEqual(h.owner.said, [], "nothing reached the owner");

  // both lanes in a turn: back has a turn of its own, and that one may not speak to the owner
  h.agents.manager.enqueue(M, { id: "w1", from: "service:clock", word: "wake", text: "Wake · pulse", attachments: [], at: Date.now() }, "back");
  await waitFor(() => d.running.has(`${M}/back`), "the back turn");
  const back = d.running.get(`${M}/back`)!.turn;
  const refused = await call(onBack, "human_say", { text: "psst" });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.error.code, "forbidden");
  assert.match(refused.data.error.message, /addressed directly/);
  assert.deepEqual(h.owner.said, []);

  const said = await call(onFront, "human_say", { text: "hi there" });
  assert.equal(said.isError, false);
  const heard = h.owner.said as Message[];
  assert.deepEqual(heard.map((m) => [m.from, (m.body as any).text, m.turn]), [[M, "hi there", front]]);
  assert.notEqual(front, back);

  // when the front turn ends, the front token has no turn either
  d.finish(M, "front");
  await waitFor(() => h.agents.currentTurn(M, "front") === null);
  const after = await call(onFront, "human_say", { text: "late" });
  assert.equal(after.isError, true);
  assert.match(after.data.error.message, /no turn is running/);
  assert.equal(h.agents.currentTurn(M, "back"), back, "the back turn goes on");
});

test("tokens: a restart of the agent's process gives new ones for every lane and the old ones stop; the lane is only what the token was issued for", async () => {
  const h = await hub();
  const old = { ...h.issued[M]! };
  await h.agents.manager.restartAgent(M);
  await settle();
  const fresh = h.issued[M]!;
  assert.deepEqual(Object.keys(fresh), ["front", "back"]);
  for (const lane of ["front", "back"]) {
    assert.notEqual(fresh[lane], old[lane]);
    const res = await fetch(h.url, { method: "POST", headers: { authorization: `Bearer ${old[lane]}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(res.status, 401, `the old ${lane} token stopped`);
  }
  // nothing in the request can name a lane: only the token is read
  const res = await fetch(h.url, { method: "POST", headers: { authorization: `Bearer ${fresh.back}`, "x-ash-lane": "front", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_list", arguments: { lane: "front" }, _meta: { lane: "front" } } }) });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /no turn is running/, "a back token with a front header is still the back lane, which has no turn");
});

test("an answer to a message is accepted only from the lane's turn that took it", async () => {
  const h = await hub();
  const d = h.drivers[0]!;
  await h.router.send({ to: M, kind: "request", word: "say", body: { text: "hello" } }, OWNER);
  h.agents.manager.enqueue(M, { id: "news-back", from: "agent:other", word: "tell", text: "fyi", attachments: [], at: Date.now() }, "back");
  await waitFor(() => d.running.size === 2, "both lanes in a turn");
  const front = d.running.get(`${M}/front`)!.turn, back = d.running.get(`${M}/back`)!.turn;
  assert.equal(h.agents.manager.inbox.get("news-back")!.turn, back);
  const onFront = await h.client(h.issued[M]!.front!), onBack = await h.client(h.issued[M]!.back!);
  const answer = (c: Client) => call(c, "capability_call", { member: "service:agents", word: "answer", body: { in_reply_to: "news-back", text: "thanks" } });

  const borrowed = await answer(onFront);
  assert.equal(borrowed.isError, true);
  assert.equal(borrowed.data.error.code, "forbidden", `the front turn ${front} did not take it`);
  const own = await answer(onBack);
  assert.equal(own.isError, false, own.text);
});
