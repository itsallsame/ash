/**
 * The names a person reads on an approval card. A service or the main container has only a code name, so it gets none (a
 * service) or a plain one (the main container); a hand that is not connected right now (the hub has just restarted) is
 * still known by the name it was paired with. Only when nothing knows the member does the id show.
 */
import { MAIN_BODY_ID } from "../../../../sdk/src/ids";

export interface NameSources {
  /** The registry's `name` for a member that is there right now. */
  memberName(id: string): string | null | undefined;
  /** The name a hand was paired with (the stored record), by hand id; works while it is offline. */
  handName(handId: string): string | null | undefined;
  /** The primary agent's name, for "<name>的容器". */
  mainAgentName(): string | null | undefined;
}

export const FALLBACK_MAIN_NAME = "Ash";

/** `null` means "there is no name a person would know": the card then leaves the object out. */
export function createNameOf(src: NameSources): (id: string) => string | null {
  const safe = <T>(read: () => T | null | undefined): T | null => { try { return read() ?? null; } catch { return null; } };
  return (id) => {
    if (id.startsWith("service:")) return null;
    if (id === MAIN_BODY_ID) return `${safe(src.mainAgentName)?.trim() || FALLBACK_MAIN_NAME} 的容器`;
    const live = safe(() => src.memberName(id))?.trim();
    if (live) return live;
    const colon = id.indexOf(":");
    const prefix = id.slice(0, colon);
    if (prefix === "device" || prefix === "body") {
      const stored = safe(() => src.handName(id.slice(colon + 1)))?.trim();
      if (stored) return stored;
    }
    return id;
  };
}
