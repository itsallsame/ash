// The hub's own apps (organs and first-party apps) are shipped with the release and copied into the apps folder. The agent
// may change them afterwards, so a new release cannot simply overwrite. Each copy carries `.builtin.json`
// ({version, sha256}): the version and content digest of the files the release brought. At every start:
//   - the release is newer and the folder still has the digest on record (nobody touched it): the folder is replaced;
//   - the release is newer and the folder differs from the record (the agent changed it): the agent's version stays, and
//     the main agent is told (the runtime sends it) so it can merge by itself;
//   - otherwise nothing is touched.
// Only a folder that is exactly the release (by the release's own digest, not the record) is granted from its app.json: what the
// agent wrote into a built-in app can never widen what the app may do.
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
  /** A replacement by this release was started and may not have finished. */
  upgrading?: string;
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
    return typeof json.version === "string" && typeof json.sha256 === "string"
      ? { version: json.version, sha256: json.sha256, ...(typeof json.notified === "string" ? { notified: json.notified } : {}), ...(typeof json.upgrading === "string" ? { upgrading: json.upgrading } : {}) } : null;
  } catch { return null; }
}

export function writeMarker(dir: string, marker: BuiltinMarker): void {
  writeFileSync(join(dir, BUILTIN_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
}

/** Remember that the main agent was told about this release (also for a folder that had no record: it gets one saying "nothing is vouched for"). */
export function markNotified(dir: string, version: string): void {
  writeMarker(dir, { ...(readMarker(dir) ?? { version: "0", sha256: "" }), notified: version });
}

/** Test seam: called before each step of a copy or replacement, so a test can stop it half way. */
export interface BuiltinHooks { step?(name: string): void }

/** What one app folder came to: whether it is exactly the release now, and what (if anything) the main agent must be told. */
export interface BuiltinOutcome { exact: boolean; kept: BuiltinKept | null }
/** What a sync of many apps found: the held-back ones, and the ids whose folder is exactly the release (only those may be granted from their app.json). */
export interface BuiltinReport { kept: BuiltinKept[]; exact: Set<string> }
export const newBuiltinReport = (): BuiltinReport => ({ kept: [], exact: new Set() });

/**
 * Bring one app folder up to the release in `from` (see the top of this file). The app's data folder is never moved or
 * deleted. The replacement is marked in `.builtin.json` (`upgrading`) before it starts, so one that was cut short (the
 * phone died) is simply done again at the next start instead of being taken for the agent's own edit.
 */
export function syncBuiltinApp(id: string, from: string, root: string, log: (...args: unknown[]) => void = () => {}, hooks: BuiltinHooks = {}): BuiltinOutcome {
  const step = (name: string) => hooks.step?.(name);
  const to = join(root, id), fresh = join(root, `.new-${id}`);
  const shipped = manifestOf(from);
  const skip = new Set(["data", ...(shipped.dataDir ? [shipped.dataDir] : [])]);
  const sha256 = digestFolder(from, skip);
  const prepare = (): void => {
    rmSync(fresh, { recursive: true, force: true });
    cpSync(from, fresh, { recursive: true });
    for (const name of skip) rmSync(join(fresh, name), { recursive: true, force: true });
  };
  if (!existsSync(to)) {
    prepare();
    writeMarker(fresh, { version: shipped.version, sha256 });
    step("install");
    renameSync(fresh, to);
    return { exact: true, kept: null };
  }
  rmSync(fresh, { recursive: true, force: true }); // left over from a cut-short replacement: only ever release files
  const marker = readMarker(to);
  const current = digestFolder(to, skip);
  if (current === sha256) {
    // Already exactly the release (copied by hand, a replacement just finished, or the record is old): make the record right.
    if (marker?.version !== shipped.version || marker.sha256 !== sha256 || marker.upgrading) writeMarker(to, { version: shipped.version, sha256 });
    return { exact: true, kept: null };
  }
  // A folder without a record is one nobody can vouch for: it counts as changed by the agent.
  const recorded = marker ?? { version: "0", sha256: "" };
  if (marker?.upgrading === undefined && compareVersions(shipped.version, recorded.version) <= 0) return { exact: false, kept: null };
  if (marker?.upgrading !== undefined || current === recorded.sha256) {
    prepare();
    writeMarker(to, { ...recorded, upgrading: shipped.version });
    step("marked");
    for (const entry of readdirSync(to)) {
      if (skip.has(entry) || entry === BUILTIN_MARKER) continue;
      step(`remove ${entry}`);
      rmSync(join(to, entry), { recursive: true, force: true });
    }
    for (const entry of readdirSync(fresh)) {
      step(`move ${entry}`);
      renameSync(join(fresh, entry), join(to, entry));
    }
    step("done");
    writeMarker(to, { version: shipped.version, sha256 });
    rmSync(fresh, { recursive: true, force: true });
    log("builtin app upgraded", id, recorded.version, "->", shipped.version);
    return { exact: true, kept: null };
  }
  // The new release is put where the agent can read it, to merge from.
  const release = join(root, RELEASE_DIR, id);
  rmSync(release, { recursive: true, force: true });
  cpSync(from, release, { recursive: true });
  log("builtin app kept: the agent changed it", id, `release ${shipped.version}, recorded ${recorded.version}`);
  return { exact: false, kept: marker?.notified === shipped.version ? null : { id, shipped: shipped.version, current: manifestOf(to).version } };
}

/** Every app folder in `source` brought up to date in `root`; returns their ids and fills `report`. */
export function syncBuiltinApps(source: string, root: string, report: BuiltinReport = newBuiltinReport(), log?: (...args: unknown[]) => void, hooks?: BuiltinHooks): string[] {
  const ids = existsSync(source) ? readdirSync(source, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  if (ids.length) mkdirSync(root, { recursive: true });
  for (const id of ids) {
    try {
      const outcome = syncBuiltinApp(id, join(source, id), root, log, hooks);
      if (outcome.kept) report.kept.push(outcome.kept);
      if (outcome.exact) report.exact.add(id);
    } catch (error) { log?.("builtin app could not be updated", id, error instanceof Error ? error.message : error); }
  }
  return ids;
}
