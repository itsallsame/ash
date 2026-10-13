/** Proving who is at the other end of a connection (SPEC-03 §2.2): the local token, and the signature over the nonce. */
import { createPublicKey, timingSafeEqual, verify } from "node:crypto";

/** Whether an `Authorization` header carries exactly this token. */
export function bearerIs(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The SPKI bytes of a hand's public key, or null when it is not one. */
export function spkiBytes(publicKey: string): Uint8Array | null {
  try {
    createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    return Buffer.from(publicKey, "base64url");
  } catch {
    return null;
  }
}

/** `sig` is ECDSA P-256 over the UTF-8 bytes of the nonce, ASN.1 DER, base64url. */
export function signatureHolds(publicKey: string, nonce: string, sig: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(nonce, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}
