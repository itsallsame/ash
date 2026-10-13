// Writes docs/app.schema.json from APP_SCHEMA (packages/sdk/src/app.ts), the only source.
// Run: npm run gen:app-schema   (add --check to fail when the file is stale)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_SCHEMA } from "../packages/sdk/src/app.ts";

const out = fileURLToPath(new URL("../docs/app.schema.json", import.meta.url));
const text = `${JSON.stringify(APP_SCHEMA, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) { console.error("docs/app.schema.json is stale: run npm run gen:app-schema"); process.exit(1); }
} else writeFileSync(out, text);
