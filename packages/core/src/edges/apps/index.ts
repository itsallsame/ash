// edges/apps: app backends as members `app:<id>`, and the words of `service:apps`.
//
//   const apps = createApps({ router, registry, ledger, primaryAgent, launcher, builtinApps });
//   registry.add(apps.service);
//   await apps.start();                 // endpoint for the apps, seed the hub's organs, start what is installed
//   // on lifecycle.stop:  await apps.stopAll(event.deadline);
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
