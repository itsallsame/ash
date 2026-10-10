// The hub's own apps (organs and first-party apps) are shipped with the release and copied into the apps folder. The agent
// may change them afterwards, so a new release cannot simply overwrite. Each copy carries `.builtin.json`
// ({version, sha256}): the version and content digest of the files the release brought. At every start:
//   - the release is newer and the folder still has the digest on record (nobody touched it): the folder is replaced;
//   - the release is newer and the folder differs from the record (the agent changed it): the agent's version stays, and
//     the main agent is told (the runtime sends it) so it can merge by itself;
//   - otherwise nothing is touched.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BUILTIN_MARKER = ".builtin.json";
/** Under the apps folder: the newest release of each app the agent changed, kept for it to read (not an app: it has no app.json of its own at this level). */
export const RELEASE_DIR = "_release";

export interface BuiltinMarker {
  version: string;
  sha256: string;
  /** The release version the main agent was last told was held back (so a restart does not tell it again). */
  notified?: string;
}
/** A release that was not applied because the agent changed the app: the main agent is told. */
export interface BuiltinKept { id: string; shipped: string; current: string }

/** Dotted numbers compared part by part ("1.10.0" > "1.9.2"); anything after a "-" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0]!.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

function manifestOf(dir: string): { version: string; dataDir: string | null } {
  try {
    const json = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as { version?: unknown; data_dir?: unknown };
    return { version: typeof json.version === "string" ? json.version : "0", dataDir: typeof json.data_dir === "string" ? json.data_dir : null };
  } catch { return { version: "0", dataDir: null }; }
}

/** A digest of the files in `dir`, by path and content; not the marker, not the app's data folder (both at the top level). */
export function digestFolder(dir: string, skip: ReadonlySet<string>): string {
  const hash = createHash("sha256");
  const walk = (path: string, rel: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!rel && (entry.name === BUILTIN_MARKER || skip.has(entry.name))) continue;
      const name = rel ? `${rel}/${entry.name}` : entry.name, full = join(path, entry.name);
      if (entry.isDirectory()) { hash.update(`d ${name}\n`); walk(full, name); }
      else if (entry.isSymbolicLink()) hash.update(`l ${name} ${readlinkSync(full)}\n`);
      else hash.update(`f ${name} ${createHash("sha256").update(readFileSync(full)).digest("hex")}\n`);
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

export function readMarker(dir: string): BuiltinMarker | null {
  try {
    const json = JSON.parse(readFileSync(join(dir, BUILTIN_MARKER), "utf8")) as Partial<BuiltinMarker>;
    return typeof json.version === "string" && typeof json.sha256 === "string" ? { version: json.version, sha256: json.sha256, ...(typeof json.notified === "string" ? { notified: json.notified } : {}) } : null;
  } catch { return null; }
}

export function writeMarker(dir: string, marker: BuiltinMarker): void {
  writeFileSync(join(dir, BUILTIN_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
}

/** Remember that the main agent was told about this release. */
export function markNotified(dir: string, version: string): void {
  const marker = readMarker(dir);
  if (marker) writeMarker(dir, { ...marker, notified: version });
}

/**
 * Bring one app folder up to the release in `from` (see the top of this file). Returns what the main agent must be told
 * about, or null.
 */
export function syncBuiltinApp(id: string, from: string, root: string, log: (...args: unknown[]) => void = () => {}): BuiltinKept | null {
  const to = join(root, id);
  const shipped = manifestOf(from);
  const skip = new Set(["data", ...(shipped.dataDir ? [shipped.dataDir] : [])]);
  const sha256 = digestFolder(from, skip);
  if (!existsSync(to)) {
    cpSync(from, to, { recursive: true });
    writeMarker(to, { version: shipped.version, sha256 });
    return null;
  }
  const marker = readMarker(to);
  const current = digestFolder(to, skip);
  if (current === sha256) {
    // Already exactly the release (copied by hand, or the marker is old or missing): just make the record right.
    if (marker?.version !== shipped.version || marker.sha256 !== sha256) writeMarker(to, { version: shipped.version, sha256 });
    return null;
  }
  // A folder without a record is one nobody can vouch for: it counts as changed by the agent.
  const recorded = marker ?? { version: "0", sha256: "" };
  if (compareVersions(shipped.version, recorded.version) <= 0) return null;
  if (current === recorded.sha256) {
    const fresh = join(root, `.new-${id}`), old = join(root, `.old-${id}`);
    rmSync(fresh, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
    cpSync(from, fresh, { recursive: true });
    for (const name of skip) if (existsSync(join(to, name))) { rmSync(join(fresh, name), { recursive: true, force: true }); renameSync(join(to, name), join(fresh, name)); }
    renameSync(to, old);
    renameSync(fresh, to);
    rmSync(old, { recursive: true, force: true });
    writeMarker(to, { version: shipped.version, sha256 });
    log("builtin app upgraded", id, recorded.version, "->", shipped.version);
    return null;
  }
  // The new release is put where the agent can read it, to merge from.
  const release = join(root, RELEASE_DIR, id);
  rmSync(release, { recursive: true, force: true });
  cpSync(from, release, { recursive: true });
  log("builtin app kept: the agent changed it", id, `release ${shipped.version}, recorded ${recorded.version}`);
  return marker?.notified === shipped.version ? null : { id, shipped: shipped.version, current: manifestOf(to).version };
}

/** Every app folder in `source` brought up to date in `root`; returns their ids, and adds the held-back ones to `kept`. */
export function syncBuiltinApps(source: string, root: string, kept: BuiltinKept[] = [], log?: (...args: unknown[]) => void): string[] {
  const ids = existsSync(source) ? readdirSync(source, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  if (ids.length) mkdirSync(root, { recursive: true });
  for (const id of ids) {
    try { const held = syncBuiltinApp(id, join(source, id), root, log); if (held) kept.push(held); }
    catch (error) { log?.("builtin app could not be updated", id, error instanceof Error ? error.message : error); }
  }
  return ids;
}
