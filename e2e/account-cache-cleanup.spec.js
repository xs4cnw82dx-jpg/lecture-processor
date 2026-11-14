const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'parallel' });

function pack(id) {
  return { study_pack_id: id, title: `Pack ${id}`, mode: 'manual', folder_id: '',
    notes_markdown: '# Synthetic notes\n\nA synthetic paragraph for highlight preservation.',
    flashcards_count: 1, test_questions_count: 0, flashcards: [{ front: 'Prompt', back: 'Answer' }], test_questions: [] };
}

async function fixture(page) {
  const account = await installAccountFixture(page);
  const state = { requests: [], patches: [], openStatus: 200, checkpointStatus: 200, patchStatus: 200, patchReply: null,
    session: { id: 'session_focus', title: 'Planned session', pack_id: 'a', duration: 45, status: 'planned', revision: 1 },
    run: { activity_id: 'run_focus', uid: 'a', pack_id: 'a', plan_item_id: 'session_focus', study_mode: 'flashcards',
      mode_generation: 0, generation: 0, source: 'tracked', content_fingerprint: 'synthetic_v1',
      queue: [{ id: 'fc_0', type: 'fc', index: 0 }], answers: {}, pending_reviews: [], retry_done: [],
      active_seconds: 0, slot_seconds: 0, notes_seconds: 0, duration_seconds: 2700,
      timer_mode: 'countdown', run_status: 'paused', checkpoint_revision: 0 },
    packs: { a: pack('a'), b: pack('b') }, errors: account.browserErrors };
  await page.addInitScript(() => localStorage.setItem('lp-preferences', JSON.stringify({ language: 'en', theme: 'light' })));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const uid = request.headers().authorization === 'Bearer token-b' ? 'b' : 'a';
    const entry = { path, uid, method: request.method(), data: request.postDataJSON() };
    state.requests.push(entry);
    if (path === '/api/auth/user') return route.fallback();
    let payload = {};
    if (path === '/api/user-preferences') payload = { preferences: { interface_language: 'en', theme: 'light' } };
    else if (path === '/api/study-packs') payload = { study_packs: [state.packs[uid]], has_more: false };
    else if (path === '/api/study-folders') payload = { folders: [] };
    else if (path === '/api/study-plan/membership') payload = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (path === '/api/study-plan/items/session_focus/run') {
      if (state.openStatus !== 200) return route.fulfill({ status: state.openStatus, json: { error: 'Study session unavailable.' } });
      payload = { session: state.session, run: state.run };
    } else if (path === '/api/study-plan/runs/run_focus') {
      if (state.checkpointStatus !== 200) return route.fulfill({ status: state.checkpointStatus, json: { error: 'Study session unavailable.' } });
      state.run = { ...state.run, ...entry.data };
      payload = { run: state.run };
    } else if (/^\/api\/study-packs\/[^/]+$/.test(path)) {
      const id = path.split('/').pop();
      if (id !== uid) return route.fulfill({ status: 404, json: { error: 'Pack unavailable.' } });
      if (entry.method === 'PATCH') {
        state.patches.push(entry);
        if (state.patchReply) return state.patchReply(route, entry, state.patches.length);
        if (state.patchStatus !== 200) return route.fulfill({ status: state.patchStatus, json: { error: 'Pack cannot be updated.' } });
        Object.assign(state.packs[id], structuredClone(entry.data));
        payload = { ok: true, study_pack_id: id };
      } else payload = state.packs[id];
    } else if (path.includes('study-progress')) payload = { card_states: {}, daily_progress: {} };
    await route.fulfill({ json: payload });
  });
  return state;
}

const ownLegacy = 'learning_session_a_pack_practice';
const retainedLegacy = {
  learning_session_b_pack_practice: JSON.stringify({ private_answer: 'Other owner' }),
  learning_session_: '{unparseable key',
  learning_session_$invalid_pack: '{unparseable owner',
  planned_run_a_run_focus: JSON.stringify({ pending_reviews: [{ answer: 'Keep unsynced progress' }] }),
  hl_ranges_pack: '{unscoped highlight',
  hl_html_pack: '<mark>Unscoped highlight</mark>',
};

for (const action of ['sign out', 'delete account']) {
  test(`explicit ${action} removes only own safe-UID legacy learning keys on a non-Study page`, async ({ page }) => {
    const state = await fixture(page);
    await page.goto('/dashboard');
    await expect(page.locator('#signout-btn')).toBeEnabled();
    await page.evaluate(({ own, retained }) => {
      localStorage.setItem(own, '{resume payload need not parse');
      for (const [key, value] of Object.entries(retained)) localStorage.setItem(key, value);
    }, { own: ownLegacy, retained: retainedLegacy });
    const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
    if (action === 'sign out') await page.locator('#signout-btn').evaluate(button => button.click());
    else {
      await page.locator('#shell-delete-account-btn').evaluate(button => button.click());
      await page.locator('#shell-delete-account-text').fill('DELETE MY ACCOUNT');
      await page.locator('#shell-delete-account-email').fill('a@example.test');
      await page.locator('#shell-delete-account-confirm').click();
    }
    await expect.poll(() => state.requests.some(entry => entry.path === '/api/session/logout')).toBe(true);
    await navigation;
    await page.waitForLoadState('domcontentloaded');
    expect(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), Object.keys(retainedLegacy))).toEqual(retainedLegacy);
    expect(await page.evaluate(key => localStorage.getItem(key), ownLegacy)).toBeNull();
    expect(state.errors).toEqual([]);
  });
}

test('external identity changes preserve legacy resume keys', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard');
  await page.evaluate(key => localStorage.setItem(key, 'keep until explicit cleanup'), ownLegacy);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#user-email')).toContainText('b@example.test');
  expect(await page.evaluate(key => localStorage.getItem(key), ownLegacy)).toBe('keep until explicit cleanup');
});

test('explicit sign out does not prefix-delete legacy keys for an ambiguous UID', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard');
  await page.evaluate(() => window.testAccount.switchTo('unsafe_uid'));
  await expect(page.locator('#user-email')).toContainText('unsafe_uid@example.test');
  const key = 'learning_session_unsafe_uid_pack_practice';
  await page.evaluate(key => localStorage.setItem(key, 'preserve ambiguous owner'), key);
  const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
  await page.locator('#signout-btn').evaluate(button => button.click());
  await navigation;
  await page.waitForLoadState('domcontentloaded');
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('preserve ambiguous owner');
});

