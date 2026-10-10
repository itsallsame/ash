/**
 * The relay program as a file (SPEC-03 §8.1 item 5): the gateway's `npm run build:bundle` writes one ES module,
 * `ash-gateway.mjs`, and the app carries it next to the hub's own program. `gateway.setup.deploy` uploads its text.
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** The file name the gateway's build gives the relay program. */
export const RELAY_BUNDLE_FILE = "ash-gateway.mjs";

export interface RelayBundle {
  /** The program's text. Throws when the file cannot be read. */
  read(): Promise<string>;
  /** Why there is no program to deploy (a sentence for the owner), or null when the file is there. Checked at every call. */
  missing(): string | null;
}

export function relayBundleFile(path: string): RelayBundle {
  return {
    read: () => readFile(path, "utf8"),
    missing: () => (existsSync(path) && statSync(path).isFile() && statSync(path).size > 0 ? null : `the packaged relay program is not at ${path}`),
  };
}
