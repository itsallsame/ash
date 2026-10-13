// A stand-in for ash's pi login helper: `status` and `login`, as JSON lines. FAKE_LOGIN=error makes the login fail; FAKE_LOGIN_READY=1 is a login that is there.
import { appendFileSync } from "node:fs";
const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const mode = process.argv[2];
log({ login_helper: mode, env: { HTTPS_PROXY: process.env.HTTPS_PROXY } });
if (mode === "status") { out({ ready: process.env.FAKE_LOGIN_READY === "1" }); process.exit(0); }
out({ event: "device_code", verification_uri: "https://auth.example/codex/device", user_code: "ABCD-1234", expires_in: 900 });
setTimeout(() => { out(process.env.FAKE_LOGIN === "error" ? { event: "error", message: "expired" } : { event: "done" }); process.exit(0); }, Number(process.env.FAKE_LOGIN_MS ?? 300));
