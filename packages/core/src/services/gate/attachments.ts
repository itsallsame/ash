/**
 * Who may read an attachment: whoever may see a message that holds it (SPEC-01 §4.3). The owner sees everything; any
 * other member sees the messages it sent or received. The router asks this in step 3 for `service:blobs`. An
 * attachment no message holds is let through: `service:blobs` answers it with `not_found`, the same as for a hash that
 * does not exist.
 */
import { OWNER_ID } from "../../../../sdk/src/ids";
import type { Caller } from "../../kernel/types";
import type { Ledger } from "../../kernel/ledger";
import { referencingMessages } from "../blobs";

export function createAttachmentGuard(ledger: Ledger): (caller: Caller, hash: string) => boolean {
  return (caller, hash) => {
    if (caller.member === OWNER_ID) return true;
    const ids = referencingMessages(ledger, hash);
    if (ids.length === 0) return true;
    return ids.some((id) => {
      const m = ledger.get(id);
      return m !== null && (m.from === caller.member || m.to === caller.member);
    });
  };
}
