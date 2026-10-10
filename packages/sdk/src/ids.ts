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
/** The app id without its `app:` prefix, as app.json writes it. */
export const APP_NAME_PATTERN = "^[a-z][a-z0-9-]{0,47}$";

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

// SHA-256 written out here so that ids work the same in Node, the browser and the tests, synchronously. The constants
// are the first 32 bits of the fractional parts of the square and cube roots of the first primes (FIPS 180-4).
const primes: number[] = [];
for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p !== 0)) primes.push(n);
const frac32 = (x: number): number => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0;
const H0 = primes.slice(0, 8).map((p) => frac32(Math.sqrt(p)));
const K = primes.map((p) => frac32(Math.cbrt(p)));

export function sha256(data: Uint8Array): Uint8Array {
  const h = Uint32Array.from(H0);
  const length = data.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000), false);
  view.setUint32(padded.length - 4, (length << 3) >>> 0, false);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => outView.setUint32(i * 4, word, false));
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64URL[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64URL[n & 63]!;
  }
  return out;
}

/** The id of a hand: base64url(sha256(its identity public key, SPKI DER)), first 22 characters. */
export function handId(spki: Uint8Array): string {
  return base64url(sha256(spki)).slice(0, HAND_ID_LENGTH);
}
