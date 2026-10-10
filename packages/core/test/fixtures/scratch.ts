import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const made: string[] = [];
process.once("exit", () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A directory holding [files] (name -> text), removed when the test process exits. For code that reads its templates from a directory. */
export function scratchDir(files: Record<string, string>, prefix = "scratch-"): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  made.push(dir);
  writeFiles(dir, files);
  return dir;
}

/** Writes (or replaces) [files] in [dir]. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
}
