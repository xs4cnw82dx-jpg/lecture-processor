const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

const costs = {
  interview_transcription: { category: 'interview', instant: 10, overnight: 5 },
  interview_extra: { category: 'slides', instant: 2, overnight: 1 },
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(page, options = {}) {
  const shared = await installAccountFixture(page);
  const state = { reads: [], fail: true, reply: null, legacy: false, costs, language: 'en', theme: 'light', ...options };
  await page.addInitScript(({ language, theme }) => {
    for (const suffix of ['', ':a', ':b']) localStorage.setItem('lp-preferences' + suffix, JSON.stringify({ language, theme }));
  }, state);
  await page.route(/\/static\/js\/batch-mode(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({
    contentType: 'application/javascript', path: path.resolve('static/js', process.env.CREDIT_RECOVERY_MINIFIED ? 'batch-mode.min.js' : 'batch-mode.js'),
  }));
  await page.route('**/api/auth/user', async route => {
    const uid = route.request().headers().authorization === 'Bearer token-b' ? 'b' : 'a';
    state.reads.push(uid);
    if (state.reply) return state.reply(route, uid);
    return route.fulfill(state.fail ? { status: 503, json: { error: 'Synthetic profile failure' } } : { json: {
      uid, email: uid + '@example.test',
      ...(state.legacy ? { credits: { lecture_standard: 0, lecture_extended: 0, slides: 5, interview_short: 5, interview_medium: 0, interview_long: 0 } }
        : { credits_version: 2, credits: uid === 'a' ? 100 : 27, credit_costs: state.costs }),
      unlimited_credits: {}, preferences: { interface_language: state.language, theme: state.theme, onboarding_completed: true },
    } });
  });
  await page.route('**/api/user-preferences', route => route.fulfill({ json: { preferences: { interface_language: state.language, theme: state.theme } } }));
  return { ...shared, state };
}

async function failedProfile(page) {
  await expect.poll(() => page.evaluate(() => window.LectureProcessorShell.getCreditState().status)).toBe('error');
  await expect(page.locator('#submit-batch-btn')).toBeDisabled();
}

async function events(page, type = 'focus', count = 1) {
  await page.evaluate(({ type, count }) => {
    for (let index = 0; index < count; index += 1) window.dispatchEvent(new Event(type));
  }, { type, count });
}

for (const type of ['focus', 'online']) {
  test(`${type} recovers a failed credit profile and preserves selected inputs`, async ({ page }) => {
    const setup = await fixture(page);
    await page.goto('/batch_mode_interview_transcription');
    await failedProfile(page);
    const row = page.locator('.batch-row').first();
    await row.locator('[data-field="audio"]').setInputFiles({ name: 'keep.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3 synthetic') });
    await row.locator('[data-interview-feature-chip="summary"]').click();
    setup.state.fail = false;
    await events(page, type, 5);
    await expect(page.locator('#shell-credits-total')).toHaveText('100 credits');
    await expect(page.locator('#submit-batch-btn')).toBeEnabled();
    await expect(row.locator('[data-interview-extra-note]')).toHaveText('Selected extras: 1 credit.');
    expect(await row.locator('[data-field="audio"]').evaluate(input => input.files[0].name)).toBe('keep.mp3');
    expect(setup.state.reads).toEqual(['a', 'a']);
    expect(setup.browserErrors).toEqual([]);
  });
}

test('repeated focus and online events allow only one retry during a persistent failure', async ({ page }) => {
  const setup = await fixture(page);
  await page.goto('/batch_mode_interview_transcription');
  await failedProfile(page);
  await events(page, 'focus', 10);
  await expect.poll(() => setup.state.reads.length).toBe(2);
  await failedProfile(page);
  await events(page, 'online', 10);
  await events(page, 'focus', 10);
  await page.waitForTimeout(250);
  expect(setup.state.reads).toEqual(['a', 'a']);
  await expect(page.locator('#submit-batch-btn')).toBeDisabled();
});

test('a verified recovery rearms one retry for a later outage', async ({ page }) => {
  const setup = await fixture(page);
  await page.goto('/batch_mode_interview_transcription');
  await failedProfile(page);
  setup.state.fail = false;
  await events(page);
  await expect(page.locator('#shell-credits-total')).toHaveText('100 credits');
  setup.state.fail = true;
  await page.evaluate(() => window.LectureProcessorShell.refreshCreditSnapshot({ force: true }).catch(() => null));
  await failedProfile(page);
  setup.state.fail = false;
  await events(page, 'online');
  await expect.poll(() => page.evaluate(() => window.LectureProcessorShell.getCreditState().status)).toBe('ready');
  expect(setup.state.reads).toEqual(['a', 'a', 'a', 'a']);
});

test('offline focus preserves the retry for the browser online event', async ({ page, context }) => {
  const setup = await fixture(page);
  await page.goto('/batch_mode_interview_transcription');
  await failedProfile(page);
  await context.setOffline(true);
  await events(page, 'focus', 5);
  await page.waitForTimeout(250);
  expect(setup.state.reads).toEqual(['a']);
  setup.state.fail = false;
  await context.setOffline(false);
  await expect(page.locator('#shell-credits-total')).toHaveText('100 credits');
  expect(setup.state.reads).toEqual(['a', 'a']);
});

test('automatic recovery and ordinary consumers coalesce while the profile is held', async ({ page }) => {
  const setup = await fixture(page);
  const held = deferred();
  await page.goto('/batch_mode_interview_transcription');
  await failedProfile(page);
  setup.state.fail = false;
  // This later route holds only the recovery call and then uses the fixture's
  // actual profile response, preserving the normal shared provider behavior.
  await page.route('**/api/auth/user', async route => { await held.promise; return route.fallback(); });
  try {
    await events(page);
    await expect.poll(() => page.evaluate(() => window.LectureProcessorShell.getCreditState().status)).toBe('loading');
    await page.evaluate(() => { window.recoveryConsumers = Promise.all([1, 2, 3].map(() => window.LectureProcessorShell.refreshCreditSnapshot())); });
    await events(page, 'online', 5);
    await expect(page.locator('#submit-batch-btn')).toBeDisabled();
    held.resolve();
    await page.evaluate(() => window.recoveryConsumers);
    await expect(page.locator('#shell-credits-total')).toHaveText('100 credits');
    expect(setup.state.reads).toEqual(['a', 'a']);
  } finally { held.resolve(); }
});

test('an old account recovery response cannot replace the new account balance', async ({ page }) => {
  const setup = await fixture(page);
  const held = deferred();
  await page.goto('/batch_mode_interview_transcription');
  await failedProfile(page);
  setup.state.fail = false;
  let waiting = false;
  await page.route('**/api/auth/user', async route => {
    if (route.request().headers().authorization === 'Bearer token-a') { waiting = true; await held.promise; }
    return route.fallback();
  });
  try {
    await events(page);
    await expect.poll(() => waiting).toBe(true);
    await page.evaluate(() => window.testAccount.switchTo('b'));
    await expect(page.locator('#shell-credits-total')).toHaveText('27 credits');
    const arrived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/user'
      && response.request().headers().authorization === 'Bearer token-a');
    held.resolve();
    await (await arrived).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#shell-credits-total')).toHaveText('27 credits');
    expect(await page.evaluate(() => window.LectureProcessorShell.getCreditState().uid)).toBe('b');
    expect(await page.evaluate(() => localStorage.getItem('lp_ui_v2:user:a:credit_snapshot'))).toBeNull();
  } finally { held.resolve(); }
});

test('a new account has its own bounded recovery allowance', async ({ page }) => {
  const setup = await fixture(page);
  await page.goto('/batch_mode_interview_transcription');
  await failedProfile(page);
  await events(page);
  await expect.poll(() => setup.state.reads.length).toBe(2);
  await failedProfile(page);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect.poll(() => setup.state.reads.length).toBe(3);
  await failedProfile(page);
  setup.state.fail = false;
  await events(page, 'online');
  await expect(page.locator('#shell-credits-total')).toHaveText('27 credits');
  expect(setup.state.reads).toEqual(['a', 'a', 'b', 'b']);
});

test('a recovered balance without a known price does not enable paid submission', async ({ page }) => {
  const setup = await fixture(page);
  await page.goto('/batch_mode_interview_transcription');
  await failedProfile(page);
  setup.state.fail = false;
  setup.state.costs = null;
  await events(page);
  await expect(page.locator('#shell-credits-total')).toHaveText('100 credits');
  await expect(page.locator('[data-interview-extra-note]').first()).toHaveText('Credit cost unavailable.');
  await expect(page.locator('#submit-batch-btn')).toBeDisabled();
});

test('healthy and signed-out states do not fetch on focus or online', async ({ page }) => {
  const setup = await fixture(page, { fail: false });
  await page.goto('/batch_mode_interview_transcription');
  await expect(page.locator('#shell-credits-total')).toHaveText('100 credits');
  await events(page, 'focus', 5);
  await events(page, 'online', 5);
  await page.evaluate(() => window.testAccount.switchTo(null));
  await expect.poll(() => page.evaluate(() => window.LectureProcessorShell.getCreditState().status)).toBe('signed-out');
  await events(page, 'focus', 5);
  await events(page, 'online', 5);
  await page.waitForTimeout(250);
  expect(setup.state.reads).toEqual(['a']);
});

for (const language of ['en', 'nl']) {
  test(`legacy batch extra notes use ${language} for zero, one and two selections`, async ({ page }) => {
    await fixture(page, { fail: false, legacy: true, language });
    await page.goto('/batch_mode_interview_transcription');
    const row = page.locator('.batch-row').first();
    const note = row.locator('[data-interview-extra-note]');
    await expect(note).toHaveText(language === 'nl'
      ? 'Geen extra’s geselecteerd. Kies één of beide opties (1 tekstextractiecredit per optie).'
      : 'No extras selected. Select one or both options (1 text extraction credit per option).');
    await row.locator('[data-interview-feature-chip="summary"]').click();
    await expect(note).toHaveText(language === 'nl' ? '1 extra geselecteerd (1 tekstextractiecredit).' : '1 extra selected (1 text extraction credit).');
    await row.locator('[data-interview-feature-chip="sections"]').click();
    await expect(note).toHaveText(language === 'nl' ? '2 extra’s geselecteerd (2 tekstextractiecredits).' : '2 extras selected (2 text extraction credits).');
    await page.evaluate(language => window.LectureI18n.setLanguage(language), language === 'nl' ? 'en' : 'nl');
    await expect(note).toHaveText(language === 'nl' ? '2 extras selected (2 text extraction credits).' : '2 extra’s geselecteerd (2 tekstextractiecredits).');
  });
}

for (const language of ['en', 'nl']) {
  for (const theme of ['light', 'dark']) {
    test(`credit recovery and legacy extras render in ${language} ${theme}`, async ({ page }, testInfo) => {
      const setup = await fixture(page, { legacy: true, language, theme });
      await page.goto('/batch_mode_interview_transcription');
      await failedProfile(page);
      const row = page.locator('.batch-row').first();
      await row.locator('[data-interview-feature-chip="summary"]').click();
      await row.locator('[data-interview-feature-chip="sections"]').click();
      const note = row.locator('[data-interview-extra-note]');
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await note.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`unavailable-${width}.png`), animations: 'disabled' });
      }
      setup.state.fail = false;
      await events(page);
      await expect(note).toHaveText(language === 'nl' ? '2 extra’s geselecteerd (2 tekstextractiecredits).' : '2 extras selected (2 text extraction credits).');
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await note.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`recovered-${width}.png`), animations: 'disabled' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
      expect(setup.browserErrors).toEqual([]);
    });
  }
}
