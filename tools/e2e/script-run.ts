/**
 * `owner.mjs script <file.json>`: the pure parts. A script file says what the script agent does (`steps`, `on_message`), what the
 * owner does while it runs (`owner`: reactions to an approval card or a checkpoint of the agent), what the hub's settings are for
 * the run (`settings`), and what must hold at the end (`expect`). This file knows the shapes and judges the outcome; owner.ts
 * does the talking. See README.md ("Device verification").
 */

export interface MessageFilter { from?: string; to?: string; word?: string; text?: string }

export type Action =
  | { answer: string; text?: string }
  | { exec: string[]; name?: string; expect?: { exit?: number; stdout?: string; not_stdout?: string }; within_ms?: number }
  | { say: string; to?: string }
  | { call: { member: string; word: string; body?: Record<string, unknown> }; name?: string; expect?: { ok?: boolean; data?: unknown } }
  | { sleep_ms: number };

export interface Reaction {
  name?: string;
  when: { start?: boolean; approval?: { word?: string }; checkpoint?: string; message?: MessageFilter };
  /** Wait this long, then act (an approval answered in 3 s, or in 40). A `start` reaction runs before the script is sent, and the run waits for it. */
  delay_ms?: number;
  /** Fire for every match, not only the first. */
  repeat?: boolean;
  /** A reaction that never fires fails the run unless it is optional. */
  optional?: boolean;
  /** At a checkpoint the agent waits for the owner: it is released when the actions are done, unless `hold`. */
  hold?: boolean;
  do?: Action[];
}

export interface StepExpect { step: string | number; ok?: boolean; error?: string; error_message?: string; status?: string; data?: unknown; min_ms?: number; max_ms?: number; min_images?: number }
export interface MessageExpect { messages: MessageFilter; count?: number | { min?: number; max?: number } }
export type Expect = StepExpect | MessageExpect;

export interface ScriptFile {
  name?: string;
  run?: string;
  /** Hub settings for the run (`service:admin/settings.set`); what they were is put back afterwards. */
  settings?: Record<string, unknown>;
  steps: unknown[];
  on_message?: { match: string; steps: unknown[] }[];
  /** How many reports of the script agent end the run (default 1; one more for each message handler that is meant to fire). */
  reports?: number;
  owner?: Reaction[];
  /** Done at the end, whatever happened (put a phone setting back); a failure here is reported but does not change the verdict. */
  cleanup?: Action[];
  expect?: Expect[];
  timeout_s?: number;
}

export interface StepReport { i: number; id?: string; kind: string; ok: boolean; status?: string; ms?: number; error?: { code: string; message?: string }; data?: unknown; images?: number }
export interface Report { run: string | null; trigger: string; completed?: boolean; matched?: string | null; steps: StepReport[] }
export interface Seen { seq: number; from: string; to: string | null; word: string; kind: string; body: unknown }
export interface Outcome { pass: boolean; what: string; detail?: string }

/** Reads a script file (JSON text), or says what is wrong with it. */
export function parseScript(text: string): ScriptFile {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { throw new Error(`not JSON: ${(e as Error).message}`); }
  const s = v as ScriptFile;
  if (!s || typeof s !== "object" || !Array.isArray(s.steps)) throw new Error('a script is {"steps": [...], ...}');
  for (const r of s.owner ?? []) if (!r || typeof r !== "object" || !r.when || !(r.when.start || r.when.approval || r.when.checkpoint || r.when.message)) throw new Error("a reaction of `owner` needs `when`: start, approval, checkpoint or message");
  return s;
}

/** Every key of [want] is in [have], recursively (arrays: the same items in the same order, each a subset). */
export function subset(have: unknown, want: unknown): boolean {
  if (want === null || typeof want !== "object") return have === want;
  if (Array.isArray(want)) return Array.isArray(have) && have.length === want.length && want.every((w, i) => subset(have[i], w));
  if (have === null || typeof have !== "object") return false;
  return Object.entries(want as Record<string, unknown>).every(([k, w]) => subset((have as Record<string, unknown>)[k], w));
}

const textOf = (body: unknown): string => { const t = (body as { text?: unknown } | null)?.text; return typeof t === "string" ? t : JSON.stringify(body ?? null); };

export function matches(m: Seen, f: MessageFilter): boolean {
  return (f.from === undefined || m.from === f.from) && (f.to === undefined || m.to === f.to) && (f.word === undefined || m.word === f.word)
    && (f.text === undefined || textOf(m.body).includes(f.text));
}

const countOk = (n: number, want: MessageExpect["count"]): boolean =>
  typeof want === "number" ? n === want : n >= (want?.min ?? 1) && n <= (want?.max ?? Infinity);
const countText = (want: MessageExpect["count"]): string => (typeof want === "number" ? `exactly ${want}` : want ? `${want.min ?? 1}..${want.max ?? "∞"}` : "at least 1");

/** The steps of all reports, in order, as one list (a step is found by its `id`, else by its position in this list). */
export const allSteps = (reports: Report[]): StepReport[] => reports.flatMap((r) => r.steps);

export function judge(expects: Expect[], reports: Report[], seen: Seen[]): Outcome[] {
  const steps = allSteps(reports);
  return expects.map((e): Outcome => {
    if ("messages" in e) {
      const hits = seen.filter((m) => matches(m, e.messages)).length;
      return { pass: countOk(hits, e.count), what: `messages ${JSON.stringify(e.messages)} ${countText(e.count)}`, detail: `${hits} found` };
    }
    const step = typeof e.step === "number" ? steps[e.step] : steps.find((s) => s.id === e.step);
    const what = `step ${e.step}`;
    if (!step) return { pass: false, what, detail: "there is no such step in the reports" };
    const bad: string[] = [];
    if (e.ok !== undefined && step.ok !== e.ok) bad.push(`ok is ${step.ok}${step.error ? ` (${step.error.code}: ${step.error.message ?? ""})` : ""}, wanted ${e.ok}`);
    if (e.error !== undefined && step.error?.code !== e.error) bad.push(`error is ${step.error?.code ?? "none"}, wanted ${e.error}`);
    if (e.error_message !== undefined && !(step.error?.message ?? "").includes(e.error_message)) bad.push(`error message ${JSON.stringify(step.error?.message ?? "")} lacks ${JSON.stringify(e.error_message)}`);
    if (e.status !== undefined && step.status !== e.status) bad.push(`status is ${step.status ?? "none"}, wanted ${e.status}`);
    if (e.data !== undefined && !subset(step.data, e.data)) bad.push(`data ${JSON.stringify(step.data)} lacks ${JSON.stringify(e.data)}`);
    if (e.min_ms !== undefined && !((step.ms ?? 0) >= e.min_ms)) bad.push(`took ${step.ms} ms, wanted at least ${e.min_ms}`);
    if (e.min_images !== undefined && !((step.images ?? 0) >= e.min_images)) bad.push(`has ${step.images ?? 0} images, wanted at least ${e.min_images}`);
    if (e.max_ms !== undefined && !((step.ms ?? Infinity) <= e.max_ms)) bad.push(`took ${step.ms} ms, wanted at most ${e.max_ms}`);
    return { pass: bad.length === 0, what: `${what}${step.ok ? " ok" : ""}`, ...(bad.length ? { detail: bad.join("; ") } : { detail: `${step.kind}${step.status ? ` ${step.status}` : ""} ${step.ms ?? "?"} ms` }) };
  });
}

/** The report a script agent said, from the text of its message; null for any other message. */
export function reportOf(text: string): Report | null {
  if (!text.startsWith('{"script_report"')) return null;
  try { return (JSON.parse(text) as { script_report: Report }).script_report; } catch { return null; }
}

/** What an `exec` action's output must be. */
export function judgeExec(want: { exit?: number; stdout?: string; not_stdout?: string } | undefined, exit: number | null, stdout: string): Outcome[] {
  const out: Outcome[] = [];
  out.push({ pass: exit === (want?.exit ?? 0), what: `exit code ${want?.exit ?? 0}`, detail: `got ${exit}` });
  if (want?.stdout !== undefined) out.push({ pass: new RegExp(want.stdout, "s").test(stdout), what: `output matches /${want.stdout}/`, detail: stdout.length > 300 ? `${stdout.slice(0, 300)}…` : stdout });
  if (want?.not_stdout !== undefined) out.push({ pass: !new RegExp(want.not_stdout, "s").test(stdout), what: `output does not match /${want.not_stdout}/` });
  return out;
}
