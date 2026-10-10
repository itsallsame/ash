import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RELAY_BUNDLE_FILE, relayBundleFile } from "../../../src/edges/link-server/control/bundle";

test("relayBundleFile: reports the missing file with its path, reads it once it is there, and treats an empty file as missing", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "relay-bundle-"));
  try {
    const path = join(dir, RELAY_BUNDLE_FILE);
    const bundle = relayBundleFile(path);
    assert.equal(RELAY_BUNDLE_FILE, "ash-gateway.mjs");
    assert.match(bundle.missing()!, new RegExp(`not at ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await assert.rejects(bundle.read());
    await writeFile(path, "");
    assert.ok(bundle.missing(), "an empty file is no program");
    await writeFile(path, "export default {};\n");
    assert.equal(bundle.missing(), null, "checked at every call: the file arrived");
    assert.equal(await bundle.read(), "export default {};\n");
    assert.ok(relayBundleFile(dir).missing(), "a directory is no program");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
