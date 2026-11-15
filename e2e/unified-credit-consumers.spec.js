const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');

const costs = {
  tools_extraction: { category: 'slides', instant: 2, overnight: null },
  tools_transcription: { category: 'interview', instant: 10, overnight: null },
};

function profile(uid = 'a', options = {}) {
  return {
    uid, email: `${uid}@example.test`, credits_version: 2,
    credits: uid === 'a' ? 12 : 27, credit_costs: costs,
    unlimited_credits: { lecture: false, slides: false, interview: false },
    preferences: { favorite_tools: [], interface_language: 'en', output_language: 'dutch', onboarding_completed: true },
    ...options,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function chooseInput(page, transcriber) {
  await page.locator(transcriber ? '#transcriber-file-input' : '#reader-file-input').setInputFiles({
    name: transcriber ? 'Original recording.mp3' : 'Original document.pdf',
    mimeType: transcriber ? 'audio/mpeg' : 'application/pdf', buffer: Buffer.from('Synthetic fixture only'),
  });
}

async function fixture(page, options = {}) {
  const shared = await installAccountFixture(page);
  await page.addInitScript(({ language, theme }) => {
    const value = JSON.stringify({ language, theme });
    localStorage.setItem('lp-preferences', value);
    localStorage.setItem('lp-preferences:a', value);
  }, { language: options.language || 'en', theme: options.theme || 'light' });
  const state = { profiles: { a: profile('a', options.profile), b: profile('b') }, reads: [], reply: null };
  if (process.env.UNIFIED_CONSUMERS_BASELINE) {
    await page.route(/\/static\/js\/(app-shell|settings|reader|general-transcriber)(\.min)?\.js(?:\?.*)?$/, route => {
      const name = new URL(route.request().url()).pathname.split('/').pop().replace('.min.js', '.js');
      return route.fulfill({ contentType: 'application/javascript', path: path.join(process.env.UNIFIED_CONSUMERS_BASELINE, name) });
    });
  }
  await page.route('**/api/auth/user', async route => {
    const uid = route.request().headers().authorization.replace('Bearer token-', '');
    state.reads.push(uid);
    if (state.reply) return state.reply(route, uid);
    return route.fulfill({ json: state.profiles[uid] });
  });
  await page.route('**/api/user-preferences', route => route.fulfill({ json: { preferences: { interface_language: options.language || 'en', theme: options.theme || 'light' } } }));
  await page.route('**/api/config', route => route.fulfill({ json: { bundles: {}, stripe_publishable_key: '' } }));
  return { ...shared, state };
}

for (const route of ['/settings', '/document-reader', '/image-reader', '/general-transcriber']) {
  test(`scalar balance remains finite on ${route} while the public rollout is off`, async ({ page }) => {
    const setup = await fixture(page);
    await page.goto(route);
    await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
    if (route === '/settings') await expect(page.locator('#settings-credit-balance')).toHaveText('12 credits');
    if (route.includes('reader')) await expect(page.locator('#reader-credit-note')).toContainText('2 credits');
    if (route === '/general-transcriber') {
      await expect(page.locator('#transcriber-credit-note')).toContainText('10 credits');
      await expect(page.locator('#transcriber-output-language')).toHaveValue('dutch');
    }
    expect(setup.browserErrors).toEqual([]);
  });
}

test('a valid legacy account retains its category balance', async ({ page }) => {
  const setup = await fixture(page, { profile: {
    credits_version: undefined,
    credits: { lecture_standard: 3, lecture_extended: 0, slides: 2, interview_short: 1, interview_medium: 0, interview_long: 0 },
  } });
  await page.goto('/document-reader');
  await expect(page.locator('#shell-credits-total')).toHaveText('6 credits');
  await expect(page.locator('#reader-credit-note')).toContainText('Text extraction credits: 2');
  expect(setup.browserErrors).toEqual([]);
});

test('reader cannot downgrade a unified cache through an old tab or an offline reload', async ({ page }) => {
  const setup = await fixture(page);
  await page.goto('/document-reader');
  await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp_ui_v2:user:a:credit_snapshot')).snapshot)).toMatchObject({ scheme: 2, balance: 12 });
  await page.evaluate(() => localStorage.setItem('lp_ui_v2:user:a:credits_breakdown', JSON.stringify({ lecture: 0, textExtraction: 0, interview: 0, total: 0 })));
  setup.state.reply = route => route.fulfill({ status: 503, json: { error: 'Synthetic offline' } });
  await page.reload();
  await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
  await expect(page.locator('#reader-credit-note')).toContainText('Balance: 12 credits');
  await expect.poll(() => page.evaluate(() => window.LectureProcessorShell.getCreditState().status)).toBe('error');
  let posts = 0;
  await page.route('**/api/tools/extract', route => { posts += 1; return route.fulfill({ json: { result: 'Unexpected' } }); });
  await chooseInput(page, false);
  await page.locator('#reader-run-btn').click();
  await expect(page.locator('#reader-status')).toContainText('Could not load your account');
  await expect(page.locator('#reader-selected-files')).toContainText('Original document.pdf');
  expect(posts).toBe(0);
  expect(setup.browserErrors).toEqual([]);
});

test('an exempt reader keeps a finite balance and does not exempt transcription', async ({ page }) => {
  const setup = await fixture(page, { profile: { credits: 8, unlimited_credits: { lecture: false, slides: true, interview: false } } });
  await page.goto('/document-reader');
  await expect(page.locator('#shell-credits-total')).toHaveText('8 credits');
  await expect(page.locator('#reader-credit-note')).toHaveText('No credits charged for this tool. Balance: 8 credits');
  await page.locator('#shell-credits-link').focus();
  await expect(page.locator('#shell-credits-tooltip')).toBeVisible();
  await expect(page.locator('#shell-credit-text')).toHaveText('No credits charged');
  await expect(page.locator('#shell-credit-interview')).toBeHidden();
  await page.goto('/general-transcriber');
  await expect(page.locator('#transcriber-credit-note')).toHaveText('Cost: 10 credits · Balance: 8 credits');
  let posts = 0;
  await page.route('**/api/tools/transcribe', route => { posts += 1; return route.fulfill({ json: { job_id: 'unexpected' } }); });
  await chooseInput(page, true);
  await page.locator('#transcriber-run-btn').click();
  await expect(page.locator('#transcriber-status')).toHaveText('Not enough credits. This needs 10 credits; 8 are available.');
  await expect(page.locator('#transcriber-file-name')).toHaveText('Original recording.mp3');
  await expect(page.locator('#transcriber-run-btn')).toBeEnabled();
  expect(posts).toBe(0);
  expect(setup.browserErrors).toEqual([]);
});

for (const transcriber of [false, true]) {
  test(`${transcriber ? 'transcriber' : 'reader'} uses the profile price and preserves input after an authoritative 402`, async ({ page }) => {
    const setup = await fixture(page, { profile: { credit_costs: {
      tools_extraction: { ...costs.tools_extraction, instant: 3 },
      tools_transcription: { ...costs.tools_transcription, instant: 11 },
    } } });
    const prefix = transcriber ? 'transcriber' : 'reader';
    await page.goto(transcriber ? '/general-transcriber' : '/document-reader');
    await expect(page.locator(`#${prefix}-credit-note`)).toHaveText(`Cost: ${transcriber ? 11 : 3} credits · Balance: 12 credits`);
    let posts = 0;
    await page.route(`**/api/tools/${transcriber ? 'transcribe' : 'extract'}`, route => {
      posts += 1;
      return route.fulfill({ status: 402, json: { error: 'Generic fallback should not win', needed: 13, available: 1, error_code: 'insufficient_credits' } });
    });
    await chooseInput(page, transcriber);
    await page.locator(`#${prefix}-run-btn`).click();
    await expect(page.locator(`#${prefix}-status`)).toHaveText('Not enough credits. This needs 13 credits; 1 are available.');
    await expect(page.locator(`#${prefix}-run-btn`)).toBeEnabled();
    await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
    expect(posts).toBe(1);
    expect(setup.browserErrors).toEqual([]);
  });

  test(`${transcriber ? 'transcription' : 'extraction'} completion refreshes the shared balance and keeps the chosen input`, async ({ page }) => {
    const setup = await fixture(page);
    const prefix = transcriber ? 'transcriber' : 'reader';
    await page.goto(transcriber ? '/general-transcriber' : '/document-reader');
    await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
    await chooseInput(page, transcriber);
    if (transcriber) {
      await page.locator('#transcriber-output-language-button').click();
      await page.locator('.app-select-item[data-value="french"]').click();
    } else {
      await page.locator('#reader-advanced-toggle').click();
      await page.locator('#reader-question-input').fill('Keep my authored question.');
    }
    let submitted;
    await page.route(`**/api/tools/${transcriber ? 'transcribe' : 'extract'}`, route => {
      submitted = route.request().postData();
      setup.state.profiles.a.credits = transcriber ? 2 : 10;
      return route.fulfill({ status: 202, json: { job_id: 'synthetic-tools-job' } });
    });
    await page.route('**/status/synthetic-tools-job', route => route.fulfill({ json: { status: 'complete', result: 'Authored output remains English.', output_text: 'Authored output remains English.', transcript: 'Authored output remains English.' } }));
    await page.locator(`#${prefix}-run-btn`).click();
    await expect(page.locator(`#${prefix}-output-pre`)).toContainText('Authored output remains English.');
    await expect(page.locator('#shell-credits-total')).toHaveText(`${transcriber ? 2 : 10} credits`);
    await expect(page.locator(`#${prefix}-credit-note`)).toContainText(`Balance: ${transcriber ? 2 : 10} credits`);
    if (transcriber) {
      await expect(page.locator('#transcriber-output-language')).toHaveValue('french');
      expect(submitted).toContain('french');
    } else await expect(page.locator('#reader-question-input')).toHaveValue('Keep my authored question.');
    expect(setup.browserErrors).toEqual([]);
  });
}

for (const [label, invalid] of [['missing', {}], ['negative', { credits: -1 }], ['string', { credits: '12' }], ['wrong account', { uid: 'b' }], ['unversioned scalar', { credits_version: undefined }]]) {
  test(`invalid profile ${label} preserves the last valid balance and rejects refresh`, async ({ page }) => {
    const setup = await fixture(page);
    await page.goto('/settings');
    await expect(page.locator('#settings-credit-balance')).toHaveText('12 credits');
    setup.state.reply = route => route.fulfill({ json: Object.keys(invalid).length ? { ...profile(), ...invalid } : {} });
    expect(await page.evaluate(() => window.LectureProcessorShell.refreshCredits())).toBe(false);
    await expect(page.locator('#settings-credit-balance')).toHaveText('12 credits');
    await expect(page.locator('#settings-credit-retry')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp_ui_v2:user:a:credit_snapshot')).snapshot.balance)).toBe(12);
    expect(setup.browserErrors).toEqual([]);
  });
}

test('ordinary refreshes coalesce and a forced refresh supersedes the older result', async ({ page }) => {
  const setup = await fixture(page);
  await page.goto('/settings');
  await expect(page.locator('#settings-credit-balance')).toHaveText('12 credits');
  const began = deferred();
  const release = deferred();
  let calls = 0;
  setup.state.reply = async route => {
    calls += 1;
    if (calls === 1) { began.resolve(); await release.promise; return route.fulfill({ json: profile('a', { credits: 99 }) }); }
    return route.fulfill({ json: profile('a', { credits: 22 }) });
  };
  expect(await page.evaluate(() => {
    const one = window.LectureProcessorShell.refreshCreditSnapshot();
    const two = window.LectureProcessorShell.refreshCreditSnapshot();
    window.oldCredits = one.then(() => true, () => false);
    return one === two;
  })).toBe(true);
  await began.promise;
  expect(await page.evaluate(() => window.LectureProcessorShell.refreshCredits())).toBe(true);
  release.resolve();
  expect(await page.evaluate(() => window.oldCredits)).toBe(false);
  await expect(page.locator('#settings-credit-balance')).toHaveText('22 credits');
  expect(calls).toBe(2);
  expect(setup.browserErrors).toEqual([]);
});

for (const heldStage of ['token', 'response', 'json']) {
  test(`account switch while ${heldStage} is held cannot publish the old balance`, async ({ page }) => {
    const setup = await fixture(page);
    await page.goto('/document-reader');
    await expect(page.locator('#shell-credits-total')).toHaveText('12 credits');
    const began = deferred();
    const release = deferred();
    if (heldStage === 'response') {
      setup.state.reply = async (route, uid) => {
        if (uid === 'a') { began.resolve(); await release.promise; }
        return route.fulfill({ json: profile(uid, uid === 'a' ? { credits: 99 } : {}) });
      };
    } else {
      await page.evaluate(stage => {
        window.creditGate = {};
        window.creditGate.promise = new Promise(resolve => { window.creditGate.release = resolve; });
        if (stage === 'token') {
          window.testAccount.currentUser.getIdToken = async () => { window.creditGate.began = true; await window.creditGate.promise; return 'token-a'; };
        } else {
          const nativeFetch = window.fetch;
          window.fetch = async (...args) => {
            const response = await nativeFetch(...args);
            if (String(args[0]).includes('/api/auth/user') && args[1].headers.Authorization === 'Bearer token-a') {
              const read = response.json.bind(response);
              response.json = async () => { const body = await read(); window.creditGate.began = true; await window.creditGate.promise; return { ...body, credits: 99 }; };
            }
            return response;
          };
        }
      }, heldStage);
    }
    await page.evaluate(() => { window.oldCredits = window.LectureProcessorShell.refreshCredits(); });
    if (heldStage === 'response') await began.promise;
    else await expect.poll(() => page.evaluate(() => !!window.creditGate.began)).toBe(true);
    await page.evaluate(() => window.testAccount.switchTo('b'));
    await expect(page.locator('#shell-credits-total')).toHaveText('27 credits');
    if (heldStage === 'response') release.resolve();
    else await page.evaluate(() => window.creditGate.release());
    expect(await page.evaluate(() => window.oldCredits)).toBe(false);
    await expect(page.locator('#reader-credit-note')).toContainText('Balance: 27 credits');
    expect(await page.evaluate(() => localStorage.getItem('lp_ui_v2:user:a:credit_snapshot'))).toBeNull();
    expect(setup.browserErrors).toEqual([]);
  });
}

test('credit balance does not depend on settings preferences and HTTP authorization failures keep their status', async ({ page }) => {
  const setup = await fixture(page);
  await page.route('**/api/user-preferences', route => route.fulfill({ status: 503, json: { error: 'Synthetic preference outage' } }));
  await page.goto('/settings');
  await expect(page.locator('#settings-credit-balance')).toHaveText('12 credits');
  await expect(page.locator('#settings-dark-mode')).toBeDisabled();
  setup.state.reply = route => route.fulfill({ status: 403, json: { error: 'Synthetic rejection' } });
  expect(await page.evaluate(() => window.LectureProcessorShell.refreshCreditSnapshot({ force: true }).then(() => null, error => error.status))).toBe(403);
  await expect(page.locator('#settings-credit-balance')).toHaveText('12 credits');
});

test('storage refusal does not discard a valid in-memory balance', async ({ page }) => {
  await page.addInitScript(() => {
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).includes('credit_snapshot')) throw new DOMException('Synthetic full storage', 'QuotaExceededError');
      return save.call(this, key, value);
    };
  });
  const setup = await fixture(page);
  await page.goto('/settings');
  await expect(page.locator('#settings-credit-balance')).toHaveText('12 credits');
  expect(await page.evaluate(() => window.LectureProcessorShell.refreshCredits())).toBe(true);
  expect(await page.evaluate(() => window.LectureProcessorShell.getCreditState())).toMatchObject({ status: 'ready', source: 'server', snapshot: { balance: 12 } });
  expect(setup.browserErrors).toEqual([]);
});

test('explicit logout invalidates profile writers before Firebase sign-out resolves', async ({ page }) => {
  const setup = await fixture(page);
  await page.goto('/settings');
  await expect(page.locator('#settings-credit-balance')).toHaveText('12 credits');
  const profileStarted = deferred();
  const profileRelease = deferred();
  const logoutStarted = deferred();
  const logoutRelease = deferred();
  const signedOut = deferred();
  await page.exposeFunction('creditTestSignedOut', user => signedOut.resolve(user));
  await page.evaluate(() => window.testAccount.onAuthStateChanged(user => {
    if (user === null) window.creditTestSignedOut(user);
  }));
  setup.state.reply = async route => { profileStarted.resolve(); await profileRelease.promise; return route.fulfill({ json: profile('a', { credits: 99 }) }); };
  await page.route('**/api/session/logout', async route => { logoutStarted.resolve(); await logoutRelease.promise; return route.fulfill({ json: { ok: true } }); });
  await page.evaluate(() => { window.oldCredits = window.LectureProcessorShell.refreshCredits(); });
  await profileStarted.promise;
  await page.locator('#shell-account-btn').click();
  await page.locator('#signout-btn').click();
  await logoutStarted.promise;
  expect(await page.evaluate(() => window.testAccount.currentUser.uid)).toBe('a');
  profileRelease.resolve();
  expect(await page.evaluate(() => window.oldCredits)).toBe(false);
  const reads = setup.state.reads.length;
  expect(await page.evaluate(() => window.LectureProcessorShell.refreshCredits())).toBe(false);
  expect(setup.state.reads).toHaveLength(reads);
  expect(await page.evaluate(() => localStorage.getItem('lp_ui_v2:user:a:credit_snapshot'))).toBeNull();
  await expect(page.locator('#settings-credit-balance')).toHaveText('Sign in to see your balance.');
  logoutRelease.resolve();
  expect(await signedOut.promise).toBeNull();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('zero remains a valid finite balance and missing prices cannot start an unquoted run', async ({ page }) => {
  const setup = await fixture(page, { profile: { credits: 0, credit_costs: undefined } });
  await page.goto('/document-reader');
  await expect(page.locator('#shell-credits-total')).toHaveText('0 credits');
  await expect(page.locator('#reader-credit-note')).toHaveText('Cost unavailable. Your balance is 0 credits.');
  let posts = 0;
  await page.route('**/api/tools/extract', route => { posts += 1; return route.fulfill({ json: {} }); });
  await chooseInput(page, false);
  await page.locator('#reader-run-btn').click();
  await expect(page.locator('#reader-status')).toHaveText('Could not check the cost. Please try again.');
  await expect(page.locator('#reader-run-btn')).toBeEnabled();
  expect(posts).toBe(0);
  expect(setup.browserErrors).toEqual([]);
});

test('a live language change rerenders amounts without changing authored inputs', async ({ page }) => {
  const setup = await fixture(page);
  await page.goto('/document-reader');
  await expect(page.locator('#reader-credit-note')).toHaveText('Cost: 2 credits · Balance: 12 credits');
  await chooseInput(page, false);
  await page.locator('#reader-advanced-toggle').click();
  await page.locator('#reader-question-input').fill('Keep this authored question in English.');
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await expect(page.locator('#reader-credit-note')).toHaveText(/Kosten: 2 credits.*12 credits/);
  await expect(page.locator('#reader-question-input')).toHaveValue('Keep this authored question in English.');
  await expect(page.locator('#reader-selected-files')).toContainText('Original document.pdf');
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(page.locator('#reader-credit-note')).toHaveText('Cost: 2 credits · Balance: 12 credits');
  expect(setup.browserErrors).toEqual([]);
});

for (const language of ['en', 'nl']) for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
  test(`credit consumers render ${language} ${theme} at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const setup = await fixture(page, { language, theme, profile: { unlimited_credits: { lecture: false, slides: true, interview: false } } });
    for (const [route, prefix] of [['/settings', 'settings'], ['/document-reader', 'reader'], ['/general-transcriber', 'transcriber']]) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.locator('#shell-credits-total')).toContainText('12 credits');
      if (prefix === 'settings') await expect(page.locator('#settings-credit-balance')).toHaveText('12 credits');
      else await chooseInput(page, prefix === 'transcriber');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${prefix}-credits-${language}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    expect(setup.browserErrors).toEqual([]);
  });
}
