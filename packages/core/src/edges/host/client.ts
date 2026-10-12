import {
  HOST_HEARTBEAT_MS, HOST_METHOD_CAPABILITY, HOST_POWER_HOLD_MAX_MS,
  type HostCapability, type HostErrorCode, type HostMethod, type HostMethods, type HostResponse, type HostStatusState,
} from "../../../../sdk/src/host";

/** A call that the host answered with an error, or that did not get an answer. */
const KNOWN_CODES: Record<HostErrorCode, true> = {
  bad_request: true, unauthorized: true, forbidden: true, not_found: true, denied: true, cancelled: true, timeout: true,
  offline: true, result_unknown: true, conflict: true, too_large: true, unavailable: true, failed: true, internal: true,
};
/** A code the host sent that is not one of the shared 14 becomes `failed`. */
const knownCode = (code: unknown): HostErrorCode => (typeof code === "string" && Object.hasOwn(KNOWN_CODES, code) ? (code as HostErrorCode) : "failed");

export class HostCallError extends Error {
  constructor(readonly code: HostErrorCode, message: string, readonly method: HostMethod, readonly status?: number) {
    super(`host ${method}: ${code}: ${message}`);
    this.name = "HostCallError";
  }
}

/** Result of an optional capability: the host either has it (and answered) or does not (nothing was sent). */
export type HostOptional<R> = { supported: true; result: R } | { supported: false };

/** Interval timer, injectable so tests can drive the heartbeat with a fake clock. Returns the stopper. */
export type HostIntervalTimer = (fn: () => void, ms: number) => () => void;
const realInterval: HostIntervalTimer = (fn, ms) => {
  const handle = setInterval(fn, ms);
  handle.unref();
  return () => clearInterval(handle);
};

export interface HostClientOptions {
  /** From host.json. */
  endpoint: string;
  /** From the environment, held in memory only. */
  token: string;
  /** From host.json; names this client does not know are ignored. */
  capabilities: readonly string[];
  /** Per call; a call that times out ends as `result_unknown`. Default 15 s. */
  timeoutMs?: number;
  setInterval?: HostIntervalTimer;
  /** Where a failed heartbeat is reported. Default: stderr. */
  onHeartbeatError?: (error: unknown) => void;
}

export interface HostHeartbeatStatus { text: string; state: HostStatusState }

export class HostClient {
  private readonly capabilities: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly interval: HostIntervalTimer;
  private readonly base: string;

  constructor(private readonly options: HostClientOptions) {
    this.capabilities = new Set(options.capabilities);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.interval = options.setInterval ?? realInterval;
    this.base = options.endpoint.replace(/\/+$/, "");
  }

  has(capability: HostCapability): boolean { return this.capabilities.has(capability); }

  // ---- required capabilities: always there (the boot check guarantees it) ----
  identityKey() { return this.call("identity.key", {}); }
  identitySign(data: string) { return this.call("identity.sign", { data }); }
  lifecycleReady(version: string, linkPort: number) { return this.call("lifecycle.ready", { version, link_port: linkPort }); }
  lifecycleRestart(reason: string) { return this.call("lifecycle.restart", { reason }); }
  statusSet(text: string, state: HostStatusState) { return this.call("status.set", { text, state }); }

  // ---- optional capabilities: `{supported:false}` when the host did not declare them, nothing is sent ----
  wakeAt(at: number) { return this.optional("wake.at", { at }); }
  wakeClear() { return this.optional("wake.clear", {}); }
  powerHold(ms: number, reason: string) {
    return this.optional("power.hold", { ms: Math.max(0, Math.min(Math.floor(ms), HOST_POWER_HOLD_MAX_MS)), reason });
  }
  powerRelease() { return this.optional("power.release", {}); }
  handsHandoff(port: number, token: string) { return this.optional("hands.handoff", { port, token }); }
  updateInstall(version: string, url: string, sha256: string) { return this.optional("update.install", { version, url, sha256 }); }
  /** A phone action (vscreen.*, input.key, apps.open): forwarded as is; `{supported:false}` when the host did not declare its group. */
  phone<M extends HostMethod>(method: M, req: HostMethods[M]["req"]) { return this.optional(method, req); }

  /** status.set every 60 s as the host's liveness signal; the first one goes out after one period. Returns the stopper. */
  startHeartbeat(status: () => HostHeartbeatStatus): () => void {
    const report = (error: unknown) => {
      (this.options.onHeartbeatError ?? ((e: unknown) => console.error(`[host] heartbeat failed: ${(e as Error).message}`)))(error);
    };
    return this.interval(() => {
      // The status callback runs inside the promise chain: if it throws, this beat fails and is reported, the timer goes on.
      Promise.resolve().then(status).then(({ text, state }) => this.statusSet(text, state)).catch(report);
    }, HOST_HEARTBEAT_MS);
  }

  private async optional<M extends HostMethod>(method: M, req: HostMethods[M]["req"]): Promise<HostOptional<HostMethods[M]["res"]>> {
    if (!this.capabilities.has(HOST_METHOD_CAPABILITY[method])) return { supported: false };
    return { supported: true, result: await this.call(method, req) };
  }

  private async call<M extends HostMethod>(method: M, req: HostMethods[M]["req"]): Promise<HostMethods[M]["res"]> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/v1/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError" || (error as Error).name === "AbortError";
      throw new HostCallError(timedOut ? "result_unknown" : "unavailable", (error as Error).message, method);
    }
    let body: HostResponse<HostMethods[M]["res"]> | undefined;
    try { body = (await response.json()) as typeof body; } catch { /* handled below */ }
    if (body && body.ok === true) return body.result;
    if (body && body.ok === false && body.error) throw new HostCallError(knownCode(body.error.code), body.error.message, method, response.status);
    if (response.status === 401) throw new HostCallError("unauthorized", "host refused the token", method, 401);
    throw new HostCallError("failed", `unreadable answer (HTTP ${response.status})`, method, response.status);
  }
}
