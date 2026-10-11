import { initialView, safeRecord as record, projectRecords as project } from "../../sdk/src/conversation.ts";
export { initialView, OWNER } from "../../sdk/src/conversation.ts";

/**
 * Does this ledger row put something in the conversation area, or change something already there?
 * Tool calls, turn bookkeeping and presence only feed the presence bar, the progress strip and the activity sheet; they never
 * need the conversation redrawn (a turn starting does: it marks the messages it was given as read).
 */
const CONVERSATION_ROWS = new Set(["owner.say", "agent.say", "show", "ask", "ask.answer", "react", "say.result", "turn.start", "app.card"]);
export function drawsConversation(message) {
  const row = record(message);
  return row !== null && CONVERSATION_ROWS.has(row.type);
}

/** Folds one ledger Message. A row the page does not know is ignored. */
export function fold(state, message) {
  const current = state && Array.isArray(state._records) ? state : initialView();
  const next = record(message);
  if (!next || current._records.some((r) => r.id === next.id || r.seq === next.seq)) return current;
  const records = [...current._records, next].sort((a, b) => a.seq - b.seq);
  return project(records);
}

/** Folds a received batch once, with the same first-delivery wins rule as successive folds. */
export function foldMany(state, messages) {
  const current = state && Array.isArray(state._records) ? state : initialView();
  if (!messages.length) return current;
  const ids = new Set(current._records.map((r) => r.id));
  const seqs = new Set(current._records.map((r) => r.seq));
  let records = null;
  for (const message of messages) {
    const next = record(message);
    if (!next || ids.has(next.id) || seqs.has(next.seq)) continue;
    ids.add(next.id);
    seqs.add(next.seq);
    (records ??= [...current._records]).push(next);
  }
  return records ? project(records.sort((a, b) => a.seq - b.seq)) : current;
}

/** The view of a whole batch of ledger rows at once (the home page reads the ledger this way, once per look, not row by row). */
export function projectMessages(messages) {
  const bySeq = new Map();
  for (const message of messages) {
    const next = record(message);
    if (next && !bySeq.has(next.seq)) bySeq.set(next.seq, next);
  }
  const seen = new Set();
  const records = [...bySeq.values()].sort((a, b) => a.seq - b.seq).filter((r) => !seen.has(r.id) && seen.add(r.id));
  return project(records);
}
