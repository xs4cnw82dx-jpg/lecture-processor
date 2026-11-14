const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.describe.configure({ mode: 'parallel' });
test.use({ serviceWorkers: 'block' });

async function fixture(page, { language = 'en', theme = 'light', config } = {}) {
  const state = await installAccountFixture(page);
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('lp-preferences', JSON.stringify({ language, theme }));
  }, { language, theme });
  await page.route(/\/static\/js\/buy-credits(?:\.min)?\.js(?:\?.*)?$/, route => route.continue());
  await page.route('**/api/config', route => config === false ? route.abort('failed')
    : config ? route.fulfill({ json: config }) : route.continue());
  await page.route('**/api/auth/user', route => route.fulfill({ json: {
    uid: 'a', email: 'a@example.test', credits_version: 2, credits: 19,
    unlimited_credits: {}, preferences: { interface_language: language, theme, onboarding_completed: true },
  } }));
  await page.route('**/api/user-preferences', route => route.fulfill({ json: {
    preferences: { interface_language: language, theme },
  } }));
  return state;
}

async function expectCatalog(page, language) {
  const bundles = page.locator('#credit-bundles .bundle-buy-btn');
  await expect(bundles).toHaveCount(3);
  await expect.poll(() => bundles.evaluateAll(nodes => nodes.map(node => Number(node.dataset.credits)))).toEqual([40, 80, 200]);
  await expect(page.locator('[data-bundle-id="credits_80"] .badge')).toHaveText(language === 'nl' ? 'Regelmatig studeren' : 'Regular study');
  await expect(page.locator('[data-bundle-id="credits_200"] .badge')).toHaveText(language === 'nl' ? 'Semester · Voordeligste keuze' : 'Semester · Best value');
  await expect(page.locator('#credit-bundles .featured')).toHaveCount(1);
  await expect(page.locator('#credit-bundles .featured')).toHaveAttribute('data-bundle-id', 'credits_200');
  expect(await bundles.evaluateAll(nodes => nodes.map(node => Number(node.dataset.priceCents)))).toEqual([999, 1699, 3499]);
}

for (const width of [1440, 375]) {
  for (const theme of ['light', 'dark']) {
    test(`real public catalog keeps ascending bundle order and accurate value labels at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const state = await fixture(page, { theme });
      const config = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config');
      await page.goto('/buy_credits');
      const payload = await (await config).json();
      expect(payload.credit_scheme).toBe(2);
      // Exercise the real JSON serializer's key order, not a hand-ordered fixture.
      expect(Object.keys(payload.bundles)).toEqual(['credits_200', 'credits_40', 'credits_80']);
      await expectCatalog(page, 'en');
      const english = await page.screenshot({ path: testInfo.outputPath(`bundles-${width}-${theme}-en.png`), fullPage: true });
      await testInfo.attach('English bundles', { body: english, contentType: 'image/png' });
      await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
      await expectCatalog(page, 'nl');
      await expect(page.locator('[data-bundle-id="credits_200"] .price')).toHaveText('€\u00a034,99');
      const dutch = await page.screenshot({ path: testInfo.outputPath(`bundles-${width}-${theme}-nl.png`), fullPage: true });
      await testInfo.attach('Dutch bundles', { body: dutch, contentType: 'image/png' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(state.browserErrors).toEqual([]);
      expect(state.requests.some(request => request.path === '/api/create-checkout-session')).toBe(false);
    });
  }
}

test('bundle order follows numeric credits when names and identifiers differ', async ({ page }) => {
  await fixture(page, { config: { credit_scheme: 2, bundles: {
    alpha: { credits: 900, price_cents: 10000, currency: 'eur', badge: 'best_value' },
    zeta: { credits: 20, price_cents: 500, currency: 'eur' },
    middle: { credits: 45, price_cents: 900, currency: 'eur' },
  } } });
  await page.goto('/buy_credits');
  const buttons = page.locator('#credit-bundles .bundle-buy-btn');
  await expect.poll(() => buttons.evaluateAll(nodes => nodes.map(node => node.dataset.bundleId))).toEqual(['zeta', 'middle', 'alpha']);
  await expect(page.locator('#credit-bundles .featured')).toHaveAttribute('data-bundle-id', 'alpha');
  await expect(page.locator('[data-bundle-id="alpha"] .badge')).toHaveText('Best value');
});

for (const language of ['en', 'nl']) {
  test(`server-rendered ${language} bundle labels remain accurate if the catalog refresh fails`, async ({ page }) => {
    const state = await fixture(page, { config: false, language });
    await page.goto('/buy_credits');
    await expectCatalog(page, language);
    expect(state.browserErrors).toEqual([]);
  });
}
