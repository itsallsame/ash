import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReadAuthorization, parseReadAuthorization, readAuthorizationPath } from "../src/collaboration/authorization";
import { deviceCli } from "../src/cli";
import { DeviceKey } from "ash-gateway/client/client";
import { deviceIdForKey } from "ash-gateway/src/protocol";
import { fileSigner } from "../src/link";

const ownerKey = (await DeviceKey.generate()).publicKey;
const ownerId = await deviceIdForKey(ownerKey);
const pair = (state: string) => writeFileSync(join(state, "paired.json"), JSON.stringify({ owner_key: ownerKey }));

test("read authorization defaults closed and binds exact scopes to the local endpoint", () => {
  const state = mkdtempSync(join(tmpdir(), "ash-read-auth-"));
  try {
    pair(state);
    assert.equal(loadReadAuthorization(state, "node").state, "scope_required");
    const config = { version: 2, owner_id: ownerId, endpoint_id: "node", authorization_generation: 1, allowedCwds: ["/tmp/scope", "/tmp/scope/."] };
    assert.deepEqual(parseReadAuthorization(config, "node").allowedCwds, ["/tmp/scope"]);
    for (const invalid of [{ ...config, version: 1 }, { ...config, endpoint_id: "other" }, { ...config, allowedCwds: ["relative"] }, { ...config, allowedCwds: ["/" + "a".repeat(4096)] }, { ...config, method: "turn/start" }, { ...config, authorization_generation: 0 }]) assert.throws(() => parseReadAuthorization(invalid, "node"));
    writeFileSync(readAuthorizationPath(state), JSON.stringify(config));
    assert.equal(loadReadAuthorization(state, "node").state, "scope_required", "legacy v2 requires a source-bound grant");
    assert.equal(loadReadAuthorization(state, "other").state, "invalid_configuration");
    writeFileSync(readAuthorizationPath(state), "{malformed");
    assert.deepEqual(loadReadAuthorization(state, "node").allowedCwds, []);
    writeFileSync(readAuthorizationPath(state), " ".repeat(1024 * 1024 + 1));
    assert.equal(loadReadAuthorization(state, "node").state, "invalid_configuration");
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("read-scope persists only explicit scopes; clear increments authorization without starting services", async () => {
  const state = mkdtempSync(join(tmpdir(), "ash-read-cli-"));
  try {
    pair(state);
    const configPath = join(state, "device.json");
    writeFileSync(configPath, JSON.stringify({ stateDir: state }));
    const predictable = `${readAuthorizationPath(state)}.tmp-${process.pid}`;
    writeFileSync(predictable, "preexisting file", { mode: 0o644 });
    const neverStart = (async () => { throw new Error("must not start device"); }) as Parameters<typeof deviceCli>[0];
    await new Promise(resolve => setTimeout(resolve, 160)); // Drain our startup writes before opening the CLI watcher.
    await deviceCli(neverStart, ["read-scope", "--config", configPath, "--allow-cwd", "/tmp/one", "--allow-cwd", "/tmp/two"]);
    const signer = await fileSigner(state);
    assert.deepEqual(loadReadAuthorization(state, signer.id).allowedCwds, ["/tmp/one", "/tmp/two"]);
    assert.equal(statSync(readAuthorizationPath(state)).mode & 0o777, 0o600);
    assert.equal(readFileSync(predictable, "utf8"), "preexisting file");
    await new Promise(resolve => setTimeout(resolve, 160));
    await deviceCli(neverStart, ["read-scope", "--config", configPath, "--clear"]);
    assert.equal(loadReadAuthorization(state, signer.id).authorization_generation, 2);
    assert.equal(loadReadAuthorization(state, signer.id).state, "scope_required");
    const saved = readFileSync(readAuthorizationPath(state), "utf8");
    await assert.rejects(deviceCli(neverStart, ["read-scope", "--config", configPath, "--allow-cwd", "relative"]));
    assert.equal(readFileSync(readAuthorizationPath(state), "utf8"), saved);
    rmSync(readAuthorizationPath(state)); mkdirSync(readAuthorizationPath(state));
    await assert.rejects(deviceCli(neverStart, ["read-scope", "--config", configPath, "--clear"]));
    assert.deepEqual(readdirSync(state).filter(name => name.startsWith("collaboration-read.json.tmp-")), [`collaboration-read.json.tmp-${process.pid}`]);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("concurrent scope writers use private unique temporary files and leave an atomic revision-bound scope", async () => {
  const state = mkdtempSync(join(tmpdir(), "ash-read-cli-concurrent-"));
  try {
    pair(state);
    const configPath = join(state, "device.json");
    writeFileSync(configPath, JSON.stringify({ stateDir: state }));
    const signer = await fileSigner(state);
    const neverStart = (async () => { throw new Error("must not start device"); }) as Parameters<typeof deviceCli>[0];
    await new Promise(resolve => setTimeout(resolve, 160));
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => deviceCli(neverStart, ["read-scope", "--config", configPath, "--allow-cwd", `/tmp/concurrent-${index}`])));
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    for (const result of outcomes) if (result.status === "rejected") assert.match(result.reason.message, /Read scope: (stale|busy)/);
    const saved = loadReadAuthorization(state, signer.id);
    assert.equal(saved.state, "scope_required"); assert.equal(saved.allowedCwds.length, 1);
    assert.match(saved.allowedCwds[0], /^\/tmp\/concurrent-[0-5]$/);
    assert.match(saved.authorization_revision, /^[a-f0-9]{64}$/);
    assert.equal(statSync(readAuthorizationPath(state)).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(state).filter(name => name.startsWith("collaboration-read.json.tmp-")), []);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
