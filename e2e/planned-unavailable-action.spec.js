const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'parallel' });

const plannedUrl = '/study?pack_id=a&mode=learn&plan_item_id=session_focus';
const runPath = '/api/study-plan/items/session_focus/run';
const unavailableCopy = {
  en: 'This planned session is no longer available. Open Study Plan to choose another session.',
  nl: 'Deze geplande sessie is niet meer beschikbaar. Open je studieplanning om een andere sessie te kiezen.',
};

function pack(id) {
  return { study_pack_id: id, title: `Pack ${id}`, mode: 'manual', folder_id: '',
    notes_markdown: '# Synthetic notes\n\nA synthetic paragraph.',
    flashcards_count: 1, test_questions_count: 0,
    flashcards: [{ front: `Prompt ${id}`, back: `Answer ${id}` }], test_questions: [] };
}

async function fixture(page, preferences = { language: 'en', theme: 'light' }) {
  const account = await installAccountFixture(page);
  const state = { requests: [], studyAssets: [], errors: account.browserErrors, openStatus: 404,
    session: { id: 'session_focus', title: 'Planned session', pack_id: 'a', duration: 45, status: 'planned', revision: 1 },
    run: { activity_id: 'run_focus', uid: 'a', pack_id: 'a', plan_item_id: 'session_focus', study_mode: 'flashcards',
      mode_generation: 0, generation: 0, source: 'tracked', content_fingerprint: 'synthetic_v1',
      queue: [{ id: 'fc_0', type: 'fc', index: 0 }], answers: {}, pending_reviews: [], retry_done: [],
      active_seconds: 0, slot_seconds: 0, notes_seconds: 0, duration_seconds: 2700,
      timer_mode: 'countdown', run_status: 'paused', checkpoint_revision: 0 },
    packs: { a: pack('a'), b: pack('b') } };
  // Observe the runner's real asset choice; do not substitute Study source for a bundle.
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (/\/static\/js\/study(?:\.min)?\.js$/.test(path)) state.studyAssets.push(path);
  });
  await page.addInitScript(value => localStorage.setItem('lp-preferences', JSON.stringify(value)), preferences);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const entry = { path, method: request.method(), data: request.postDataJSON() };
    state.requests.push(entry);
    if (path === '/api/auth/user') return route.fallback();
    let payload = {};
    if (path === '/api/user-preferences') payload = { preferences: { interface_language: preferences.language, theme: preferences.theme } };
    else if (path === '/api/study-packs') payload = { study_packs: Object.values(state.packs), has_more: false };
    else if (path === '/api/study-folders') payload = { folders: [] };
    else if (path === '/api/study-plan/membership') payload = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (path === runPath) {
      if (state.openStatus !== 200) return route.fulfill({ status: state.openStatus, json: { error: 'Study session unavailable.' } });
      payload = { session: state.session, run: state.run };
    } else if (path === '/api/study-plan/runs/run_focus') {
      state.run = { ...state.run, ...entry.data };
      payload = { run: state.run };
    } else if (/^\/api\/study-packs\/[^/]+$/.test(path)) {
      payload = state.packs[path.split('/').pop()];
      if (!payload) return route.fulfill({ status: 404, json: { error: 'Pack unavailable.' } });
    } else if (path.includes('study-progress')) payload = { card_states: {}, daily_progress: {} };
    await route.fulfill({ json: payload });
  });
  return state;
}

function starts(state) {
  return state.requests.filter(entry => entry.path === runPath && entry.method === 'POST');
}

async function chooseModes(page, modes = ['flashcards']) {
  await expect(page.locator('#setup-overlay')).toBeVisible();
  for (const card of await page.locator('.lesson-card[data-lesson]').all()) {
    if (!(await card.isVisible()) || (await card.getAttribute('class')).includes('unavailable')) continue;
    const selected = await card.getAttribute('aria-pressed') === 'true';
    if (selected !== modes.includes(await card.getAttribute('data-lesson'))) await card.click();
  }
}

async function openSetup(page, state) {
  await page.goto(plannedUrl);
  await chooseModes(page);
  const filename = process.env.USE_MINIFIED_JS_ASSETS === '1' ? 'study.min.js' : 'study.js';
  expect(state.studyAssets).toEqual([`/static/js/${filename}`]);
}

async function firstUnavailable(page, state) {
  await openSetup(page, state);
  await page.locator('#setup-start-btn').click();
  await expect.poll(() => starts(state).length).toBe(1);
  await expect(page.locator('#setup-session-context')).toContainText(/unavailable|no longer available|niet (meer )?beschikbaar/i);
  await expect(page.locator('#setup-overlay')).toBeVisible();
  await expect(page.locator('#learn-stage')).not.toHaveClass(/visible/);
}

async function seedBackups(page) {
  return page.evaluate(() => {
    const cache = window.LectureProcessorStudyCache, token = cache.capture('a');
    for (const id of ['focus', 'other']) cache.set(token, 'conflict', `run_${id}`, {
      activity_id: `run_${id}`, plan_item_id: `session_${id}`, pack_id: 'a', checkpoint_revision: 3,
      pending_reviews: [{ key: 'first', answer: `Keep ${id}` }],
    }, { packId: 'a', pending: true });
    const other = 'lp_ui_v2:user:a:study_cache:conflict:run_other';
    const legacy = 'planned_run_a_run_focus_conflict';
    localStorage.setItem(legacy, '{unparseable legacy conflict');
    return { other: localStorage.getItem(other), legacy: localStorage.getItem(legacy) };
  });
}

async function backups(page) {
  return page.evaluate(() => ({
    focus: localStorage.getItem('lp_ui_v2:user:a:study_cache:conflict:run_focus'),
    other: localStorage.getItem('lp_ui_v2:user:a:study_cache:conflict:run_other'),
    legacy: localStorage.getItem('planned_run_a_run_focus_conflict'),
  }));
}

for (const language of ['en', 'nl']) for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
  test(`known unavailable setup has a usable recovery action in ${language} at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    const state = await fixture(page, { language, theme });
    await firstUnavailable(page, state);
    await expect(page.locator('.toast')).not.toHaveClass(/visible/);
    await page.screenshot({ path: testInfo.outputPath(`${language}-${width}-${theme}.png`), animations: 'disabled' });
    await expect(page.locator('#setup-session-context')).toHaveText(unavailableCopy[language]);
    await expect(page.locator('#setup-start-btn')).toBeDisabled();
    const recovery = page.locator('#setup-overlay').getByRole('link', {
      name: language === 'nl' ? 'Studieplanning openen' : 'Open Study Plan', exact: true,
    });
    await expect(recovery).toBeVisible();
    await expect(recovery).toHaveAttribute('href', '/plan');
    // Check the changed dialog, allowing the unrelated existing library overflow.
    for (const element of [page.locator('#setup-session-context'), page.locator('#setup-start-btn'), recovery]) {
      const bounds = await element.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
    expect(state.errors).toEqual([]);
  });
}

test('a repeated Start activation cannot repost a known missing session', async ({ page }) => {
  const state = await fixture(page);
  await firstUnavailable(page, state);
  await page.locator('#setup-start-btn').evaluate(button => button.click());
  await page.waitForTimeout(350);
  expect(starts(state)).toHaveLength(1);
  await expect(page.locator('#setup-start-btn')).toBeDisabled();
  expect(state.errors).toEqual([]);
});

test('a direct mode handler cannot bypass the known missing-session guard', async ({ page }) => {
  const state = await fixture(page);
  await firstUnavailable(page, state);
  await page.evaluate(() => window.startSelectedStudyMode('flashcards'));
  expect(starts(state)).toHaveLength(1);
  await expect(page.locator('#setup-overlay')).toBeVisible();
  await expect(page.locator('#learn-stage')).not.toHaveClass(/visible/);
  expect(state.errors).toEqual([]);
});

test('an already open mode picker cannot repost a known missing session', async ({ page }) => {
  const state = await fixture(page);
  await openSetup(page, state);
  await chooseModes(page, ['flashcards', 'notes']);
  await page.locator('#setup-start-btn').click();
  const mode = page.locator('.mode-picker-card[data-study-mode="flashcards"]');
  await mode.click();
  await expect(page.locator('#setup-session-context')).toContainText(/unavailable|no longer available/i);
  await mode.evaluate(button => button.click());
  await page.waitForTimeout(350);
  expect(starts(state)).toHaveLength(1);
  await expect(page.locator('#setup-session-context')).toBeVisible();
  await expect(page.locator('#setup-session-context')).toHaveText(unavailableCopy.en);
  const recovery = page.locator('#setup-overlay').getByRole('link', { name: 'Open Study Plan', exact: true });
  await expect(recovery).toBeVisible();
  await expect(recovery).toBeFocused();
  expect(state.errors).toEqual([]);
});

test('closing and reopening setup retains the known unavailable Start guard', async ({ page }) => {
  const state = await fixture(page);
  await firstUnavailable(page, state);
  await page.locator('#setup-close-btn').click();
  await page.locator('#open-learn-btn').click();
  await expect(page.locator('#setup-overlay')).toBeVisible();
  await page.locator('#setup-start-btn').evaluate(button => button.click());
  await page.waitForTimeout(350);
  expect(starts(state)).toHaveLength(1);
  await expect(page.locator('#setup-start-btn')).toBeDisabled();
  await expect(page.locator('#setup-session-context')).toHaveText(unavailableCopy.en);
  expect(state.errors).toEqual([]);
});

test('a temporary open failure retains its backup and allows a successful retry', async ({ page }) => {
  const state = await fixture(page); state.openStatus = 503;
  await openSetup(page, state);
  const before = await seedBackups(page);
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#setup-session-context')).toContainText(/unavailable|no longer available/i);
  await expect(page.locator('#setup-start-btn')).toBeEnabled();
  const retained = await backups(page);
  expect(retained.focus).not.toBeNull();
  expect(retained.other).toBe(before.other); expect(retained.legacy).toBe(before.legacy);
  await expect(page.locator('#setup-overlay a[href="/plan"]')).toBeHidden();
  state.openStatus = 200;
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
  await expect(page.locator('[data-pause]')).toHaveText('Pause');
  // A successful open uses one lookup followed by the selected-mode request.
  expect(starts(state).map(entry => entry.data)).toEqual([
    {}, {}, { study_mode: 'flashcards', timer_mode: 'countdown' },
  ]);
  expect(state.errors).toEqual([]);
});

test('known 404 does not automatically retry or discard unrelated recovery records', async ({ page }) => {
  const state = await fixture(page);
  await openSetup(page, state);
  const before = await seedBackups(page);
  await page.locator('#setup-start-btn').click();
  await expect.poll(async () => (await backups(page)).focus).toBeNull();
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pagehide')); });
  await page.waitForTimeout(1500);
  expect(starts(state)).toHaveLength(1);
  const after = await backups(page);
  expect(after.other).toBe(before.other); expect(after.legacy).toBe(before.legacy);
  expect(state.requests.filter(entry => entry.path.startsWith('/api/study-plan/') && entry.method !== 'GET' && entry.path !== runPath)).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('ordinary practice remains usable without a planned-session request', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/study?pack_id=a');
  await page.locator('#open-learn-btn').click();
  await chooseModes(page);
  await expect(page.locator('#setup-start-btn')).toBeEnabled();
  await expect(page.locator('#setup-overlay a[href="/plan"]')).toBeHidden();
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
  expect(starts(state)).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

for (const language of ['en', 'nl']) {
  test(`failed device cleanup keeps its warning and recovery action in ${language}`, async ({ page }) => {
    const state = await fixture(page, { language, theme: 'light' });
    await openSetup(page, state);
    const before = await seedBackups(page);
    await page.evaluate(() => {
      const remove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        if (key.includes(':study_cache:')) throw new DOMException('Synthetic storage failure', 'SecurityError');
        return remove.call(this, key);
      };
    });
    await page.locator('#setup-start-btn').click();
    const context = page.locator('#setup-session-context');
    await expect(context).toContainText(unavailableCopy[language]);
    await expect(context).toContainText(language === 'nl'
      ? 'De opslag op dit apparaat kon niet worden gewist.' : 'Device storage could not be cleared.');
    const otherLanguage = language === 'nl' ? 'en' : 'nl';
    await page.evaluate(value => window.LectureI18n.setLanguage(value), otherLanguage);
    await expect(context).toContainText(unavailableCopy[otherLanguage]);
    await expect(context).toContainText(otherLanguage === 'nl'
      ? 'De opslag op dit apparaat kon niet worden gewist.' : 'Device storage could not be cleared.');
    await expect(page.locator('#setup-start-btn')).toBeDisabled();
    await expect(page.locator('#setup-plan-link')).toBeVisible();
    await page.evaluate(() => window.startSelectedStudyMode('flashcards'));
    expect(starts(state)).toHaveLength(1);
    const retained = await backups(page);
    expect(retained.focus).not.toBeNull();
    expect(retained.other).toBe(before.other); expect(retained.legacy).toBe(before.legacy);
    expect(await page.evaluate(() => window.LectureProcessorStudyPersistence.hasPending())).toBe(true);
    expect(state.errors).toEqual([]);
  });
}

test('a known missing session does not disable ordinary practice in another pack', async ({ page }) => {
  const state = await fixture(page);
  await firstUnavailable(page, state);
  await page.locator('#setup-close-btn').click();
  await page.locator('#pack-list [data-pack-id="b"] [data-pack-open]').click();
  await page.locator('#open-learn-btn').click();
  await chooseModes(page);
  await expect(page.locator('#setup-pack-name')).toHaveText('Pack b');
  await expect(page.locator('#setup-start-btn')).toBeEnabled();
  await expect(page.locator('#setup-overlay a[href="/plan"]')).toBeHidden();
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
  expect(starts(state)).toHaveLength(1);
  expect(state.errors).toEqual([]);
});
