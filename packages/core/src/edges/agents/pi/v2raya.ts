/**
 * v2rayA, the proxy pi uses to reach OpenAI from a network that blocks it, kept running in the container. It is started
 * the first time a pi agent starts (not for a phone that never uses pi) and then stays; if it dies it is started again
 * after a pause. The owner configures it himself: the phone's browser opens its page (http://127.0.0.1:2017, the container
 * shares the phone's network), where the subscription is imported and a node chosen. Nothing of that passes through Ash.
 *
 * `--lite` is v2rayA's mode for a process that is not root; no transparent proxy is set up, only the local ports.
 */
import type { DriverProcess, SpawnFn } from "../dsh/acp";

export const V2RAYA_DIR = "/opt/v2";
export const V2RAYA_ARGV = [
  `${V2RAYA_DIR}/v2raya`, "--lite", "--address", "127.0.0.1:2017", "--config", "/root/v2raya",
  "--v2ray-bin", `${V2RAYA_DIR}/v2raya_core`, "--v2ray-assetsdir", `${V2RAYA_DIR}/assets`, "--log-file", "/tmp/v2raya.log",
];

export interface ProxyService { ensure(): void; stop(): void }

export interface V2rayaOptions {
  spawn: SpawnFn;
  log?: (...args: unknown[]) => void;
  argv?: string[];
  /** The pause before it is started again after it ended. */
  restartMs?: number;
  /** After this many endings within `quickMs` of starting, it is left alone: the program is not there, or cannot run. */
  quickLimit?: number;
  quickMs?: number;
}

export function createV2raya(o: V2rayaOptions): ProxyService {
  const log = o.log ?? (() => {});
  const argv = o.argv ?? V2RAYA_ARGV;
  const restartMs = o.restartMs ?? 5000;
  const quickLimit = o.quickLimit ?? 3;
  const quickMs = o.quickMs ?? 4000;
  let child: DriverProcess | null = null;
  let wanted = false;
  let quick = 0;
  let timer: NodeJS.Timeout | null = null;

  function start(): void {
    if (!wanted || child || timer) return;
    const began = Date.now();
    let proc: DriverProcess;
    try { proc = o.spawn(argv, { cwd: "/root" }); } catch (error) { log("v2raya: could not start:", (error as Error).message); return; }
    child = proc;
    proc.stdout.resume();
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => { const line = chunk.split("\n").find((l) => l.trim()); if (line) log("[v2raya]", line.slice(0, 200)); });
    proc.stdin.on("error", () => {});
    const ended = (why: string) => {
      if (child !== proc) return;
      child = null;
      quick = Date.now() - began < quickMs ? quick + 1 : 0;
      log(`v2raya: ended (${why})`);
      if (!wanted) return;
      if (quick >= quickLimit) { log("v2raya: it keeps ending at once; not started again"); return; }
      timer = setTimeout(() => { timer = null; start(); }, restartMs);
      timer.unref();
    };
    proc.on("exit", (code, signal) => ended(String(signal ?? code)));
    proc.on("error", (error) => ended(error.message));
  }

  return {
    ensure() { wanted = true; start(); },
    stop() {
      wanted = false;
      if (timer) { clearTimeout(timer); timer = null; }
      const proc = child;
      child = null;
      if (!proc) return;
      try { if (proc.pid) { process.kill(-proc.pid, "SIGTERM"); return; } } catch { /* not a group */ }
      try { proc.kill("SIGTERM"); } catch { /* gone */ }
    },
  };
}
