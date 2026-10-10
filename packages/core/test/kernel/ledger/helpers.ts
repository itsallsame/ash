import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { Ledger } from "../../../src/kernel/ledger";

const dirs: string[] = [];
const ledgers: Ledger[] = [];
after(() => {
  for (const ledger of ledgers) { try { ledger.close(); } catch { /* already closed */ } }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
  dirs.push(dir);
  return dir;
}

export function openLedger(): { ledger: Ledger; dir: string; path: string } {
  const dir = tempDir();
  const path = join(dir, "state", "ash.db");
  const ledger = Ledger.open(path);
  ledgers.push(ledger);
  return { ledger, dir, path };
}

export const say = (text: string, extra: Record<string, unknown> = {}) =>
  ({ from: "person:owner", to: "agent:main", kind: "event" as const, word: "say", body: { text }, ...extra });
