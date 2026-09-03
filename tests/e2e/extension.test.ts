// TestTrace e2e — extension smoke tests.
//
// Prerequisites: `pnpm build` must have run so dist/ exists.
// Run: `pnpm e2e`
//
// These tests verify that the extension loads, the service worker registers,
// and the UI pages render without errors.

import { test, expect } from './fixture.js';

test.describe('Extension loads', () => {
  test('service worker registers and responds to ping', async ({ context, extensionId }) => {
    // Open a blank page and send a ping via the extension's SW.
    const page = await context.newPage();
    await page.goto('about:blank');

    const response = await page.evaluate(async (extId) => {
      return new Promise((resolve) => {
        // @ts-expect-error — chrome is available in Chromium pages
        chrome.runtime.sendMessage(extId, { type: 'TT_PING' }, resolve);
      });
    }, extensionId);

    expect(response).toMatchObject({ type: 'TT_PONG' });
    await page.close();
  });

  test('popup renders without JS errors', async ({ popupPage }) => {
    const errors: string[] = [];
    popupPage.on('pageerror', (err) => errors.push(err.message));

    // The side panel should render idle state copy when no recording is active.
    await expect(popupPage.locator('text=Not recording')).toBeVisible({ timeout: 5000 });
    expect(errors).toHaveLength(0);
  });

  test('dashboard View Pricing CTA opens pricing modal and supports browser navigation', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(`chrome-extension://${extensionId}/ui/dashboard/dashboard.html`);
    await expect(page.getByRole('button', { name: 'View Pricing' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: 'View Pricing' }).click();
    await expect(page.getByRole('dialog', { name: 'BusinessFlow pricing' })).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/view=pricing/);

    await page.goBack();
    await expect(page.getByRole('dialog', { name: 'BusinessFlow pricing' })).toBeHidden({ timeout: 5000 });

    await page.goForward();
    await expect(page.getByRole('dialog', { name: 'BusinessFlow pricing' })).toBeVisible({ timeout: 5000 });

    await page.reload();
    await expect(page.getByRole('dialog', { name: 'BusinessFlow pricing' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog', { name: 'BusinessFlow pricing' })).toBeHidden({ timeout: 5000 });

    expect(errors).toHaveLength(0);
    await page.close();
  });

  test('report page renders empty state', async ({ reportPage }) => {
    const errors: string[] = [];
    reportPage.on('pageerror', (err) => errors.push(err.message));

    await expect(reportPage.locator('text=No sessions recorded yet')).toBeVisible({ timeout: 5000 });
    expect(errors).toHaveLength(0);
  });
});

test.describe('Fixture server', () => {
  test('home page loads', async ({ context }) => {
    const page = await context.newPage();
    await page.goto('http://localhost:3737/');
    await expect(page.locator('h1')).toContainText('TestTrace — Fixture');
    await page.close();
  });

  test('navigation between fixture pages works', async ({ context }) => {
    const page = await context.newPage();
    await page.goto('http://localhost:3737/');
    await page.click('#link-page-a');
    await expect(page.locator('h1')).toContainText('Page A');
    await page.click('a[href="/"]');
    await expect(page.locator('h1')).toContainText('TestTrace — Fixture');
    await page.close();
  });
});
