/** Each step of reaching the gateway gets this long; on a slow mobile network a request can otherwise hang for minutes. */
export const STEP_MS = 20_000;

/**
 * [work], or a timeout error after [ms]. What arrives late is handed to [late] (a connection is closed there), so a
 * stalled request never holds up the next attempt.
 */
export function bounded<T>(work: Promise<T>, ms: number, what: string, late?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error(`timeout: ${what} took over ${ms / 1000}s`)); }, ms); });
  work.then((value) => { if (timedOut) late?.(value); }, () => {});
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
