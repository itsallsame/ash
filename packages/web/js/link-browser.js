// The browser client of packages/link, behind its own file so that the app's page (which may not compile code at run
// time, and has no socket of its own) can be built without it: tools/gen-ui.mjs swaps this file for an empty one.
export { HandClient, browserConnector } from "../../link/src/browser.ts";
