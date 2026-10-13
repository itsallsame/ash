/**
 * The program the host starts (`node ash-core.mjs`, SPEC-07 §2): no arguments. Everything it needs comes from the host's
 * launch description (`ASH_HOST_SPEC`) and its private pipe to the host (standard input and output): the secrets first,
 * then calls, answers and events. Standard output belongs to that pipe; the log goes to standard error.
 * `startHub` (next.ts) does the assembly; this file only hardens the process, starts it and waits for it to end.
 */
import { protectProcessMemory } from "./edges/host";
import { startHub } from "./next";

const log = (...args: unknown[]): void => console.error("[ash]", ...args.map((a) => (a instanceof Error ? a.message : a)));

// Standard output is the pipe to the host: nothing may print to it but the pipe itself.
console.log = console.error;
console.info = console.error;

// Before any secret is read: the agent's body runs as the same Linux user and must not be able to read this process's memory.
protectProcessMemory(log);

let hub: Awaited<ReturnType<typeof startHub>>;
try {
  hub = await startHub({});
} catch (error) {
  log(error); // startHub says why ("cannot start: ...")
  process.exit(typeof (error as { exitCode?: unknown }).exitCode === "number" ? (error as { exitCode: number }).exitCode : 1);
}

// The host asks for a stop with `lifecycle.stop` (the hub then closes by itself); a signal is the fallback.
const stop = (): void => { void hub.stop(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await hub.closed;
process.exit(0);

