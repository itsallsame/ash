// edges/apps: app backends as members `app:<id>`, and the words of `service:apps`.
//
//   const apps = createApps({ router, registry, ledger, primaryAgent, launcher, builtinApps });
//   registry.add(apps.service);
//   await apps.start();                 // endpoint for the apps, seed the hub's organs, start what is installed
//   // on lifecycle.stop:  await apps.stopAll(event.deadline);
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Member } from "../../../../sdk/src/word";
import { AppRuntime, type AppRuntimeOptions } from "./runtime";
import { createAppsService } from "./words";

export { AppRuntime, hostLauncher, type AppInfo, type AppLauncher, type AppOrigin, type AppReport, type AppRuntimeOptions, type AppSpawn } from "./runtime";
export { AppBridge, APP_BRIDGE_TOOLS, ownerText, type BridgeResult, type RecentFacts } from "./bridge";
export { AppGrants, needKey, type AppGrant } from "./store";
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
 * The hub's own organs (ash-skills/organs/<id>): each is copied into the apps folder the first time and then left alone,
 * because after that the agent maintains it. Returns their ids, for `builtinApps`.
 */
export function installBuiltinOrgans(source: string, root: string): string[] {
  const ids = existsSync(source) ? readdirSync(source, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  for (const id of ids) if (!existsSync(join(root, id))) cpSync(join(source, id), join(root, id), { recursive: true });
  return ids;
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
