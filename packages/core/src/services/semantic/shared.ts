// Small helpers the semantic layer's members share: asking other members through the router as a service, finding the
// primary agent, setting clock timers, reading and writing the body's files, and local-time arithmetic. No state here.
import { errorBody, type Caller, type Reply } from "../../../../sdk/src/message";
import type { Ledger } from "../../kernel/ledger";
import type { Router } from "../../kernel/types";

export type Sender = Pick<Router, "send">;

/** A semantic member talking to the rest of the hub: the hub's own code, so no approval (HUB-MODULES §1.4 step 3). */
export const asService = (member: string): Caller => ({ member, via: "service", local: true });

/** The `data` of a successful reply, or null. */
export function dataOf<T = Record<string, any>>(reply: Reply): T | null {
  if (!reply.ok) return null;
  const result = reply.result as { data?: unknown } | undefined;
  return (result?.data ?? null) as T | null;
}

export const messageOf = (reply: Reply): string => (reply.ok ? "" : `${reply.error.code}: ${reply.error.message}`);

/** Ask a member; a thrown error becomes an `internal` failure so callers have one shape to handle. */
export async function ask(router: Sender, from: string, to: string, word: string, body: unknown = {}): Promise<Reply> {
  try { return await router.send({ to, kind: "request", word, body }, asService(from)); } catch (error) {
    return { ok: false, error: errorBody("internal", error instanceof Error ? error.message : String(error)) };
  }
}

export interface AgentInfo { id: string; primary?: boolean; ephemeral?: boolean; state?: string; lanes?: Record<string, unknown> }

export async function listAgents(router: Sender, from: string): Promise<AgentInfo[]> {
  const agents = dataOf<{ agents?: AgentInfo[] }>(await ask(router, from, "service:agents", "list"))?.agents;
  return Array.isArray(agents) ? agents : [];
}

/** The agent declared `primary: true`, or null. No agent name appears in this code. */
export async function primaryAgent(router: Sender, from: string): Promise<string | null> {
  return (await listAgents(router, from)).find((agent) => agent.primary)?.id ?? null;
}

/** `agent:<primary>/wake {lane: "back", reason, context}`; the lane is the agent's background one. */
export async function wakeAgent(router: Sender, from: string, agent: string, reason: string, context: Record<string, unknown>): Promise<Reply> {
  return ask(router, from, agent, "wake", { lane: "back", reason, context });
}

/** Make the clock's timers whose label starts with `prefix` exactly `want` (label -> {at, body}); the others are cancelled. */
export async function reconcileTimers(router: Sender, from: string, prefix: string, to: string, word: string,
  want: Map<string, { at: number; body: unknown }>): Promise<string | null> {
  const listed = await ask(router, from, "service:clock", "list");
  if (!listed.ok) return messageOf(listed);
  const have = new Map<string, string>();
  // Only the timers this member set itself: another member cannot take a label of ours (or crowd it out) by naming one like it.
  for (const timer of dataOf<{ timers?: { id: string; label?: string; created_by?: string }[] }>(listed)?.timers ?? []) if (timer.created_by === from && timer.label?.startsWith(prefix)) have.set(timer.label, timer.id);
  for (const [label, id] of have) if (!want.has(label)) await ask(router, from, "service:clock", "cancel", { id });
  let problem: string | null = null;
  for (const [label, item] of want) {
    if (have.has(label)) continue;
    const set = await ask(router, from, "service:clock", "set", { at: item.at, to, word, body: item.body, label });
    if (!set.ok && set.error.code !== "offline") problem = messageOf(set);
  }
  return problem;
}

/** One of the hub's settings (`service:admin/settings.get`); undefined when it is not set. */
export const readSetting = async (router: Sender, from: string, key: string): Promise<unknown> =>
  dataOf<{ settings?: Record<string, unknown> }>(await ask(router, from, "service:admin", "settings.get", { keys: [key] }))?.settings?.[key];

/** A text file of the main body (relative to its work folder). `missing` tells a file that is not there from a body that did not answer. */
export async function readBodyFile(router: Sender, from: string, path: string): Promise<{ ok: true; text: string } | { ok: false; missing: boolean; message: string }> {
  const reply = await ask(router, from, "body:main", "workspace.read", { path, limit: 20000 });
  if (reply.ok) { const text = dataOf<{ text?: unknown }>(reply)?.text; return { ok: true, text: typeof text === "string" ? text : "" }; }
  return { ok: false, missing: reply.error.code === "not_found", message: messageOf(reply) };
}

export async function writeBodyFile(router: Sender, from: string, path: string, content: string): Promise<boolean> {
  return (await ask(router, from, "body:main", "workspace.write", { path, content })).ok;
}

/** Write `content` into the body only when the file is not there yet. Returns true when the file exists afterwards. */
export async function seedBodyFile(router: Sender, from: string, path: string, content: string): Promise<boolean> {
  const read = await readBodyFile(router, from, path);
  if (read.ok) return true;
  return read.missing ? writeBodyFile(router, from, path, content) : false;
}

// ---- local time ------------------------------------------------------------------------------------------------------

export const CLOCK_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The next local `HH:MM` strictly after `from` (Unix ms). */
export function nextMoment(from: number, time: string): number {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const base = new Date(from);
  const today = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime();
  return today > from ? today : new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, hour, minute, 0, 0).getTime();
}

/** Today's local `HH:MM` as an instant (may be in the past). */
export function momentOn(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime();
}

export function localDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function previousDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return localDate(new Date(y, m - 1, d - 1, 12).getTime());
}

export const localDayStart = (at: number): number => { const d = new Date(at); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

// ---- the semantic layer's own small table --------------------------------------------------------------------------------

/** `semantic_kv`: the few facts the layer keeps about itself (when it first ran, whether the first meeting was held). */
export class SemanticKv {
  private readonly db;
  constructor(ledger: Pick<Ledger, "db">) {
    this.db = ledger.db();
    this.db.exec("CREATE TABLE IF NOT EXISTS semantic_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  get(key: string): string | null { return (this.db.prepare("SELECT value FROM semantic_kv WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null; }
  set(key: string, value: string): void { this.db.prepare("INSERT INTO semantic_kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  delete(key: string): void { this.db.prepare("DELETE FROM semantic_kv WHERE key=?").run(key); }
  /** Set only when absent; true when this call set it. */
  setOnce(key: string, value: string): boolean { return this.db.prepare("INSERT OR IGNORE INTO semantic_kv (key, value) VALUES (?,?)").run(key, value).changes > 0; }
}
