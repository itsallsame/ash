import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HOST_ENV, HOST_EXIT_CONFIG, type HostSpec } from "../../../../sdk/src/host";
import { hostFatal, loadHostBoot } from "../../../src/edges/host";
import { FAKE_SEAL_KEY, FAKE_TOKEN, FakeHost } from "../../fixtures/host";

let host: FakeHost | undefined;
afterEach(async () => { await host?.stop(); host = undefined; });

describe("host spec", () => {
  it("reads every field of host.json", async () => {
    host = await new FakeHost().start();
    const { env, spec, specPath } = host.writeLaunch({
      isolation: {
        kind: "proot",
        proot: { root: "/r", rootfs: "/r/ubuntu", bin: "/r/proot/bin/proot", loader: "/r/proot/libexec/loader", lib: "/r/proot/lib", storage_binds: ["/sdcard:/sdcard"], dns: ["223.5.5.5"] },
      },
      network: { proxy: { http: "http://p:1", https: "http://p:1", no_proxy: "localhost" } },
      dev: { owner_token: true },
    });
    const result = loadHostBoot({ env });
    assert.ok(result.ok);
    assert.deepEqual(result.boot.spec, JSON.parse(JSON.stringify(spec)));
    assert.equal(result.boot.specPath, specPath);
    const read: HostSpec = result.boot.spec;
    assert.equal(read.contract, "ash-host/1");
    assert.deepEqual(read.host, { kind: "fake", version: "0.0.1" });
    assert.equal(read.platform.timezone, "UTC");
    assert.equal(read.dirs.logs, spec.dirs.logs);
    assert.equal(read.isolation.kind, "proot");
    assert.deepEqual(read.network?.proxy, { http: "http://p:1", https: "http://p:1", no_proxy: "localhost" });
    assert.equal(read.endpoint, host.endpoint);
    assert.deepEqual(read.capabilities, host.capabilities);
    assert.equal(read.secure_storage, "file");
    assert.equal(read.dev?.owner_token, true);
  });

  it("keeps the spec path but removes the seal key and token from the environment", async () => {
    host = await new FakeHost().start();
    const { env, specPath } = host.writeLaunch();
    const result = loadHostBoot({ env });
    assert.ok(result.ok);
    assert.equal(env[HOST_ENV.spec], specPath);
    assert.ok(!(HOST_ENV.sealKey in env));
    assert.ok(!(HOST_ENV.token in env));
    assert.equal(result.boot.secrets.token, FAKE_TOKEN);
    assert.equal(result.boot.secrets.sealKey.toString("base64url"), FAKE_SEAL_KEY);
    assert.ok(!JSON.stringify(result.boot).includes(FAKE_TOKEN), "secrets stay out of a serialized boot");
  });

  it("uses process.env by default and clears the secrets there", async () => {
    host = await new FakeHost().start();
    const { env } = host.writeLaunch();
    Object.assign(process.env, env);
    try {
      assert.ok(loadHostBoot().ok);
      assert.equal(process.env[HOST_ENV.sealKey], undefined);
      assert.equal(process.env[HOST_ENV.token], undefined);
      assert.ok(process.env[HOST_ENV.spec]);
    } finally { delete process.env[HOST_ENV.spec]; }
  });

  it("removes the secrets even when the launch is refused", async () => {
    host = await new FakeHost({ contract: "ash-host/2" }).start();
    const { env } = host.writeLaunch();
    assert.equal(loadHostBoot({ env }).ok, false);
    assert.ok(!(HOST_ENV.sealKey in env) && !(HOST_ENV.token in env));
  });

  const refused = async (host: FakeHost, pattern: RegExp, overrides: Partial<HostSpec> = {}, tweak?: (env: NodeJS.ProcessEnv) => void) => {
    const { env } = host.writeLaunch(overrides);
    tweak?.(env);
    const result = loadHostBoot({ env });
    assert.ok(!result.ok, "launch is refused");
    assert.equal(result.exitCode, HOST_EXIT_CONFIG);
    assert.equal(HOST_EXIT_CONFIG, 78);
    assert.match(result.reason, pattern);
  };

  it("refuses a wrong contract version with exit code 78", async () => {
    host = await new FakeHost({ contract: "ash-host/2" }).start();
    await refused(host, /ash-host\/2.*ash-host\/1/);
  });

  for (const missing of ["identity", "lifecycle", "status"] as const) {
    it(`refuses a host without required capability ${missing}`, async () => {
      host = await new FakeHost({ without: [missing] }).start();
      await refused(host, new RegExp(`required capabilities: ${missing}`));
    });
  }

  it("refuses a host without secure storage unless it is a development run", async () => {
    host = await new FakeHost({ secureStorage: "none" }).start();
    await refused(host, /secure storage/);
    const dev = await new FakeHost({ secureStorage: "none", dev: { owner_token: true } }).start();
    try { assert.ok(loadHostBoot({ env: dev.writeLaunch().env }).ok); } finally { await dev.stop(); }
  });

  it("refuses a missing or malformed launch description or secret", async () => {
    host = await new FakeHost().start();
    await refused(host, /ASH_HOST_SPEC/, {}, (env) => { delete env[HOST_ENV.spec]; });
    await refused(host, /cannot read host spec/, {}, (env) => { env[HOST_ENV.spec] = "/nonexistent/host.json"; });
    await refused(host, /invalid/, { endpoint: "" as string, dirs: undefined as never });
    await refused(host, /ASH_VAULT_SEAL_KEY/, {}, (env) => { env[HOST_ENV.sealKey] = "short"; });
    await refused(host, /ASH_HOST_TOKEN/, {}, (env) => { delete env[HOST_ENV.token]; });
  });

  it("ignores capability names it does not know", async () => {
    host = await new FakeHost({ capabilities: ["identity", "lifecycle", "status", "telepathy"] }).start();
    assert.ok(loadHostBoot({ env: host.writeLaunch().env }).ok);
  });

  it("hostFatal logs the reason and exits with 78 through the given exit", () => {
    const logged: string[] = [];
    const exits: number[] = [];
    hostFatal({ ok: false, exitCode: 78, reason: "no way" }, { log: (line) => logged.push(line), exit: ((code: number) => { exits.push(code); return undefined as never; }) });
    assert.deepEqual(exits, [78]);
    assert.match(logged[0], /no way/);
  });
});
