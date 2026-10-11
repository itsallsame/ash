/** Display relations are recorded on the ledger connection, inside the caller's append transaction. */
import { safeRecord } from "../../../../sdk/src/conversation";
import type { Db, NewMessage } from "./ledger";
import { STRING_LIMIT } from "./externalize";
import { textSummary, REF_SUMMARY_MAX } from "./summary";
type Row = Record<string, unknown>;

export function indexMessage(db: Db, m: NewMessage, stored: unknown, id: string, ts: number, seq: number): void {
  const fact = safeRecord({ ...m, id, ts, seq, body: stored });
  const original = m.kind === "response" || m.word === "turn.started" || m.word === "agent.tool" || fact?.type === "activity.request" || fact?.type === "ask" || (m.from === "person:owner" && m.word === "say") || !fact ? safeRecord({ ...m, id, ts, seq }) : fact;
  if (fact || original) {
    const normalized = original ?? fact!;
    const display = ["owner.say", "agent.say", "show", "ask", "app.card"].includes(fact?.type) ? fact!.type : null;
    db.prepare("UPDATE messages SET display_type=?,fact_type=?,fact_turn=?,lane=?,expires_at=?,outcome=?,tool_name=?,tool_phase=? WHERE seq=?")
      .run(display, normalized.type, normalized.turn || null, normalized.lane ?? null, normalized.expires_at ?? null, normalized.outcome ?? null, normalized.type === "tool" ? normalized.name : null, normalized.type === "tool" ? normalized.phase : null, seq);
    // Keep only derived state and short display metadata when a large result/argument field becomes a blob.
    // Only declared owner-facing text and derived state are retained; long text uses a preview and its existing blob reference.
    const answerText = normalized.type === "ask.answer" ? normalized.answer_text : "";
    const answerRef = answerText && Buffer.byteLength(answerText) > STRING_LIMIT
      ? db.prepare("SELECT hash FROM message_blobs WHERE message_id=? AND path='/result/data/text'").get(id) as { hash: string } | undefined : undefined;
    const originalText = normalized.type === "ask" && typeof normalized.original === "string" ? normalized.original : "";
    const originalRef = originalText && Buffer.byteLength(originalText) > STRING_LIMIT
      ? db.prepare("SELECT hash FROM message_blobs WHERE message_id=? AND path='/source/body_full'").get(id) as { hash: string } | undefined : undefined;
    const state = normalized.type === "ask" && originalText ? { original: originalRef ? textSummary(originalText, REF_SUMMARY_MAX) : originalText, ...(originalRef ? { original_full: originalRef.hash } : {}) }
      : normalized.type === "ask.answer" ? { type: normalized.type, choice: normalized.choice, error: normalized.error === "timeout" ? "timeout" : "",
      answer_text: answerRef ? textSummary(answerText, REF_SUMMARY_MAX) : answerText, ...(answerRef ? { answer_full: answerRef.hash } : {}) }
      : normalized.type === "say.result" ? { type: normalized.type, accepted: normalized.accepted }
      : normalized.type === "activity.response" ? { type: normalized.type, result: normalized.result }
      : normalized.type === "activity.request" ? { type: normalized.type, action: normalized.action }
      : normalized.type === "tool" ? { type: normalized.type, name: normalized.name, phase: normalized.phase, summary: normalized.summary, ok: normalized.ok }
      : normalized.type === "owner.say" ? { has_attachments: normalized.attachments.length > 0 } : null;
    if (state) db.prepare("UPDATE messages SET state_facts=? WHERE seq=?").run(JSON.stringify(state), seq);
    const relation = db.prepare("INSERT OR IGNORE INTO message_relations(target,kind,source_seq,position) VALUES(?,?,?,?)");
    if (original?.type === "turn.start") for (let i = 0; i < original.ids.length; i++) relation.run(original.ids[i], "read", seq, i);
    // A replacement turn on the same lane overtakes a dead process that never reported its end.
    if (original?.type === "turn.start") db.prepare("UPDATE messages SET turn_end_seq=? WHERE fact_type='turn.start' AND \"from\"=? AND lane=? AND seq<? AND turn_end_seq IS NULL").run(seq, m.from, original.lane, seq);
    if (fact?.type === "owner.say" && fact.in_reply_to && fact.option_id) relation.run(fact.in_reply_to, "option", seq, null);
    if (fact?.type === "react") relation.run(fact.message_id, "react", seq, null);
    if (normalized.type === "tool" && normalized.phase === "end") {
      const start = db.prepare("SELECT id,seq FROM messages WHERE fact_type='tool' AND fact_turn=? AND tool_name=? AND tool_phase='start' AND answer_seq IS NULL AND seq<? ORDER BY seq LIMIT 1").get(normalized.turn, normalized.name, seq) as { id: string; seq: number } | undefined;
      if (start) { relation.run(start.id, "tool.end", seq, null); db.prepare("UPDATE messages SET answer_seq=? WHERE seq=?").run(seq, start.seq); }
    }
    if (normalized.type === "activity.request") {
      const a = normalized.action;
      const key = JSON.stringify([a.member, a.tool, a.signature]);
      const mode = a.polling ? "poll" : a.wrapper ? "wrapper" : a.native ? "native" : "member";
      db.prepare("UPDATE messages SET activity_state='pending',activity_key=?,activity_mode=? WHERE seq=?").run(key, mode, seq);
      if (mode === "wrapper" || mode === "member") {
        const pair = db.prepare("SELECT id FROM messages m WHERE fact_type='activity.request' AND activity_state='pending' AND fact_turn=? AND activity_key=? AND activity_mode=? AND seq<? AND NOT EXISTS(SELECT 1 FROM message_relations r WHERE r.target=m.id AND r.kind='activity.child') AND NOT EXISTS(SELECT 1 FROM message_relations r WHERE r.source_seq=m.seq AND r.kind='activity.child') ORDER BY seq LIMIT 2")
          .all(normalized.turn, key, mode === "wrapper" ? "member" : "wrapper", seq) as { id: string }[];
        if (pair.length === 1) relation.run(pair[0]!.id, "activity.child", seq, null);
      }
    }
    if (normalized.type === "activity.response") {
      const targets = db.prepare("SELECT * FROM messages WHERE fact_type='activity.request' AND (id=? OR activity_receipt=?)").all(normalized.reply_to, normalized.reply_to) as Row[];
      for (const target of targets) {
        const parent = db.prepare("SELECT target FROM message_relations WHERE source_seq=? AND kind='activity.child' LIMIT 1").get(Number(target.seq)) as { target: string } | undefined;
        const root = parent ? db.prepare("SELECT * FROM messages WHERE id=?").get(parent.target) as Row : target;
        const child = db.prepare("SELECT m.activity_mode FROM message_relations r JOIN messages m ON m.seq=r.source_seq WHERE r.target=? AND r.kind='activity.child' LIMIT 1").get(String(root.id)) as { activity_mode: string } | undefined;
        if (normalized.result.state === "accepted" && root.activity_state !== "pending" && root.activity_state !== "accepted") continue;
        const primary = child?.activity_mode === "wrapper" ? target.activity_mode === "wrapper" : target.id === root.id;
        if (primary && child && root.activity_state === "failed") continue;
        db.prepare("UPDATE messages SET activity_state=?,activity_receipt=? WHERE id=?").run(normalized.result.state, normalized.result.receipt ?? null, String(root.id));
      }
    }
    if (normalized.type === "ask.answer") db.prepare("UPDATE messages SET answer_seq=? WHERE id=? AND display_type='ask' AND seq<? AND answer_seq IS NULL").run(seq, normalized.reply_to, seq);
    if (original?.type === "turn.end") db.prepare("UPDATE messages SET turn_end_seq=? WHERE fact_turn=? AND fact_type='turn.start' AND seq<? AND turn_end_seq IS NULL").run(seq, original.turn, seq);
  }
}
