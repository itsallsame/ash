/**
 * The vault (HUB-MODULES §1.7): sealed storage for the credentials the hub uses. One file, `vault.json`, AES-256-GCM.
 *
 * - The seal key comes from the host and is given to the constructor. There is no plaintext mode: without a key the
 *   vault does not start, and a file that is not sealed is refused, not read.
 * - `use` returns the plaintext. It is handed only to `edges/llm` and `edges/agents`; assembly makes sure nobody else
 *   gets this object (the words in services/vault see only `list`, `set`, `delete`).
 * - Nothing here logs, throws or returns a value in a message.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Vault } from "../types";

export const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_VALUE_LENGTH = 4096;
const SEAL_KEY_BYTES = 32;

/** The vault cannot start: no seal key, or a wrong one, or a file that is not a sealed vault. */
export class VaultUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "VaultUnavailableError"; }
}

/** The host's seal key (the boot line on the core's private pipe, SPEC-07): 32 bytes. */
export function parseSealKey(text: string | undefined): Buffer {
  const key = text ? Buffer.from(text.trim(), "base64url") : Buffer.alloc(0);
  if (key.length !== SEAL_KEY_BYTES) throw new VaultUnavailableError("the vault needs a 32-byte seal key from the host");
  return key;
}

export interface VaultOptions {
  /** `<state>/vault.json` */
  file: string;
  /** 32 bytes. */
  sealKey: Uint8Array;
  now?: () => number;
}

interface Entry { value: string; set_at: number }

export function openVault(options: VaultOptions): Vault {
  if (!options.sealKey || options.sealKey.length !== SEAL_KEY_BYTES) throw new VaultUnavailableError("the vault needs a 32-byte seal key; it does not store anything unsealed");
  const key = Buffer.from(options.sealKey);
  const now = options.now ?? Date.now;
  const { file } = options;

  const seal = (text: string): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return JSON.stringify({ sealed: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
  };
  const open = (raw: string): string => {
    const outer = JSON.parse(raw) as { sealed?: unknown; iv?: string; tag?: string; data?: string };
    if (outer.sealed !== 1 || typeof outer.iv !== "string" || typeof outer.tag !== "string" || typeof outer.data !== "string") throw new Error("not a sealed vault");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(outer.iv, "base64"));
    decipher.setAuthTag(Buffer.from(outer.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(outer.data, "base64")), decipher.final()]).toString("utf8");
  };

  let entries: Record<string, Entry> = {};
  if (existsSync(file)) {
    try { entries = (JSON.parse(open(readFileSync(file, "utf8"))) as { entries: Record<string, Entry> }).entries; }
    catch { throw new VaultUnavailableError(`the vault file cannot be opened with this seal key; it was left untouched: ${file}`); }
  }

  const save = (next: Record<string, Entry>): void => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, seal(JSON.stringify({ version: 1, entries: next })), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    entries = next;
  };

  return {
    set(ref, value) {
      if (!REF_PATTERN.test(ref)) throw new TypeError("a credential name is letters, digits and _, starting with a letter or _ (at most 64)");
      if (typeof value !== "string" || !value.trim() || value.length > MAX_VALUE_LENGTH) throw new TypeError(`a credential value is a non-empty string of at most ${MAX_VALUE_LENGTH} characters`);
      save({ ...entries, [ref]: { value: value.trim(), set_at: now() } });
    },
    delete(ref) {
      if (!Object.hasOwn(entries, ref)) return;
      const { [ref]: _gone, ...rest } = entries;
      save(rest);
    },
    list: () => Object.entries(entries).map(([ref, e]) => ({ ref, set_at: e.set_at, length: e.value.length })).sort((a, b) => a.ref.localeCompare(b.ref)),
    use: (ref) => (Object.hasOwn(entries, ref) ? entries[ref]!.value : null),
  };
}
