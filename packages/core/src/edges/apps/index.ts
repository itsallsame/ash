// edges/apps: app backends as members `app:<id>`, and the words of `service:apps`.
//
//   const apps = createApps({ router, registry, ledger, primaryAgent, launcher, builtinApps });
//   registry.add(apps.service);
//   await apps.start();                 // endpoint for the apps, seed the hub's organs, start what is installed
//   // on lifecycle.stop:  await apps.stopAll(event.deadline);
import { cpSync, existsSync, readdirSync } from "node:fs";
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
