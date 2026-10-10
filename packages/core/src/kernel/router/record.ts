import { OWNER_ID } from "../../../../sdk/src/ids";
import type { Caller, Message, WordContract } from "../types";

/**
 * What goes into the ledger (HUB-MODULES §1.2): the ledger holds events of life, not a stream of data. The one place
 * this is decided; a response follows its request.
 *
 *   event    only if the contract says `record: true`
 *   request  anything the owner sends from a channel; anything an agent asks (a read too); anything that has an
 *            effect (write, act, execute) whoever asks — which covers what is said or asked of the owner. Left out: a
 *            service, hand or app only reading (polling), even when it reads on the owner's behalf.
 */
export function shouldRecord(msg: Pick<Message, "from" | "to" | "kind">, contract: WordContract, caller: Caller): boolean {
  if (msg.kind === "event") return contract.record === true;
  if (msg.from === OWNER_ID && caller.via === "human") return true;
  if (caller.via === "agent") return true;
  return contract.effect !== "read";
}
