// What the app edge remembers, in three tables of the ledger's database (created through `ledger.db()`):
//   apps_installed  which apps the owner installed, whether they run, which `listens` the owner approved
//   app_grants      what each app may use of the hub: one row per need (a member id, or notify / widgets / card)
//   app_quota       a count per app, kind and day (wakes and the like)
// Every call an app makes is checked against app_grants; nothing here widens without an install approval.
import type { AppNeed } from "../../../../sdk/src/app";
import type { Db, Ledger } from "../../kernel/ledger";

/** The key a need is granted and revoked by: its member id, or notify / widgets / card. */
export const needKey = (need: AppNeed): string => ("member" in need ? need.member : "notify" in need ? "notify" : "widgets" in need ? "widgets" : "card");

export interface AppGrant {
  version: string;
  granted_at: number;
  enabled: boolean;
  /** Seeded with the hub (the owner's own organs), not installed through a card. */
  builtin: boolean;
  needs: AppNeed[];
  /** The events the owner approved the app to hear. */
  listens: string[];
}

const SQL = `
CREATE TABLE IF NOT EXISTS apps_installed (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  listens TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS app_grants (
  app TEXT NOT NULL,
  need TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (app, need)
);
CREATE TABLE IF NOT EXISTS app_quota (
  app TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (app, kind)
);
`;

type Row = Record<string, unknown>;

export class AppGrants {
  private readonly db: Db;
  constructor(private readonly ledger: Pick<Ledger, "db" | "tx">, private readonly now: () => number = Date.now) {
    this.db = ledger.db();
    this.db.exec(SQL);
  }

  get(id: string): AppGrant | null {
    const row = this.db.prepare("SELECT * FROM apps_installed WHERE id=?").get(id) as Row | undefined;
    if (!row) return null;
    const needs = (this.db.prepare("SELECT grant_json FROM app_grants WHERE app=? ORDER BY granted_at, need").all(id) as Row[])
      .map((r) => JSON.parse(String(r.grant_json)) as AppNeed);
    return {
      version: String(row.version), granted_at: Number(row.installed_at), enabled: row.enabled === 1, builtin: row.builtin === 1,
      needs, listens: JSON.parse(String(row.listens)) as string[],
    };
  }

  ids(): string[] {
    return (this.db.prepare("SELECT id FROM apps_installed ORDER BY id").all() as Row[]).map((r) => String(r.id));
  }

  /** The owner approved exactly these needs and listens, from now on (replacing any earlier approval). */
  grant(id: string, version: string, needs: readonly AppNeed[], listens: readonly string[], options: { builtin?: boolean } = {}): AppGrant {
    const at = this.now();
    const keep = this.db.prepare("SELECT builtin FROM apps_installed WHERE id=?").get(id) as Row | undefined;
    const builtin = options.builtin ?? keep?.builtin === 1;
    this.ledger.tx(() => {
      this.db.prepare("DELETE FROM app_grants WHERE app=?").run(id);
      this.db.prepare("INSERT OR REPLACE INTO apps_installed (id, version, installed_at, enabled, builtin, listens) VALUES (?,?,?,?,?,?)")
        .run(id, version, at, 1, builtin ? 1 : 0, JSON.stringify([...listens]));
      const insert = this.db.prepare("INSERT INTO app_grants (app, need, grant_json, granted_at) VALUES (?,?,?,?)");
      for (const need of needs) insert.run(id, needKey(need), JSON.stringify(need), at);
    });
    return this.get(id)!;
  }

  setEnabled(id: string, enabled: boolean): AppGrant | null {
    this.db.prepare("UPDATE apps_installed SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  /** Take back one need (a member id, notify / widgets / card, or `listens`), or the whole app when none is given. Only ever narrows. */
  revoke(id: string, need?: string): AppGrant | null {
    if (!this.get(id)) return null;
    if (need === undefined) {
      this.db.prepare("DELETE FROM app_grants WHERE app=?").run(id);
      this.db.prepare("DELETE FROM apps_installed WHERE id=?").run(id);
      this.db.prepare("DELETE FROM app_quota WHERE app=?").run(id);
      return null;
    }
    if (need === "listens") this.db.prepare("UPDATE apps_installed SET listens='[]' WHERE id=?").run(id);
    else this.db.prepare("DELETE FROM app_grants WHERE app=? AND need=?").run(id, need);
    return this.get(id);
  }

  /** May app:<id> use member/word through a need? Only an enabled app, only a granted word. */
  allows(app: string, member: string, word: string): boolean {
    const id = app.replace(/^app:/, "");
    const grant = this.get(id);
    return Boolean(grant?.enabled && grant.needs.some((need) => "member" in need && need.member === member && need.words.includes(word)));
  }

  has(id: string, kind: "notify" | "widgets" | "card"): boolean {
    const grant = this.get(id);
    return Boolean(grant?.enabled && grant.needs.some((need) => needKey(need) === kind));
  }

  /** At most `limit` of this kind per app per local day. Records the use when it is allowed. */
  take(id: string, kind: string, limit: number): boolean {
    const day = new Date(this.now()).toLocaleDateString("sv-SE");
    const row = this.db.prepare("SELECT day, n FROM app_quota WHERE app=? AND kind=?").get(id, kind) as Row | undefined;
    const used = row && row.day === day ? Number(row.n) : 0;
    if (used >= limit) return false;
    this.db.prepare("INSERT OR REPLACE INTO app_quota (app, kind, day, n) VALUES (?,?,?,?)").run(id, kind, day, used + 1);
    return true;
  }
}
