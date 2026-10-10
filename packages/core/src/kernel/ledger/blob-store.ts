/**
 * Content-addressed attachments: `<dir>/<first 2 hex of sha256>/<sha256>`, the same content stored once.
 * The `blobs` table records size and mime. Files are written before the row and moved into place with a rename, so a
 * crash leaves at worst an unreferenced file, never a row without a file.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class BlobStore {
  constructor(private readonly dir: string, private readonly db: DatabaseSync) {}

  private file(hash: string): string { return join(this.dir, hash.slice(0, 2), hash); }

  /** Store the bytes (once) and return the ref: the sha256 of the content, in lower-case hex. */
  put(bytes: Uint8Array, mime: string): string {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const target = this.file(hash);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        writeFileSync(temp, bytes, { mode: 0o600 });
        renameSync(temp, target);
      } finally { rmSync(temp, { force: true }); }
    }
    this.db.prepare("INSERT OR IGNORE INTO blobs(hash,size,mime,created_at) VALUES(?,?,?,?)").run(hash, bytes.byteLength, mime, Date.now());
    return hash;
  }

  get(ref: string): { bytes: Uint8Array; mime: string } | null {
    if (!HASH_PATTERN.test(ref)) return null;
    const row = this.db.prepare("SELECT mime FROM blobs WHERE hash=?").get(ref) as { mime: string } | undefined;
    if (!row) return null;
    const bytes = readFileSync(this.file(ref));
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime: row.mime };
  }
}
