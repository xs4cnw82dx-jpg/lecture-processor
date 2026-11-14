const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function profile(total, uid = 'a') {
  return {
    email: uid + '@example.test',
    credits: { lecture_standard: total - 3, lecture_extended: 0, slides: 2, interview_short: 1, interview_medium: 0, interview_long: 0 },
    preferences: { favorite_tools: ['lecture-notes'], onboarding_completed: true },
  };
}

async function installCredits(page, options = {}) {
  const fixture = await installAccountFixture(page);
  const confirmation = deferred();
  const state = { confirmed: false, refreshReply: null, profileReads: 0 };
  await page.route('**/api/verify-email', route => route.fulfill({ json: { allowed: true } }));
  await page.route(/\/static\/js\/(app-shell|buy-credits)(\.min)?\.js(?:\?.*)?$/, (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop().replace('.min.js', '.js');
    const currentSource = name === 'buy-credits.js' && process.env.CREDIT_STATUS_BUY_CREDITS_SOURCE
      ? process.env.CREDIT_STATUS_BUY_CREDITS_SOURCE
      : path.resolve('static/js', name);
    const source = process.env.CREDIT_STATUS_BASELINE
      ? '/tmp/lp-b1b-' + name.replace('.js', '-before.js')
      : currentSource;
    return route.fulfill({ contentType: 'application/javascript', path: source });
  });
  await page.route('**/api/auth/user', async (route) => {
    state.profileReads += 1;
    const uid = route.request().headers().authorization === 'Bearer token-b' ? 'b' : 'a';
    if (state.confirmed && state.refreshReply && uid === 'a') return route.fulfill(state.refreshReply);
    return route.fulfill({ json: profile(uid === 'b' ? 27 : state.confirmed ? 12 : 5, uid) });
  });
  await page.route('**/api/confirm-checkout-session?*', async (route) => {
    await confirmation.promise;
    state.confirmed = true;
    return route.fulfill({ json: { status: options.confirmationStatus || 'granted' } });
  });
  return { ...fixture, state, confirm: () => confirmation.resolve() };
}

test('confirmed purchase updates the displayed balance and account cache before claiming credits updated', async ({ page }) => {
  const fixture = await installCredits(page);
  await page.goto('/buy_credits?payment=success&session_id=synthetic-credit-session');
  await expect(page.locator('#shell-credits-total')).toHaveText('5 credits');
  fixture.confirm();
  await expect(page.locator('#payment-result-message')).toHaveText('Payment successful. Credits updated.');
  await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
  await expect(page.locator('#shell-credit-lecture')).toHaveText('9');
  await expect(page.locator('#shell-credit-text')).toHaveText('2');
  await expect(page.locator('#shell-credit-interview')).toHaveText('1');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lp_ui_v2:user:a:credits_breakdown')).total)).toBe(12);
  fixture.state.refreshReply = { status: 503, json: { error: 'Synthetic profile outage' } };
  await page.reload();
  await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp_ui_v2:user:a:shell_profile')).credits.total)).toBe(12);
  expect(fixture.browserErrors).toEqual([]);
});

test('an already-confirmed payment refreshes the displayed credits', async ({ page }) => {
  const fixture = await installCredits(page, { confirmationStatus: 'already_processed' });
  await page.goto('/buy_credits?payment=success&session_id=synthetic-credit-session');
  await expect(page.locator('#shell-credits-total')).toHaveText('5 credits');
  fixture.confirm();
  await expect(page.locator('#payment-result-message')).toHaveText('Payment already confirmed. Credits are available.');
  await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
  expect(fixture.browserErrors).toEqual([]);
});

const failedRefreshes = [
  ['unavailable profile', { status: 503, json: { error: 'Synthetic profile outage' } }],
  ['invalid JSON', { contentType: 'application/json', body: '{' }],
  ['missing credits', { json: {} }],
  ['incomplete credits', { json: { credits: { slides: 12 } } }],
  ['invalid credit counter', { json: { ...profile(12), credits: { ...profile(12).credits, slides: 'invalid' } } }],
];
for (const [label, reply] of failedRefreshes) {
  test(`confirmed purchase keeps its previous balance and does not claim refresh success for ${label}`, async ({ page }) => {
    const fixture = await installCredits(page);
    await page.goto('/buy_credits?payment=success&session_id=synthetic-credit-session');
    await expect(page.locator('#shell-credits-total')).toHaveText('5 credits');
    fixture.state.refreshReply = reply;
    fixture.confirm();
    await expect(page.locator('#payment-result-message')).toHaveText('Payment successful. Credits may take a few seconds to appear.');
    await expect(page.locator('#shell-credits-total')).toHaveText('5 credits');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp_ui_v2:user:a:credits_breakdown')).total)).toBe(5);
    expect(fixture.browserErrors).toEqual([]);
  });
}

for (const unlimited of [false, true]) {
  test(`shared refresh accepts a valid ${unlimited ? 'unlimited' : 'zero'} balance`, async ({ page }) => {
    const fixture = await installCredits(page);
    await page.goto('/buy_credits');
    await expect(page.locator('#shell-credits-total')).toHaveText('5 credits');
    const payload = profile(5);
    for (const key of Object.keys(payload.credits)) payload.credits[key] = 0;
    payload.unlimited_credits = { lecture: unlimited, slides: false, interview: false };
    fixture.state.confirmed = true;
    fixture.state.refreshReply = { json: payload };
    expect(await page.evaluate(() => window.LectureProcessorShell.refreshCredits())).toBe(true);
    await expect(page.locator('#shell-credits-total')).toHaveText(unlimited ? 'Unlimited credits' : '0 credits');
    await expect(page.locator('#shell-credit-lecture')).toHaveText(unlimited ? 'Unlimited' : '0');
    expect(fixture.browserErrors).toEqual([]);
  });
}

test('a delayed older refresh cannot overwrite the confirmed purchase or its cache', async ({ page }) => {
  const fixture = await installCredits(page);
  await page.goto('/buy_credits?payment=success&session_id=synthetic-credit-session');
  await expect(page.locator('#shell-credits-total')).toHaveText('5 credits');
  const oldStarted = deferred();
  const oldResponse = deferred();
  let calls = 0;
  await page.route('**/api/auth/user', async (route) => {
    if (++calls === 1) {
      oldStarted.resolve();
      await oldResponse.promise;
      return route.fulfill({ json: profile(5) });
    }
    return route.fulfill({ json: profile(12) });
  });
  await page.evaluate(() => { window.testOldRefresh = window.LectureProcessorShell.refreshCredits(); });
  await oldStarted.promise;
  fixture.confirm();
  await expect(page.locator('#payment-result-message')).toHaveText('Payment successful. Credits updated.');
  await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
  oldResponse.resolve();
  expect(await page.evaluate(() => window.testOldRefresh)).toBe(false);
  await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp_ui_v2:user:a:shell_profile')).credits.total)).toBe(12);
  expect(fixture.browserErrors).toEqual([]);
});

test('a refresh for a previous account cannot change the new account balance or cache', async ({ page }) => {
  const fixture = await installCredits(page);
  await page.goto('/buy_credits');
  await expect(page.locator('#shell-credits-total')).toHaveText('5 credits');
  const oldStarted = deferred();
  const oldResponse = deferred();
  await page.route('**/api/auth/user', async (route) => {
    if (route.request().headers().authorization === 'Bearer token-a') {
      oldStarted.resolve();
      await oldResponse.promise;
      return route.fulfill({ json: profile(12) });
    }
    return route.fulfill({ json: profile(27, 'b') });
  });
  await page.evaluate(() => { window.testOldRefresh = window.LectureProcessorShell.refreshCredits(); });
  await oldStarted.promise;
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#shell-credits-total')).toHaveText('27 credits');
  oldResponse.resolve();
  expect(await page.evaluate(() => window.testOldRefresh)).toBe(false);
  await expect(page.locator('#shell-credits-total')).toHaveText('27 credits');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp_ui_v2:user:b:credits_breakdown')).total)).toBe(27);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp_ui_v2:shell_profile:last')).uid)).toBe('b');
  await page.evaluate(() => window.testAccount.switchTo(null));
  const readsBefore = fixture.state.profileReads;
  expect(await page.evaluate(() => window.LectureProcessorShell.refreshCredits())).toBe(false);
  await expect(page.locator('#shell-credits-link')).toBeHidden();
  expect(fixture.state.profileReads).toBe(readsBefore);
  expect(fixture.browserErrors).toEqual([]);
});

const spendingPages = [
  '/lecture-notes', '/slides-extraction', '/interview-transcription', '/voice-notes',
  '/document-reader', '/image-reader', '/url-reader', '/general-transcriber',
  '/batch_mode', '/batch_mode_slides_extraction', '/batch_mode_interview_transcription',
  '/batch_mode_audio_transcription', '/batch_mode_text_combine',
  '/instant_batch_mode', '/instant_batch_mode_slides_extraction', '/instant_batch_mode_interview_transcription',
  '/instant_batch_mode_audio_transcription', '/instant_batch_mode_text_combine',
];
for (const route of spendingPages) {
  test(`signed-in ${route} exposes the current credit balance and purchase link`, async ({ page }) => {
    const fixture = await installCredits(page);
    await page.goto(route);
    const pill = page.getByRole('link', { name: 'Buy credits, 5 credits', exact: true });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('href', '/buy_credits');
    await pill.focus();
    await expect(page.locator('#shell-credits-tooltip')).toBeVisible();
    await expect(page.locator('#shell-credit-total')).toHaveText('5');
    expect(fixture.browserErrors).toEqual([]);
  });
}

for (const width of [1440, 375]) {
  for (const theme of ['light', 'dark']) {
    test(`Lecture Notes credit balance fits at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      const fixture = await installCredits(page);
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/user-preferences', route => route.fulfill({ json: { preferences: { theme, interface_language: 'en', onboarding_completed: true } } }));
      await page.goto('/lecture-notes');
      await expect(page.locator('#shell-credits-total')).toHaveText('5 credits');
      await expect.poll(() => page.evaluate(() => window.LecturePreferences.get().ready)).toBe(true);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const pill = page.locator('#shell-credits-link');
      await expect(pill).toBeVisible();
      const bounds = await pill.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`creation-credits-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      expect(fixture.browserErrors).toEqual([]);
    });
  }
}
