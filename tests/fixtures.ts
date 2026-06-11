// Custom Playwright fixtures: drive the user's already-running Chrome via
// CDP (started with --remote-debugging-port=9222). New pages open as tabs in
// their existing window — no second window, no incognito context.
//
// Falls back to Playwright's bundled Chromium if CDP isn't reachable.

import { test as base, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5190';

async function isCdpReachable(url: string, timeoutMs = 500): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${url}/json/version`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

type Fixtures = Record<string, never>;
type WorkerFixtures = { cdpMode: boolean };

export const test = base.extend<Fixtures, WorkerFixtures>({
  cdpMode: [
    async ({}, use) => {
      const ok = await isCdpReachable(CDP_URL);
      if (ok) {
        // eslint-disable-next-line no-console
        console.log(`[fixtures] using remote Chrome at ${CDP_URL}`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[fixtures] CDP unreachable at ${CDP_URL}; launching bundled Chromium`);
      }
      await use(ok);
    },
    { scope: 'worker' },
  ],

  browser: [
    async ({ cdpMode }, use) => {
      if (cdpMode) {
        const b: Browser = await chromium.connectOverCDP(CDP_URL);
        await use(b);
        // Do NOT close the user's browser.
      } else {
        const b = await chromium.launch();
        await use(b);
        await b.close();
      }
    },
    { scope: 'worker' },
  ],

  // Reuse the user's existing browser context so newPage opens a tab in their
  // window, not a separate window/incognito.
  context: async ({ browser, cdpMode }, use) => {
    if (cdpMode) {
      const existing: BrowserContext | undefined = browser.contexts()[0];
      const ctx = existing ?? (await browser.newContext());
      await use(ctx);
      // Do not close the shared context.
    } else {
      const ctx = await browser.newContext();
      await use(ctx);
      await ctx.close();
    }
  },

  // Open a fresh tab per test and close it after, so we don't leave litter.
  page: async ({ context }, use) => {
    const page = await context.newPage();
    // Wipe planetar-ui's localStorage namespace before each test so prior
    // sessions don't bias outcomes.
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem('planetar-ui-layout');
      } catch {
        /* ignore */
      }
    });
    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';

// Helper: navigate to the running app and wait for the shell to render.
// Centralised so tests don't hard-code the URL.
export async function openApp(page: Page): Promise<void> {
  await page.goto(APP_URL);
  await page.waitForSelector('.app');
}

export const URLS = { app: APP_URL };
