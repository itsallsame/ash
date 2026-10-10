// Writes packages/sdk/schema/host.json from HOST_SPEC_SCHEMA (packages/sdk/src/host.ts), the only source.
// Run: node --import tsx tools/gen-host-schema.mjs   (add --check to fail when the file is stale)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HOST_SPEC_SCHEMA } from "../packages/sdk/src/host.ts";

const out = fileURLToPath(new URL("../packages/sdk/schema/host.json", import.meta.url));
const text = `${JSON.stringify(HOST_SPEC_SCHEMA, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) { console.error("packages/sdk/schema/host.json is stale: run tools/gen-host-schema.mjs"); process.exit(1); }
} else writeFileSync(out, text);
