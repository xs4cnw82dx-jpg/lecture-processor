const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

async function install(page, balance = 0, options = {}) {
  const fixture = await installAccountFixture(page);
  const state = { balance, posts: 0, accepted: false, profileError: false, unlimited: {}, legacy: false, online: true, ...options };
  await page.addInitScript(online => {
    window.voiceOnline = online;
    Object.defineProperty(navigator, 'onLine', { get: () => window.voiceOnline });
  }, state.online);
  await page.route(/\/static\/js\/voice-notes(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', path: path.join(process.env.CREATION_CREDIT_SOURCE_DIR || 'static/js', process.env.CREATION_CREDIT_USE_MINIFIED ? 'voice-notes.min.js' : 'voice-notes.js') }));
  await page.route('**/api/auth/user', route => route.fulfill(state.profileError ? { status: 503, json: { error: 'Synthetic profile unavailable' } } : { json: {
    uid: route.request().headers().authorization === 'Bearer token-b' ? 'b' : 'a',
    ...(state.legacy ? { credits: { lecture_standard: 0, lecture_extended: 0, slides: 0, interview_short: 1, interview_medium: 0, interview_long: 0 } }
      : { credits_version: 2, credits: state.balance, credit_costs: state.missingCosts ? null : { voice_note: { category: 'interview', instant: 10, overnight: null } } }),
    unlimited_credits: state.unlimited, preferences: { onboarding_completed: true },
  } }));
  await page.route('**/api/config', route => route.fulfill({ json: state.legacy ? { bundles: {} } : {
    credit_scheme: 2, action_costs: { voice_note: { category: 'interview', instant: 10, overnight: null } }, free_signup_credits: 12, bundles: {},
  } }));
  await page.route('**/api/voice-notes', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { voice_notes: [] } });
    state.posts++;
    if (state.wait) await state.wait;
    if (!state.accepted) return route.fulfill({ status: 402, json: { error: 'Not enough credits.', error_code: 'insufficient_credits', needed: 10, available: state.serverAvailable ?? state.balance } });
    if (!state.unlimited.interview && !state.legacy) state.balance -= 10;
    return route.fulfill({ json: { job_id: 'voice-' + state.posts } });
  });
  await page.route('**/api/voice-notes/jobs/*', route => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({ json: { status: 'complete', study_pack_id: id, title: 'Synthetic voice', transcript: 'Saved transcript' } });
  });
  await page.route('**/api/study-packs/voice-*', route => route.fulfill({ json: { title: 'Synthetic voice', source_transcript: 'Saved transcript' } }));
  return { ...fixture, state };
}

async function savedAudio(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('lecture-processor-voice-notes', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction('audio', 'readonly').objectStore('audio').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return Promise.all(rows.map(async row => ({ owner: row.owner_key, text: await row.blob.text() })));
  });
}

test('zero balance keeps imported audio locally and does not start paid transcription', async ({ page }) => {
  const fixture = await install(page);
  await page.goto('/voice-notes');
  await page.locator('#voice-file-input').setInputFiles({ name: 'keep.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('keep this audio') });
  await expect.poll(() => savedAudio(page)).toEqual([{ owner: 'user:a', text: 'keep this audio' }]);
  await expect.soft(page.locator('#voice-record-status')).toContainText('credits');
  expect(fixture.state.posts).toBe(0);
  await expect(page.locator('#voice-credit-cost')).toContainText('10 credits');
});

async function importAudio(page, name = 'keep.mp3') {
  await page.locator('#voice-file-input').setInputFiles({ name, mimeType: 'audio/mpeg', buffer: Buffer.from(name) });
}

async function openSync(page) {
  await page.locator('[data-voice-view="settings"]').click();
}

async function noteStatuses(page) {
  return page.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('lecture-processor-voice-notes', 2); request.onsuccess = () => resolve(request.result); });
    const notes = await new Promise(resolve => { const request = db.transaction('notes').objectStore('notes').getAll(); request.onsuccess = () => resolve(request.result); });
    db.close();
    return notes.map(note => note.status).sort();
  });
}

test('offline queued notes retain all audio and sync only the affordable prefix', async ({ page }) => {
  const fixture = await install(page, 20, { online: false, accepted: true });
  await page.goto('/voice-notes');
  for (const name of ['one.mp3', 'two.mp3', 'three.mp3']) await importAudio(page, name);
  await expect.poll(async () => (await savedAudio(page)).length).toBe(3);
  await openSync(page);
  await expect(page.locator('#voice-pending-credit-cost')).toHaveText('3 pending transcriptions · 30 credits');
  expect(fixture.state.posts).toBe(0);
  await page.reload();
  await expect.poll(async () => (await savedAudio(page)).length).toBe(3);
  await page.evaluate(() => { window.voiceOnline = true; window.dispatchEvent(new Event('online')); });
  await expect.poll(() => fixture.state.posts).toBe(2);
  await expect.poll(() => noteStatuses(page)).toEqual(['pending', 'synced', 'synced']);
  await expect.poll(async () => (await savedAudio(page)).length).toBe(3);
  expect(fixture.state.balance).toBe(0);
  expect(fixture.browserErrors).toEqual([]);
});

for (const failure of ['profileError', 'missingCosts']) {
  test(`unknown voice ${failure} pauses paid sync without losing audio`, async ({ page }) => {
    const fixture = await install(page, 10, { [failure]: true, accepted: true });
    await page.goto('/voice-notes');
    await importAudio(page);
    await expect.poll(async () => (await savedAudio(page)).length).toBe(1);
    await expect(page.locator('#voice-record-status')).toContainText(failure === 'profileError' ? 'Could not load your account' : 'unavailable');
    expect(fixture.state.posts).toBe(0);
    fixture.state[failure] = false;
    await openSync(page);
    await page.locator('#voice-sync-all-btn').click();
    await expect.poll(() => fixture.state.posts).toBe(1);
    await expect.poll(() => noteStatuses(page)).toEqual(['synced']);
  });
}

test('automatic and manual sync share the per-note in-flight guard', async ({ page }) => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const fixture = await install(page, 10, { accepted: true, wait });
  await page.goto('/voice-notes');
  await importAudio(page);
  await expect.poll(() => fixture.state.posts).toBe(1);
  await openSync(page);
  await page.locator('#voice-sync-all-btn').click();
  expect(fixture.state.posts).toBe(1);
  release();
  await expect.poll(() => noteStatuses(page)).toEqual(['synced']);
  expect(fixture.state.posts).toBe(1);
});

test('interview exemption permits transcription at zero balance', async ({ page }) => {
  const fixture = await install(page, 0, { accepted: true, unlimited: { interview: true } });
  await page.goto('/voice-notes');
  await expect(page.locator('#voice-credit-cost')).toContainText('0 credits per note');
  await importAudio(page);
  await expect.poll(() => noteStatuses(page)).toEqual(['synced']);
  expect(fixture.state.posts).toBe(1);
  expect(fixture.state.balance).toBe(0);
});

test('server balance rejection preserves the blob and reports actual needed and available', async ({ page }) => {
  const fixture = await install(page, 10, { serverAvailable: 0 });
  await page.goto('/voice-notes');
  await importAudio(page);
  await expect(page.locator('#voice-record-status')).toContainText('10 credits; 0 are available');
  await expect.poll(() => noteStatuses(page)).toEqual(['pending']);
  expect(fixture.state.posts).toBe(1);
  expect((await savedAudio(page))[0].text).toBe('keep.mp3');
});

test('legacy off preserves automatic transcription and old-category copy', async ({ page }) => {
  const fixture = await install(page, 0, { legacy: true, accepted: true });
  await page.goto('/voice-notes');
  await expect(page.locator('#voice-credit-cost')).toContainText('1 interview credit per note');
  await importAudio(page);
  await expect.poll(() => noteStatuses(page)).toEqual(['synced']);
  expect(fixture.state.posts).toBe(1);
});

test('switching accounts during a credit refresh never uploads the previous owner audio', async ({ page }) => {
  const fixture = await install(page, 10);
  await page.goto('/voice-notes');
  await expect(page.locator('#voice-credit-cost')).toContainText('10 credits');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let started = false;
  await page.route('**/api/auth/user', async route => {
    const old = route.request().headers().authorization === 'Bearer token-a';
    if (old) { started = true; await held; }
    return route.fulfill({ json: { uid: old ? 'a' : 'b', credits_version: 2, credits: 10, credit_costs: { voice_note: { category: 'interview', instant: 10, overnight: null } } } });
  });
  await importAudio(page);
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  release();
  await expect(page.locator('#shell-credits-total')).toHaveText('10 credits');
  await expect.poll(() => noteStatuses(page)).toEqual(['pending']);
  expect(fixture.state.posts).toBe(0);
  expect((await savedAudio(page))[0].owner).toBe('user:a');
});

for (const language of ['en', 'nl']) {
  for (const theme of ['light', 'dark']) {
    test(`voice cost before recording is readable in ${language} ${theme}`, async ({ page }, testInfo) => {
      await install(page, 10);
      await page.goto('/voice-notes');
      await expect(page.locator('#voice-credit-cost')).toContainText('10 credits');
      await page.evaluate(({ language, theme }) => { window.LectureI18n.setLanguage(language); window.LPTheme.apply({ theme }); }, { language, theme });
      await expect(page.locator('#voice-credit-cost')).toContainText(language === 'nl' ? 'Transcriptie' : 'Transcription');
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`voice-${language}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      }
    });
  }
}
