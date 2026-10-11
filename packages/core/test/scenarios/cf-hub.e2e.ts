/**
 * Not part of the suite: a real hub (the scenario harness boots `startHub`) that talks to the real Cloudflare through the
 * real relay code, driven by command files so that a person (or agent) can step through the relay flow:
 *   CMD_DIR/<n>.json  {op:"call", to, word, body}  |  {op:"restart"}  |  {op:"quit"}  |  {op:"messages", n}
 *   → CMD_DIR/<n>.out.json
 * The agent behind `agent:main` is a script: it answers the owner with a real DeepSeek reply (DEEPSEEK_KEY), else an echo.
 * Env: CF_TOKEN_FILE (vault-format sign-in, 0600), RELAY_DIST, CMD_DIR.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Scenario, MAIN, type TurnContext, type Human } from "./harness";
import { CLOUDFLARE_REF } from "../../src/edges/link-server/control/setup";
import { hubKey } from "../edges/link-server/control-harness";

const CMD_DIR = process.env.CMD_DIR!;
mkdirSync(CMD_DIR, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function deepseek(text: string): Promise<string> {
  const key = process.env.DEEPSEEK_KEY;
  if (!key) return `echo: ${text}`;
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "deepseek-chat", max_tokens: 120, messages: [{ role: "system", content: "You are Ash. Reply in one short sentence." }, { role: "user", content: text }] }),
    });
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content?.trim() || `echo: ${text}`;
  } catch { return `echo: ${text}`; }
}

const s = new Scenario({});
const key = await hubKey();
s.host.results.set("identity.key", () => key.identity.key());
s.host.results.set("identity.sign", (body: unknown) => key.identity.sign((body as { data: string }).data));
s.driver.script(async (turn: TurnContext) => {
  for (const m of turn.messages) {
    if (m.from === "person:owner" && m.word === "say" && m.text && !m.text.startsWith("Wake")) {
      await turn.tool("human_say", { text: await deepseek(m.text) });
    }
  }
});
const useRealBundle = () => {
  copyFileSync(join(process.env.RELAY_DIST!, "ash-gateway.mjs"), join(s.dataDir, "ash-gateway.mjs"));
  copyFileSync(join(process.env.RELAY_DIST!, "ash-gateway.metadata.json"), join(s.dataDir, "ash-gateway.metadata.json"));
};
await s.boot();
await s.passFirstMeeting();
useRealBundle();
let owner: Human = await s.human({ name: "owner-cli", surfaces: ["chat", "notification"] });
const saved = await owner.call("service:vault", "set", { ref: CLOUDFLARE_REF, value: readFileSync(process.env.CF_TOKEN_FILE!, "utf8") });
log(`vault set ${CLOUDFLARE_REF}:`, saved.ok ? "ok" : JSON.stringify(saved));
writeFileSync(join(CMD_DIR, "READY"), String(Date.now()));
log("ready; commands in", CMD_DIR);

const done = new Set<string>();
for (;;) {
  const files = readdirSync(CMD_DIR).filter((f) => /^\d+\.json$/.test(f) && !done.has(f)).sort();
  for (const f of files) {
    done.add(f);
    const n = f.replace(".json", "");
    let out: unknown;
    try {
      const cmd = JSON.parse(readFileSync(join(CMD_DIR, f), "utf8"));
      log("cmd", cmd.op, cmd.to ?? "", cmd.word ?? "");
      if (cmd.op === "call") out = await owner.call(cmd.to, cmd.word, cmd.body ?? {});
      else if (cmd.op === "restart") { await s.restart(); useRealBundle(); owner = await s.human({ name: "owner-cli", surfaces: ["chat", "notification"] }); out = { ok: true }; }
      else if (cmd.op === "messages") out = (await owner.ledger({ limit: cmd.n ?? 20 })).slice(0, cmd.n ?? 20).map((m) => ({ seq: m.seq, from: m.from, to: m.to, word: m.word, body: JSON.stringify(m.body).slice(0, 400) }));
      else if (cmd.op === "quit") { writeFileSync(join(CMD_DIR, `${n}.out.json`), "{}"); await s.dispose(); process.exit(0); }
      else out = { ok: false, error: "unknown op" };
    } catch (error) { out = { ok: false, error: String(error instanceof Error ? error.stack : error) }; }
    const tmp = join(CMD_DIR, `${n}.out.tmp`);
    writeFileSync(tmp, JSON.stringify(out, null, 1), { mode: 0o600 });
    renameSync(tmp, join(CMD_DIR, `${n}.out.json`));
  }
  await new Promise((r) => setTimeout(r, 300));
}
