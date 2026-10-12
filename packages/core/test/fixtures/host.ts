import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import {
  HOST_CAPABILITIES, HOST_ENV, HOST_METHOD_CAPABILITY,
  type HostCapability, type HostEvent, type HostMethod, type HostSecureStorage, type HostSpec,
} from "../../../sdk/src/host";

/** Fake values only. */
export const FAKE_SEAL_KEY = Buffer.alloc(32, 7).toString("base64url");

export interface HostCallRecord { method: string; body: unknown }

export interface FakeHostOptions {
  /** Capability groups the host declares. Default: all of them. */
  capabilities?: string[];
  /** Capability groups to leave out of the default list. */
  without?: HostCapability[];
  secureStorage?: HostSecureStorage;
  contract?: string;
  /** The seal key sent on the boot line (default FAKE_SEAL_KEY); null sends no boot line at all. */
  sealKey?: string | null;
  dev?: HostSpec["dev"];
}

/** One run of the kernel's pipe: what the kernel reads (`stdin`) and what it writes (`stdout`). */
export interface FakeHostConnection { stdin: PassThrough; stdout: PassThrough; close(): void }

/**
 * A host in a box: the far end of the kernel's private pipe (SPEC-07). For each run of the kernel ([connect]) it sends the
 * boot line, answers the kernel's calls (only for the capabilities it declares) and passes on the host events played on
 * [stdin]; it records every call. It can also write host.json and produce the environment.
 */
export class FakeHost {
  readonly calls: HostCallRecord[] = [];
  /** The host's events: [sendEvent] writes here, and it reaches the kernel of the current run (or waits for the next). */
  readonly stdin = new PassThrough();
  readonly capabilities: string[];
  /** Replace the result of a method (default: a plausible fixed answer). A function is given the request body and answers with the result. */
  readonly results = new Map<string, unknown>();
  /** Make a method fail with this error code instead of answering. */
  readonly failures = new Map<string, string>();
  /** Methods that are received (and recorded) but never answered, to exercise client timeouts. */
  readonly hangs = new Set<string>();
  private dir?: string;
  private onCall?: () => void;
  private current?: FakeHostConnection;

  constructor(private readonly options: FakeHostOptions = {}) {
    this.capabilities = options.capabilities ?? HOST_CAPABILITIES.filter((name) => !options.without?.includes(name));
    // Ending the host's stream is the host dying: the kernel of the current run sees its input close.
    this.stdin.on("finish", () => this.current?.close());
  }

  /** Kept for the tests' shape: there is nothing to start, the pipe is made per run ([connect]). */
  async start(): Promise<this> { return this; }

  async stop(): Promise<void> {
    this.current?.close();
    this.stdin.end();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }

  /** The pipe of one kernel run: the boot line first, then answers and events. The previous run's pipe is closed. */
  connect(): FakeHostConnection {
    this.current?.close();
    const toKernel = new PassThrough();
    const fromKernel = new PassThrough();
    const sealKey = this.options.sealKey === undefined ? FAKE_SEAL_KEY : this.options.sealKey;
    if (sealKey !== null) toKernel.write(`${JSON.stringify({ boot: { seal_key: sealKey } })}\n`);
    this.stdin.pipe(toKernel, { end: false });
    const reply = (id: number, value: object) => { if (!toKernel.writableEnded) toKernel.write(`${JSON.stringify({ reply: id, ...value })}\n`); };
    createInterface({ input: fromKernel, crlfDelay: Infinity }).on("line", (line) => void (async () => {
      let call: { call?: unknown; method?: unknown; params?: unknown };
      try { call = JSON.parse(line); } catch { return; }
      if (typeof call.call !== "number" || typeof call.method !== "string") return;
      const id = call.call;
      const method = call.method;
      this.calls.push({ method, body: call.params ?? {} });
      this.onCall?.();
      const capability = HOST_METHOD_CAPABILITY[method as HostMethod];
      if (!capability || !this.capabilities.includes(capability)) return reply(id, { ok: false, error: { code: "not_found", message: `no ${method}` } });
      if (this.hangs.has(method)) return;
      const failure = this.failures.get(method);
      if (failure) return reply(id, { ok: false, error: { code: failure, message: "scripted failure" } });
      const scripted = this.results.get(method);
      const result = this.results.has(method) ? (typeof scripted === "function" ? await (scripted as (body: unknown) => unknown)(call.params) : scripted) : defaultResult(method as HostMethod, call.params);
      reply(id, { ok: true, result });
    })());
    const connection: FakeHostConnection = {
      stdin: toKernel,
      stdout: fromKernel,
      close: () => { this.stdin.unpipe(toKernel); toKernel.end(); if (this.current === connection) this.current = undefined; },
    };
    this.current = connection;
    return connection;
  }

  /** Calls of one method, in order. */
  callsOf(method: string): HostCallRecord[] { return this.calls.filter((call) => call.method === method); }

  /** Resolves once `count` calls (of any method, or of `method`) have arrived. Event-driven, no polling. */
  async waitForCalls(count: number, method?: string): Promise<void> {
    const have = () => (method ? this.callsOf(method) : this.calls).length;
    while (have() < count) await new Promise<void>((resolve) => { this.onCall = resolve; });
    this.onCall = undefined;
  }

  /** Writes one host event as a JSON line towards the kernel. */
  sendEvent(event: HostEvent | Record<string, unknown>): void { this.stdin.write(`${JSON.stringify(event)}\n`); }
  sendRaw(line: string): void { this.stdin.write(`${line}\n`); }

  /** The launch description this host would write. */
  spec(overrides: Partial<HostSpec> = {}): HostSpec {
    const base = this.dir ?? tmpdir();
    return {
      contract: (this.options.contract ?? "ash-host/1") as HostSpec["contract"],
      host: { kind: "fake", version: "0.0.1" },
      platform: { os: "testos", os_version: "1", arch: "x64", model: "Test Box", locale: "en-US", timezone: "UTC" },
      dirs: { state: join(base, "state"), home: join(base, "home"), tmp: join(base, "tmp"), runtime: join(base, "runtime"), logs: join(base, "logs") },
      isolation: { kind: "native", native: { workspace: join(base, "home"), dsh_bin: join(base, "runtime", "dsh"), dsh_home: join(base, "dsh") } },
      network: { proxy: null },
      capabilities: this.capabilities,
      secure_storage: this.options.secureStorage ?? "file",
      dev: this.options.dev ?? { owner_token: false },
      ...overrides,
    };
  }

  /** Writes host.json (0600) into a fresh run directory and returns the environment the host would give the kernel. */
  writeLaunch(overrides: Partial<HostSpec> = {}): { env: NodeJS.ProcessEnv; specPath: string; spec: HostSpec } {
    this.dir ??= mkdtempSync(join(tmpdir(), "fake-host-"));
    const spec = this.spec(overrides);
    const specPath = join(this.dir, "host.json");
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
    chmodSync(specPath, 0o600);
    return { env: { [HOST_ENV.spec]: specPath }, specPath, spec };
  }
}

function defaultResult(method: HostMethod, body: unknown): unknown {
  switch (method) {
    case "identity.key": return { id: "fakeid0123456789abcdef", public_key: "fake-public-key" };
    case "identity.sign": return { sig: `sig:${(body as { data: string }).data}` };
    case "hands.handoff": return { delivered: ["hand:fake"] };
    default: return {};
  }
}

/** A manual interval timer for HostClient: nothing fires until tick() moves the clock. */
export class FakeClock {
  private now = 0;
  private timers: { fn: () => void; every: number; next: number }[] = [];
  readonly setInterval = (fn: () => void, every: number): (() => void) => {
    const timer = { fn, every, next: this.now + every };
    this.timers.push(timer);
    return () => { this.timers = this.timers.filter((other) => other !== timer); };
  };
  tick(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      this.now = due.next;
      due.next += due.every;
      due.fn();
    }
    this.now = end;
  }
}
