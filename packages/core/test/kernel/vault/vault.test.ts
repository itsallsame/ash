import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { openVault, parseSealKey, VaultUnavailableError } from "../../../src/kernel/vault";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "vault-test-")); dirs.push(d); return d; };
const SECRET = "sk-test-0123456789-very-secret";

test("a value is sealed on disk and read back the same, also after a restart", () => {
  const file = join(dir(), "state", "vault.json");
  const key = randomBytes(32);
  const vault = openVault({ file, sealKey: key, now: () => 1234 });
  vault.set("DEEPSEEK_API_KEY", SECRET);
  assert.equal(vault.use("DEEPSEEK_API_KEY"), SECRET);
  assert.deepEqual(vault.list(), [{ ref: "DEEPSEEK_API_KEY", set_at: 1234, length: SECRET.length }]);

  const disk = readFileSync(file, "utf8");
  assert.ok(!disk.includes(SECRET) && !disk.includes("DEEPSEEK_API_KEY"));
  assert.equal(JSON.parse(disk).sealed, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const again = openVault({ file, sealKey: key });
  assert.equal(again.use("DEEPSEEK_API_KEY"), SECRET);
  again.delete("DEEPSEEK_API_KEY");
  assert.equal(again.use("DEEPSEEK_API_KEY"), null);
  assert.equal(openVault({ file, sealKey: key }).list().length, 0);
});

test("without a seal key the vault does not start; nothing is stored unsealed", () => {
  const file = join(dir(), "vault.json");
  assert.throws(() => openVault({ file, sealKey: undefined as never }), VaultUnavailableError);
  assert.throws(() => openVault({ file, sealKey: randomBytes(16) }), VaultUnavailableError);
  assert.throws(() => parseSealKey(undefined), VaultUnavailableError);
  assert.throws(() => parseSealKey(""), VaultUnavailableError);
  assert.equal(parseSealKey(randomBytes(32).toString("base64url")).length, 32);
});

test("a wrong key or a plaintext file is refused and left untouched", () => {
  const file = join(dir(), "vault.json");
  openVault({ file, sealKey: randomBytes(32) }).set("A", SECRET);
  const before = readFileSync(file, "utf8");
  assert.throws(() => openVault({ file, sealKey: randomBytes(32) }), VaultUnavailableError);
  assert.equal(readFileSync(file, "utf8"), before);

  const plain = join(dir(), "vault.json");
  writeFileSync(plain, JSON.stringify({ version: 1, entries: { A: { value: SECRET, set_at: 1 } } }));
  assert.throws(() => openVault({ file: plain, sealKey: randomBytes(32) }), VaultUnavailableError);
});

test("bad names and values are refused", () => {
  const vault = openVault({ file: join(dir(), "vault.json"), sealKey: randomBytes(32) });
  assert.throws(() => vault.set("bad name", "x"), TypeError);
  assert.throws(() => vault.set("A", "   "), TypeError);
  assert.throws(() => vault.set("A", "x".repeat(5000)), TypeError);
});
