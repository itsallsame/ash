/**
 * A client for one pi process in RPC mode: JSON records, one per line, on its standard input and output. A command may
 * carry an `id`; the `response` record with that id answers it. Every other record is an event of the session
 * (`agent_start`, `message_end`, `tool_execution_start`, `agent_settled`...). Lines are split on LF only: pi's own
 * documentation warns that a reader that also splits on U+2028/U+2029 cuts a JSON string in two.
 */
import type { DriverProcess } from "../dsh/acp";

export type PiRecord = { type?: string; [key: string]: any };

export class PiRpcError extends Error {
  constructor(readonly command: string, message: string) { super(message); this.name = "PiRpcError"; }
}

type Pending = { command: string; resolve(data: any): void; reject(error: Error): void; timer?: NodeJS.Timeout };
const MAX_LINE = 64 * 1024 * 1024;

export class PiRpc {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(record: PiRecord) => void>();
  private readonly exits = new Set<(reason: string) => void>();
  private buffer = "";
  private exited: string | null = null;

  constructor(private readonly child: DriverProcess, private readonly log: (...args: unknown[]) => void = () => {}) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { for (const line of chunk.split("\n")) if (line.trim()) this.log("[pi]", line.slice(0, 300)); });
    child.stdin.on("error", () => { /* the exit tells */ });
    child.on("exit", (code, signal) => this.fail(`pi exited (${signal ?? code})`));
    child.on("error", (error) => this.fail(`pi failed: ${error.message}`));
  }

  get alive(): boolean { return this.exited === null; }
  get pid(): number | undefined { return this.child.pid; }
  /** The listener is called with every record that is not a command's response. Returns the function that removes it. */
  onEvent(listener: (record: PiRecord) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** The listener is called once, when the process is gone (at once if it is). Returns the function that removes it. */
  onExit(listener: (reason: string) => void): () => void {
    if (this.exited) { listener(this.exited); return () => {}; }
    this.exits.add(listener);
    return () => { this.exits.delete(listener); };
  }

  /** Send a command and wait for its response (its `data`). A response with `success: false` rejects with pi's error text. */
  request<T = any>(command: { type: string; [key: string]: unknown }, timeoutMs = 30_000): Promise<T> {
    if (this.exited) return Promise.reject(new PiRpcError(command.type, this.exited));
    const id = `c${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { command: command.type, resolve, reject };
      if (timeoutMs > 0) entry.timer = setTimeout(() => { this.pending.delete(id); reject(new PiRpcError(command.type, `${command.type} did not answer in ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, entry);
      this.write({ id, ...command });
    });
  }

  /** End the process: close its input (pi shuts down in order), then ask it to stop, and kill it if it does not. */
  close(): void {
    if (this.exited) return;
    try { this.child.stdin.end(); } catch { /* closed */ }
    const signal = (name: NodeJS.Signals) => {
      const pid = this.child.pid;
      try { if (pid) { process.kill(-pid, name); return; } } catch { /* not a group of its own */ }
      try { this.child.kill(name); } catch { /* gone */ }
    };
    const kill = setTimeout(() => signal("SIGKILL"), 3000);
    kill.unref();
    const term = setTimeout(() => signal("SIGTERM"), 500);
    term.unref();
    this.child.on("exit", () => { clearTimeout(kill); clearTimeout(term); });
  }

  private write(record: unknown): void {
    try { this.child.stdin.write(`${JSON.stringify(record)}\n`); } catch (error) { this.fail(`stdin failed: ${(error as Error).message}`); }
  }

  private fail(reason: string): void {
    if (this.exited) return;
    this.exited = reason;
    for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(new PiRpcError(p.command, reason)); }
    this.pending.clear();
    for (const listener of this.exits) { try { listener(reason); } catch { /* one cannot stop the next */ } }
    this.exits.clear();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) { this.fail("pi sent an oversized line"); this.close(); return; }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record: PiRecord;
      try { record = JSON.parse(line) as PiRecord; } catch { this.log("[pi] unreadable line", line.slice(0, 120)); continue; }
      this.dispatch(record);
    }
  }

  private dispatch(record: PiRecord): void {
    if (record.type === "response") {
      const pending = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
      if (!pending) return;
      this.pending.delete(record.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (record.success === false) pending.reject(new PiRpcError(pending.command, String(record.error ?? `${pending.command} failed`)));
      else pending.resolve(record.data);
      return;
    }
    for (const listener of [...this.listeners]) { try { listener(record); } catch { /* keep the stream going */ } }
  }
}
