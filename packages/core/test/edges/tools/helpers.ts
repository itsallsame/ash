import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Caller, Outgoing, Reply } from "../../../../sdk/src/message";
import type { WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { Ledger } from "../../../src/kernel/ledger";
import type { MemberInfo } from "../../../src/kernel/types";
import { createToolsEdge, type AgentPolicy, type ToolsEdge, type ToolsEdgeOptions, type ToolsRouter } from "../../../src/edges/tools";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => { for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* already gone */ } } });

export const MAIN = "agent:main";
export const HELPER = "agent:helper";
export const PHONE = "device:B-Rce0000000000000000";

export interface FakeMember { id: string; kind: MemberInfo["kind"]; name: string; words: WordContract[] }

/** The members of a small hub, with the real contracts of sdk/words.ts. */
export function members(extra: FakeMember[] = []): FakeMember[] {
  return [
    { id: "person:owner", kind: "person", name: "owner", words: wordsOf("person:owner") },
    ...["service:clock", "service:gate", "service:devices", "service:agents", "service:vault", "service:admin", "service:history", "service:pulse"].map((id): FakeMember => ({ id, kind: "service", name: id.slice(8), words: wordsOf(id) })),
    { id: MAIN, kind: "agent", name: "main", words: wordsOf(MAIN) },
    ...extra,
  ];
}

export function fakeRegistry(list: FakeMember[] = members()) {
  return {
    list: (): MemberInfo[] => list.map(({ id, kind, name }) => ({ id, kind, name })),
    describe: (id: string) => { const m = list.find((x) => x.id === id); return m ? { info: { id: m.id, kind: m.kind, name: m.name }, words: m.words } : null; },
  };
}

/** The options the router takes from the tool surface: `approval` is T4's addition to the kernel type. */
export interface SendOpts { signal?: AbortSignal; approval?: { ttl_minutes?: number; purpose?: string } }
export type Replied = Reply & { ref?: string };
export interface Sent { msg: Outgoing; caller: Caller; opts: SendOpts }
export type RouterScript = (msg: Outgoing, caller: Caller, opts: SendOpts) => Replied | Promise<Replied>;

/** A router that records what it is sent and answers by a script (default: ok, empty result). */
export function fakeRouter(script: RouterScript = () => ({ ok: true, result: { data: { done: true } } })): ToolsRouter & { sent: Sent[]; script: RouterScript } {
  const router = {
    sent: [] as Sent[],
    script,
    async send(msg: Outgoing, caller: Caller, opts: SendOpts = {}): Promise<Replied> {
      router.sent.push({ msg, caller, opts });
      return await router.script(msg, caller, opts);
    },
  };
  return router;
}

/** A promise settled from outside. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function openLedger(dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tools-test-"))): { ledger: Ledger; dir: string; reopen(): Ledger } {
  const path = join(dir, "state", "ash.db");
  const ledgers: Ledger[] = [];
  const open = () => { const ledger = Ledger.open(path); ledgers.push(ledger); return ledger; };
  const first = open();
  cleanups.push(() => { for (const l of ledgers) { try { l.close(); } catch { /* closed */ } } rmSync(dir, { recursive: true, force: true }); });
  return { ledger: first, dir, reopen: open };
}

let shared: Ledger | undefined;
/** One ledger for a whole test file: opening a database syncs the disk, which is slow here and not what these tests are about. */
export const sharedLedger = (): Ledger => (shared ??= openLedger().ledger);

export const OPEN_POLICY: AgentPolicy = {};

export interface Rig {
  edge: ToolsEdge;
  ledger: Ledger;
  router: ReturnType<typeof fakeRouter>;
  /** The turn each agent is in now; set to null for "no turn". */
  turns: Map<string, string | null>;
  policies: Map<string, AgentPolicy | null>;
  url: string;
  token(agent?: string): string;
  client(agent?: string): Promise<ToolClient>;
}

export interface ToolResult { isError: boolean; data: any; text: string; content: any[] }

export class ToolClient {
  constructor(readonly client: Client) {}
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const res = (await this.client.callTool({ name, arguments: args })) as { content?: any[]; structuredContent?: unknown; isError?: boolean };
    const content = res.content ?? [];
    return { isError: Boolean(res.isError), data: res.structuredContent, content, text: content.filter((p) => p.type === "text").map((p) => p.text).join("\n") };
  }
  async tools(): Promise<{ name: string; description?: string; inputSchema: any }[]> { return (await this.client.listTools()).tools as any; }
}

/** The edge on a real HTTP server, with the pieces the hub would inject replaced by maps the test can change. */
export async function startRig(over: Partial<ToolsEdgeOptions> & { dir?: string; ledger?: Ledger; router?: ReturnType<typeof fakeRouter> } = {}): Promise<Rig> {
  const ledger = over.ledger ?? (over.dir ? openLedger(over.dir).ledger : sharedLedger());
  const router = over.router ?? fakeRouter();
  const turns = new Map<string, string | null>([[MAIN, "turn-1"], [HELPER, "turn-h"]]);
  const policies = new Map<string, AgentPolicy | null>([[MAIN, OPEN_POLICY], [HELPER, OPEN_POLICY]]);
  const edge = createToolsEdge({
    router, registry: fakeRegistry(), ledger,
    agentPolicy: (id) => policies.get(id) ?? null,
    currentTurn: (id) => turns.get(id) ?? null,
    fastPathMs: 60, maxWaitMs: 400, settleMs: 40,
    ...over,
  });
  const server: HttpServer = createServer((req, res) => edge.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const tokens = new Map<string, string>();
  const clients: Client[] = [];
  cleanups.push(async () => {
    edge.close();
    for (const c of clients) await c.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const token = (agent = MAIN) => { let t = tokens.get(agent); if (!t) { t = edge.issueToken(agent); tokens.set(agent, t); } return t; };
  return {
    edge, ledger, router, turns, policies, url, token,
    async client(agent = MAIN) {
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token(agent)}` } } }));
      clients.push(client);
      return new ToolClient(client);
    },
  };
}

/** A raw POST, to see the status and body of a refusal (and to send headers the MCP client never would). */
export function rawPost(url: string, headers: Record<string, string>, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
