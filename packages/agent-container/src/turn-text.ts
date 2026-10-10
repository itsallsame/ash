import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

// Text and file helpers for an agent turn: attachment storage, reply splitting, the standing notices.

/** Atomic, idempotent materialization; supplied filenames never determine the target. */
export function materializeFile(root: string, id: string, index: number, data: Buffer): { path: string; hash: string } {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(index) || index < 0) throw new TypeError("invalid attachment identity");
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(root)).isSymbolicLink()) throw new Error("attachment parent is not a safe directory");
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("attachment root is not a safe directory");
  const directory = realpathSync(root);
  const hash = createHash("sha256").update(data).digest("hex");
  const path = join(directory, `${id}-${index}-${hash}`);
  const claim = join(directory, `${id}-${index}.claim`);
  const temp = join(directory, `.tmp-${randomUUID()}`);
  try {
    const descriptor = openSync(temp, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < data.length) offset += writeSync(descriptor, data, offset, data.length - offset);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    try { linkSync(temp, claim); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(claim);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== data.length ||
        createHash("sha256").update(readFileSync(claim)).digest("hex") !== hash) throw new Error("existing attachment differs");
    }
    try { linkSync(claim, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== data.length ||
        createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) throw new Error("existing attachment differs");
    }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
  return { path, hash };
}

/** Separate conversational paragraphs, never a fenced code block. */
/** Character pairs of a message with spacing and punctuation removed; two retellings of one answer share most of them. */
function pairs(text: string): Set<string> {
  const chars = [...text.toLowerCase().replace(/[\s，。！？、：；,.!?:;"“”「」（）()\-—*_`]/gu, "")];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** True when `text` only retells something already said: nearly the same pairs, in either direction. */
export function retells(text: string, said: Iterable<string>): boolean {
  const mine = pairs(text);
  if (mine.size < 6) return false;
  for (const earlier of said) {
    const theirs = pairs(earlier);
    if (theirs.size < 6) continue;
    let shared = 0;
    for (const pair of mine) if (theirs.has(pair)) shared++;
    const jaccard = shared / (mine.size + theirs.size - shared);
    const contained = shared / Math.min(mine.size, theirs.size);
    const similarSize = Math.min(mine.size, theirs.size) / Math.max(mine.size, theirs.size) >= 0.3;
    if (jaccard >= 0.5 || (contained >= 0.85 && similarSize)) return true;
  }
  return false;
}

export function splitAssistantText(text: string): string[] {
  const parts: string[] = [];
  let lines: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let indentedCode = false;
  const source = text.split("\n");
  const flush = () => { const value = lines.join("\n").replace(/^\n+|\n+$/g, ""); if (value.trim()) parts.push(value); lines = []; };
  for (let index = 0; index < source.length; index++) {
    const line = source[index];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // A closing fence has the same marker, at least the opener's length, and no info text.
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && /^[ \t]*$/.test(marker[2])) fence = null;
      lines.push(line);
      continue;
    }
    if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = { marker: marker[1][0], length: marker[1].length };
      indentedCode = false;
      lines.push(line);
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) { indentedCode = true; lines.push(line); continue; }
    if (!line.trim()) {
      const next = source.slice(index + 1).find((item) => item.trim());
      if (indentedCode && next && /^(?: {4}|\t)/.test(next)) lines.push(line);
      else { flush(); indentedCode = false; }
      continue;
    }
    indentedCode = false;
    lines.push(line);
  }
  flush();
  return parts;
}

/** Shown when a message arrives and no model key has been set. Plain words, and where to go. */
export const NO_MODEL_KEY = "我还没有模型的 Key，现在没法回你。请打开 设置 → 密钥，把 DeepSeek Key 填进去保存，马上就能聊了。";

/** What the owner is told when a model call fails: the likely cause in plain words, never the provider's raw payload. */
export function modelFailureText(failure: unknown): string {
  const detail = failure && typeof failure === "object" ? failure as { code?: unknown; status?: unknown; message?: unknown } : {};
  const text = `${String(detail.code ?? "")} ${String(detail.status ?? "")} ${String(detail.message ?? "")}`;
  if (/\b(401|403)\b|auth|api.?key|unauthori[sz]ed|forbidden/i.test(text))
    return "模型那边没认我的 Key，这次没能回你。请到 设置 → 密钥 检查一下 DeepSeek Key，换成有效的再保存。";
  if (/\b402\b|balance|insufficient|quota/i.test(text)) return "模型账户余额不足，这次没能回你。充值后再发一次就行。";
  if (/\b429\b|rate/i.test(text)) return "模型那边在限流，这次没能回你。过一会儿再发一次。";
  if (/network|fetch|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|offline/i.test(text)) return "连不上模型，这次没能回你。看看手机网络（或代理）是否通，再发一次。";
  return "模型那边出了点问题，这次没能回你。再发一次试试；还不行的话告诉我。";
}

/** The model has no clock; without this it runs a shell command just to learn the time. Stated afresh every turn. */
export function clockLine(now: number): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options }).format(new Date(now));
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now));
  return `Now: ${part({ weekday: "long" })} ${date} ${time} (${zone}, ${part({ timeZoneName: "shortOffset" }).split(", ").pop()}); epoch ms ${now}. Use this for dates and timers instead of running a command to read the clock.`;
}
