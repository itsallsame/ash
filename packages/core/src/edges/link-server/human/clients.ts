/**
 * The owner's channels (SPEC-01 §7.2): every connection that opened the `human` channel is one `client:<sid>`. The
 * table `human_clients` remembers them; what is live (the session, whether it is being looked at) is in memory only.
 */
import type { DatabaseSync } from "node:sqlite";
import type { HumanOrigin } from "../../../../../sdk/src/message";
import type { LinkSession } from "../../../../../link/src/server";

export const SURFACES = ["chat", "notification", "island", "widget", "status"] as const;
export type Surface = (typeof SURFACES)[number];

export interface ClientInfo {
  client: string;
  /** `device:<hand_id>` */
  hand: string;
  channel: HumanOrigin["channel"];
  provider?: string;
  label: string;
  local: boolean;
  surfaces: Surface[];
  connected_at: number;
  last_seen: number;
  visible: boolean;
}

export interface LiveClient extends ClientInfo {
  session: LinkSession;
  /** When it last became visible, and when it last did anything; "the channel the owner is on" is chosen by these. */
  visible_at: number;
  active_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS human_clients (
  sid TEXT PRIMARY KEY, channel TEXT NOT NULL, hand TEXT NOT NULL, provider TEXT, label TEXT NOT NULL,
  local INTEGER NOT NULL, surfaces TEXT NOT NULL, connected_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
);`;

export class Clients {
  private readonly live = new Map<string, LiveClient>();

  constructor(private readonly db: DatabaseSync, private readonly now: () => number) { db.exec(SCHEMA); }

  add(c: LiveClient): void {
    this.live.set(c.client, c);
    this.db.prepare(`INSERT INTO human_clients(sid,channel,hand,provider,label,local,surfaces,connected_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sid) DO UPDATE SET channel=excluded.channel,hand=excluded.hand,provider=excluded.provider,label=excluded.label,local=excluded.local,
      surfaces=excluded.surfaces,connected_at=excluded.connected_at,last_seen=excluded.last_seen`)
      .run(c.client, c.channel, c.hand, c.provider ?? null, c.label, c.local ? 1 : 0, JSON.stringify(c.surfaces), c.connected_at, c.last_seen);
  }

  remove(client: string): void {
    const c = this.live.get(client);
    if (!c) return;
    this.live.delete(client);
    this.db.prepare("UPDATE human_clients SET last_seen=? WHERE sid=?").run(this.now(), client);
  }

  get(client: string): LiveClient | undefined { return this.live.get(client); }
  all(): LiveClient[] { return [...this.live.values()]; }
  withSurface(surface: Surface): LiveClient[] { return this.all().filter((c) => c.surfaces.includes(surface)); }
  /** The owner is looking at Ash when any channel is visible. */
  watching(): boolean { return this.all().some((c) => c.visible); }

  /** The channel the owner is on: the one most recently made visible, else the most recently active one that shows chat. */
  current(): LiveClient | undefined {
    const chat = this.withSurface("chat");
    const visible = chat.filter((c) => c.visible).sort((a, b) => b.visible_at - a.visible_at)[0];
    return visible ?? chat.sort((a, b) => b.active_at - a.active_at)[0];
  }

  touch(c: LiveClient): void { c.active_at = this.now(); }

  info(): ClientInfo[] {
    return this.all().map(({ session: _session, visible_at: _v, active_at: _a, ...info }) => info);
  }
}
