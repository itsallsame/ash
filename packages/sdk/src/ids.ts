/**
 * Member ids: the kinds and the one regular expression for each. Every place that checks an id uses these.
 *
 *   person:owner            the owner (one); which channel they came from is in `origin`, never in the id
 *   agent:<name>            a declared agent; `^agent:[a-z][a-z0-9_-]{0,31}$`
 *   service:<name>          a hub service
 *   device:<hand_id>        a hand (phone app, computer program)
 *   body:main, body:<hand_id>   a body (the kernel's own, or a computer lent by a hand)
 *   app:<id>                an app backend
 *   client:<sid>            one open channel of the owner; written in `origin.client`, never a sender
 */

export const MEMBER_KINDS = ["person", "agent", "service", "device", "body", "app"] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];
/** A member kind, or `client` (a session id that appears in `origin` but is never a member). */
export const ID_KINDS = [...MEMBER_KINDS, "client"] as const;
export type IdKind = (typeof ID_KINDS)[number];

export const OWNER_ID = "person:owner";
export const MAIN_BODY_ID = "body:main";
/** `hand_id` is the first 22 characters of base64url(sha256(SPKI)). */
export const HAND_ID_LENGTH = 22;

const HAND = `[A-Za-z0-9_-]{${HAND_ID_LENGTH}}`;
export const AGENT_ID_PATTERN = "^agent:[a-z][a-z0-9_-]{0,31}$";
export const SERVICE_ID_PATTERN = "^service:[a-z][a-z0-9_-]{0,31}$";
export const DEVICE_ID_PATTERN = `^device:${HAND}$`;
export const BODY_ID_PATTERN = `^body:(main|${HAND})$`;
export const APP_ID_PATTERN = "^app:[a-z][a-z0-9-]{0,47}$";
export const CLIENT_ID_PATTERN = "^client:[A-Za-z0-9_-]{1,64}$";
export const HAND_ID_PATTERN = `^${HAND}$`;
/** The agent name without its `agent:` prefix. */
export const AGENT_NAME_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";
/** The app id without its `app:` prefix, as app.json writes it. */
export const APP_NAME_PATTERN = "^[a-z][a-z0-9-]{0,47}$";
/** An opaque, stable key (1..128 characters) a sender picks to keep a repeat from counting twice: `batch_id`, `dedupe_key`. */
export const DEDUPE_KEY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
/** The id of one page (surface) of an app. */
export const SURFACE_ID_PATTERN = "^[a-z][a-z0-9-]{0,31}$";
/** A calendar date, YYYY-MM-DD. */
export const DATE_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

export const AGENT_ID = new RegExp(AGENT_ID_PATTERN);
export const SERVICE_ID = new RegExp(SERVICE_ID_PATTERN);
export const DEVICE_ID = new RegExp(DEVICE_ID_PATTERN);
export const BODY_ID = new RegExp(BODY_ID_PATTERN);
export const APP_ID = new RegExp(APP_ID_PATTERN);
export const CLIENT_ID = new RegExp(CLIENT_ID_PATTERN);
export const HAND_ID = new RegExp(HAND_ID_PATTERN);

const BY_KIND: Record<IdKind, (id: string) => boolean> = {
  person: (id) => id === OWNER_ID,
  agent: (id) => AGENT_ID.test(id),
  service: (id) => SERVICE_ID.test(id),
  device: (id) => DEVICE_ID.test(id),
  body: (id) => BODY_ID.test(id),
  app: (id) => APP_ID.test(id),
  client: (id) => CLIENT_ID.test(id),
};

/** The kind of a well-formed id, or null. */
export function idKind(id: unknown): IdKind | null {
  if (typeof id !== "string") return null;
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const kind = id.slice(0, colon) as IdKind;
  return Object.hasOwn(BY_KIND, kind) && BY_KIND[kind](id) ? kind : null;
}

export const isMemberId = (id: unknown): id is string => {
  const kind = idKind(id);
  return kind !== null && kind !== "client";
};
export const isAgentId = (id: unknown): id is `agent:${string}` => typeof id === "string" && AGENT_ID.test(id);
export const isDeviceId = (id: unknown): id is `device:${string}` => typeof id === "string" && DEVICE_ID.test(id);
export const isBodyId = (id: unknown): id is `body:${string}` => typeof id === "string" && BODY_ID.test(id);
export const isAppId = (id: unknown): id is `app:${string}` => typeof id === "string" && APP_ID.test(id);
export const isClientId = (id: unknown): id is `client:${string}` => typeof id === "string" && CLIENT_ID.test(id);

/** The part after the colon. */
export const idName = (id: string): string => id.slice(id.indexOf(":") + 1);

/** `device:<hand_id>` and `body:<hand_id>` for one hand. */
export const deviceId = (hand: string): string => `device:${hand}`;
export const bodyId = (hand: string): string => `body:${hand}`;

// ---------------------------------------------------------------------------------------------------------------------
// hand_id
// ---------------------------------------------------------------------------------------------------------------------

/** Unpadded base64url, the encoding of ids and tokens. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The id of a hand: base64url(sha256(its identity public key, SPKI DER)), first 22 characters.
 * Asynchronous because Web Crypto is (Node, browsers and Workers all have `crypto.subtle`).
 */
export async function handId(spki: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", spki as BufferSource);
  return base64url(new Uint8Array(digest)).slice(0, HAND_ID_LENGTH);
}
