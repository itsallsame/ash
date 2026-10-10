/**
 * A JSON-RPC client over one agent process's stdio (newline-delimited JSON: the ACP stdio transport). Standard ACP
 * methods and the `_ash/*` extensions go through `request`. The agent's permission questions are always answered
 * "allow once": whatever the agent does inside its body is allowed there; what reaches the owner's world goes through
 * the hub's tools and its gate.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** What the driver needs of a started process (a Node child process is one). */
export type DriverProcess = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "kill" | "on">;
/** Start a command on the main body. Injected by the assembly (the body edge); the driver never starts a process itself. */
export type SpawnFn = (argv: string[], opts: { env?: Record<string, string>; cwd?: string }) => DriverProcess;

export interface AcpUpdate {
  sessionUpdate: string;
  messageId?: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

export class AcpError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = "AcpError"; }
}

type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void };
const MAX_LINE = 64 * 1024 * 1024;

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly updates = new Set<(sessionId: string, update: AcpUpdate) => void>();
  private readonly exits = new Set<(reason: string) => void>();
  private buffer = "";
  private exited: string | null = null;

  constructor(private readonly child: DriverProcess, private readonly log: (...args: unknown[]) => void = () => {}) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { for (const line of chunk.split("\n")) if (line.trim()) this.log("[agent]", line.slice(0, 300)); });
    child.stdin.on("error", () => { /* the exit tells */ });
    child.on("exit", (code, signal) => this.fail(`process exited (${signal ?? code})`));
    child.on("error", (error) => this.fail(`process failed: ${error.message}`));
  }

  get alive(): boolean { return this.exited === null; }
  onUpdate(listener: (sessionId: string, update: AcpUpdate) => void): void { this.updates.add(listener); }
  onExit(listener: (reason: string) => void): void { this.exits.add(listener); }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new AcpError(-32000, this.exited));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: (v) => resolve(v as T), reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown): void { if (!this.exited) this.write({ jsonrpc: "2.0", method, params }); }

  /** End the process: close its input, ask it to stop, and kill it if it does not. */
  close(): void {
    if (this.exited) return;
    try { this.child.stdin.end(); } catch { /* closed */ }
    const timer = setTimeout(() => { try { this.child.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
    timer.unref();
    try { this.child.kill("SIGTERM"); } catch { /* gone */ }
  }

  private write(message: unknown): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) { this.fail(`stdin failed: ${(error as Error).message}`); }
  }

  private fail(reason: string): void {
    if (this.exited) return;
    this.exited = reason;
    for (const p of this.pending.values()) p.reject(new AcpError(-32000, reason));
    this.pending.clear();
    for (const listener of this.exits) { try { listener(reason); } catch { /* one cannot stop the next */ } }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) { this.fail("the agent sent an oversized line"); this.close(); return; }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try { this.dispatch(JSON.parse(line) as Record<string, any>); } catch { this.log("[agent] unreadable line", line.slice(0, 120)); }
    }
  }

  private dispatch(message: Record<string, any>): void {
    const id = message.id;
    if (typeof message.method !== "string") {
      const pending = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) pending.reject(new AcpError(Number(message.error.code ?? -32603), String(message.error.message ?? `${pending.method} failed`)));
      else pending.resolve(message.result);
      return;
    }
    const params = (message.params ?? {}) as Record<string, any>;
    if (message.method === "session/update") {
      const update = params.update as AcpUpdate | undefined;
      if (update && typeof update.sessionUpdate === "string") for (const listener of this.updates) { try { listener(String(params.sessionId ?? ""), update); } catch { /* keep the stream going */ } }
      return;
    }
    if (id === undefined) return;
    if (message.method === "session/request_permission") {
      const options = Array.isArray(params.options) ? params.options as { optionId?: string; kind?: string }[] : [];
      const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
      this.write({ jsonrpc: "2.0", id, result: { outcome: allow?.optionId ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } } });
      return;
    }
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `${message.method} is not offered here` } });
  }
}
