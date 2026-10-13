import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HOST_ENV, HOST_EXIT_CONFIG, type HostSpec } from "../../../../sdk/src/host";
import { loadHostBoot } from "../../../src/edges/host";
import { FakeHost } from "../../fixtures/host";

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
    assert.deepEqual(read.capabilities, host.capabilities);
    assert.equal(read.secure_storage, "file");
    assert.equal(read.dev?.owner_token, true);
  });

  it("needs only the spec path from the environment, and leaves it there", async () => {
    host = await new FakeHost().start();
    const { env, specPath } = host.writeLaunch();
    assert.deepEqual(Object.keys(env), [HOST_ENV.spec], "no secret is in the environment");
    assert.ok(loadHostBoot({ env }).ok);
    assert.equal(env[HOST_ENV.spec], specPath);
  });

  it("uses process.env by default", async () => {
    host = await new FakeHost().start();
    const { env } = host.writeLaunch();
    Object.assign(process.env, env);
    try { assert.ok(loadHostBoot().ok); } finally { delete process.env[HOST_ENV.spec]; }
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

  it("refuses a missing or malformed launch description", async () => {
    host = await new FakeHost().start();
    await refused(host, /ASH_HOST_SPEC/, {}, (env) => { delete env[HOST_ENV.spec]; });
    await refused(host, /cannot read host spec/, {}, (env) => { env[HOST_ENV.spec] = "/nonexistent/host.json"; });
    await refused(host, /invalid/, { dirs: undefined as never });
  });

  it("ignores capability names it does not know", async () => {
    host = await new FakeHost({ capabilities: ["identity", "lifecycle", "status", "telepathy"] }).start();
    assert.ok(loadHostBoot({ env: host.writeLaunch().env }).ok);
  });
});
