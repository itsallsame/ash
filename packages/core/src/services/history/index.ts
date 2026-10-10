/**
 * `service:history`: look back through the ledger (HUB-MODULES §3, SPEC-08 §2.6). Everything is read from the ledger;
 * no full-text or vector index (`query` uses the ledger's LIKE).
 *
 *   query {text?, speaker?, lane?, thread?, before?, after?, limit?}   newest first
 *   read {from_seq, to_seq}     messages by sequence range, oldest first, at most 200
 *   turn {turn}                 one turn of an agent: what it was given, what it said, its tool calls
 *   activity {id, offset}       the detail of one tool call (request and answer), paged by characters
 *
 * The ledger holds only masked versions (SPEC-01 §10.0), so a row is safe for every caller as stored. As a second
 * line, each answer's data is passed through `redact.forCaller` with the contract of the word it answers, so a
 * sensitive field that got in unmasked still reaches nobody but the owner.
 */
import { activityDetail } from "../../../../sdk/src/activity";
import { WordError, type Caller, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger, LedgerMessage } from "../../kernel/ledger";
import type { Registry, Redact } from "../../kernel/types";

export const HISTORY_ID = "service:history";
export const DEFAULT_QUERY_LIMIT = 30;
export const MAX_READ_MESSAGES = 200;
/** How many characters of an activity detail one call returns. */
export const ACTIVITY_PAGE_CHARS = 16_000;
/** `lane` is found through the `turn.started` events; at most this many are looked at. */
const LANE_TURNS = 500;

export interface HistoryOptions {
  ledger: Pick<Ledger, "page" | "get" | "db">;
  /** With both, the data of answers is masked for the caller by the contract of the word that was answered. */
  redact?: Pick<Redact, "forCaller">;
  registry?: Pick<Registry, "find">;
}

const MAX_SEQ = Number.MAX_SAFE_INTEGER;
const BATCH = 1000;
const MAX_BATCHES = 20;

export function createHistoryService(options: HistoryOptions): Member {
  const { ledger } = options;
  const db = ledger.db();

  /** Pass an answer's data through the caller's masking, by the contract of the word it answers. */
  function forCaller(m: LedgerMessage, caller: Caller): LedgerMessage {
    if (!options.redact || !options.registry || m.kind !== "response") return m;
    const reply = m.body as { ok?: boolean; result?: { data?: unknown } } | null;
    if (!reply?.ok || reply.result?.data === undefined) return m;
    const contract = options.registry.find(m.from, m.word)?.contract;
    if (!contract) return m;
    const data = options.redact.forCaller(reply.result.data, contract, caller);
    return data === reply.result.data ? m : { ...m, body: { ...reply, result: { ...reply.result, data } } };
  }

  /** The turns and the messages delivered in them, for the turns that ran on a lane. */
  function laneScope(lane: string): { turns: Set<string>; ids: Set<string> } {
    const rows = db.prepare("SELECT body FROM messages WHERE word='turn.started' AND json_extract(body,'$.lane')=? ORDER BY seq DESC LIMIT ?").all(lane, LANE_TURNS) as { body: string }[];
    const turns = new Set<string>(), ids = new Set<string>();
    for (const row of rows) {
      const b = JSON.parse(row.body) as { turn?: string; ids?: string[] };
      if (b.turn) turns.add(b.turn);
      for (const id of b.ids ?? []) ids.add(id);
    }
    return { turns, ids };
  }

  function query(body: Record<string, unknown>, caller: Caller) {
    const limit = (body.limit as number | undefined) ?? DEFAULT_QUERY_LIMIT;
    const base = {
      ...(body.text !== undefined ? { text: body.text as string } : {}), ...(body.speaker !== undefined ? { from: body.speaker as string } : {}),
      ...(body.thread !== undefined ? { thread: body.thread as string } : {}), ...(body.after !== undefined ? { after: body.after as number } : {}),
    };
    let before = (body.before as number | undefined) ?? MAX_SEQ;
    const scope = body.lane === undefined ? null : laneScope(body.lane as string);
    const found: LedgerMessage[] = [];
    // Newest first, in windows. Without a lane filter one window is enough.
    for (let i = 0; i < MAX_BATCHES && found.length < limit; i++) {
      const window = ledger.page({ ...base, before, limit: scope ? BATCH : limit });
      if (!window.length) break;
      for (const m of [...window].reverse()) {
        if (scope && !(scope.ids.has(m.id) || (m.turn !== undefined && scope.turns.has(m.turn)))) continue;
        found.push(m);
        if (found.length >= limit) break;
      }
      if (window.length < (scope ? BATCH : limit)) break;
      before = window[0]!.seq;
    }
    const last = found[found.length - 1];
    return { messages: found.map((m) => forCaller(m, caller)), ...(found.length >= limit && last ? { next_before: last.seq } : {}) };
  }

  function read(body: Record<string, unknown>, caller: Caller) {
    const from = body.from_seq as number, to = body.to_seq as number;
    if (to < from) throw new WordError("bad_request", "to_seq must not be smaller than from_seq");
    if (to - from + 1 > MAX_READ_MESSAGES) throw new WordError("too_large", `a range holds at most ${MAX_READ_MESSAGES} messages; read it in pieces`);
    const messages = ledger.page({ after: from - 1, limit: MAX_READ_MESSAGES }).filter((m) => m.seq <= to);
    return { messages: messages.map((m) => forCaller(m, caller)) };
  }

  function turn(body: Record<string, unknown>, caller: Caller) {
    const turnId = body.turn as string;
    const ids = (sql: string, ...args: string[]) => (db.prepare(sql).all(...args) as { id: string }[]).map((r) => r.id);
    const started = ids("SELECT id FROM messages WHERE word='turn.started' AND json_extract(body,'$.turn')=? ORDER BY seq", turnId);
    if (!started.length && !ids("SELECT id FROM messages WHERE turn=? LIMIT 1", turnId).length) throw new WordError("not_found", `no turn ${turnId} in the ledger`);
    const given = started.flatMap((id) => (ledger.get(id)?.body as { ids?: string[] } | undefined)?.ids ?? []).map((id) => ledger.get(id)).filter((m): m is LedgerMessage => m !== null);
    const inTurn = ids("SELECT id FROM messages WHERE turn=? ORDER BY seq", turnId).map((id) => ledger.get(id)!);
    const spoken = inTurn.filter((m) => m.kind === "request" && m.to !== null && /^(person|agent):/.test(m.to));
    const calls = inTurn.filter((m) => m.kind === "request" && m.to !== null && !/^(person|agent):/.test(m.to));
    const native = ids("SELECT id FROM messages WHERE word='agent.tool' AND json_extract(body,'$.turn')=? ORDER BY seq", turnId).map((id) => ledger.get(id)!);
    const tools = [
      ...calls.map((m) => {
        const answer = (db.prepare("SELECT id FROM messages WHERE reply_to=? AND kind='response' LIMIT 1").get(m.id) as { id: string } | undefined);
        const response = answer ? ledger.get(answer.id) : null;
        return { seq: m.seq, id: m.id, to: m.to, word: m.word, summary: m.summary,
          ...(response ? { ok: (response.body as { ok?: boolean }).ok === true, result_summary: response.summary } : {}) };
      }),
      ...native.map((m) => { const b = m.body as { name?: string; phase?: string; summary?: string; ok?: boolean }; return { seq: m.seq, native: true, name: b.name, phase: b.phase, summary: b.summary ?? m.summary, ...(b.ok !== undefined ? { ok: b.ok } : {}) }; }),
    ].sort((a, b) => a.seq - b.seq);
    return { turn: turnId, messages: [...given, ...spoken].map((m) => forCaller(m, caller)), tools };
  }

  function activity(body: Record<string, unknown>, caller: Caller) {
    const request = ledger.get(body.id as string);
    if (!request || request.kind !== "request" || !request.from.startsWith("agent:") || !request.turn || request.to === "person:owner") throw new WordError("not_found", "no such activity");
    const answer = db.prepare("SELECT id FROM messages WHERE reply_to=? AND kind='response' LIMIT 1").get(request.id) as { id: string } | undefined;
    const response = answer ? forCaller(ledger.get(answer.id)!, caller) : null;
    const full = activityDetail({ tool: request.word, member: request.to, input: request.body, result: response?.body ?? { status: "pending", note: "尚无返回记录" } });
    const offset = (body.offset as number | undefined) ?? 0;
    const next = Math.min(full.length, offset + ACTIVITY_PAGE_CHARS);
    return { items: [{ text: full.slice(offset, next), total: full.length, tool: request.word, member: request.to }], next_offset: next < full.length ? next : null };
  }

  return {
    id: HISTORY_ID, kind: "service", name: "History",
    words: (): WordContract[] => wordsOf(HISTORY_ID),
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
      const body = (msg.body ?? {}) as Record<string, unknown>;
      switch (msg.word) {
        case "query": return { data: query(body, ctx.caller) };
        case "read": return { data: read(body, ctx.caller) };
        case "turn": return { data: turn(body, ctx.caller) };
        case "activity": return { data: activity(body, ctx.caller) };
        default: throw new WordError("not_found", `service:history has no word ${msg.word}`);
      }
    },
  };
}
