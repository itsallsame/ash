import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The kernel's lines carry no level or time yet, so the last `lines` are all there is to choose by. */
const TAIL_BYTES = 256 * 1024;

/** The last `lines` lines of a text file (its last 256 KB at most), oldest first. A file that is not there has none. */
export function tailFile(path: string, lines: number): string[] {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const all = buffer.toString("utf8").split("\n");
    if (size > length) all.shift();
    if (all[all.length - 1] === "") all.pop();
    return all.slice(-lines);
  } finally { closeSync(fd); }
}
