import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  HOST_CAPABILITIES, HOST_ENV, HOST_METHOD_CAPABILITY,
  type HostCapability, type HostEvent, type HostMethod, type HostSecureStorage, type HostSpec,
} from "../../../sdk/src/host";

/** Fake values only. */
export const FAKE_SEAL_KEY = Buffer.alloc(32, 7).toString("base64url");
export const FAKE_TOKEN = "fake-host-token";

export interface HostCallRecord { method: string; body: unknown; authorization: string | undefined }

export interface FakeHostOptions {
  /** Capability groups the host declares. Default: all of them. */
  capabilities?: string[];
  /** Capability groups to leave out of the default list. */
  without?: HostCapability[];
  secureStorage?: HostSecureStorage;
  contract?: string;
  token?: string;
  dev?: HostSpec["dev"];
}

/**
 * A host in a box: a loopback HTTP server that implements the host interface (only for the capabilities it declares),
 * records every call, and a stdin pipe the code under test can read host events from. It can also write host.json and
 * produce the three environment variables.
 */
export class FakeHost {
  readonly calls: HostCallRecord[] = [];
  /** Hand this to readHostEvents: it plays the kernel's standard input. */
  readonly stdin = new PassThrough();
  readonly token: string;
  readonly capabilities: string[];
  /** Replace the result of a method (default: a plausible fixed answer). A function is given the request body and answers with the result. */
  readonly results = new Map<string, unknown>();
  /** Make a method fail with this error code instead of answering. */
  readonly failures = new Map<string, string>();
  /** Methods that are received (and recorded) but never answered, to exercise client timeouts. */
  readonly hangs = new Set<string>();
  endpoint = "";
  private server?: Server;
  private dir?: string;
  private onCall?: () => void;

  constructor(private readonly options: FakeHostOptions = {}) {
    this.token = options.token ?? FAKE_TOKEN;
    this.capabilities = options.capabilities ?? HOST_CAPABILITIES.filter((name) => !options.without?.includes(name));
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => void (async () => {
        const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); };
        const fail = (status: number, code: string, message: string) => json(status, { ok: false, error: { code, message } });
        const method = (req.url ?? "").replace(/^\/v1\//, "");
        let body: unknown;
        try { body = raw ? JSON.parse(raw) : {}; } catch { return fail(400, "bad_request", "bad json"); }
        this.calls.push({ method, body, authorization: req.headers.authorization });
        this.onCall?.();
        if (req.headers.authorization !== `Bearer ${this.token}`) return fail(401, "unauthorized", "bad token");
        const capability = HOST_METHOD_CAPABILITY[method as HostMethod];
        if (req.method !== "POST" || !capability || !this.capabilities.includes(capability)) return fail(404, "not_found", `no ${method}`);
        if (this.hangs.has(method)) return;
        const failure = this.failures.get(method);
        if (failure) return fail(500, failure, "scripted failure");
        const scripted = this.results.get(method);
        const result = this.results.has(method) ? (typeof scripted === "function" ? await (scripted as (body: unknown) => unknown)(body) : scripted) : defaultResult(method as HostMethod, body);
        json(200, { ok: true, result });
      })());
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.stdin.end();
    const server = this.server;
    this.server = undefined;
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }

  /** Calls of one method, in order. */
  callsOf(method: string): HostCallRecord[] { return this.calls.filter((call) => call.method === method); }

  /** Resolves once `count` calls (of any method, or of `method`) have arrived. Event-driven, no polling. */
  async waitForCalls(count: number, method?: string): Promise<void> {
    const have = () => (method ? this.callsOf(method) : this.calls).length;
    while (have() < count) await new Promise<void>((resolve) => { this.onCall = resolve; });
    this.onCall = undefined;
  }

  /** Writes one host event as a JSON line on the kernel's stdin. */
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
      endpoint: this.endpoint,
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
    return {
      env: { [HOST_ENV.spec]: specPath, [HOST_ENV.sealKey]: FAKE_SEAL_KEY, [HOST_ENV.token]: this.token },
      specPath,
      spec,
    };
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
