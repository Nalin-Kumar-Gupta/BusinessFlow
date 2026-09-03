// Shared Playwright fixtures for TestTrace extension tests.
//
// Provides:
//   - `extensionId`  — the Chrome extension ID assigned at load time
//   - `popupPage`    — a page opened to the extension's popup URL
//   - `reportPage`   — a page opened to the extension's report/options URL

import { test as base, chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../../dist');

function resolveChromiumExecutable(): string | undefined {
  const fromEnv = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  if (fromEnv) return fromEnv;

  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'darwin' && fs.existsSync(macChrome)) return macChrome;
  return undefined;
}

async function resolveExtensionIdFromTargets(page: Page): Promise<string | null> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const targets = await cdp.send('Target.getTargets') as {
    targetInfos: Array<{ type: string; url: string }>;
  };

  for (const t of targets.targetInfos) {
    if (!t.url.startsWith('chrome-extension://')) continue;
    if (!['service_worker', 'background_page', 'page'].includes(t.type)) continue;
    try {
      const parsed = new URL(t.url);
      if (parsed.hostname) return parsed.hostname;
    } catch {
      // ignore malformed target url
    }
  }
  return null;
}

async function waitForExtensionId(context: BrowserContext): Promise<string> {
  const existing = context.serviceWorkers();
  if (existing[0]) {
    return new URL(existing[0].url()).hostname;
  }

  const probe = await context.newPage();
  try {
    await probe.goto('about:blank');

    for (let attempt = 0; attempt < 12; attempt++) {
      const fromTargets = await resolveExtensionIdFromTargets(probe);
      if (fromTargets) return fromTargets;

      const sw = await context.waitForEvent('serviceworker', { timeout: 1500 }).catch(() => null);
      if (sw) {
        return new URL(sw.url()).hostname;
      }

      await probe.waitForTimeout(250);
    }

    const finalFromTargets = await resolveExtensionIdFromTargets(probe);
    if (finalFromTargets) return finalFromTargets;

    throw new Error('Extension service worker/target not detected after retries');
  } finally {
    await probe.close();
  }
}

export interface TestTraceFixtures {
  context: BrowserContext;
  extensionId: string;
  popupPage: import('@playwright/test').Page;
  reportPage: import('@playwright/test').Page;
}

export const test = base.extend<TestTraceFixtures>({
  // Each test gets a fresh browser context with the extension loaded.
  context: async ({}, use) => {
    const ctx = await chromium.launchPersistentContext('', {
      executablePath: resolveChromiumExecutable(),
      headless: false,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
    });
    await use(ctx);
    await ctx.close();
  },

  extensionId: async ({ context }, use) => {
    const id = await waitForExtensionId(context);
    await use(id);
  },

  popupPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/ui/panel.html`);
    await use(page);
    await page.close();
  },

  reportPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/ui/report.html`);
    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';
