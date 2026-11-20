const { test, expect } = require('@playwright/test');

const CATALOG = /\/static\/js\/i18n-(catalog|supplement|dynamic|dynamic-learning|dynamic-tools)\.js/;

function catalogRequests(page) {
  const seen = [];
  page.on('request', (request) => {
    const match = CATALOG.exec(new URL(request.url()).pathname);
    if (match) seen.push(match[1]);
  });
  return seen;
}

test('English pages skip the Dutch catalogs and load them in order on the first switch', async ({ page }) => {
  const seen = catalogRequests(page);
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Less');
  expect(seen).toEqual([]);
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await expect(page.locator('h1')).toContainText('Minder');
  expect(seen).toEqual(['catalog', 'supplement', 'dynamic', 'dynamic-learning', 'dynamic-tools']);
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(page.locator('h1')).toContainText('Less');
});

test('a saved Dutch preference loads the catalogs before the page is translated', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('lp-preferences', JSON.stringify({ language: 'nl' })));
  const seen = catalogRequests(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await expect(page.locator('h1')).toContainText('Minder');
  expect(seen).toEqual(['catalog', 'supplement', 'dynamic', 'dynamic-learning', 'dynamic-tools']);
  // Content rendered after load is still translated by the live observer.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'late-button';
    button.textContent = 'Save';
    document.body.appendChild(button);
  });
  await expect(page.locator('#late-button')).toHaveText('Opslaan');
});

test('a failed catalog download keeps the page usable in English', async ({ page }) => {
  await page.route(CATALOG, (route) => route.abort('failed'));
  await page.goto('/');
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await page.waitForTimeout(300);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('h1')).toContainText('Less');
});
