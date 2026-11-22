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

test('pages authored in Dutch still load the catalogs for their English view', async ({ page }) => {
  const seen = catalogRequests(page);
  await page.route('**/healthz', (route) => route.abort('connectionrefused'));
  await page.goto('/physio');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText('Help getting started', { exact: true })).toBeVisible();
  expect(seen).toEqual(['catalog', 'supplement', 'dynamic', 'dynamic-learning', 'dynamic-tools']);
});

test('a later English preference wins while the first Dutch switch is downloading', async ({ page }) => {
  let releaseCatalog;
  const delayed = new Promise(resolve => { releaseCatalog = resolve; });
  await page.route('**/i18n-catalog.js*', async route => { await delayed; await route.continue(); });
  await page.goto('/');
  await page.evaluate(() => {
    window.languageEvents = [];
    window.addEventListener('lp:language-changed', event => window.languageEvents.push(event.detail.language));
  });
  const pending = page.waitForRequest('**/i18n-catalog.js*');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lp:preferences-changed', { detail: { language: 'nl' } })));
  await pending;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lp:preferences-changed', { detail: { language: 'en' } })));
  await page.evaluate(() => {
    window.catalogFinished = new Promise(resolve => {
      document.addEventListener('load', event => {
        if (event.target.src?.includes('/i18n-dynamic-tools.js')) requestAnimationFrame(resolve);
      }, true);
    });
  });
  releaseCatalog();
  await page.evaluate(() => window.catalogFinished);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('h1')).toContainText('Less');
  expect(await page.evaluate(() => window.languageEvents)).not.toContain('nl');
});

test('a failed supplemental catalog can be retried after the base file loads', async ({ page }) => {
  const seen = catalogRequests(page);
  await page.route('**/i18n-supplement.js*', route => route.abort('failed'), { times: 1 });
  await page.goto('/');
  const failed = page.waitForEvent('requestfailed', request => request.url().includes('/i18n-supplement.js'));
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await failed;
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await expect(page.locator('h1')).toContainText('Minder');
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  expect(seen.filter(name => name === 'supplement')).toHaveLength(2);
  expect(await page.evaluate(() => window.LectureI18n.t('Could not save your settings. Please try again.')))
    .toBe('Je instellingen konden niet worden opgeslagen. Probeer het opnieuw.');
});

test('a saved Dutch preference recovers a missing catalog during page startup', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lp-preferences', JSON.stringify({ language: 'nl' })));
  const seen = catalogRequests(page);
  await page.route('**/i18n-supplement.js*', route => route.abort('failed'), { times: 1 });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.LectureI18n.t('Operations overview'))).toBe('Operationeel overzicht');
  await expect(page.locator('h1')).toContainText('Minder');
  expect(seen.filter(name => name === 'supplement')).toHaveLength(2);
});
