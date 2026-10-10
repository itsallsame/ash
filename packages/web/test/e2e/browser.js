// A real browser for the page's end-to-end tests. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use a Chrome that is already installed;
// without any browser the tests are skipped, not failed.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

const CANDIDATES = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, "/usr/bin/google-chrome", "/usr/bin/chromium", "/snap/bin/chromium"].filter(Boolean);

export async function launchBrowser() {
  const executablePath = CANDIDATES.find((path) => existsSync(path));
  try {
    return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  } catch {
    return null;
  }
}

/** A new page of [browser] on a phone-sized screen. */
export async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
  return { page: await context.newPage(), context };
}
