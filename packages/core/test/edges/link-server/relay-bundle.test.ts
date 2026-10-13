import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RELAY_BUNDLE_FILE, RELAY_METADATA_FILE, relayBundleFile } from "../../../src/edges/link-server/control/bundle";

test("relayBundleFile: reports the missing file with its path, reads it once it is there, and needs the metadata beside it, and treats an empty file as missing", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "relay-bundle-"));
  try {
    const path = join(dir, RELAY_BUNDLE_FILE);
    const bundle = relayBundleFile(path);
    assert.equal(RELAY_BUNDLE_FILE, "ash-gateway.mjs");
    assert.equal(RELAY_METADATA_FILE, "ash-gateway.metadata.json");
    assert.match(bundle.missing()!, new RegExp(`not at ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await assert.rejects(bundle.read());
    await writeFile(path, "");
    assert.ok(bundle.missing(), "an empty file is no program");
    await writeFile(path, "export default {};\n");
    assert.match(bundle.missing()!, new RegExp(`metadata is not at ${join(dir, RELAY_METADATA_FILE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the program alone is not enough");
    await writeFile(join(dir, RELAY_METADATA_FILE), JSON.stringify({ main_module: "ash-gateway.mjs", keep_bindings: ["plain_text"] }));
    assert.equal(bundle.missing(), null, "checked at every call: the files arrived");
    assert.deepEqual(await bundle.read(), { source: "export default {};\n", metadata: { main_module: "ash-gateway.mjs", keep_bindings: ["plain_text"] } });
    await writeFile(join(dir, RELAY_METADATA_FILE), "{}");
    await assert.rejects(bundle.read(), /no main_module/);
    assert.ok(relayBundleFile(dir).missing(), "a directory is no program");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
