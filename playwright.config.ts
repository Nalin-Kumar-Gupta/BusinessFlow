// Playwright config for TestTrace e2e tests.
//
// Chrome extension testing constraints:
//   - Extensions only load in headed Chromium (headless=false) OR with
//     --headless=new (Chrome 112+). We use --headless=new for CI.
//   - Each test gets its own browser context with the extension pre-loaded.
//   - The fixture server must be running (managed via webServer below).

import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path to the built extension. Build before running e2e tests. */
const DIST = path.resolve(__dirname, 'dist');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Extension tests share browser state — serialize.
  retries: process.env['CI'] ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'testtrace-extension',
      use: {
        browserName: 'chromium',
        launchOptions: {
          headless: false, // switch to headless:new if needed for CI
          args: [
            // Load the built extension.
            `--disable-extensions-except=${DIST}`,
            `--load-extension=${DIST}`,
            // Suppress first-run UX.
            '--no-first-run',
            '--no-default-browser-check',
            // Required for stable extension ID in tests.
            '--disable-default-apps',
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'node fixture/server.mjs',
    url: 'http://localhost:3737',
    reuseExistingServer: !process.env['CI'],
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
