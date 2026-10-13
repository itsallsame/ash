import type { Db } from "./ledger";

/** Ids of the messages whose body holds an attachment (oldest first). Who may read the attachment follows from who may see these. */
export function referencingMessages(ledger: { db(): Db }, hash: string): string[] {
  return (ledger.db().prepare("SELECT message_id FROM message_blobs mb JOIN messages m ON m.id=mb.message_id WHERE mb.hash=? ORDER BY m.seq").all(hash) as { message_id: string }[])
    .map((row) => row.message_id);
}
