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
import { WordError, type Caller, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { HostCapability, HostEvent, HostMethod, HostNetwork } from "../../../../sdk/src/host";
import type { ContentPart } from "../../../../sdk/src/link";
import { namespaceOf, standardContracts } from "../../../../sdk/src/namespaces";
import type { Member } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Router } from "../../kernel/types";
import type { HostEventReader, HostPipe } from "./pipe";
import { HostCallError, type HostClient, type HostOptional } from "./client";
import type { VirtualScreen } from "./virtual";

export const HOST_ID = "service:host";
const SELF: Caller = { member: HOST_ID, via: "service", local: true };

/** The phone namespaces the host serves and the host capability that gates each: a word is listed only when the host has it. */
const PHONE_CAPABILITY: Readonly<Record<string, HostCapability>> = { vscreen: "vscreen", input: "input", apps: "apps" };
/** The phone capability a word needs, or undefined for a word that is not a phone action. */
const phoneCapabilityOf = (word: string): HostCapability | undefined => PHONE_CAPABILITY[namespaceOf(word) ?? ""];

export interface HostServiceDeps {
  client: Pick<HostClient, "wakeAt" | "wakeClear" | "powerHold" | "powerRelease" | "handsHandoff" | "updateInstall" | "phone" | "has">;
  router: Pick<Router, "send">;
  /** The virtual screen's bookkeeping: every vscreen.* call goes through it. */
  virtual: VirtualScreen;
  /** The host asked the kernel to stop before `deadline` (Unix ms). */
  onStop(deadline: number, reason: string): void | Promise<void>;
  /** The host's network changed (`env.changed`/`network`): the proxy to use from now on, or null for none. */
  onNetwork?(network: HostNetwork, online: boolean): void;
  log?(message: string, error?: unknown): void;
}

export interface HostService {
  /** `service:host`: add it to the registry. */
  member: Member;
  /** Takes the host's events from the pipe; `close()` stops reading. */
  listen(pipe: Pick<HostPipe, "events">): HostEventReader;
}

export function createHostService(deps: HostServiceDeps): HostService {
  const { client, router } = deps;
  const log = deps.log ?? (() => {});
  const done = <R>(r: HostOptional<R>): WordResult => {
    if (!r.supported) throw new WordError("unavailable", "the host does not offer this");
    return { data: (r.result ?? {}) as object };
  };

  // The phone actions (the virtual screen, keys, launching an app) live on this member too (sdk standardMember), but only
  // while the host can do them: the ones whose capability the host did not declare are left out of the list ("部位不在就不列").
  const phoneWords = standardContracts().filter((c) => c.member === HOST_ID);

  const member: Member = {
    id: HOST_ID, kind: "service", name: "host",
    words: () => [...wordsOf(HOST_ID), ...phoneWords.filter((c) => client.has(phoneCapabilityOf(c.word)!))],
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
      const b = (msg.body ?? {}) as Record<string, any>;
      if (phoneCapabilityOf(msg.word)) return phone(msg.word as HostMethod, b, ctx?.caller?.turn);
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

  /** Forward one phone word to the host and shape its reply: data follows the word, the host's `message` and (for see) the JPEG become content. */
  async function phone(word: HostMethod, body: Record<string, any>, turn: string | undefined): Promise<WordResult> {
    let r: HostOptional<Record<string, any>>;
    try {
      r = word.startsWith("vscreen.") ? await deps.virtual.call(word, body, turn) : await client.phone(word, body as never);
    } catch (error) {
      if (error instanceof HostCallError) throw new WordError(error.code, error.message);
      throw error;
    }
    if (!r.supported) throw new WordError("unavailable", "the phone cannot do this now: pair the phone's debug identity (「后台也能动手」)");
    const res = r.result as Record<string, any>;
    if (word === "vscreen.see") {
      const { screenW: sw, screenH: sh, imageW: iw, imageH: ih, displayId, jpeg } = res;
      const caption = sw === iw && sh === ih
        ? `Virtual screen (display ${displayId}) ${sw}x${sh}; image pixels = tap coordinates.`
        : `Virtual screen (display ${displayId}) ${sw}x${sh}; image ${iw}x${ih}: multiply image coordinates by ${(iw > 0 ? sw / iw : 1).toFixed(4)} for vscreen.tap/swipe.`;
      const content: ContentPart[] = [{ type: "text", text: caption }, { type: "image", mime: "image/jpeg", b64: jpeg }];
      return { content };
    }
    const { message, ...data } = res;
    const out: WordResult = {};
    if (Object.keys(data).length > 0) out.data = data;
    if (typeof message === "string" && message.length > 0) out.content = [{ type: "text", text: message }];
    return out;
  }

  const pass = async (to: string, word: string, body: object): Promise<void> => {
    const reply = await router.send({ to, kind: "event", word, body }, SELF);
    if (!reply.ok && reply.error.code !== "offline") log(`${word} to ${to}: ${reply.error.code}: ${reply.error.message}`);
  };

  return {
    member,
    listen: (pipe) => pipe.events(async (event: HostEvent) => {
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
    }),
  };
}
