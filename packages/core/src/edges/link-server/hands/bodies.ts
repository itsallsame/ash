/**
 * The hub's bodies (SPEC-09, HUB-MODULES §2.3): the `bodies` table, the member `service:bodies`, and the rule that
 * splits a bound computer's manifest into the hand (`device:<id>`) and the body (`body:<id>`).
 *
 * The main body is bound from the first start and cannot be unbound. A computer's `workspace.*` and `body.info` are
 * registered as `body:<hand>` only while the owner has bound that computer; unbinding takes them offline at once and
 * leaves the hand as it was.
 *
 * This module touches no other module: what it needs from the hand registry and the router it is given (`BodiesDeps`).
 */
import type { DatabaseSync } from "node:sqlite";
import { bodyId, idKind, MAIN_BODY_ID } from "../../../../../sdk/src/ids";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../../sdk/src/message";
import { standardMember } from "../../../../../sdk/src/namespaces";
import { wordsOf } from "../../../../../sdk/src/words";
import type { Member, WordContract } from "../../../../../sdk/src/word";

export const BODIES_ID = "service:bodies";

/** What `service:bodies` needs to know of a hand; `null` from `hands.get` means no such paired, unrevoked hand. */
export interface HandView {
  id: string;
  name: string;
  /** phone | computer | browser | im: only a computer can be a body. */
  kind: string;
  online: boolean;
}

export interface BodiesDeps {
  /** The ledger's database (`ledger.db()`): the `bodies` table is created in it. */
  db: DatabaseSync;
  hands: { get(hand: string): HandView | null };
  /**
   * Bind or unbind changed which of this hand's capabilities are a body: the hand registry registers the new split
   * (calls `splitBodyCapabilities` again with the hand's current manifest). Called after the table is updated.
   */
  rebind(hand: string): void;
  /** `router.send` as the service, for `body.info` on a body. Resolves with the member's `WordResult`. */
  call(to: string, word: string, body: unknown): Promise<WordResult | void>;
  now?: () => number;
  /** `bodies.kind` of the main body: `mainBodyKind(isolation)` from edges/body/local.ts. Default `proot-ubuntu`. */
  mainKind?: string;
}

export interface Bodies extends Member {
  /** True while the owner has this computer bound as a body. The hand registry asks this when it splits a manifest. */
  isBound(hand: string): boolean;
  /** The hand was revoked or deleted: its body binding ends too (no registry call: the hand is going away). */
  forget(hand: string): void;
}

export interface BodyCapabilities<C> {
  /** `device:<hand>`: everything that is not the body contract. */
  hand: C[];
  /** `body:<hand>`: `workspace.*` and `body.info`; empty while the hand is not bound. */
  body: C[];
  /** The member id of the body, or `null` when there is none to register. */
  bodyId: string | null;
}

/** True for the capability names that belong to a body: `workspace.*` and `body.info` (sdk `standardMember`). */
export const isBodyCapability = (name: string): boolean => standardMember(name) === "body:*";

/**
 * Splits a hand's declared capabilities. Only a bound hand gets a body; an unbound hand's `workspace.*` and `body.info`
 * are kept out of the registry altogether (they are not the hand's, and not yet a body).
 */
export function splitBodyCapabilities<C extends { name: string }>(hand: { id: string; bound: boolean }, capabilities: readonly C[]): BodyCapabilities<C> {
  const body = hand.bound ? capabilities.filter((item) => isBodyCapability(item.name)) : [];
  return {
    hand: capabilities.filter((item) => !isBodyCapability(item.name)),
    body,
    bodyId: body.length > 0 ? bodyId(hand.id) : null,
  };
}

interface Row { id: string; kind: string; ownership: string; provider: string; info: string; bound_at: number; unbound_at: number | null; last_seen: number | null }

const SCHEMA = `CREATE TABLE IF NOT EXISTS bodies (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ownership TEXT NOT NULL, provider TEXT NOT NULL, info TEXT NOT NULL,
  bound_at INTEGER NOT NULL, unbound_at INTEGER, last_seen INTEGER)`;

const handOf = (body: string): string => body.slice("body:".length);

export function createBodies(deps: BodiesDeps): Bodies {
  const now = deps.now ?? Date.now;
  const db = deps.db;
  db.exec(SCHEMA);
  const errors = new Map<string, string>();

  const get = db.prepare("SELECT * FROM bodies WHERE id = ?");
  const bound = db.prepare("SELECT * FROM bodies WHERE unbound_at IS NULL ORDER BY (id = 'body:main') DESC, bound_at, id");
  const row = (id: string): Row | undefined => get.get(id) as Row | undefined;

  // The main body is there from the first start and is always bound.
  db.prepare(`INSERT INTO bodies (id, kind, ownership, provider, info, bound_at, unbound_at) VALUES (?, ?, 'own', 'kernel', '{}', ?, NULL)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, unbound_at = NULL`).run(MAIN_BODY_ID, deps.mainKind ?? "proot-ubuntu", now());

  const online = (r: Row): boolean => r.id === MAIN_BODY_ID || (deps.hands.get(handOf(r.id))?.online ?? false);
  const summary = (r: Row) => ({
    body: r.id,
    name: r.id === MAIN_BODY_ID ? "main body" : deps.hands.get(handOf(r.id))?.name ?? r.provider,
    ownership: r.ownership as "own" | "borrowed",
    online: online(r),
    bound: r.unbound_at === null,
    ...(r.id === MAIN_BODY_ID ? {} : { hand: handOf(r.id) }),
  });
  const boundRow = (body: unknown): Row => {
    if (typeof body !== "string" || idKind(body) !== "body") throw new WordError("bad_request", "body must be a body id such as body:main");
    const r = row(body);
    if (!r || r.unbound_at !== null) throw new WordError("not_found", `${body} is not a bound body`);
    return r;
  };

  async function describe(r: Row) {
    let info: unknown = JSON.parse(r.info);
    if (online(r)) {
      try {
        const data = (await deps.call(r.id, "body.info", {}))?.data;
        if (data && typeof data === "object") {
          info = data;
          db.prepare("UPDATE bodies SET info = ? WHERE id = ?").run(JSON.stringify(data), r.id);
          errors.delete(r.id);
        }
      } catch (error) {
        errors.set(r.id, error instanceof Error ? error.message : String(error));
      }
    }
    const resources = (info as { resources?: { disk?: unknown } } | null)?.resources;
    return { info: { ...(info as object), ...summary(r) }, ...(resources?.disk ? { disk: resources.disk } : {}), ...(errors.has(r.id) ? { last_error: errors.get(r.id) } : {}) };
  }

  function bind(handId: unknown) {
    if (typeof handId !== "string" || handId === "") throw new WordError("bad_request", "hand must be a hand id");
    const hand = deps.hands.get(handId);
    if (!hand) throw new WordError("not_found", `${handId} is not a paired computer`);
    if (hand.kind !== "computer") throw new WordError("bad_request", `${hand.name} is a ${hand.kind}; only a computer can be a body`);
    const id = bodyId(handId);
    const existing = row(id);
    if (existing && existing.unbound_at === null) return summary(existing);
    if (existing) db.prepare("UPDATE bodies SET unbound_at = NULL, bound_at = ?, kind = ?, provider = ? WHERE id = ?").run(now(), hand.kind, handId, id);
    else db.prepare("INSERT INTO bodies (id, kind, ownership, provider, info, bound_at, unbound_at) VALUES (?, ?, 'borrowed', ?, '{}', ?, NULL)").run(id, hand.kind, handId, now());
    deps.rebind(handId);
    return summary(row(id)!);
  }

  function unbind(body: unknown) {
    if (body === MAIN_BODY_ID) throw new WordError("forbidden", "body:main cannot be unbound: the hub always carries at least one body");
    const r = boundRow(body);
    db.prepare("UPDATE bodies SET unbound_at = ? WHERE id = ?").run(now(), r.id);
    errors.delete(r.id);
    deps.rebind(handOf(r.id));
    return { unbound: true };
  }

  const self: Bodies = {
    id: BODIES_ID,
    kind: "service",
    name: "bodies",
    words: (): WordContract[] => wordsOf(BODIES_ID),
    async handle(msg: Message, _ctx: HandleContext): Promise<WordResult> {
      const input = (msg.body ?? {}) as Record<string, unknown>;
      switch (msg.word) {
        case "list": return { data: { bodies: (bound.all() as unknown as Row[]).map(summary) } };
        case "describe": return { data: await describe(boundRow(input.body)) };
        case "bind": return { data: bind(input.hand) };
        case "unbind": return { data: unbind(input.body) };
        default: throw new WordError("not_found", `service:bodies has no word ${msg.word}`);
      }
    },
    isBound: (hand) => { const r = row(bodyId(hand)); return !!r && r.unbound_at === null; },
    forget(hand) {
      const id = bodyId(hand);
      const r = row(id);
      if (r && r.unbound_at === null) db.prepare("UPDATE bodies SET unbound_at = ? WHERE id = ?").run(now(), id);
      errors.delete(id);
    },
  };
  return self;
}
