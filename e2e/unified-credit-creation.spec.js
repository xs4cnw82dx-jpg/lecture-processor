const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

const costs = {
  lecture_notes: { category: 'lecture', instant: 8, overnight: 4 },
  slides_extraction: { category: 'slides', instant: 2, overnight: 1 },
  interview_transcription: { category: 'interview', instant: 10, overnight: 5 },
  interview_extra: { category: 'slides', instant: 2, overnight: 1 },
  audio_transcription: { category: 'interview', instant: 10, overnight: 5 },
  text_combine: { category: 'lecture', instant: 8, overnight: 4 },
  voice_note: { category: 'interview', instant: 10, overnight: null },
};

async function install(page, options = {}) {
  const fixture = await installAccountFixture(page);
  const state = { balance: 100, costs: structuredClone(costs), unlimited: {}, posts: [], legacy: false, configScheme: 2, signupGrant: 12, ...options };
  await page.route(/\/static\/js\/(index-app|batch-mode)(?:\.min)?\.js(?:\?.*)?$/, route => {
    const name = path.basename(new URL(route.request().url()).pathname).replace('.min.js', '.js');
    return route.fulfill({ contentType: 'application/javascript', path: path.join(process.env.CREATION_CREDIT_SOURCE_DIR || 'static/js', process.env.CREATION_CREDIT_USE_MINIFIED ? name.replace('.js', '.min.js') : name) });
  });
  await page.route('**/api/verify-email', route => route.fulfill({ json: { allowed: true } }));
  await page.route('**/api/auth/user', route => route.fulfill(state.profileError ? { status: 503, json: { error: 'Synthetic unavailable profile' } } : { json: {
    uid: route.request().headers().authorization === 'Bearer token-b' ? 'b' : 'a', email: 'a@example.test',
    ...(state.legacy ? { credits: { lecture_standard: 5, lecture_extended: 0, slides: 3, interview_short: 2, interview_medium: 0, interview_long: 0 } }
      : { credits_version: 2, credits: state.balance, credit_costs: state.costs }),
    unlimited_credits: state.unlimited,
    preferences: { onboarding_completed: true, interface_language: 'en', output_language: 'english' },
  } }));
  await page.route('**/api/config', route => route.fulfill(state.configError ? { status: 503, json: { error: 'Synthetic unavailable configuration' } } : { json: state.configScheme === 2
    ? { credit_scheme: 2, action_costs: state.costs, free_signup_credits: state.signupGrant, bundles: {} } : { bundles: {} } }));
  await page.route('**/api/user-preferences', route => route.fulfill({ json: { preferences: { onboarding_completed: true, interface_language: 'en' } } }));
  return { ...fixture, state };
}

test('single lecture shows its unified charge and scalar balance before submission', async ({ page }) => {
  await install(page, { balance: 8 });
  await page.goto('/lecture-notes');
  await expect(page.locator('#mode-credit-cost')).toContainText('8 credits');
  await expect(page.locator('#mode-cost-summary')).toContainText('8 credits available');
  await page.locator('#study-pack-title-input').fill('Synthetic lecture');
  await page.locator('#pdf-input').setInputFiles({ name: 'slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 synthetic') });
  await page.locator('#audio-input').setInputFiles({ name: 'audio.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3 synthetic') });
  await expect(page.locator('#process-button')).toBeEnabled();
});

test('three-row batch updates quote when processing speed changes without losing files', async ({ page }) => {
  await install(page);
  await page.goto('/batch_mode_slides_extraction');
  await page.locator('#add-row-btn').click();
  await expect(page.locator('.batch-row')).toHaveCount(3);
  const first = page.locator('[data-field="slides"]').first();
  await first.setInputFiles({ name: 'keep.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-fixture') });
  await expect(page.locator('#batch-credit-summary')).toContainText('3 credits');
  await page.getByRole('switch', { name: 'Instant processing' }).click();
  await expect(page.locator('#batch-credit-summary')).toContainText('6 credits');
  expect(await first.evaluate(input => input.files[0].name)).toBe('keep.pdf');
});

test('known unified batch prices explain the half-price deferred option across speed changes', async ({ page }) => {
  const fixture = await install(page, { configScheme: 1 });
  await page.goto('/batch_mode');
  await expect(page.locator('#batch-speed-description')).toHaveText('Overnight batches use half the instant credit price. Allow up to 24 hours for results.');
  await page.getByRole('switch', { name: 'Instant processing' }).click();
  await expect(page.locator('#batch-speed-description')).toHaveText('Starts now. Standard credit cost.');
  await page.getByRole('switch', { name: 'Instant processing' }).click();
  await expect(page.locator('#batch-speed-description')).toContainText('half the instant credit price');
  fixture.state.costs.lecture_notes.overnight = 3;
  await refresh(page);
  await expect(page.locator('#batch-speed-description')).toHaveText('Allow up to 24 hours for results.');
  fixture.state.costs = null;
  await refresh(page);
  await expect(page.locator('#batch-speed-description')).toHaveText('Allow up to 24 hours for results.');
});

test('legacy batch pricing keeps its timing description without a half-price claim', async ({ page }) => {
  await install(page, { legacy: true, configScheme: 1 });
  await page.goto('/batch_mode');
  await expect(page.locator('#shell-credits-total')).toHaveText('10 credits');
  await expect(page.locator('#batch-speed-description')).toHaveText('Allow up to 24 hours for results.');
  await page.getByRole('switch', { name: 'Instant processing' }).click();
  await expect(page.locator('#batch-speed-description')).toHaveText('Starts now. Standard credit cost.');
});

test('batch output language hydrates the saved account preference', async ({ page }) => {
  const fixture = await install(page);
  await page.route('**/api/user-preferences', route => route.fulfill({ json: {
    preferences: { output_language: 'other', output_language_custom: 'Italian' },
  } }));
  await page.goto('/batch_mode');
  await expect(page.locator('#output-language')).toHaveValue('other');
  await expect(page.locator('#output-language-custom')).toBeVisible();
  await expect(page.locator('#output-language-custom')).toHaveValue('Italian');
  await expect(page.locator('#output-language-label')).toContainText('Italian');
  expect(fixture.browserErrors).toEqual([]);
});

test('batch output language keeps the user choice when saved preferences arrive late', async ({ page }) => {
  const fixture = await install(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/api/user-preferences', async route => {
    requested = true;
    await held;
    return route.fulfill({ json: { preferences: { output_language: 'dutch' } } });
  });
  await page.goto('/batch_mode');
  await expect.poll(() => requested).toBe(true);
  await page.locator('#output-language-button').click();
  await page.locator('#output-language-menu [data-value="spanish"]').click();
  await expect(page.locator('#output-language')).toHaveValue('spanish');
  const arrived = page.waitForResponse('**/api/user-preferences');
  release();
  await (await arrived).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#output-language')).toHaveValue('spanish');
  await expect(page.locator('#output-language-label')).toContainText('Spanish');
  expect(fixture.browserErrors).toEqual([]);
});

test('batch output language ignores saved preferences from the previous account', async ({ page }) => {
  const fixture = await install(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/api/user-preferences', async route => {
    const previousAccount = route.request().headers().authorization === 'Bearer token-a';
    if (previousAccount) { requested = true; await held; }
    return route.fulfill({ json: { preferences: { output_language: previousAccount ? 'dutch' : 'french' } } });
  });
  await page.goto('/batch_mode');
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#output-language')).toHaveValue('french');
  const arrived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/user-preferences'
    && response.request().headers().authorization === 'Bearer token-a');
  release();
  await (await arrived).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#output-language')).toHaveValue('french');
  await expect(page.locator('#output-language-label')).toContainText('French');
  expect(fixture.browserErrors).toEqual([]);
});

async function fillSingle(page, mode) {
  await page.locator('#study-pack-title-input').fill('Keep my title');
  if (mode !== 'interview') await page.locator('#pdf-input').setInputFiles({ name: 'keep.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 synthetic') });
  if (mode !== 'slides-only') await page.locator('#audio-input').setInputFiles({ name: 'keep.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3 synthetic') });
}

async function refresh(page) {
  await page.evaluate(() => window.LectureProcessorShell.refreshCreditSnapshot({ force: true }).catch(() => null));
}

for (const [suffix, instant, overnight] of [
  ['', 8, 4], ['_slides_extraction', 2, 1], ['_interview_transcription', 10, 5],
  ['_audio_transcription', 10, 5], ['_text_combine', 8, 4],
]) {
  test(`batch ${suffix || 'lecture'} quotes each row and three-row total in both strategies`, async ({ page }) => {
    await install(page);
    await page.goto('/batch_mode' + suffix);
    await expect(page.locator('[data-row-credit-cost]').first()).toHaveText(`Row total: ${overnight} ${overnight === 1 ? 'credit' : 'credits'}.`);
    await page.locator('[data-action="remove-row"]').first().click();
    await expect(page.locator('.batch-row')).toHaveCount(2);
    await page.locator('#add-row-btn').click();
    await expect(page.locator('#batch-credit-summary')).toContainText(`Batch total: ${overnight * 3} credits.`);
    await page.getByRole('switch', { name: 'Instant processing' }).click();
    await expect(page.locator('[data-row-credit-cost]').first()).toHaveText(`Row total: ${instant} credits.`);
    await expect(page.locator('#batch-credit-summary')).toContainText(`Batch total: ${instant * 3} credits.`);
    await page.goBack();
    await expect(page.locator('#batch-credit-summary')).toContainText(`Batch total: ${overnight * 3} credits.`);
  });
}

test('selected interview extras survive insufficient balance and changing server prices', async ({ page }) => {
  const fixture = await install(page, { balance: 14, configScheme: 1 });
  await page.goto('/interview-transcription');
  await fillSingle(page, 'interview');
  await page.locator('#advanced-settings-toggle').click();
  await page.locator('[data-feature="summary"]').click();
  await page.locator('[data-feature="sections"]').click();
  await expect(page.locator('#mode-credit-cost')).toContainText('14 credits');
  await expect(page.locator('#process-button')).toBeEnabled();
  fixture.state.balance = 10;
  await refresh(page);
  await expect(page.locator('.interview-option.active')).toHaveCount(2);
  await expect(page.locator('#process-button')).toBeDisabled();
  await expect(page.locator('#mode-cost-summary')).toContainText('14 credits; 10 are available');
  fixture.state.costs.interview_extra.instant = 4;
  fixture.state.balance = 18;
  await refresh(page);
  await expect(page.locator('#mode-credit-cost')).toContainText('18 credits');
  await expect(page.locator('#process-button')).toBeEnabled();
  expect(await page.locator('#audio-input').evaluate(input => input.files[0].name)).toBe('keep.mp3');
  expect(fixture.browserErrors).toEqual([]);
});

for (const [unlimited, balance, total, enabled] of [
  [{ interview: true }, 4, 4, true], [{ slides: true }, 10, 10, true],
  [{ interview: true, slides: true }, 0, 0, true], [{ lecture: true }, 0, 14, false],
]) {
  test(`interview exemptions ${JSON.stringify(unlimited)} apply only to their components`, async ({ page }) => {
    await install(page, { balance, unlimited });
    await page.goto('/interview-transcription');
    await fillSingle(page, 'interview');
    await page.locator('#advanced-settings-toggle').click();
    await page.locator('[data-feature="summary"]').click();
    await page.locator('[data-feature="sections"]').click();
    await expect(page.locator('#mode-credit-cost')).toContainText(`${total} credits`);
    await expect(page.locator('#process-button')).toBeEnabled({ enabled });
  });
}

test('mixed batch extras and refreshed prices update every row and aggregate', async ({ page }) => {
  const fixture = await install(page);
  await page.goto('/batch_mode_interview_transcription');
  await page.locator('#add-row-btn').click();
  await page.locator('.batch-row').nth(1).locator('[data-interview-feature-chip="summary"]').click();
  await page.locator('.batch-row').nth(2).locator('[data-interview-feature-chip]').first().click();
  await page.locator('.batch-row').nth(2).locator('[data-interview-feature-chip]').last().click();
  await expect(page.locator('#batch-credit-summary')).toContainText('18 credits');
  await page.getByRole('switch', { name: 'Instant processing' }).click();
  await expect(page.locator('#batch-credit-summary')).toContainText('36 credits');
  fixture.state.costs.interview_transcription = { category: 'interview', instant: 14, overnight: 7 };
  fixture.state.costs.interview_extra = { category: 'slides', instant: 4, overnight: 2 };
  await refresh(page);
  await expect(page.locator('#batch-credit-summary')).toContainText('54 credits');
  fixture.state.unlimited = { interview: true };
  await refresh(page);
  await expect(page.locator('#batch-credit-summary')).toContainText('12 credits');
  await page.locator('.batch-row').last().locator('[data-action="remove-row"]').click();
  await expect(page.locator('#batch-credit-summary')).toContainText('4 credits');
});

test('missing prices preserve scalar balance and files but cannot authorize creation', async ({ page }) => {
  const fixture = await install(page, { balance: 8 });
  await page.goto('/lecture-notes');
  await fillSingle(page, 'lecture-notes');
  await expect(page.locator('#process-button')).toBeEnabled();
  fixture.state.costs = null;
  await refresh(page);
  await expect(page.locator('#shell-credits-total')).toHaveText('8 credits');
  await expect(page.locator('#mode-credit-cost')).toContainText('unavailable');
  await expect(page.locator('#process-button')).toBeDisabled();
  expect(await page.locator('#pdf-input').evaluate(input => input.files[0].name)).toBe('keep.pdf');
});

test('an authoritative upload rejection retains files and displays needed and available', async ({ page }) => {
  await install(page, { balance: 8 });
  let posts = 0;
  await page.route('**/upload', route => { posts++; return route.fulfill({ status: 402, json: { error: 'Changed balance', error_code: 'insufficient_credits', needed: 8, available: 3 } }); });
  await page.goto('/lecture-notes');
  await fillSingle(page, 'lecture-notes');
  await page.locator('#process-button').click();
  await expect(page.locator('#status-text')).toContainText('8 credits; 3 are available');
  expect(posts).toBe(1);
  expect(await page.locator('#pdf-input').evaluate(input => input.files[0].name)).toBe('keep.pdf');
});

test('legacy off retains category cost and signup grant', async ({ page }) => {
  await install(page, { legacy: true, configScheme: 1 });
  await page.goto('/lecture-notes');
  await fillSingle(page, 'lecture-notes');
  await expect(page.locator('#mode-credit-cost')).toHaveText('Uses 1 lecture credit');
  await expect(page.locator('#process-button')).toBeEnabled();
  await expect(page.locator('#signup-credit-grant')).toHaveText('Get started with 1 free lecture credit');
});

for (const [label, signupGrant] of [['missing', undefined], ['invalid', '12']]) {
  test(`a ${label} unified signup grant keeps generic signup copy`, async ({ page }) => {
    await install(page, { signupGrant });
    await page.goto('/lecture-notes');
    await expect(page.locator('#mode-credit-cost')).toContainText('8 credits');
    await page.evaluate(() => window.testAccount.switchTo(null));
    await page.locator('#sign-in-to-process-btn').click();
    await page.locator('#switch-to-signup').click();
    await expect(page.locator('#signup-credit-grant')).toBeVisible();
    await expect(page.locator('#signup-credit-grant')).toHaveText('Create your study account');
  });
}

test('unavailable policy and profile cannot imply legacy prices or authorize creation', async ({ page }) => {
  const fixture = await install(page, { configError: true, profileError: true, balance: 8 });
  const unavailable = page.waitForResponse('**/api/config');
  await page.goto('/lecture-notes');
  await (await unavailable).finished();
  await fillSingle(page, 'lecture-notes');
  await expect(page.locator('#shell-credits-total')).toHaveText('Credits unavailable');
  await expect(page.locator('#mode-credit-cost')).toHaveText('Credit cost unavailable.');
  await expect(page.locator('#signup-credit-grant')).toHaveText('Create your study account');
  await expect(page.locator('#process-button')).toBeDisabled();
  fixture.state.profileError = false;
  await refresh(page);
  await expect(page.locator('#mode-credit-cost')).toContainText('8 credits');
  await expect(page.locator('#process-button')).toBeEnabled();
  expect(await page.locator('#pdf-input').evaluate(input => input.files[0].name)).toBe('keep.pdf');
  expect(fixture.browserErrors).toEqual([]);
});

test('explicit legacy public pricing keeps anonymous category and signup copy', async ({ page }) => {
  await install(page, { legacy: true, configScheme: 1 });
  await page.goto('/lecture-notes');
  await expect(page.locator('#signup-credit-grant')).toHaveText('Get started with 1 free lecture credit');
  await page.evaluate(() => window.testAccount.switchTo(null));
  await expect(page.locator('#mode-credit-cost')).toHaveText('Uses 1 lecture credit');
  await expect(page.locator('#signup-credit-grant')).toHaveText('Get started with 1 free lecture credit');
});

test('valid unified public pricing supplies changed anonymous rates and signup amounts', async ({ page }) => {
  const changedCosts = structuredClone(costs);
  changedCosts.lecture_notes = { category: 'lecture', instant: 14, overnight: 7 };
  await install(page, { costs: changedCosts, signupGrant: 20 });
  await page.goto('/lecture-notes');
  await expect(page.locator('#signup-credit-grant')).toHaveText('Get started with 20 credits');
  await page.evaluate(() => window.testAccount.switchTo(null));
  await expect(page.locator('#mode-credit-cost')).toHaveText('Uses 14 credits.');
  await expect(page.locator('#signup-credit-grant')).toHaveText('Get started with 20 credits');
});

test('anonymous pricing and signup use server costs without assuming a balance', async ({ page }, testInfo) => {
  await install(page);
  await page.goto('/lecture-notes');
  await page.evaluate(() => window.testAccount.switchTo(null));
  await expect(page.locator('#mode-credit-cost')).toContainText('8 credits');
  await expect(page.locator('#mode-cost-summary')).toBeHidden();
  await expect(page.locator('#signup-credit-grant')).toHaveText('Get started with 12 credits');
  await page.locator('#sign-in-to-process-btn').click();
  await page.locator('#switch-to-signup').click();
  await expect(page.locator('#signup-credit-grant')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('signup-grant.png'), fullPage: true, animations: 'disabled' });
});

test('a late previous-account profile cannot replace the current creation quote', async ({ page }) => {
  const fixture = await install(page, { balance: 8 });
  await page.goto('/lecture-notes');
  await expect(page.locator('#mode-cost-summary')).toContainText('8 credits available');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/api/auth/user', async route => {
    const old = route.request().headers().authorization === 'Bearer token-a';
    if (old) { requested = true; await held; }
    return route.fulfill({ json: { uid: old ? 'a' : 'b', email: old ? 'a@example.test' : 'b@example.test', credits_version: 2, credits: old ? 1 : 27, credit_costs: costs, preferences: { onboarding_completed: true } } });
  });
  await page.evaluate(() => { window.oldCreditRequest = window.LectureProcessorShell.refreshCreditSnapshot({ force: true }).catch(() => null); });
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#mode-cost-summary')).toContainText('27 credits available');
  release();
  await page.evaluate(() => window.oldCreditRequest);
  await expect(page.locator('#mode-cost-summary')).toContainText('27 credits available');
  expect(fixture.browserErrors).toEqual([]);
});

for (const language of ['en', 'nl']) {
  for (const theme of ['light', 'dark']) {
    test(`creation and batch prices remain readable in ${language} ${theme}`, async ({ page }, testInfo) => {
      await install(page);
      for (const [label, route, summary] of [
        ['single', '/lecture-notes', '#mode-credit-cost'],
        ['batch', '/batch_mode_interview_transcription', '#batch-credit-summary'],
      ]) {
        await page.goto(route);
        await expect(page.locator(summary)).toContainText('credits');
        await page.evaluate(({ language, theme }) => { window.LectureI18n.setLanguage(language); window.LPTheme.apply({ theme }); }, { language, theme });
        await expect(page.locator(summary)).toContainText(language === 'nl' ? (label === 'single' ? 'Gebruikt' : 'Batchtotaal') : (label === 'single' ? 'Uses' : 'Batch total'));
        for (const width of [1440, 375]) {
          await page.setViewportSize({ width, height: 1000 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`${label}-${language}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
        }
      }
    });
  }
}

test('single slides uses stored unified prices with public activation off', async ({ page }) => {
  await install(page, { balance: 2, configScheme: 1 });
  await page.goto('/slides-extraction');
  await fillSingle(page, 'slides-only');
  await expect(page.locator('#mode-credit-cost')).toHaveText('Uses 2 credits.');
  await expect(page.locator('#process-button')).toBeEnabled();
});

test('batch admission rejection preserves all rows and reports the authoritative shortfall', async ({ page }) => {
  const fixture = await install(page, { balance: 2 });
  let posts = 0;
  await page.route('**/api/batch/jobs', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++;
    fixture.state.balance = 1;
    return route.fulfill({ status: 402, json: { error: 'Changed balance', needed: 2, available: 1, error_code: 'insufficient_credits' } });
  });
  await page.goto('/batch_mode_slides_extraction');
  await page.locator('#batch-title').fill('Keep batch title');
  for (const input of await page.locator('[data-field="slides"]').all()) await input.setInputFiles({ name: 'keep.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 fixture') });
  await page.locator('#submit-batch-btn').click();
  await expect(page.locator('#batch-submit-feedback')).toContainText('2 credits; 1 are available');
  await expect(page.locator('#batch-title')).toHaveValue('Keep batch title');
  expect(posts).toBe(1);
  expect(await page.locator('[data-field="slides"]').evaluateAll(inputs => inputs.map(input => input.files[0].name))).toEqual(['keep.pdf', 'keep.pdf']);
});

test('a late upload rejection cannot replace another account interface', async ({ page }) => {
  await install(page, { legacy: true, configScheme: 1 });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/upload', async route => {
    requested = true;
    await held;
    await route.fulfill({ status: 402, json: { error: 'Previous account private balance', needed: 8, available: 0 } });
  });
  await page.goto('/lecture-notes');
  await fillSingle(page, 'lecture-notes');
  await page.locator('#process-button').click();
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect.poll(() => page.evaluate(() => window.LectureProcessorShell.getCreditState().uid)).toBe('b');
  const prior = await page.locator('#status-text').textContent();
  const received = page.waitForResponse(response => new URL(response.url()).pathname === '/upload');
  release();
  await (await received).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#status-text')).toHaveText(prior);
});
