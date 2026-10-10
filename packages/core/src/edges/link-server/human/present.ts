/** Sending `present` frames to a channel and waiting for its `present.result` (SPEC-03 §5.4). */
import { randomBytes } from "node:crypto";
import type { Frame, PresentFrame, PresentResultFrame } from "../../../../../sdk/src/link";
import { errorBody, type ErrorBody } from "../../../../../sdk/src/message";
import type { LiveClient } from "./clients";

export type PresentResult = { ok: true; data?: unknown } | { ok: false; error: ErrorBody };
type Shown = Pick<PresentFrame, "surface" | "op" | "body">;

export class Presenter {
  private readonly waits = new Map<string, { client: string; timer: ReturnType<typeof setTimeout>; done(result: PresentResult): void }>();

  constructor(private readonly defaultMs: number) {}

  /** Sends one frame and resolves with the channel's answer; a channel that is gone or silent gives `offline` or `timeout`. */
  send(c: LiveClient, shown: Shown, ms: number = this.defaultMs): Promise<PresentResult> {
    const id = `p_${randomBytes(9).toString("base64url")}`;
    return new Promise((resolve) => {
      const finish = (result: PresentResult) => {
        const wait = this.waits.get(id);
        if (!wait) return;
        this.waits.delete(id);
        clearTimeout(wait.timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: errorBody("timeout", `${c.client} did not answer ${shown.surface}/${shown.op}`) }), ms);
      timer.unref?.();
      this.waits.set(id, { client: c.client, timer, done: finish });
      if (!c.session.send({ t: "present", ch: "human", id, ...shown } as Frame)) finish({ ok: false, error: errorBody("offline", `${c.client} is gone`) });
    });
  }

  /** A `present.result` arrived. */
  result(frame: PresentResultFrame): void {
    this.waits.get(frame.id)?.done(frame.ok ? { ok: true, ...(frame.data !== undefined ? { data: frame.data } : {}) } : { ok: false, error: frame.error });
  }

  /** The channel went away: whatever it still owed is answered `offline`. */
  drop(client: string): void {
    for (const wait of [...this.waits.values()]) if (wait.client === client) wait.done({ ok: false, error: errorBody("offline", `${client} is gone`) });
  }
}
