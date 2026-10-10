/**
 * The relay program as files (SPEC-03 §8.1 item 5): the gateway's `npm run build:bundle` writes one ES module,
 * `ash-gateway.mjs`, and `ash-gateway.metadata.json` (the upload metadata: entry module, compatibility, bindings,
 * migration, what a redeploy keeps). The app carries both next to the hub's own program; `gateway.setup.deploy`
 * uploads them. The metadata is the gateway's: the hub only adds what it knows at deploy time (see setup.ts).
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** The file name the gateway's build gives the relay program. */
export const RELAY_BUNDLE_FILE = "ash-gateway.mjs";
/** The upload metadata the gateway's build writes beside the program. */
export const RELAY_METADATA_FILE = "ash-gateway.metadata.json";

/** The relay program and the metadata part of its upload. */
export interface RelayProgram {
  /** The program's text. */
  source: string;
  /** The gateway's upload metadata, as built: `main_module` names the part [source] is uploaded as. */
  metadata: Record<string, unknown> & { main_module: string };
}

export interface RelayBundle {
  /** The program and its metadata. Throws when a file cannot be read or the metadata is not what the gateway writes. */
  read(): Promise<RelayProgram>;
  /** Why there is no program to deploy (a sentence for the owner), or null when the files are there. Checked at every call. */
  missing(): string | null;
}

const present = (path: string): boolean => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;

/** [path] is the program; its metadata is beside it, `<name>.metadata.json`. */
export function relayBundleFile(path: string): RelayBundle {
  const metadataPath = path.replace(/\.mjs$/, "") + ".metadata.json";
  return {
    async read() {
      const [source, text] = await Promise.all([readFile(path, "utf8"), readFile(metadataPath, "utf8")]);
      const metadata = JSON.parse(text) as RelayProgram["metadata"];
      if (!metadata || typeof metadata !== "object" || typeof metadata.main_module !== "string" || !metadata.main_module) throw new Error(`${metadataPath} has no main_module`);
      return { source, metadata };
    },
    missing: () => (present(path) ? (present(metadataPath) ? null : `the packaged relay metadata is not at ${metadataPath}`) : `the packaged relay program is not at ${path}`),
  };
}
