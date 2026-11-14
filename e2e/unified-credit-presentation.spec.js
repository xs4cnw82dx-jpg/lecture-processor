const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { installAccountFixture } = require('./helpers/batch-fixture');

const unifiedUser = { uid: 'student', email: 'student@example.test', credits_version: 2, credits: 19, unlimited: { lecture: true, slides: false, interview: false }, effective_unlimited: { lecture: true, slides: false, interview: false } };
const costs = {
  lecture_notes: { category: 'lecture', instant: 8, overnight: 4 },
  slides_extraction: { category: 'slides', instant: 2, overnight: 1 },
  interview_transcription: { category: 'interview', instant: 10, overnight: 5 },
  interview_extra: { category: 'slides', instant: 2, overnight: 1 },
  text_combine: { category: 'lecture', instant: 8, overnight: 4 },
  audio_transcription: { category: 'interview', instant: 10, overnight: 5 },
  tools_extraction: { category: 'slides', instant: 2, overnight: null },
  tools_transcription: { category: 'interview', instant: 10, overnight: null },
  voice_note: { category: 'interview', instant: 10, overnight: null },
  regenerate_study_tools: { category: 'slides', instant: 2, overnight: null },
  interview_coding: { category: 'slides', instant: 2, overnight: null },
};
const bundles = {
  credits_40: { name: '40 credits', credits: 40, price_cents: 999, currency: 'eur' },
  credits_80: { name: '80 credits', credits: 80, price_cents: 1699, currency: 'eur', badge: 'best_value' },
  credits_200: { name: '200 credits', credits: 200, price_cents: 3499, currency: 'eur', badge: 'semester' },
};

async function buyFixture(page, options = {}) {
  const setup = await installAccountFixture(page);
  // The shared legacy fixture overrides this bundle. Final runs exercise the
  // generated production file, while an explicit baseline path preserves red evidence.
  await page.route(/\/static\/js\/buy-credits(?:\.min)?\.js(?:\?.*)?$/, route => process.env.PRESENTATION_BASELINE
    ? route.fulfill({ contentType: 'application/javascript', path: process.env.PRESENTATION_BASELINE })
    : route.continue());
  const state = { checkouts: [], heldCheckout: null, profileReads: 0, heldProfile: null };
  await page.route('**/api/config', route => route.fulfill({ json: options.config || { credit_scheme: 2, action_costs: costs, bundles, free_signup_credits: 12 } }));
  await page.route('**/api/auth/user', route => {
    state.profileReads += 1;
    if (options.holdRefresh && state.profileReads > 1) { state.heldProfile = route; return; }
    const uid = route.request().headers().authorization.replace('Bearer token-', '');
    return route.fulfill({ json: { uid, email: `${uid}@example.test`, credits_version: 2, credits: 19, credit_costs: costs, unlimited_credits: {}, preferences: { interface_language: 'en', onboarding_completed: true } } });
  });
  await page.route('**/api/purchase-history', route => route.fulfill({ json: { purchases: options.history || [] } }));
  await page.route('**/api/create-checkout-session', route => {
    state.checkouts.push(route.request().postDataJSON());
    if (options.holdCheckout) { state.heldCheckout = route; return; }
    return route.fulfill({ json: { checkout_url: '/synthetic-checkout' } });
  });
  await page.route('**/api/confirm-checkout-session?*', route => route.fulfill({ json: { status: 'granted' } }));
  await page.route('**/synthetic-checkout', route => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic checkout</h1>' }));
  return { ...setup, state };
}

test('buy page uses three configured bundles and all action prices', async ({ page }) => {
  const setup = await buyFixture(page);
  await page.goto('/buy_credits');
  await expect(page.locator('.bundle-buy-btn')).toHaveCount(3);
  await expect(page.locator('[data-bundle-id="credits_80"] .badge')).toHaveText('Best value');
  for (const [action, price] of Object.entries(costs)) {
    const row = page.locator(`[data-credit-action="${action}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-credit-rate="instant"]')).toHaveText(String(price.instant));
    await expect(row.locator('[data-credit-rate="overnight"]')).toHaveText(price.overnight === null ? '—' : String(price.overnight));
  }
  await page.locator('[data-bundle-id="credits_80"]').click();
  await expect(page.getByRole('heading', { name: 'Synthetic checkout' })).toBeVisible();
  expect(setup.state.checkouts).toEqual([{ bundle_id: 'credits_80' }]);
  expect(setup.browserErrors).toEqual([]);
});

test('changed configuration reaches the displayed amounts and checkout without hardcoded prices', async ({ page }) => {
  const setup = await buyFixture(page, { config: { credit_scheme: 2, bundles: { synthetic: { name: '53 credits', credits: 53, price_cents: 1234, currency: 'usd' } }, action_costs: { lecture_notes: { category: 'lecture', instant: 14, overnight: 7 } } } });
  await page.goto('/buy_credits');
  await expect(page.locator('.bundle-buy-btn')).toHaveCount(1);
  const button = page.locator('[data-bundle-id="synthetic"]');
  await expect(button.locator('.credits')).toHaveText('53 credits');
  await expect(button.locator('.price')).toHaveText(await page.evaluate(() => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD' }).format(12.34)));
  await expect(page.locator('[data-credit-action="lecture_notes"] [data-credit-rate="instant"]')).toHaveText('14');
  await expect(page.locator('[data-credit-action="lecture_notes"] [data-credit-rate="overnight"]')).toHaveText('7');
  await button.click();
  await expect.poll(() => setup.state.checkouts).toEqual([{ bundle_id: 'synthetic' }]);
});

test('purchase history keeps recorded scalar and historical quantities through locale changes', async ({ page }) => {
  await buyFixture(page, { history: [
    { bundle_name: 'Current receipt', credits: 40, price_cents: 999, currency: 'eur', created_at: 1700000000 },
    { bundle_name: 'Historical receipt', credits: { slides_credits: 10 }, price_cents: 499, currency: 'eur', created_at: 1600000000 },
    { bundle_name: 'Converted receipt', credit_scheme: 2, credits: 40, legacy_credits: { lecture_credits_standard: 5 }, price_cents: 999, currency: 'eur', created_at: 1500000000 },
  ] });
  await page.goto('/buy_credits');
  await expect(page.locator('#purchase-history-list')).toContainText('40 credits');
  await expect(page.locator('#purchase-history-list')).toContainText('Text Extraction: 10');
  await expect(page.locator('#purchase-history-list')).toContainText('Lecture Notes (standard): 5');
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await expect(page.locator('[data-bundle-id="credits_40"] .price')).toHaveText('€\u00a09,99');
  await expect(page.locator('#purchase-history-list .meta').first()).toContainText('€\u00a09,99');
  await expect(page.locator('#purchase-history-list')).toContainText('Current receipt');
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(page.locator('[data-bundle-id="credits_40"] .price')).toHaveText('€9.99');
});

test('a held checkout cannot navigate the next signed-in account', async ({ page }) => {
  const setup = await buyFixture(page, { holdCheckout: true });
  await page.goto('/buy_credits');
  await page.locator('[data-bundle-id="credits_40"]').click();
  await expect.poll(() => Boolean(setup.state.heldCheckout)).toBe(true);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await setup.state.heldCheckout.fulfill({ json: { checkout_url: '/synthetic-checkout' } });
  await expect(page.locator('[data-bundle-id="credits_40"]')).toBeEnabled();
  await expect(page).toHaveURL(/\/buy_credits$/);
  expect(setup.state.checkouts).toHaveLength(1);
  expect(setup.browserErrors).toEqual([]);
});

test('a legacy public config cannot downgrade a stored version-two account balance', async ({ page }) => {
  await buyFixture(page, { config: { bundles: {} } });
  await page.goto('/buy_credits');
  await expect(page.locator('#shell-credits-total')).toHaveText('19 credits');
});

test('checkout confirmation waits for a fresh account balance before claiming credits updated', async ({ page }) => {
  const setup = await buyFixture(page, { holdRefresh: true });
  await page.goto('/buy_credits?payment=success&session_id=synthetic-session');
  await expect.poll(() => Boolean(setup.state.heldProfile)).toBe(true);
  await expect(page.locator('#payment-result')).toBeHidden();
  await setup.state.heldProfile.fulfill({ json: { uid: 'a', credits_version: 2, credits: 59, credit_costs: costs, unlimited_credits: {}, preferences: {} } });
  await expect(page.locator('#payment-result-message')).toHaveText('Payment successful. Credits updated.');
  await expect(page.locator('#shell-credits-total')).toHaveText('59 credits');
  expect(setup.state.checkouts).toEqual([]);
  expect(setup.browserErrors).toEqual([]);
});

async function adminFixture(page, options = {}) {
  const setup = await installAccountFixture(page);
  const state = { grants: [], heldGrant: null, user: { ...unifiedUser, ...options.user } };
  await page.route('**/api/admin/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/users/search')) return route.fulfill({ json: { user: state.user, recent_grants: options.history || [] } });
    if (pathname.endsWith('/credits/grant')) {
      state.grants.push(request.postDataJSON());
      if (options.holdGrant) { state.heldGrant = route; return; }
      if (options.failFirst && state.grants.length === 1) return route.fulfill({ status: 503, json: { error: 'Please retry this grant.' } });
      return route.fulfill({ json: { user: { ...state.user, credits: 24 } } });
    }
    if (pathname.endsWith('/model-pricing')) return route.fulfill({ json: JSON.parse(fs.readFileSync('config/model_pricing.json', 'utf8')) });
    return route.fulfill({ json: pathname.endsWith('/overview') ? { metrics: { total_processed: 7, total_revenue_cents: 1234 }, recent_jobs: [{ credit_scheme: 2, charged_credits: 10, refunded_credits: 2, credit_refunded: true }] } : { grants: options.history || [] } });
  });
  const html = fs.readFileSync('templates/admin.html', 'utf8')
    .replace("{% include '_preferences_head.html' %}", fs.readFileSync('templates/_preferences_head.html', 'utf8'))
    .replace(/\{#[\s\S]*?#\}/g, '')
    .replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g, (_match, filename) => `/static/${filename}`)
    .replace("{{ url_for('static', filename=admin_js_asset or 'js/admin.js') }}", `/static/js/admin${process.env.USE_MINIFIED_JS_ASSETS === '1' ? '.min' : ''}.js`);
  await page.route('**/admin', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('/admin');
  await page.locator('#admin-tab-credits').click();
  await page.locator('#admin-credit-email').fill('student@example.test');
  await page.locator('#admin-credit-search-btn').click();
  await expect(page.locator('#admin-credit-user-email')).toHaveText('student@example.test');
  return { ...setup, state };
}

test('admin presents a scalar balance separately from category access', async ({ page }) => {
  const setup = await adminFixture(page);
  await expect(page.locator('#admin-credit-summary-total')).toHaveText('19 credits');
  await expect(page.locator('#admin-credit-unlimited-lecture')).toBeChecked();
  await expect(page.locator('#admin-credit-unlimited-slides')).not.toBeChecked();
  await expect(page.locator('#admin-credit-grant-amount')).toBeVisible();
  await expect(page.locator('#admin-credit-grant-lecture')).toBeHidden();
  expect(setup.browserErrors).toEqual([]);
});

test('a failed scalar grant retries the same reference and preserves historical units', async ({ page }) => {
  const setup = await adminFixture(page, { failFirst: true, history: [
    { action: 'grant_credits', credits: 8, credit_scheme: 2, created_at: 1700000000 },
    { action: 'grant_credits', credit_categories: { lecture: 2, slides: 3 }, created_at: 1600000000 },
  ] });
  await expect(page.locator('#admin-credit-grants-body')).toContainText('+8 credits');
  await expect(page.locator('#admin-credit-grants-body')).toContainText('Lecture Notes +2');
  await expect(page.locator('#admin-credit-grants-body')).toContainText('Text Extraction +3');
  await page.locator('#admin-credit-grant-amount').fill('5');
  await page.locator('#admin-credit-grant-note').fill('Synthetic adjustment');
  await page.locator('#admin-credit-grant-btn').click();
  await expect(page.locator('#admin-credit-state')).toContainText('Please retry this grant.');
  await page.locator('#admin-credit-grant-btn').click();
  await expect.poll(() => setup.state.grants.length).toBe(2);
  expect(setup.state.grants[0]).toMatchObject({ credits: 5, note: 'Synthetic adjustment' });
  expect(setup.state.grants[0].ref).toBeTruthy();
  expect(setup.state.grants[1].ref).toBe(setup.state.grants[0].ref);
  await expect(page.locator('#admin-credit-summary-total')).toHaveText('24 credits');
  expect(setup.browserErrors).toEqual([]);
});

test('unconverted accounts retain category grants and separate unlimited switches', async ({ page }) => {
  const setup = await adminFixture(page, { user: { credits_version: undefined, credits: { lecture: 2, slides: 3, interview: 4 } } });
  await expect(page.locator('#admin-credit-summary-lecture')).toHaveText('Unlimited');
  await expect(page.locator('#admin-credit-summary-slides')).toHaveText('3');
  await expect(page.locator('#admin-credit-unified-summary')).toBeHidden();
  await page.locator('#admin-credit-grant-slides').fill('2');
  await page.locator('#admin-credit-grant-btn').click();
  await expect.poll(() => setup.state.grants.length).toBe(1);
  expect(setup.state.grants[0].credits).toEqual({ lecture: 0, slides: 2, interview: 0 });
  expect(setup.state.grants[0].ref).toBeTruthy();
  expect(setup.browserErrors).toEqual([]);
});

test('an in-flight grant is submitted once and cannot restore another admin session', async ({ page }) => {
  const setup = await adminFixture(page, { holdGrant: true });
  await page.locator('#admin-credit-grant-amount').fill('5');
  await page.locator('#admin-credit-grant-btn').click();
  await expect.poll(() => Boolean(setup.state.heldGrant)).toBe(true);
  await page.locator('#admin-credit-grant-form').evaluate(form => form.requestSubmit());
  expect(setup.state.grants).toHaveLength(1);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await setup.state.heldGrant.fulfill({ json: { user: { ...unifiedUser, credits: 24 } } });
  await expect(page.locator('#admin-credit-user-card')).toBeHidden();
  expect(setup.state.grants).toHaveLength(1);
  expect(setup.browserErrors).toEqual([]);
});

test('admin distinguishes processing jobs, recorded credits and localized provider costs', async ({ page }) => {
  await adminFixture(page);
  await page.locator('#admin-tab-overview').click();
  await expect(page.locator('#m-processed').locator('..')).toContainText('Processing jobs');
  await expect(page.locator('#m-processed')).toHaveText('7');
  await expect(page.locator('#jobs-body')).toContainText('10 credits charged · 2 credits refunded');
  await expect(page.locator('#calc-total')).toHaveText('$1.0280');
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await expect(page.locator('#m-revenue')).toHaveText('€\u00a012,34');
  await expect(page.locator('#calc-total')).toHaveText('$\u00a01,0280');
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(page.locator('#calc-total')).toHaveText('$1.0280');
});

for (const surface of ['buy', 'admin']) {
  test(`${surface} credits fit desktop and mobile in both languages and themes`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    if (surface === 'buy') {
      await buyFixture(page, { history: [{ bundle_name: '40 credits', credits: 40, price_cents: 999, currency: 'eur', created_at: 1700000000 }] });
      await page.goto('/buy_credits');
      await expect(page.locator('.bundle-buy-btn')).toHaveCount(3);
      await expect(page.locator('#shell-credits-total')).toHaveText('19 credits');
    } else {
      await adminFixture(page, { user: { legacy_credits_snapshot: { lecture_credits_standard: 2, slides_credits: 3 } }, history: [{ action: 'grant_credits', credit_scheme: 2, credits: 8, email: 'student@example.test', note: 'Synthetic adjustment', created_at: 1700000000 }] });
      await expect(page.locator('#admin-credit-summary-total')).toHaveText('19 credits');
      await expect(page.locator('.admin-toast')).not.toHaveClass(/visible/);
    }
    for (const language of ['en', 'nl']) {
      await page.evaluate(value => window.LectureI18n.setLanguage(value), language);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => window.LPTheme.apply({ theme: value }), theme);
        for (const width of [1440, 375]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(async () => {
            await document.fonts.ready;
            document.activeElement.blur();
            window.getSelection().removeAllRanges();
            window.scrollTo(0, 0);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
          });
          await expect(page.locator('html')).toHaveAttribute('lang', language);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
            const layout = await page.evaluate(() => Array.from(document.querySelectorAll('body *')).map(el => ({ name: el.id || el.className || el.tagName, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width, display: getComputedStyle(el).display, min: getComputedStyle(el).minWidth })).filter(el => el.width && el.right > innerWidth + 1));
            fs.writeFileSync(testInfo.outputPath(`overflow-${language}-${theme}-${width}.json`), JSON.stringify(layout, null, 2));
          }
          expect(await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ viewport: width, document: width });
          if (surface === 'buy') {
            await expect(page.locator('#credit-cost-title')).toHaveText(language === 'nl' ? 'Wat elke actie kost' : 'What each action costs');
            await expect(page.locator('[data-bundle-id="credits_40"] .price')).toHaveText(language === 'nl' ? '€\u00a09,99' : '€9.99');
            if (width === 375) {
              await expect(page.locator('.credit-rate-mobile').last()).toHaveText(language === 'nl' ? 'Nachtelijk' : 'Overnight');
              for (const header of await page.locator('.credit-rate-mobile').all()) expect(await header.evaluate(node => node.getClientRects().length)).toBe(1);
            }
          } else {
            await expect(page.locator('#admin-credit-summary-total')).toHaveText('19 credits');
            await expect(page.locator('#admin-credit-grant-amount')).toBeVisible();
          }
          await page.screenshot({ path: testInfo.outputPath(`${surface}-${language}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
        }
      }
    }
  });
}
