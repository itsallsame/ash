/**
 * The virtual screen's bookkeeping. The screen itself lives in the kernel host (vscreen.* on `service:host`); what the
 * hub keeps is who owns it and a generation that moves on every change, so that the reflex closes a screen only when
 * the turn that made it is done with it and nothing touched it since. Every vscreen call goes through here, one at a
 * time, so a newer screen can never be closed by an older decision.
 */
import type { HostMethod } from "../../../../sdk/src/host";
import type { HostClient, HostOptional } from "./client";

export interface VirtualState {
  open: boolean;
  /** Moves on every create, use and close. */
  generation: number;
  /** The turn that made the screen and is the only one that used it; empty when another turn touched it. */
  owner: string;
}

export interface VirtualScreen {
  /** The host can make a virtual screen now (it is paired). */
  available(): boolean;
  state(): VirtualState;
  /** One vscreen.* call through the host, by [turn], with its bookkeeping. */
  call(word: HostMethod, body: object, turn: string | undefined): Promise<HostOptional<Record<string, any>>>;
  /** Closes the screen for the reflex when [owner] still owns [generation]; one decision acts at most once. */
  close(generation: number, owner: string, decisionId: string): Promise<boolean>;
}

export function createVirtualScreen(client: Pick<HostClient, "phone" | "has">): VirtualScreen {
  const s: VirtualState = { open: false, generation: 0, owner: "" };
  const applied = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  };
  const closed = () => { s.generation++; s.open = false; s.owner = ""; };

  return {
    available: () => client.has("vscreen"),
    state: () => ({ ...s }),
    call: (word, body, turn) => serial(async () => {
      const r = await client.phone(word, body as never) as HostOptional<Record<string, any>>;
      if (!r.supported) return r;
      const t = turn ?? "";
      switch (word) {
        case "vscreen.create":
          if (!r.result.reused) { s.generation++; s.open = true; s.owner = t; } else if (s.owner !== t) { s.generation++; s.owner = ""; }
          break;
        case "vscreen.close": closed(); break;
        case "vscreen.status": case "vscreen.see": break;
        default: s.generation++; if (s.owner !== t) s.owner = "";
      }
      return r;
    }),
    close: (generation, owner, decisionId) => serial(async () => {
      if (applied.has(decisionId) || !owner || !s.open || owner !== s.owner || generation !== s.generation) return false;
      // Claimed before the call: an uncertain reply must not repeat the close on a later screen.
      applied.add(decisionId);
      if (applied.size > 256) applied.delete(applied.values().next().value!);
      let ok = false;
      try { ok = (await client.phone("vscreen.close", {})).supported; } catch { /* the screen is gone either way */ }
      closed();
      return ok;
    }),
  };
}
