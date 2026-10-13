// Codex's login for the pi runtime, for a phone: no browser on this side, so the device-code flow. The pi driver runs
//   node index.mjs status   ->  {"ready": true|false}
//   node index.mjs login    ->  {"event":"device_code","verification_uri","user_code","expires_in"}   (the owner types the code in the phone's browser)
//                               then {"event":"done"} when the token is stored, or {"event":"error","message"}
// The token goes where pi keeps it (`$PI_CODING_AGENT_DIR/auth.json`, default ~/.pi/agent) and pi refreshes it itself afterwards.
// The requests of the login go through HTTPS_PROXY when the driver sets it (pi's own processes do the same).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PI = process.env.ASH_PI_DIR || "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
const PROVIDER = "openai-codex";
const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

function status() {
  const file = join(agentDir, "auth.json");
  let ready = false;
  try {
    const entry = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))[PROVIDER] : null;
    ready = !!entry && entry.type === "oauth" && typeof entry.refresh === "string" && entry.refresh.length > 0;
  } catch { /* unreadable: not ready */ }
  out({ ready });
}

async function login() {
  process.env.PI_OFFLINE = "1";
  const undici = createRequire(join(PI, "package.json"))("undici");
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
  undici.install?.();
  const { ModelRuntime } = await import(pathToFileURL(join(PI, "dist", "index.js")).href);
  const runtime = await ModelRuntime.create();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 16 * 60 * 1000);
  try {
    await runtime.login(PROVIDER, "oauth", {
      signal: abort.signal,
      prompt: async (p) => {
        if (p.type === "select") return "device_code";
        return new Promise(() => {}); // nothing else is asked in the device-code flow
      },
      notify: (event) => {
        if (event.type === "device_code") out({ event: "device_code", verification_uri: event.verificationUri, user_code: event.userCode, expires_in: event.expiresInSeconds });
      },
    });
    out({ event: "done" });
  } finally { clearTimeout(timer); }
}

const mode = process.argv[2];
try {
  if (mode === "status") status();
  else if (mode === "login") await login();
  else { out({ event: "error", message: `unknown mode ${mode}` }); process.exitCode = 2; }
} catch (error) {
  out({ event: "error", message: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300) });
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
