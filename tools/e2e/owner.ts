/**
 * The owner from a command line (T13a): connects to the hub's local link as the owner's human channel, to say things,
 * read what comes back, answer cards and call words. It is the same connection a phone makes, and it is judged the same
 * way (SPEC-03 §2.2): the hub's local token, as `Authorization: Bearer`, and a signature over the challenge. There is no
 * other way in and nothing here skips either check. The token is read from a file or from standard input, never from an
 * argument (those land in shell history and `ps`).
 *
 * Built into one file without dependencies by `tools/e2e/build-owner.mjs`; see README.md next to it.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { base64url } from "../../packages/sdk/src/ids";
import type { PresentFrame, SendResultFrame } from "../../packages/sdk/src/link";
import type { Message } from "../../packages/sdk/src/message";
import { createNodeClient } from "../../packages/link/src/client";
import type { HandClient } from "../../packages/link/src/hand";

const VERSION = "0.1.0";
const OWNER = "person:owner";
const MAIN = "agent:main";
const USAGE = `owner.mjs: the owner of an Ash hub, from a command line.

  owner.mjs [options] say "<text>"                 say it to the primary agent (--to AGENT), wait for the reply, print it
  owner.mjs [options] watch [seconds]              print everything that arrives (messages, cards, presents); default 60, 0 = until stopped
  owner.mjs [options] answer <card id> <option> [text]   answer an approval card or a question (ask), or pick on an option card (show)
  owner.mjs [options] call <member> <word> ['<json>' | - | @file]   call a word as the owner; the JSON body from the argument, standard input (-) or a file
  owner.mjs [options] set-key [REF]                save a model key in the vault (service:vault/set); the key comes from --key-file or standard input

Connection (the hub's local link, SPEC-03 §2.2):
  --port N | --url ws://127.0.0.1:N/link     where the hub listens (env ASH_OWNER_PORT)
  --token-file PATH | --token-stdin           the hub's local token (env ASH_OWNER_TOKEN_FILE); never an argument
  --state DIR                                 where this client keeps its identity key (default ~/.ash-owner)
  --name NAME                                 how the hub lists this channel (default "owner-cli")
Options:
  --json            one JSON object per line instead of text lines
  --timeout S       say: give up waiting for a reply after S seconds (default 120)
  --settle S        say: after a reply, wait S seconds of quiet for more bubbles (default 1.5)
  --all             say: print every message of the ledger that arrives, not only those for the owner
  --history N       watch/say: also print the last N messages that were already there
  --surfaces LIST   human surfaces this channel declares, comma separated (default chat; watch: chat,notification)
  --key-file PATH   set-key: read the key from a file instead of standard input
  --label TEXT      set-key: the label shown for a ref the hub does not know

Exit codes: 0 done, 1 error (cannot connect, refused token), 2 say got no reply in time, 3 a word was refused or failed, 64 usage.
`;

// --- arguments -------------------------------------------------------------------------------------------------------------

interface Options {
  flags: Map<string, string | true>;
  rest: string[];
}
const VALUE_FLAGS = new Set(["port", "url", "token-file", "state", "name", "timeout", "settle", "history", "surfaces", "key-file", "label", "to"]);
const BOOL_FLAGS = new Set(["json", "token-stdin", "help", "all"]);

class UsageError extends Error {}

function parse(argv: string[]): Options {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { rest.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--") || arg === "-") { rest.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOL_FLAGS.has(name)) { flags.set(name, true); continue; }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option --${name}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { flags, rest };
}

// --- output ----------------------------------------------------------------------------------------------------------------

let asJson = false;
const stamp = (at = Date.now()): string => new Date(at).toISOString();
/** One line: `<time> <kind> key=value …`. Values with spaces or quotes are JSON-quoted, so a line splits on spaces. */
function line(kind: string, fields: Record<string, unknown>, raw?: unknown): void {
  const at = stamp();
  if (asJson) { process.stdout.write(`${JSON.stringify({ at, kind, ...fields, ...(raw !== undefined ? { raw } : {}) })}\n`); return; }
  const parts = Object.entries(fields).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${plain(v)}`);
  process.stdout.write(`${at} ${kind}${parts.length ? ` ${parts.join(" ")}` : ""}\n`);
}
const plain = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /^[^\s"=]+$/.test(s) ? s : JSON.stringify(s);
};

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {}); // eslint-disable-line @typescript-eslint/no-explicit-any

/** A message as one line; cards and questions are spelled out with their options. */
function describeMessage(m: Message, tag = "msg"): void {
  const b = asRecord(m.body);
  const base = { seq: m.seq, id: m.id, from: m.from, to: m.to ?? "*", mkind: m.kind, word: m.word, reply_to: m.reply_to };
  if (m.word === "ask" && m.kind === "request") {
    const options = (b.options as { id: string; label?: string; text?: string }[] | undefined) ?? (b.human_kind === "confirmation" ? [{ id: "yes", label: "yes" }, { id: "no", label: "no" }] : []);
    line("ask", { ...base, title: b.title, detail: b.detail, options: options.map((o) => `${o.id}:${o.label ?? o.text ?? ""}`).join(","), expires_at: b.expires_at }, m);
    return;
  }
  if (m.word === "show") {
    const card = asRecord(b.card);
    const options = ((card.options as { id: string; text: string }[] | undefined) ?? []).map((o) => `${o.id}:${o.text}`).join(",");
    line("card", { ...base, type: card.type, prompt: card.prompt, title: card.title, url: card.url, path: card.path, options }, m);
    return;
  }
  const text = typeof b.text === "string" ? b.text : m.kind === "response" ? JSON.stringify(b) : b.text === undefined && Object.keys(b).length ? JSON.stringify(b) : "";
  line(tag, { ...base, text }, m);
}

function describePresent(f: PresentFrame): void {
  const b = asRecord(f.body);
  const options = Array.isArray(b.options) ? (b.options as { id: string; text?: string; label?: string }[]).map((o) => `${o.id}:${o.text ?? o.label ?? ""}`).join(",") : undefined;
  line("present", { surface: f.surface, op: f.op, id: asRecord(f.body).id ?? f.id, pkind: b.kind, title: b.title, text: b.text, options, reply_target: b.reply_target, status: b.state ?? b.status }, f);
}

// --- the identity ----------------------------------------------------------------------------------------------------------

interface Identity { publicKey: string; sign(nonce: string): string }

/** The key of this client, made once and kept in <state>/identity.json (owner-only): the hub knows the channel by it. */
function loadIdentity(stateDir: string): Identity {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, "identity.json");
  let privatePem: string;
  if (existsSync(file)) {
    privatePem = JSON.parse(readFileSync(file, "utf8")).private_pem;
  } else {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeFileSync(file, JSON.stringify({ private_pem: privatePem }), { mode: 0o600 });
  }
  const key = createPrivateKey(privatePem);
  const publicKey = base64url(createPublicKey(key).export({ type: "spki", format: "der" }));
  return { publicKey, sign: (nonce) => base64url(signBytes("sha256", Buffer.from(nonce, "utf8"), { key, dsaEncoding: "der" })) };
}

// --- input -----------------------------------------------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError("standard input is a terminal: pipe the value in or use a file");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

let stdinUsed = false;
async function stdinOnce(): Promise<string> {
  if (stdinUsed) throw new UsageError("standard input can be used for one thing only");
  stdinUsed = true;
  return readStdin();
}

async function localToken(o: Options): Promise<string> {
  const file = (o.flags.get("token-file") as string | undefined) ?? process.env.ASH_OWNER_TOKEN_FILE;
  if (o.flags.has("token-stdin")) {
    const first = (await stdinOnce()).split(/\r?\n/, 1)[0]!.trim();
    if (!first) throw new UsageError("--token-stdin: nothing came in");
    return first;
  }
  if (!file) throw new UsageError("the hub's local token is needed: --token-file PATH (or --token-stdin)");
  const token = readFileSync(resolve(file), "utf8").trim();
  if (!token) throw new UsageError(`${file} is empty`);
  return token;
}

function linkUrl(o: Options): string {
  const url = o.flags.get("url") as string | undefined;
  if (url) return url;
  const port = (o.flags.get("port") as string | undefined) ?? process.env.ASH_OWNER_PORT;
  if (!port || !/^\d{1,5}$/.test(port)) throw new UsageError("where the hub listens is needed: --port N (or --url ws://127.0.0.1:N/link)");
  return `ws://127.0.0.1:${port}/link`;
}

const seconds = (o: Options, name: string, fallback: number): number => {
  const v = o.flags.get(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a number of seconds`);
  return n;
};

// --- the session -----------------------------------------------------------------------------------------------------------

class Failure extends Error { constructor(message: string, readonly code: number) { super(message); } }

class Owner {
  readonly messages: Message[] = [];
  private readonly known = new Set<string>();
  private listeners: ((m: Message) => void)[] = [];
  private lastSeq = 0;
  /** The highest seq the first page showed: what was already there. */
  baseline = 0;
  clientId = "";
  private firstPage!: () => void;
  private firstPageSeen = new Promise<void>((r) => { this.firstPage = r; });
  private closedFor: Failure | null = null;
  private failed!: (f: Failure) => void;
  private readonly dead = new Promise<never>((_, reject) => { this.failed = reject; });
  readonly client: HandClient;
  /** Messages seen (live or in the first page) are given to this, in order. */
  onMessage: (m: Message, backlog: boolean) => void = () => {};
  onPresent: (f: PresentFrame) => void = () => {};

  constructor(o: Options, url: string, token: string, surfaces: string[], private readonly connectMs: number) {
    const identity = loadIdentity(resolve((o.flags.get("state") as string | undefined) ?? join(homedir(), ".ash-owner")));
    let everReady = false;
    this.dead.catch(() => {}); // reported where it is awaited
    this.client = createNodeClient({
      url, headers: () => ({ authorization: `Bearer ${token}` }),
      hand: { kind: "computer", name: (o.flags.get("name") as string | undefined) ?? `owner-cli@${hostname()}`, version: VERSION, platform: `${process.platform}-${process.arch}`, public_key: identity.publicKey },
      channels: { human: { label: "owner command line", surfaces: surfaces as never } },
      sign: (nonce) => identity.sign(nonce),
      handlers: {
        welcome: (w) => {
          everReady = true;
          const grant = w.channels.human;
          if (grant && "client" in grant) { this.clientId = grant.client; line("conn", { state: "welcomed", hand: w.hand_id, client: grant.client, local: grant.local }); }
          else { this.failed(new Failure(`the hub did not open the human channel: ${JSON.stringify(grant)}`, 1)); return; }
          let backlog = !this.lastSeq && !this.baseline;
          this.client.openSync(this.lastSeq ? { after: this.lastSeq, follow: true, summary: true } : { follow: true, summary: true }, {
            page: (frame) => {
              for (const m of frame.messages as unknown as Message[]) this.take(m, backlog);
              if (frame.end) { backlog = false; this.firstPage(); }
            },
            message: (frame) => this.take(frame.message as unknown as Message, false),
          });
        },
        present: async (frame) => {
          this.onPresent(frame);
          if (frame.surface === "chat" && frame.op === "open") return { ok: true, data: { opened: false } };
          if (frame.surface === "island") return { ok: true, data: { showing: false } };
          return { ok: true };
        },
        closed: ({ code, reason, willReconnect }) => {
          line("conn", { state: "closed", code, reason, reconnect: willReconnect });
          if (code === 4001 && !everReady) this.failed(new Failure(`the hub refused this connection (4001 ${reason}): the local token is not the one of the running hub, or the signature did not hold`, 1));
          else if (code === 4003) this.failed(new Failure("the hub revoked this channel (4003): it is not allowed to come back", 1));
          else if (!willReconnect) this.failed(new Failure(`the connection ended for good (${code} ${reason})`, 1));
        },
      },
    });
  }

  private take(m: Message, backlog: boolean): void {
    if (this.known.has(m.id)) return;
    this.known.add(m.id);
    this.messages.push(m);
    if (m.seq > this.lastSeq) this.lastSeq = m.seq;
    if (backlog) this.baseline = Math.max(this.baseline, m.seq);
    this.onMessage(m, backlog);
  }

  /** Connects and waits for the welcome and the first page of the conversation. */
  async open(): Promise<void> {
    this.client.start();
    const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Failure(`could not connect within ${this.connectMs / 1000} s (is the hub up, and is the port forwarded?)`, 1)), this.connectMs).unref());
    await Promise.race([this.client.ready().then(() => this.firstPageSeen), this.dead, timer]);
    this.baseline = Math.max(this.baseline, this.lastSeq);
  }

  /** Rejects when the connection is lost for good. */
  readonly lost = (): Promise<never> => this.dead;

  close(): void { this.client.stop(); }

  async send(request: Parameters<HandClient["send"]>[0]): Promise<SendResultFrame> {
    return Promise.race([this.client.send({ client_id: `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, ...request }), this.dead]);
  }

  /** Looks a message up by its id (or its seq) in the conversation, newest first. */
  async find(ref: string): Promise<Message | null> {
    const have = this.messages.find((m) => m.id === ref || String(m.seq) === ref);
    if (have) return have;
    let before: number | undefined;
    for (let pages = 0; pages < 25; pages++) {
      const page = await new Promise<{ messages: Message[] }>((resolveP) => {
        const handle = this.client.openSync({ ...(before ? { before } : {}), limit: 200, summary: true }, {
          page: (frame) => { if (frame.end) { handle.close(); resolveP({ messages: frame.messages as unknown as Message[] }); } },
          message: () => {},
        });
      });
      const hit = page.messages.find((m) => m.id === ref || String(m.seq) === ref);
      if (hit) return hit;
      if (page.messages.length < 200) return null;
      before = Math.min(...page.messages.map((m) => m.seq));
    }
    return null;
  }
}

async function connect(o: Options, surfaces: string[]): Promise<Owner> {
  const owner = new Owner(o, linkUrl(o), await localToken(o), surfaces, 20_000);
  await owner.open();
  return owner;
}

const sendError = (r: SendResultFrame): string => (!r.ok ? `${r.error.code}: ${r.error.message}` : "");
const surfacesOf = (o: Options, fallback: string): string[] => ((o.flags.get("surfaces") as string | undefined) ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);

// --- commands --------------------------------------------------------------------------------------------------------------

/** A message that is the agent's answer to the owner: something said or shown to them, or a question for them. */
const isAnswer = (m: Message): boolean => m.to === OWNER && m.kind !== "response" && (m.word === "say" || m.word === "show" || m.word === "ask");

function printBacklog(owner: Owner, o: Options): void {
  const n = Number(o.flags.get("history") ?? 0);
  if (n > 0) for (const m of owner.messages.slice(-n)) describeMessage(m, "history");
}

async function say(o: Options): Promise<number> {
  const text = o.rest[1];
  if (!text) throw new UsageError('say needs the text: owner.mjs say "<text>"');
  const owner = await connect(o, surfacesOf(o, "chat"));
  try {
    printBacklog(owner, o);
    const settleMs = seconds(o, "settle", 1.5) * 1000;
    const timeoutMs = seconds(o, "timeout", 120) * 1000;
    const all = o.flags.has("all");
    let mine = 0;
    let replies = 0;
    let lastReply = 0;
    owner.onMessage = (m, backlog) => {
      if (backlog) return;
      // The owner's own words and the answers to them are in the ledger too; `say` shows what is for the owner (all of it with --all).
      if (all || (m.to === OWNER && m.kind !== "response")) describeMessage(m);
      if (mine && m.seq > mine && isAnswer(m)) { replies++; lastReply = Date.now(); }
    };
    owner.onPresent = describePresent;
    const to = (o.flags.get("to") as string | undefined) ?? MAIN;
    const sent = await owner.send({ to, kind: "request", word: "say", body: { text } });
    if (!sent.ok) throw new Failure(`the hub refused the message: ${sendError(sent)}`, 3);
    mine = sent.message.seq;
    line("sent", { seq: sent.message.seq, id: sent.message.id, to });
    const started = Date.now();
    // Done when the agent has answered and then been quiet for the settle time; a question waiting for the owner ends it too.
    for (;;) {
      await Promise.race([new Promise((r) => setTimeout(r, 100)), owner.lost()]);
      const now = Date.now();
      const asked = owner.messages.some((m) => m.seq > mine && m.word === "ask" && m.to === OWNER);
      if (replies > 0 && now - lastReply >= settleMs) break;
      if (asked && now - started > settleMs && now - lastReply >= settleMs) break;
      if (now - started > timeoutMs) { line("timeout", { waited_s: Math.round((now - started) / 1000), replies }); return replies ? 0 : 2; }
    }
    line("done", { replies, waited_ms: Date.now() - started });
    return 0;
  } finally { owner.close(); }
}

async function watch(o: Options): Promise<number> {
  const secs = o.rest[1] === undefined ? 60 : Number(o.rest[1]);
  if (!Number.isFinite(secs) || secs < 0) throw new UsageError("watch [seconds]: seconds must be a number");
  const owner = await connect(o, surfacesOf(o, "chat,notification"));
  try {
    printBacklog(owner, o);
    owner.onMessage = (m, backlog) => { if (!backlog) describeMessage(m); };
    owner.onPresent = describePresent;
    const stop = new Promise<void>((r) => { if (secs > 0) setTimeout(r, secs * 1000).unref(); process.once("SIGINT", r); process.once("SIGTERM", r); });
    await Promise.race([stop, owner.lost()]);
    line("done", { watched_s: secs });
    return 0;
  } finally { owner.close(); }
}

async function answer(o: Options): Promise<number> {
  const [, id, choice, ...text] = o.rest;
  if (!id || !choice) throw new UsageError("answer needs a card id and an option: owner.mjs answer <card id> <option> [text]");
  const owner = await connect(o, surfacesOf(o, "chat"));
  try {
    const card = await owner.find(id);
    if (!card) throw new Failure(`no message ${id} in the conversation`, 3);
    const body = asRecord(card.body);
    let sent: SendResultFrame;
    if (card.word === "ask" && card.kind === "request") {
      sent = await owner.send({ to: card.from, kind: "response", word: "ask", reply_to: card.id, body: { ok: true, result: { data: { choice, ...(text.length ? { text: text.join(" ") } : {}) } } } });
    } else if (card.word === "show" && asRecord(body.card).type === "options") {
      sent = await owner.send({ to: card.from, kind: "request", word: "say", body: { in_reply_to: card.id, option_id: choice } });
    } else {
      throw new Failure(`message ${id} is a ${card.kind} ${card.word}, not a question or an option card`, 3);
    }
    if (!sent.ok) throw new Failure(`the hub refused the answer: ${sendError(sent)}`, 3);
    line("answered", { card: card.id, from: card.from, choice, seq: sent.message.seq, duplicate: sent.duplicate });
    return 0;
  } finally { owner.close(); }
}

async function jsonBody(arg: string | undefined): Promise<Record<string, unknown>> {
  if (arg === undefined) return {};
  const text = arg === "-" ? await stdinOnce() : arg.startsWith("@") ? readFileSync(resolve(arg.slice(1)), "utf8") : arg;
  let value: unknown;
  try { value = text.trim() ? JSON.parse(text) : {}; } catch (error) { throw new UsageError(`the body is not JSON: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError("the body must be a JSON object");
  return value as Record<string, unknown>;
}

async function callWord(o: Options, to: string, word: string, body: Record<string, unknown>, redact: boolean): Promise<number> {
  const owner = await connect(o, surfacesOf(o, "chat"));
  try {
    const sent = await owner.send({ to, kind: "request", word, body, wait: true });
    if (!sent.ok) { line("result", { to, word, ok: false, code: sent.error.code, message: sent.error.message }); return 3; }
    const reply = asRecord(sent.response);
    if (reply.ok === false) { line("result", { to, word, ok: false, code: reply.error?.code, message: reply.error?.message }); return 3; }
    line("result", { to, word, ok: true, data: redact ? { ...asRecord(reply.result?.data), value: undefined } : reply.result?.data, content: reply.result?.content }, redact ? undefined : reply);
    return 0;
  } finally { owner.close(); }
}

async function setKey(o: Options): Promise<number> {
  const ref = o.rest[1] ?? "DEEPSEEK_API_KEY";
  const file = o.flags.get("key-file") as string | undefined;
  const value = (file ? readFileSync(resolve(file), "utf8") : await stdinOnce()).replace(/\r?\n$/, "");
  if (!value.trim()) throw new UsageError("the key is empty");
  if (/\s/.test(value)) throw new UsageError("the key has whitespace in it; it was not saved");
  const label = o.flags.get("label") as string | undefined;
  return callWord(o, "service:vault", "set", { ref, value, ...(label ? { label } : {}) }, true);
}

async function main(argv: string[]): Promise<number> {
  const o = parse(argv);
  asJson = o.flags.has("json");
  const command = o.rest[0];
  if (!command || o.flags.has("help") || command === "help") { process.stdout.write(USAGE); return command || o.flags.has("help") ? 0 : 64; }
  switch (command) {
    case "say": return say(o);
    case "watch": return watch(o);
    case "answer": return answer(o);
    case "call": {
      const [, member, word, json] = o.rest;
      if (!member || !word) throw new UsageError("call needs a member and a word: owner.mjs call <member> <word> ['<json>']");
      return callWord(o, member, word, await jsonBody(json), false);
    }
    case "set-key": return setKey(o);
    default: throw new UsageError(`unknown command ${command}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    if (error instanceof UsageError) { process.stderr.write(`owner.mjs: ${error.message}\n(owner.mjs help)\n`); process.exit(64); }
    if (error instanceof Failure) { line("error", { message: error.message }); process.exit(error.code); }
    line("error", { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  },
);
