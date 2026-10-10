// The secure vault when the platform's secure storage fails: the owner route turns read-only and the app stays up.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startOwner } from "../../src/main";

test("Android secure-storage failure keeps the app up but makes the owner vault route read-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-vault-locked-"));
  const state = join(root, "state"); mkdirSync(state);
  const file = join(state, "vault.json");
  const raw = JSON.stringify({ version: 1, entries: { DEEPSEEK_API_KEY: { value: "sk-existing", label: "x", kind: "model", updated_at: 1 } } });
  writeFileSync(file, raw);
  const oldRequired = process.env.ASH_VAULT_SEAL_REQUIRED;
  const oldKey = process.env.ASH_VAULT_SEAL_KEY;
  process.env.ASH_VAULT_SEAL_REQUIRED = "1";
  delete process.env.ASH_VAULT_SEAL_KEY;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: state, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const listed = await fetch(`${running.url}/api/vault`, { headers });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json() as { available: boolean }).available, false);
    const put = await fetch(`${running.url}/api/vault/DEEPSEEK_API_KEY`, { method: "PUT", headers, body: JSON.stringify({ value: "sk-new" }) });
    assert.equal(put.status, 503);
    assert.equal((await put.json() as { error: string }).error, "vault_unavailable");
    const del = await fetch(`${running.url}/api/vault/DEEPSEEK_API_KEY`, { method: "DELETE", headers });
    assert.equal(del.status, 503);
    assert.equal(readFileSync(file, "utf8"), raw);
  } finally {
    await running?.close();
    if (oldRequired === undefined) delete process.env.ASH_VAULT_SEAL_REQUIRED; else process.env.ASH_VAULT_SEAL_REQUIRED = oldRequired;
    if (oldKey === undefined) delete process.env.ASH_VAULT_SEAL_KEY; else process.env.ASH_VAULT_SEAL_KEY = oldKey;
    rmSync(root, { recursive: true, force: true });
  }
});
