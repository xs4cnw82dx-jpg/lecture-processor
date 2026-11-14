const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');

async function installStudent(page, preferences = {}) {
  const fixture = await installAccountFixture(page);
  // Use the asset chosen by the page, including the production bundle in build checks.
  await page.route(/\/static\/js\/buy-credits(?:\.min)?\.js(?:\?.*)?$/, route => route.continue());
  await page.route('**/api/verify-email', route => route.fulfill({ json: { allowed: true } }));
  await page.route('**/api/auth/user', route => route.fulfill({ json: {
    preferences: { onboarding_completed: true, output_language: 'english', ...preferences },
    credits: { lecture_standard: 1, lecture_extended: 0, slides: 2, interview_short: 0, interview_medium: 0, interview_long: 0 },
  } }));
  return fixture;
}

async function recordScrolls(page) {
  await page.addInitScript(() => {
    window.testScrolls = [];
    window.scrollTo = options => window.testScrolls.push({ target: 'window', ...options });
    Element.prototype.scrollIntoView = function (options) {
      window.testScrolls.push({ target: this.id || this.className, ...options });
    };
  });
}

test('onboarding languages expose the selected button before and after keyboard selection', async ({ page }) => {
  const fixture = await installStudent(page, { onboarding_completed: false, output_language: 'dutch' });
  await page.goto('/lecture-notes');
  const grid = page.locator('#language-onboarding-grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(grid.locator('[data-value="dutch"]')).toHaveAttribute('aria-pressed', 'true');
  const other = grid.locator('[data-value="other"]');
  await other.focus();
  await page.keyboard.press('Enter');
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await expect(grid.locator('[data-value="dutch"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(grid.locator('[aria-pressed="false"]')).toHaveCount(6);
  await expect(page.locator('#language-onboarding-custom')).toBeVisible();
  expect(fixture.browserErrors).toEqual([]);
});

for (const reduced of [true, false]) {
  const behavior = reduced ? 'auto' : 'smooth';
  test(`recommended lecture setup uses ${behavior} scrolling`, async ({ page }) => {
    const fixture = await installStudent(page);
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await recordScrolls(page);
    await page.goto('/lecture-notes');
    await page.locator('#quickstart-apply-btn').click();
    await expect.poll(() => page.evaluate(() => window.testScrolls.at(-1)?.behavior)).toBe(behavior);
    expect(fixture.browserErrors).toEqual([]);
  });

  test(`Workout navigation uses ${behavior} scrolling`, async ({ page }) => {
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await recordScrolls(page);
    // Navigation works independently of the asynchronously loaded account data.
    await page.addInitScript(() => {
      window.LectureProcessorBootstrap = { getAuth: () => ({}), onAuthStateReady() {} };
      window.LectureProcessorAuth = { createAuthClient: () => ({}) };
    });
    const html = readFileSync(path.resolve('templates/workout.html'), 'utf8')
      .split('\n').filter(line => !line.includes('firebasejs') && !line.includes('js/firebase-bootstrap.js') && !line.includes('js/auth-utils.js')).join('\n')
      .replace(/\{\{\s*url_for\('static', filename=(?:workout(?:_utils)?_js_asset or )?'([^']+)'\)\s*\}\}/g, '/static/$1');
    await page.route('**/admin/workout', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('/admin/workout');
    const routines = page.locator('.workout-bottom-nav [data-workout-nav="routines"]');
    await routines.click();
    await expect(routines).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => window.testScrolls.at(-1)?.behavior)).toBe(behavior);
    expect(browserErrors).toEqual([]);
  });

  test(`Physio search matches use ${behavior} scrolling`, async ({ page }) => {
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await recordScrolls(page);
    const url = new URL(process.env.PHYSIO_COMPANION_URL);
    url.searchParams.set('lp_language', 'nl');
    url.hash = `owner_token=${encodeURIComponent(process.env.PHYSIO_COMPANION_OWNER_TOKEN)}`;
    await page.goto(url.href);
    const search = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/physio/search') && new URL(response.url()).searchParams.get('q') === 'scapula');
    await page.locator('#clinical-search-input').fill('scapula');
    await search;
    await page.locator('#search-results [data-note-id="structure-scapula"]').first().click();
    await page.locator('[data-match-next]').click();
    await expect.poll(() => page.evaluate(() => window.testScrolls.at(-1)?.behavior)).toBe(behavior);
    expect(browserErrors).toEqual([]);
  });
}

for (const language of ['en', 'nl']) {
  test(`bundles and purchase history follow the ${language} locale and later language changes`, async ({ page }) => {
    const fixture = await installStudent(page);
    await page.route('**/api/user-preferences', route => route.fulfill({ json: { preferences: { interface_language: language, theme: 'light' } } }));
    let purchaseRequests = 0;
    await page.route('**/api/purchase-history', route => {
      purchaseRequests += 1;
      return route.fulfill({ json: { purchases: [
        { bundle_name: 'Example bundle', price_cents: 1234, currency: 'EUR', created_at: 1710000000 },
      ] } });
    });
    await page.goto('/buy_credits');
    await expect.poll(() => page.evaluate(() => window.LecturePreferences.get().ready)).toBe(true);
    await expect(page.locator('.purchase-row')).toHaveCount(1);
    for (const nextLanguage of [language, language === 'nl' ? 'en' : 'nl']) {
      await page.evaluate(value => window.LectureI18n.setLanguage(value), nextLanguage);
      const expected = await page.evaluate(() => {
        const price = document.querySelector('.price[data-price-cents]');
        const format = new Intl.NumberFormat(window.LectureI18n.locale(), { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return { bundle: format.format(Number(price.dataset.priceCents) / 100), history: format.format(12.34) };
      });
      await expect(page.locator('.price[data-price-cents]').first()).toHaveText(expected.bundle);
      await expect(page.locator('.purchase-row .meta')).toContainText(expected.history);
    }
    expect(purchaseRequests).toBe(1);
    await page.evaluate(() => window.testAccount.switchTo(null));
    await expect(page.locator('.purchase-row')).toHaveCount(0);
    await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
    await expect(page.locator('.purchase-row')).toHaveCount(0);
    expect(purchaseRequests).toBe(1);
    expect(fixture.browserErrors).toEqual([]);
  });
}
