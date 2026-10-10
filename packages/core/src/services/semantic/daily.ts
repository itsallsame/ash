/**
 * The daily memory and review (SPEC-10 §2): at `semantic.review_time` (default 21:30) the primary agent is woken on its
 * back lane with reason `daily`. What it does then is the skill `daily-review`; this module only decides when.
 *
 *   - one wake a day: each date is recorded when its wake is sent, and a date is not woken twice;
 *   - a day whose diary (`memory/YYYY-MM-DD.md`) already carries the done mark (`<!-- review:done -->`) is not woken at all;
 *   - a missed review is made up: when the hub starts (or on a later `tick`) and today's review time has passed, or
 *     yesterday's was never sent, the wake goes out then (yesterday's only if the hub was already installed before it);
 *   - the day's sensor statistics are fetched with `service:senses/daily` and given in the wake's context when there are any.
 *
 * The timer is a clock timer: `service:clock/set` to `service:pulse/pulse.due {kind: "daily"}`, one at a time, laid down again
 * after each one fires and whenever the setting changes.
 */
import type { Ledger } from "../../kernel/ledger";
import { ask, CLOCK_TIME, dataOf, localDate, momentOn, nextMoment, previousDate, primaryAgent, readBodyFile, readSetting, reconcileTimers, wakeAgent, type SemanticKv, type Sender } from "./shared";

export const DAILY_FROM = "service:semantic";
export const DEFAULT_REVIEW_TIME = "21:30";
export const REVIEW_SETTING = "semantic.review_time";
/** The line an agent puts at the end of a finished diary. */
export const DONE_MARK = "review:done";
/** A review sent later than this after its time is marked as made up. */
const LATE_MS = 30 * 60_000;

export interface DailyOptions {
  ledger: Pick<Ledger, "db">;
  router: Sender;
  kv: SemanticKv;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export class DailyReview {
  private readonly db;
  private readonly now: () => number;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: DailyOptions) {
    this.db = options.ledger.db();
    this.now = options.now ?? Date.now;
    this.db.exec("CREATE TABLE IF NOT EXISTS semantic_daily (date TEXT PRIMARY KEY, woke_at INTEGER NOT NULL, outcome TEXT NOT NULL)");
  }

  async reviewTime(): Promise<string> {
    const set = await readSetting(this.options.router, DAILY_FROM, REVIEW_SETTING);
    return typeof set === "string" && CLOCK_TIME.test(set) ? set : DEFAULT_REVIEW_TIME;
  }

  /** Lay down the clock timer for the next review time (and take away one for a time that is no longer the setting). */
  async schedule(): Promise<void> {
    const at = nextMoment(this.now(), await this.reviewTime());
    const problem = await reconcileTimers(this.options.router, DAILY_FROM, "semantic:daily:", "service:pulse", "pulse.due",
      new Map([[`semantic:daily:${at}`, { at, body: { kind: "daily", at } }]]));
    if (problem) this.options.log?.(`daily review timer: ${problem}`);
  }

  /** The clock reported the review time (`at`), maybe late. The date is the day the timer was set for. */
  due(at: number): Promise<void> {
    return this.serial(async () => {
      const date = localDate(at);
      // Older than yesterday is not made up.
      if (date >= previousDate(localDate(this.now()))) await this.review(date, at);
      await this.schedule();
    });
  }

  /** At start and now and then: send what is owed. Today's review once its time has come; before that, yesterday's if it was missed. */
  catchUp(): Promise<void> {
    return this.serial(async () => {
      const now = this.now();
      const time = await this.reviewTime();
      const today = localDate(now);
      if (now >= momentOn(today, time)) await this.review(today, momentOn(today, time));
      else { const yesterday = previousDate(today); await this.review(yesterday, momentOn(yesterday, time)); }
    });
  }

  /** True when the date's wake went out (or the day was already reviewed). Tests read this. */
  woken(date: string): string | null { return (this.db.prepare("SELECT outcome FROM semantic_daily WHERE date=?").get(date) as { outcome: string } | undefined)?.outcome ?? null; }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.busy.catch(() => {}).then(task);
    this.busy = next;
    return next;
  }

  private async review(date: string, scheduledFor: number): Promise<void> {
    if (this.woken(date)) return;
    // Only days the hub was there for: it was installed before that day's review time.
    const since = Number(this.options.kv.get("installed_at") ?? 0);
    if (since && since >= scheduledFor) return;
    if (dataOf<{ paused?: boolean }>(await ask(this.options.router, DAILY_FROM, "service:admin", "status"))?.paused === true) return;
    const diary = await readBodyFile(this.options.router, DAILY_FROM, `memory/${date}.md`);
    if (diary.ok && diary.text.includes(DONE_MARK)) { this.mark(date, "already_done"); return; }
    const agent = await primaryAgent(this.options.router, DAILY_FROM);
    if (!agent) return;
    if (this.woken(date)) return;
    this.mark(date, "sent");
    const context: Record<string, unknown> = { date, review_time: await this.reviewTime(), diary: `memory/${date}.md`,
      ...(this.now() - scheduledFor > LATE_MS ? { made_up: true } : {}) };
    const senses = dataOf<{ counts?: Record<string, number> }>(await ask(this.options.router, DAILY_FROM, "service:senses", "daily", { date }));
    if (senses?.counts && Object.values(senses.counts).some((n) => n > 0)) context.senses = senses;
    const sent = await wakeAgent(this.options.router, DAILY_FROM, agent, "daily", context);
    // A wake that did not go out is tried again later.
    if (!sent.ok) { this.db.prepare("DELETE FROM semantic_daily WHERE date=?").run(date); this.options.log?.(`daily review wake failed: ${sent.error.message}`); }
  }

  private mark(date: string, outcome: string): void {
    this.db.prepare("INSERT OR REPLACE INTO semantic_daily (date, woke_at, outcome) VALUES (?,?,?)").run(date, this.now(), outcome);
  }
}
