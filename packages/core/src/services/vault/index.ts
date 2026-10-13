/**
 * `service:vault`: the words over the vault (HUB-MODULES §1.7, §3).
 *
 *   list / describe     which credentials are saved: name, label, kind, whether set. Never a value.
 *   set {ref, value, label?, kind?}   owner, this machine. The value is read from `ctx.raw`: `msg.body` holds only
 *                       the masked `{set: true, length}` the router put on the ledger.
 *   delete {ref}        owner, this machine.
 *
 * After a change the service sends the event `vault.changed {ref, action}` (names only) to `service:agents`, whose
 * module listens for it to configure the runtimes' own credential files. The vault object is not passed on: this
 * service only sets, deletes and lists. Labels and kinds are not secret; they live in the ledger database (`vault_meta`).
 */
import { WordError, type Caller, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Router, Vault } from "../../kernel/types";
import { REF_PATTERN } from "../../kernel/vault";

export const VAULT_ID = "service:vault";
type Kind = "model" | "login" | "api" | "other";

/** What the owner sees a known credential called. Anything else is shown under its own name. */
const KNOWN: Record<string, { label: string; kind: Kind }> = {
  DEEPSEEK_API_KEY: { label: "DeepSeek（对话模型）", kind: "model" },
  OPENROUTER_API_KEY: { label: "OpenRouter（小模型判断）", kind: "model" },
};

export interface VaultServiceOptions {
  /** Only `list`, `set` and `delete` are used; `use` is never called here. */
  vault: Pick<Vault, "set" | "delete" | "list">;
  ledger: Pick<Ledger, "db">;
  router: Pick<Router, "send">;
  log?: (message: string, error?: unknown) => void;
}

const SELF: Caller = { member: VAULT_ID, via: "service", local: true };

export function createVaultService(options: VaultServiceOptions): Member {
  const { vault, router } = options;
  const db = options.ledger.db();
  const log = options.log ?? ((m, e) => console.error(`[vault] ${m}${e ? `: ${(e as Error).message}` : ""}`));
  db.exec("CREATE TABLE IF NOT EXISTS vault_meta (ref TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL)");

  const meta = (ref: string): { label: string; kind: Kind } => {
    const row = db.prepare("SELECT label, kind FROM vault_meta WHERE ref=?").get(ref) as { label: string; kind: Kind } | undefined;
    return row ?? KNOWN[ref] ?? { label: ref, kind: "other" };
  };
  const entry = (ref: string) => {
    const set = vault.list().find((e) => e.ref === ref);
    return { ref, ...meta(ref), configured: set !== undefined, ...(set ? { updated_at: set.set_at } : {}) };
  };
  const announce = (ref: string, action: "saved" | "removed"): void => {
    router.send({ to: "service:agents", kind: "event", word: "vault.changed", body: { ref, action } }, SELF)
      .then((reply) => { if (!reply.ok) log(`vault.changed ${ref}: ${reply.error.code}: ${reply.error.message}`); }, (error) => log("vault.changed failed", error));
  };
  const refOf = (body: unknown): string => {
    const ref = (body as { ref?: unknown } | null)?.ref;
    if (typeof ref !== "string" || !REF_PATTERN.test(ref)) throw new WordError("bad_request", "ref is letters, digits and _ (at most 64), starting with a letter or _");
    return ref;
  };

  return {
    id: VAULT_ID, kind: "service", name: "Vault",
    words: (): WordContract[] => wordsOf(VAULT_ID),
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
      switch (msg.word) {
        case "list": {
          const refs = new Set([...Object.keys(KNOWN), ...vault.list().map((e) => e.ref)]);
          return { data: { entries: [...refs].sort().map(entry) } };
        }
        case "describe": return { data: entry(refOf(msg.body)) };
        case "set": {
          // The plaintext is only in the original request; the ledger's copy of the body is the masked placeholder.
          const raw = (ctx.raw ?? {}) as { ref?: unknown; value?: unknown; label?: unknown; kind?: unknown };
          const ref = refOf(raw);
          if (typeof raw.value !== "string") throw new WordError("bad_request", "value must be the secret text");
          try { vault.set(ref, raw.value); } catch (error) { throw new WordError("bad_request", (error as Error).message); }
          const known = KNOWN[ref];
          const label = typeof raw.label === "string" ? raw.label : meta(ref).label;
          const kind = (typeof raw.kind === "string" ? raw.kind : known?.kind ?? meta(ref).kind) as Kind;
          db.prepare("INSERT INTO vault_meta(ref,label,kind) VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET label=excluded.label, kind=excluded.kind").run(ref, label, kind);
          announce(ref, "saved");
          return { data: { ref, configured: true } };
        }
        case "delete": {
          const ref = refOf(msg.body);
          const existed = vault.list().some((e) => e.ref === ref);
          if (existed) { vault.delete(ref); db.prepare("DELETE FROM vault_meta WHERE ref=?").run(ref); announce(ref, "removed"); }
          return { data: { deleted: existed } };
        }
        default: throw new WordError("not_found", `service:vault has no word ${msg.word}`);
      }
    },
  };
}
