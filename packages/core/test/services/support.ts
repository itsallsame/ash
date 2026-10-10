import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply, type WordResult } from "../../../sdk/src/message";
import type { Member } from "../../../sdk/src/word";
import { compileSchema } from "../../../sdk/src/word";
import assert from "node:assert/strict";

export const owner: Caller = { member: "person:owner", via: "human", local: true, client: "client:1" };
export const agent = (name = "main"): Caller => ({ member: `agent:${name}`, via: "agent", local: false, turn: "t_1" });
export const kernel: Caller = { member: "service:test", via: "service", local: true };

export const msg = (to: string, word: string, body: unknown, from = "person:owner", kind: "request" | "event" = "request"): Message =>
  ({ seq: 0, id: "m_test", ts: 0, from, to, kind, word, body });
export const ctxOf = (caller: Caller, raw?: unknown): HandleContext => ({ signal: new AbortController().signal, caller, raw });

/** A router that records what is sent and answers with `answer`. */
export function fakeRouter(answer: (m: Outgoing, caller: Caller) => Reply | Promise<Reply> = () => ({ ok: true })) {
  const sent: { msg: Outgoing; caller: Caller }[] = [];
  return { sent, send: async (m: Outgoing, caller: Caller): Promise<Reply> => { sent.push({ msg: m, caller }); return answer(m, caller); } };
}

/** Call a word the way the router would: check the input against the contract, then handle. */
export async function call(member: Member, caller: Caller, word: string, body: unknown = {}, raw: unknown = body): Promise<any> {
  const contract = member.words().find((w) => w.word === word && w.kind === "request")!;
  assert.ok(contract, `no word ${word}`);
  assert.ok(compileSchema(contract.input_schema)(body), `input of ${word} does not fit its contract`);
  const result = await member.handle(msg(member.id, word, body, caller.member), ctxOf(caller, raw)) as WordResult;
  return result?.data;
}

export async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (e) { assert.ok(e instanceof WordError, String(e)); return (e as WordError).code; }
  return assert.fail("expected a WordError");
}
