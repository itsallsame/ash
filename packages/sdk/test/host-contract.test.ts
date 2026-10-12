import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { HOST_CONTRACT, HOST_SPEC_SCHEMA, type HostSpec } from "../src/host";

const validate = new Ajv({ strict: false, allErrors: true }).compile(HOST_SPEC_SCHEMA);

// Typed on purpose: if HostSpec changes shape this stops compiling, and the schema checks below say whether it still agrees.
const full: HostSpec = {
  contract: HOST_CONTRACT,
  host: { kind: "any", version: "0.4.0" },
  platform: { os: "linux", os_version: "6", arch: "arm64", model: "m", locale: "zh-CN", timezone: "Asia/Shanghai" },
  dirs: { state: "/s", home: "/h", tmp: "/t", runtime: "/r", logs: "/l" },
  isolation: { kind: "proot", proot: { root: "/c", rootfs: "/c/u", bin: "/b", loader: "/l", lib: "/lib", storage_binds: ["/a:/a"], dns: ["1.1.1.1"] } },
  network: { proxy: { http: "h", https: "s", no_proxy: "n" } },
  capabilities: ["identity", "lifecycle", "status", "wake", "power", "hands", "update", "future"],
  secure_storage: "keychain",
  dev: { owner_token: false },
};
const keys: Record<keyof HostSpec, true> = { contract: true, host: true, platform: true, dirs: true, isolation: true, network: true, capabilities: true, secure_storage: true, dev: true };

describe("host.json schema", () => {
  it("is the checked-in packages/sdk/schema/host.json (regenerate with npm run gen:host-schema)", () => {
    const file = readFileSync(fileURLToPath(new URL("../schema/host.json", import.meta.url)), "utf8");
    assert.equal(file, `${JSON.stringify(HOST_SPEC_SCHEMA, null, 2)}\n`);
  });

  it("describes exactly the fields of HostSpec", () => {
    assert.deepEqual(Object.keys(HOST_SPEC_SCHEMA.properties).sort(), Object.keys(keys).sort());
  });

  it("accepts the typed samples", () => {
    assert.ok(validate(full), JSON.stringify(validate.errors));
    const minimal: HostSpec = {
      contract: HOST_CONTRACT, host: { kind: "k", version: "1" }, platform: { os: "linux", arch: "x64" },
      dirs: full.dirs, isolation: { kind: "native", native: { workspace: "/w", dsh_bin: "/d", dsh_home: "/dh" } },
      capabilities: ["identity", "lifecycle", "status"], secure_storage: "none",
    };
    assert.ok(validate(minimal), JSON.stringify(validate.errors));
    assert.ok(validate({ ...minimal, isolation: { kind: "container", container: { engine: "docker", image: "i" } }, network: { proxy: null } }));
    assert.ok(validate({ ...minimal, extra_field_from_a_newer_host: 1 }), "extra fields keep ash-host/1");
  });

  it("rejects a sample missing any required field or with a wrong value", () => {
    for (const key of HOST_SPEC_SCHEMA.required) {
      const broken: Record<string, unknown> = { ...full };
      delete broken[key];
      assert.equal(validate(broken), false, `missing ${key}`);
    }
    for (const key of HOST_SPEC_SCHEMA.properties.dirs.required) assert.equal(validate({ ...full, dirs: { ...full.dirs, [key]: undefined } }), false, `dirs.${key}`);
    assert.equal(validate({ ...full, contract: "ash-host/2" }), false);
    assert.equal(validate({ ...full, secure_storage: "cloud" }), false);
    assert.equal(validate({ ...full, isolation: { kind: "proot" } }), false);
    assert.equal(validate({ ...full, isolation: { kind: "proot", proot: { root: "/c" } } }), false);
    assert.equal(validate({ ...full, isolation: { kind: "vm", vm: {} } }), false);
    assert.equal(validate({ ...full, capabilities: ["identity", "identity"] }), false);
    assert.equal(validate({ ...full, network: { proxy: "http://p" } }), false);
  });
});
