/**
 * The semantic layer v1 (SPEC-10): one persistent entity made of a few loops. Assembly:
 *
 *   const semantic = createSemantic({ ledger, router, templates: { "SOUL.md": …, "IDENTITY.md": …, "PULSE.md": … } });
 *   for (const member of semantic.members) registry.add(member);   // service:persona, service:pulse, service:semantic
 *   await semantic.start();                                         // after the clock, agents and body are up
 *   // on lifecycle.stop: semantic.stop()
 *
 * It uses the rest of the hub only through `router.send`: `service:clock/set` for every timer, `service:agents/list` to
 * find the primary agent and the lanes, `agent:<primary>/wake`, `service:agents/session.reload`, `service:senses/daily`,
 * `service:admin` (settings, pause), `body:main/workspace.*`.
 */
import type { Member } from "../../../../sdk/src/word";
import type { Ledger } from "../../kernel/ledger";
import { DailyReview } from "./daily";
import { Entity } from "./entity";
import { PersonaService, type PersonaFile } from "./persona";
import { PulseService } from "./pulse";
import { SemanticKv, type Sender } from "./shared";

export { PersonaService, PERSONA_ID, PERSONA_FILES, type PersonaFile } from "./persona";
export { PulseService, PULSE_ID, DEFAULT_SCHEDULE } from "./pulse";
export { DailyReview, DONE_MARK, DEFAULT_REVIEW_TIME, REVIEW_SETTING } from "./daily";
export { Entity, ENTITY_ID, DEFAULT_RELOAD_TIME, RELOAD_SETTING } from "./entity";

export interface SemanticOptions {
  ledger: Pick<Ledger, "db" | "tx">;
  router: Sender;
  /** The starting text of the persona files and of PULSE.md (ash-skills/persona/*.template.md). */
  templates: Record<PersonaFile, string> & { "PULSE.md": string };
  now?: () => number;
  /** Wakes a day for the pulse (default 16). */
  budget?: number;
  /** Housekeeping interval (default 30 min); 0 turns it off. */
  tickMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export interface Semantic {
  persona: PersonaService;
  pulse: PulseService;
  daily: DailyReview;
  entity: Entity;
  /** Add these to the registry. */
  members: Member[];
  start(): Promise<void>;
  /** Housekeeping: seed files the body was not ready for, renew timers, make up a missed review. */
  tick(): Promise<void>;
  stop(): void;
}

export function createSemantic(options: SemanticOptions): Semantic {
  const { ledger, router, now, log } = options;
  const kv = new SemanticKv(ledger);
  const persona = new PersonaService({ ledger, router, templates: options.templates, ...(now ? { now } : {}), ...(log ? { log } : {}) });
  const daily = new DailyReview({ ledger, router, kv, ...(now ? { now } : {}), ...(log ? { log } : {}) });
  const entity = new Entity({ ledger, router, kv, daily, ...(now ? { now } : {}), ...(log ? { log } : {}) });
  const pulse = new PulseService({
    ledger, router, templates: { pulse: options.templates["PULSE.md"] }, ...(now ? { now } : {}), ...(log ? { log } : {}),
    ...(options.budget !== undefined ? { budget: options.budget } : {}), ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
    onDue: (kind, at) => (kind === "daily" ? daily.due(at) : entity.reload(at).then(() => {})),
  });
  return {
    persona, pulse, daily, entity, members: [persona, pulse, entity],
    async start() { await persona.start(); await pulse.start(); await entity.start(); },
    async tick() { await persona.tick(); await pulse.tick(); await daily.catchUp(); },
    stop() { pulse.stop(); },
  };
}
