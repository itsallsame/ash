/**
 * The host as a member (HUB-MODULES §2.8): `service:host`, whose words are the host client's calls, and the host's events
 * (the kernel's standard input) turned into words.
 *
 *   wake.fired      -> an event to `service:clock`
 *   env.changed     -> an event to `service:agents` and to `service:link` (whichever is there); a network change also to `onNetwork`
 *   lifecycle.stop  -> `onStop`, the shutdown the entry program handed over
 *
 * What the host does not offer is skipped, not imitated: its words answer `unavailable`.
 */
import type { Readable } from "node:stream";
import { WordError, type Caller, type Message, type WordResult } from "../../../../sdk/src/message";
import type { HostEvent, HostNetwork } from "../../../../sdk/src/host";
import type { Member } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Router } from "../../kernel/types";
import { readHostEvents, type HostEventReader } from "./events";
import type { HostClient, HostOptional } from "./client";

export const HOST_ID = "service:host";
const SELF: Caller = { member: HOST_ID, via: "service", local: true };

export interface HostServiceDeps {
  client: Pick<HostClient, "wakeAt" | "wakeClear" | "powerHold" | "powerRelease" | "handsHandoff" | "updateInstall">;
  router: Pick<Router, "send">;
  /** The host asked the kernel to stop before `deadline` (Unix ms). */
  onStop(deadline: number, reason: string): void | Promise<void>;
  /** The host's network changed (`env.changed`/`network`): the proxy to use from now on, or null for none. */
  onNetwork?(network: HostNetwork, online: boolean): void;
  log?(message: string, error?: unknown): void;
}

export interface HostService {
  /** `service:host`: add it to the registry. */
  member: Member;
  /** Reads the host's events from the kernel's standard input; `close()` stops reading. */
  listen(input: Readable): HostEventReader;
}

export function createHostService(deps: HostServiceDeps): HostService {
  const { client, router } = deps;
  const log = deps.log ?? (() => {});
  const done = <R>(r: HostOptional<R>): WordResult => {
    if (!r.supported) throw new WordError("unavailable", "the host does not offer this");
    return { data: (r.result ?? {}) as object };
  };

  const member: Member = {
    id: HOST_ID, kind: "service", name: "host",
    words: () => wordsOf(HOST_ID),
    async handle(msg: Message): Promise<WordResult> {
      const b = (msg.body ?? {}) as Record<string, any>;
      switch (msg.word) {
        case "wake.at": return done(await client.wakeAt(b.at));
        case "wake.clear": return done(await client.wakeClear());
        case "power.hold": return done(await client.powerHold(b.ms, b.reason));
        case "power.release": return done(await client.powerRelease());
        case "hands.handoff": return done(await client.handsHandoff(b.port, b.token));
        case "update.install": return done(await client.updateInstall(b.version, b.url, b.sha256));
        default: throw new WordError("not_found", `${HOST_ID} has no word ${msg.word}`);
      }
    },
  };

  const pass = async (to: string, word: string, body: object): Promise<void> => {
    const reply = await router.send({ to, kind: "event", word, body }, SELF);
    if (!reply.ok && reply.error.code !== "offline") log(`${word} to ${to}: ${reply.error.code}: ${reply.error.message}`);
  };

  return {
    member,
    listen: (input) => readHostEvents(input, async (event: HostEvent) => {
      switch (event.event) {
        case "wake.fired": await pass("service:clock", "wake.fired", { at: event.at }); return;
        case "env.changed": {
          const { event: _name, ...rest } = event;
          if (event.what === "network") deps.onNetwork?.(event.network, event.online);
          await Promise.all([pass("service:agents", "env.changed", rest), pass("service:link", "env.changed", rest)]);
          return;
        }
        case "lifecycle.stop": await deps.onStop(event.deadline, event.reason); return;
      }
    }, (line) => log(line)),
  };
}
