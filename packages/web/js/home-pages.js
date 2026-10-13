// The pages of 她的主页, by the name `ash:open` gives them (design/app/IMPLEMENTATION.md: waiting upcoming memory promises hands backstage
// identity files activity) and the pages under them (settled device connect browser apps app keys model usage advanced).
import { homePage } from "./home-page.js";
import { waitingPage, settledPage } from "./home-waiting.js";
import { activityPage } from "./home-activity.js";
import { upcomingPage } from "./home-upcoming.js";
import { memoryPage, identityPage } from "./home-memory.js";
import { promisesPage } from "./home-promises.js";
import { handsPage } from "./home-hands.js";
import { devicePage, connectPage } from "./home-devices.js";
import { appsPage, appPage } from "./home-apps.js";
import { backstagePage, keysPage, modelPage, usagePage, advancedPage } from "./home-backstage.js";
import { filesPage } from "./home-files.js";

export const PAGES = {
  home: homePage, waiting: waitingPage, settled: settledPage, activity: activityPage, upcoming: upcomingPage, memory: memoryPage, promises: promisesPage,
  hands: handsPage, device: devicePage, connect: connectPage, apps: appsPage, app: appPage, backstage: backstagePage,
  keys: keysPage, model: modelPage, usage: usagePage, advanced: advancedPage, identity: identityPage, files: filesPage,
};
// The names the kernel and the page used before the pages were moved.
PAGES.approvals = waitingPage;
PAGES.plans = upcomingPage;
