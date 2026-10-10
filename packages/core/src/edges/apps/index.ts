// edges/apps: app backends as members `app:<id>`, and the words of `service:apps`.
//
//   const apps = createApps({ router, registry, ledger, primaryAgent, launcher, builtinApps });
//   registry.add(apps.service);
//   await apps.start();                 // endpoint for the apps, seed the hub's organs, start what is installed
//   // on lifecycle.stop:  await apps.stopAll(event.deadline);
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinApps, type BuiltinKept } from "./builtin";
import type { Member } from "../../../../sdk/src/word";
import { AppRuntime, type AppRuntimeOptions } from "./runtime";
import { createAppsService } from "./words";

export { AppRuntime, hostLauncher, type AppInfo, type AppLauncher, type AppOrigin, type AppReport, type AppRuntimeOptions, type AppSpawn } from "./runtime";
export { AppBridge, APP_BRIDGE_TOOLS, ownerText, type BridgeResult, type RecentFacts } from "./bridge";
export { AppGrants, needKey, type AppGrant } from "./store";
export { BUILTIN_MARKER, RELEASE_DIR, type BuiltinKept, type BuiltinMarker } from "./builtin";
export { createAppsService, APPS_ID } from "./words";

export interface Apps {
  runtime: AppRuntime;
  /** `service:apps`; add it to the registry. */
  service: Member;
  start(): Promise<void>;
  /** End every app's server before `deadline` (epoch ms); for `lifecycle.stop`. */
  stopAll(deadline: number): Promise<void>;
}

export function createApps(options: AppRuntimeOptions): Apps {
  const runtime = new AppRuntime(options);
  return { runtime, service: createAppsService(runtime), start: () => runtime.start(), stopAll: (deadline) => runtime.stopAll(deadline) };
}

/**
 * The hub's own apps, built in with the release: the organs (ash-skills/organs/<id>) and the first-party apps (packages/apps,
 * bundled into the payload). Each is copied into the apps folder the first time, with a `.builtin.json` recording what the
 * release brought. A newer release replaces a folder the agent never changed; one it did change is kept, and appended to
 * `kept` (the runtime tells the main agent). Returns their ids, for `builtinApps` (installed without a card: the release
 * decides, not a card). See ./builtin.ts.
 */
export function installBuiltinOrgans(source: string, root: string, kept: BuiltinKept[] = [], log?: (...args: unknown[]) => void): string[] {
  return syncBuiltinApps(source, root, kept, log);
}

/** The app contract as a file in the apps folder (`apps.contract` returns the same text and names this path). Rewritten only when it differs. */
export function installContractDoc(root: string, doc: string): void {
  const file = join(root, "APP-CONTRACT.md");
  try { if (readFileSync(file, "utf8") === doc) return; } catch { /* missing: write it */ }
  mkdirSync(root, { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, doc, { mode: 0o644 });
  renameSync(temp, file);
}
