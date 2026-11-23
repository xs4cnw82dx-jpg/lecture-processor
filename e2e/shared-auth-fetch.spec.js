const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

// Pages send signed-in requests through the shared auth client (auth-utils.js).

test('Buy Credits retries purchase history once with a refreshed token after a 401', async ({ page }) => {
  const fixture = await installAccountFixture(page);
  await page.addInitScript(() => {
    const user = window.testAccount.currentUser;
    user.getIdToken = force => Promise.resolve(force ? 'token-fresh' : 'token-stale');
  });
  const seen = [];
  await page.route('**/api/purchase-history', route => {
    const authorization = route.request().headers().authorization;
    seen.push(authorization);
    if (authorization !== 'Bearer token-fresh') return route.fulfill({ status: 401, json: { error: 'expired' } });
    return route.fulfill({ json: { purchases: [{ bundle_name: 'Regular study', credits: 80, price_cents: 1699, currency: 'eur', created_at: 1795400000 }] } });
  });
  await page.goto('/buy_credits');
  await expect(page.locator('#purchase-history-list .purchase-row')).toHaveCount(1);
  await expect(page.locator('#purchase-history-list')).toContainText('Regular study');
  expect(seen.slice(0, 2)).toEqual(['Bearer token-stale', 'Bearer token-fresh']);
  expect(fixture.browserErrors).toEqual([]);
});

test('Buy Credits still loads its bundles when auth-utils.js fails to load', async ({ page }) => {
  const fixture = await installAccountFixture(page);
  await page.route('**/static/js/auth-utils.js*', route => route.abort('failed'));
  await page.goto('/buy_credits');
  await expect(page.locator('button', { hasText: 'Regular study' })).toBeVisible();
  await expect(page.locator('button', { hasText: 'Regular study' })).toBeEnabled();
  expect(fixture.browserErrors).toEqual([]);
});
