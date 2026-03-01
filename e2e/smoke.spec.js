const { test, expect } = require('@playwright/test');

test('landing and config endpoints are healthy', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText(/Lecture Processor|Transform Lectures/i);

  const configResponse = await request.get('/api/config');
  expect(configResponse.ok()).toBeTruthy();
  const config = await configResponse.json();
  expect(config).toHaveProperty('bundles');
});

test('privacy and terms pages load', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.locator('body')).toContainText(/Privacy Policy|Privacy/i);

  await page.goto('/terms');
  await expect(page.locator('body')).toContainText(/Terms|Conditions/i);
});

test('dashboard shell loads for unauthenticated user', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('body')).toContainText(/Sign in|Lecture Processor|Welcome/i);
});
