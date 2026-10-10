/**
 * `service:persona`: the approved SOUL.md and IDENTITY.md (SPEC-10 §1).
 *
 *   get     {file?}                     the approved version of each file: the only text a session loads
 *   propose {file, content, reason}     a new version. The contract is risk `structure` and is in the gate's
 *                                       always-ask list, so an agent's proposal reaches `handle` only after the
 *                                       owner said yes (the review model cannot say it for them); the owner's own
 *                                       change comes in as a human call and goes straight through.
 *
 * Every approved version is kept in the ledger's database (the first one is the template the hub started with); `get`
 * returns the newest. The files in the main body are never read back and never checked: an agent that edits SOUL.md
 * there changes nothing a session loads. An approved change shows in a session only when that session is opened, that
 * is at the next `session.reload` (the agents module sees the static text changed and opens a new session then).
 * The body's copy is rewritten with the approved text so the file the agent reads is the one in force.
 */
import { createHash } from "node:crypto";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import { seedBodyFile, writeBodyFile, type Sender } from "./shared";

export const PERSONA_ID = "service:persona";
export const PERSONA_FILES = ["SOUL.md", "IDENTITY.md"] as const;
export type PersonaFile = (typeof PERSONA_FILES)[number];

export interface PersonaOptions {
  ledger: Pick<Ledger, "db">;
  router: Sender;
  /** The text the first approved version of each file is made from (ash-skills/persona/*.template.md). */
  templates: Record<PersonaFile, string>;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export interface PersonaVersion { file: PersonaFile; content: string; version: string; approved_at: number; by: string; reason: string }

const SQL = `CREATE TABLE IF NOT EXISTS persona_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL, content TEXT NOT NULL, version TEXT NOT NULL,
  approved_at INTEGER NOT NULL, approved_by TEXT NOT NULL, reason TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS persona_versions_file ON persona_versions(file, id);`;

const versionOf = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 12);

export class PersonaService implements Member {
  readonly id = PERSONA_ID;
  readonly kind = "service" as const;
  readonly name = "Persona";
  private readonly db;
  private readonly now: () => number;
  private bodySeeded = false;

  constructor(private readonly options: PersonaOptions) {
    this.db = options.ledger.db();
    this.now = options.now ?? Date.now;
    this.db.exec(SQL);
    // The templates are the first approved versions, set down once (not again after a restart, and not over a later version).
    for (const file of PERSONA_FILES) if (!this.current(file)) this.insert(file, options.templates[file], "template", "the starting text shipped with ash");
  }

  words(): WordContract[] { return wordsOf(PERSONA_ID); }

  /** Put the approved files into the main body when they are not there yet. Best effort: the body may not be up; `tick` tries again. */
  async start(): Promise<void> { await this.seedBody(); }
  async tick(): Promise<void> { if (!this.bodySeeded) await this.seedBody(); }

  private async seedBody(): Promise<void> {
    let all = true;
    for (const file of PERSONA_FILES) all = (await seedBodyFile(this.options.router, PERSONA_ID, file, this.current(file)!.content)) && all;
    this.bodySeeded = all;
  }

  // ---- storage ----

  private insert(file: PersonaFile, content: string, by: string, reason: string): PersonaVersion {
    this.db.prepare("INSERT INTO persona_versions (file, content, version, approved_at, approved_by, reason) VALUES (?,?,?,?,?,?)")
      .run(file, content, versionOf(content), this.now(), by, reason);
    return this.current(file)!;
  }

  /** The newest approved version of a file. */
  current(file: PersonaFile): PersonaVersion | null {
    const row = this.db.prepare("SELECT file, content, version, approved_at, approved_by AS by, reason FROM persona_versions WHERE file=? ORDER BY id DESC LIMIT 1").get(file) as PersonaVersion | undefined;
    return row ?? null;
  }

  /** Every approved version of a file, oldest first (for the owner's page and for tests). */
  versions(file: PersonaFile): PersonaVersion[] {
    return this.db.prepare("SELECT file, content, version, approved_at, approved_by AS by, reason FROM persona_versions WHERE file=? ORDER BY id").all(file) as unknown as PersonaVersion[];
  }

  // ---- words ----

  async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    const body = (msg.body ?? {}) as Record<string, unknown>;
    switch (msg.word) {
      case "get": return { data: this.get(body.file as PersonaFile | undefined) };
      case "propose": return { data: await this.propose(body, ctx) };
      default: throw new WordError("not_found", `service:persona has no word ${msg.word}`);
    }
  }

  private get(file?: PersonaFile) {
    const files = (file ? [file] : [...PERSONA_FILES]).map((f) => this.current(f)).filter((v): v is PersonaVersion => v !== null)
      .map(({ file, content, version, approved_at }) => ({ file, content, version, approved_at }));
    return { files };
  }

  private async propose(body: Record<string, unknown>, ctx: HandleContext) {
    const file = body.file as PersonaFile;
    const content = body.content as string;
    if (!PERSONA_FILES.includes(file)) throw new WordError("bad_request", "file must be SOUL.md or IDENTITY.md");
    if (!String(body.reason ?? "").trim()) throw new WordError("bad_request", "reason is required: say why the change is wanted");
    if (this.current(file)?.content === content) return { proposed: false, applied: false };
    // Reaching here means the gate let the call through: the owner made it, or the owner approved it.
    this.insert(file, content, ctx.caller.member, String(body.reason).slice(0, 500));
    if (!(await writeBodyFile(this.options.router, PERSONA_ID, file, content))) this.options.log?.(`persona: could not write ${file} into the body; the approved version is in force anyway`);
    return { proposed: true, applied: true };
  }
}

export function createPersonaService(options: PersonaOptions): PersonaService { return new PersonaService(options); }
