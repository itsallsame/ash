// Writes packages/sdk/schema/link/ from the frame definitions in src/link.ts. `--check` only compares.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { linkSchemaFiles } from "../src/link.ts";

const dir = join(fileURLToPath(new URL("..", import.meta.url)), "schema", "link");
const files = linkSchemaFiles();
if (process.argv.includes("--check")) {
  const onDisk = new Set(readdirSync(dir));
  const stale = Object.keys(files).filter((name) => !onDisk.has(name) || readFileSync(join(dir, name), "utf8") !== files[name]);
  const extra = [...onDisk].filter((name) => !(name in files));
  if (stale.length || extra.length) {
    process.stderr.write(`schema/link is out of date (changed: ${stale.join(", ") || "-"}; unexpected: ${extra.join(", ") || "-"}); run npm run gen:link-schema\n`);
    process.exit(1);
  }
} else {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}
