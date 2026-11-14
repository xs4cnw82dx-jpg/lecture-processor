const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { installAccountFixture } = require('./helpers/batch-fixture');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function pack(id, title = `Pack ${id.toUpperCase()}`) {
  return {
    study_pack_id: id, title, mode: 'manual', folder_id: '',
    notes_markdown: '# Synthetic notes\n\nStudy this synthetic example before reviewing the cards.',
    flashcards_count: 2, test_questions_count: 0,
    flashcards: [{ front: 'First prompt', back: 'First answer' }, { front: 'Second prompt', back: 'Second answer' }],
    test_questions: [],
  };
}

async function installStudy(page, options = {}) {
  const account = await installAccountFixture(page);
  const state = {
    packs: { a: { a: pack('a'), b: pack('b') }, b: { c: pack('c', 'Other account pack') } },
    requests: [], checkpoints: [], completions: [], offline: false,
    session: { id: 'session_focus', title: 'Synthetic planned session', pack_id: 'a', duration: 45, status: 'planned', revision: 1 },
    run: {
      activity_id: 'run_focus', uid: 'a', plan_item_id: 'session_focus', study_mode: 'flashcards',
      mode_generation: 0, generation: 0, source: 'tracked', content_fingerprint: 'synthetic_v1',
      queue: [{ id: 'fc_0', type: 'fc', index: 0 }, { id: 'fc_1', type: 'fc', index: 1 }],
      answers: {}, pending_reviews: [], retry_done: [], active_seconds: 0, slot_seconds: 0,
      notes_seconds: 0, duration_seconds: 2700, timer_mode: 'countdown', run_status: 'paused', checkpoint_revision: 0,
    },
    errors: account.browserErrors,
  };
  await page.addInitScript(() => {
    localStorage.setItem('lp-preferences', JSON.stringify({ language: 'en', theme: 'light' }));
  });
  // These optional executable snapshots prove failures before the change. Normal runs use deployed assets.
  for (const [name, variable] of [['study', 'STUDY_STORAGE_BASELINE_STUDY'], ['planned-study', 'STUDY_STORAGE_BASELINE_PLANNED'], ['app-shell', 'STUDY_STORAGE_BASELINE_SHELL']]) {
    if (!process.env[variable]) continue;
    const source = readFileSync(process.env[variable], 'utf8');
    await page.route(new RegExp(`/static/js/${name}(?:\\.min)?\\.js(?:\\?.*)?$`), route => route.fulfill({ contentType: 'application/javascript', body: source }));
  }
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const uid = (request.headers().authorization || '').replace('Bearer token-', '') || 'a';
    const entry = { path, uid, method: request.method(), data: request.postDataJSON() };
    state.requests.push(entry);
    if (options.route && await options.route(route, state, entry)) return;
    let payload = {};
    if (path === '/api/auth/user') payload = { uid, email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/user-preferences') payload = { preferences: { interface_language: 'en', theme: 'light' } };
    else if (path === '/api/study-folders') payload = { folders: [] };
    else if (path === '/api/study-plan/membership') payload = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (path.endsWith('/session_focus/run')) {
      if (entry.data.study_mode && entry.data.study_mode !== state.run.study_mode) {
        state.run.study_mode = entry.data.study_mode; state.run.mode_generation += 1;
      }
      payload = { session: state.session, run: state.run };
    } else if (path.endsWith('/runs/run_focus')) {
      state.checkpoints.push(entry);
      if (state.offline) return route.fulfill({ status: 503, json: { error: 'Synthetic network outage.' } });
      if (entry.data.mode_generation !== state.run.mode_generation) return route.fulfill({ status: 409, json: { error: 'A newer session mode is active.' } });
      state.run = { ...state.run, ...entry.data };
      payload = { run: state.run };
    } else if (path.endsWith('/session_focus/completion')) {
      state.completions.push(entry);
      state.session = { ...state.session, status: 'completed', revision: state.session.revision + 1 };
      payload = { session: state.session };
    } else if (path === '/api/study-packs') payload = { study_packs: Object.values(state.packs[uid] || {}), has_more: false };
    else if (/^\/api\/study-packs\/[^/]+$/.test(path)) {
      const id = path.split('/').pop();
      const current = state.packs[uid]?.[id];
      if (!current) return route.fulfill({ status: 404, json: { error: 'Pack unavailable.' } });
      if (entry.method === 'DELETE') { delete state.packs[uid][id]; payload = { ok: true }; }
      else if (entry.method === 'PATCH') { Object.assign(current, structuredClone(entry.data)); payload = { ok: true, study_pack_id: id }; }
      else payload = structuredClone(current);
    } else if (path.includes('study-progress')) payload = { card_states: {}, daily_progress: {} };
    await route.fulfill({ json: payload });
  });
  return state;
}

async function chooseMode(page, mode) {
  await expect(page.locator('#setup-overlay')).toBeVisible();
  for (const card of await page.locator('.lesson-card[data-lesson]').all()) {
    if ((await card.getAttribute('class')).includes('unavailable')) continue;
    if ((await card.getAttribute('aria-pressed') === 'true') !== (await card.getAttribute('data-lesson') === mode)) await card.click();
  }
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
}

async function openPlanned(page, mode = 'flashcards') {
  await page.goto('/study?pack_id=a&mode=learn&plan_item_id=session_focus');
  await chooseMode(page, mode);
  await expect(page.locator('[data-pause]')).toHaveText('Pause');
}

async function hidePage(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
}

async function studyRecords(page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key =>
    /^(?:planned_run_|learning_session_|hl_ranges_|hl_notes_)/.test(key) || key.includes(':study_cache:')
  ).map(key => ({ key, value: JSON.parse(localStorage.getItem(key)) })));
}

async function plannedRecords(page) {
  return (await studyRecords(page)).filter(record => record.key.startsWith('planned_run_') || record.value.kind === 'planned');
}

async function openPack(page, id = 'a') {
  await page.goto(`/study?pack_id=${id}`);
  await expect(page.locator('#notes-view p')).toContainText('Study this synthetic example');
}

async function highlight(page, color = 'yellow') {
  await page.locator(`[data-hl-color="${color}"]`).click();
  await page.locator('#notes-view p').evaluate(paragraph => {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveAttribute('data-hl', color);
}

async function settleResponses(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function seedPackRecords(page, id) {
  await page.evaluate(({ packId, legacy }) => {
    if (legacy) return; // Baselines retain the real highlight cache written through the UI.
    const records = [
      { kind: 'highlights', id: packId, legacy: `hl_ranges_${packId}`, payload: { base_key: 'synthetic', ranges: [], updated_at: 1 } },
      { kind: 'learning', id: JSON.stringify([packId, 'practice']), legacy: `learning_session_a_${packId}_practice`, payload: { version: 'synthetic', modes: {} } },
      { kind: 'planned', id: `run_${packId}`, legacy: `planned_run_a_run_${packId}`, payload: { activity_id: `run_${packId}`, plan_item_id: `session_${packId}`, pack_id: packId } },
      { kind: 'conflict', id: `run_${packId}`, legacy: `planned_run_a_run_${packId}_conflict`, payload: { activity_id: `run_${packId}`, pack_id: packId, pending_reviews: [{ key: 'first' }] } },
    ];
    for (const record of records) {
      if (window.LectureProcessorStudyCache) {
        const key = `lp_ui_v2:user:a:study_cache:${record.kind}:${encodeURIComponent(record.id)}`;
        localStorage.setItem(key, JSON.stringify({ schema: 1, uid: 'a', kind: record.kind, id: record.id, pack_id: packId, updated_at: Date.now(), pending: true, payload: record.payload }));
      } else localStorage.setItem(record.legacy, JSON.stringify(record.payload));
    }
  }, { packId: id, legacy: Boolean(process.env.STUDY_STORAGE_BASELINE_STUDY) });
}

function belongsToPack(record, id) {
  return record.value.pack_id === id || record.key === `hl_ranges_${id}` || record.key.startsWith(`learning_session_a_${id}_`) || record.key.startsWith(`planned_run_a_run_${id}`);
}

async function writeHighlightCache(page, payload, legacy = false) {
  await page.evaluate(({ value, rawLegacy }) => {
    const key = Object.keys(localStorage).find(candidate => candidate.startsWith('lp_ui_v2:user:a:study_cache:highlights:'));
    if (key && !rawLegacy) {
      const record = JSON.parse(localStorage.getItem(key));
      record.payload = value; record.pending = true; record.updated_at = Date.now();
      localStorage.setItem(key, JSON.stringify(record));
    } else {
      if (key) localStorage.removeItem(key);
      localStorage.setItem('hl_ranges_a', JSON.stringify(value));
    }
  }, { value: payload, rawLegacy: legacy });
}

test('a finished planned session stays removed after the page is hidden', async ({ page }) => {
  const state = await installStudy(page);
  state.packs.a.a.flashcards = state.packs.a.a.flashcards.slice(0, 1);
  state.packs.a.a.flashcards_count = 1;
  state.run.queue = state.run.queue.slice(0, 1);
  await openPlanned(page);
  await page.locator('#learn-f-flip').click();
  await page.locator('[data-review-action="good"]').click();
  await expect.poll(() => Object.keys(state.run.answers).length).toBe(1);
  await expect.poll(async () => (await plannedRecords(page)).length).toBe(1);
  await page.locator('[data-finish]').click();
  await expect(page.locator('[data-phase]')).toHaveText('Session complete');
  await expect.poll(async () => (await plannedRecords(page)).length).toBe(0);
  const checkpointCount = state.checkpoints.length;
  await hidePage(page);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await plannedRecords(page)).length).toBe(0);
  expect(state.checkpoints).toHaveLength(checkpointCount);
  expect(state.completions).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test('failed device storage and an offline checkpoint never claim progress was saved', async ({ page }) => {
  const state = await installStudy(page);
  await openPlanned(page);
  state.offline = true;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (/planned_run_|:study_cache:/.test(key)) throw new DOMException('Synthetic quota reached', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.locator('[data-pause]').click();
  await expect(page.locator('[data-save]')).toContainText(/Keep this tab open|could not be saved|not saved|unavailable/i);
  await expect(page.locator('[data-save]')).not.toContainText('Saved on this device');
  expect(state.errors).toEqual([]);
});

test('an external account switch preserves unsynced work, fences old writers, and restores it for its owner', async ({ page }) => {
  const checkpoint = deferred();
  let hold = false;
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (!hold || !entry.path.endsWith('/runs/run_focus')) return false;
    await checkpoint.promise;
    await route.fulfill({ json: { run: entry.data } });
    return true;
  } });
  await openPlanned(page);
  await expect.poll(async () => (await plannedRecords(page)).length).toBe(1);
  hold = true;
  const heldRequest = page.waitForRequest(request => request.url().endsWith('/runs/run_focus'));
  await page.locator('#learn-f-flip').click();
  await page.locator('[data-review-action="good"]').click();
  await heldRequest;
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#pack-list')).toContainText('Other account pack');
  const retained = await plannedRecords(page);
  expect(retained).toHaveLength(1);
  expect(retained[0].value.uid).toBe('a');
  expect(retained[0].value.pending).toBe(true);
  await expect(page.locator('#learn-stage')).not.toHaveClass(/visible/);
  const response = page.waitForResponse(result => result.url().endsWith('/runs/run_focus'));
  checkpoint.resolve();
  await response;
  await settleResponses(page);
  expect(await plannedRecords(page)).toEqual(retained);
  expect(await page.evaluate(() => window.LectureProcessorStudyCache.get('b', 'planned', 'run_focus'))).toBeNull();
  hold = false;
  await page.evaluate(() => window.testAccount.switchTo('a'));
  await expect(page.locator('#pack-list')).toContainText('Pack A');
  await page.locator('#pack-list [data-pack-id="a"] [data-pack-open]').click();
  await page.locator('#open-learn-btn').click();
  await chooseMode(page, 'flashcards');
  await expect(page.locator('[data-pause]')).toHaveText('Pause');
  await expect.poll(() => Object.keys(state.run.answers).length).toBe(1);
  await page.locator('[data-pause]').click();
  await expect(page.locator('[data-save]')).toHaveText('Progress saved');
  await expect.poll(async () => (await plannedRecords(page))[0]?.value.pending).toBe(false);
  expect(state.errors).toEqual([]);
});

test('sign out invalidates writers before the logout request completes', async ({ page }) => {
  const checkpoint = deferred(), logout = deferred();
  let hold = false;
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.path === '/api/session/logout') { await logout.promise; await route.fulfill({ json: { ok: true } }); return true; }
    if (!hold || !entry.path.endsWith('/runs/run_focus')) return false;
    await checkpoint.promise;
    await route.fulfill({ json: { run: entry.data } });
    return true;
  } });
  await openPlanned(page);
  hold = true;
  const heldRequest = page.waitForRequest(request => request.url().endsWith('/runs/run_focus'));
  await page.locator('[data-pause]').click();
  await heldRequest;
  const loggingOut = page.waitForRequest(request => request.url().endsWith('/api/session/logout'));
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#signout-btn').evaluate(button => button.click());
  await loggingOut;
  const response = page.waitForResponse(result => result.url().endsWith('/runs/run_focus'));
  checkpoint.resolve();
  await response;
  await settleResponses(page);
  await hidePage(page);
  expect(await studyRecords(page)).toEqual([]);
  logout.resolve();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(await studyRecords(page)).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('cancelling sign out retains unsynced work and permits a later successful sync', async ({ page }) => {
  const state = await installStudy(page);
  await openPlanned(page);
  state.offline = true;
  await page.locator('#learn-f-flip').click();
  await page.locator('[data-review-action="good"]').click();
  await expect(page.locator('[data-save]')).toContainText('Saved on this device');
  const dialogPromise = page.waitForEvent('dialog', { timeout: 5000 });
  await page.locator('#signout-btn').evaluate(button => button.click());
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('confirm');
  expect(dialog.message()).toContain('Some study progress has not synced.');
  await dialog.dismiss();
  await expect(page.locator('#signout-btn')).toBeEnabled();
  expect(await page.evaluate(() => window.testAccount.currentUser.uid)).toBe('a');
  expect(state.requests.filter(entry => entry.path === '/api/session/logout')).toEqual([]);
  const pending = await plannedRecords(page);
  expect(pending).toHaveLength(1);
  expect(pending[0].value.pending).toBe(true);
  expect(Object.keys(pending[0].value.payload.answers)).toHaveLength(1);
  state.offline = false;
  await page.locator('[data-pause]').click();
  await expect(page.locator('[data-save]')).toHaveText('Progress saved');
  await expect.poll(() => Object.keys(state.run.answers).length).toBe(1);
  expect(state.errors).toEqual([]);
});

test('confirming sign out clears unsynced device work after the warning', async ({ page }) => {
  const state = await installStudy(page);
  await openPlanned(page);
  state.offline = true;
  await page.locator('#learn-f-flip').click();
  await page.locator('[data-review-action="good"]').click();
  await expect(page.locator('[data-save]')).toContainText('Saved on this device');
  const dialogPromise = page.waitForEvent('dialog', { timeout: 5000 });
  await page.locator('#signout-btn').evaluate(button => button.click());
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain('Signing out now will remove it from this device.');
  await dialog.accept();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(await studyRecords(page)).toEqual([]);
  expect(state.requests.some(entry => entry.path === '/api/session/logout')).toBe(true);
  expect(state.errors).toEqual([]);
});

test('account switching removes old highlight data and keeps the other account notes clear', async ({ page }) => {
  const state = await installStudy(page);
  await openPack(page);
  await highlight(page);
  await expect.poll(() => state.packs.a.a.notes_highlights?.ranges.length).toBe(1);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#pack-list')).toContainText('Other account pack');
  await page.locator('#pack-list [data-pack-id="c"] [data-pack-open]').click();
  await expect(page.locator('#notes-view p')).toContainText('Study this synthetic example');
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(0);
  expect(state.packs.b.c.notes_highlights).toBeUndefined();
  expect((await studyRecords(page)).filter(record => record.value.uid === 'a' || record.key === 'hl_ranges_a')).toEqual([]);
  await page.evaluate(() => window.testAccount.switchTo('a'));
  await expect(page.locator('#pack-list')).toContainText('Pack A');
  await page.locator('#pack-list [data-pack-id="a"] [data-pack-open]').click();
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveAttribute('data-hl', 'yellow');
  expect(state.errors).toEqual([]);
});

for (const partialFailure of [false, true]) {
  test(`deleting packs clears each acknowledged pack${partialFailure ? ' even if the next deletion fails' : ' and leaves no study cache'}`, async ({ page }) => {
    const state = await installStudy(page, { route: async (route, _state, entry) => {
      if (!partialFailure || entry.path !== '/api/study-packs/b' || entry.method !== 'DELETE') return false;
      await route.fulfill({ status: 503, json: { error: 'Second deletion temporarily unavailable.' } });
      return true;
    } });
    await page.goto('/study');
    await expect(page.locator('#pack-list [data-pack-select]')).toHaveCount(2);
    for (const id of ['a', 'b']) {
      await page.locator(`#pack-list [data-pack-id="${id}"] [data-pack-open]`).click();
      await expect(page.locator('#pack-title')).toHaveValue(`Pack ${id.toUpperCase()}`);
      await highlight(page);
      await expect.poll(() => state.packs.a[id].notes_highlights?.ranges.length).toBe(1);
    }
    await seedPackRecords(page, 'a');
    await seedPackRecords(page, 'b');
    const retained = (await studyRecords(page)).filter(record => belongsToPack(record, 'b'));
    for (const id of ['a', 'b']) await page.locator(`#pack-list [data-pack-id="${id}"] .pack-select-control`).click();
    await page.locator('#delete-selected-packs-btn').click();
    await page.locator('#confirm-modal-confirm').click();
    await expect(page.locator('#toast')).toHaveText(partialFailure ? 'Second deletion temporarily unavailable.' : 'Study packs deleted.');
    expect(state.packs.a.a).toBeUndefined();
    const records = await studyRecords(page);
    expect(records.filter(record => belongsToPack(record, 'a'))).toEqual([]);
    if (partialFailure) {
      expect(state.packs.a.b).toBeDefined();
      expect(records.filter(record => belongsToPack(record, 'b'))).toEqual(retained);
    } else {
      expect(state.packs.a.b).toBeUndefined();
      expect(records).toEqual([]);
    }
    expect(state.errors).toEqual([]);
  });
}

for (const newer of ['local', 'server']) {
  test(`scoped highlight storage preserves the newer ${newer} changes`, async ({ page }) => {
    const state = await installStudy(page);
    await openPack(page);
    await highlight(page);
    await expect.poll(() => state.packs.a.a.notes_highlights?.ranges.length).toBe(1);
    const original = structuredClone(state.packs.a.a.notes_highlights);
    await writeHighlightCache(page, {
      ...original, updated_at: original.updated_at + 100,
      ranges: original.ranges.map(range => ({ ...range, color: 'green' })),
    });
    state.packs.a.a.notes_highlights = {
      ...original, updated_at: original.updated_at + (newer === 'server' ? 200 : 50),
      ranges: original.ranges.map(range => ({ ...range, color: 'blue' })),
    };
    await page.reload();
    const color = newer === 'local' ? 'green' : 'blue';
    await expect(page.locator('#notes-view mark[data-hl]')).toHaveAttribute('data-hl', color);
    await expect.poll(() => state.packs.a.a.notes_highlights?.ranges[0]?.color).toBe(color);
    expect(state.errors).toEqual([]);
  });
}

for (const cleared of [false, true]) {
  test(`an owned legacy highlight ${cleared ? 'clear' : 'edit'} migrates without losing newer local changes`, async ({ page }) => {
    const state = await installStudy(page);
    await openPack(page);
    await highlight(page);
    await expect.poll(() => state.packs.a.a.notes_highlights?.ranges.length).toBe(1);
    const original = structuredClone(state.packs.a.a.notes_highlights);
    await writeHighlightCache(page, {
      ...original, updated_at: original.updated_at + 100,
      ranges: cleared ? [] : original.ranges.map(range => ({ ...range, color: 'green' })),
    }, true);
    await page.reload();
    await expect(page.locator('#notes-view p')).toContainText('Study this synthetic example');
    if (cleared) {
      await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(0);
      await expect.poll(() => state.packs.a.a.notes_highlights).toBeNull();
    } else {
      await expect(page.locator('#notes-view mark[data-hl]')).toHaveAttribute('data-hl', 'green');
      await expect.poll(() => state.packs.a.a.notes_highlights?.ranges[0]?.color).toBe('green');
    }
    expect(await page.evaluate(() => localStorage.getItem('hl_ranges_a'))).toBeNull();
    expect((await studyRecords(page)).some(record => record.value.uid === 'a' && record.value.kind === 'highlights')).toBe(true);
    expect(state.errors).toEqual([]);
  });
}

test('an unsynced scoped highlight clear survives reload and retries successfully', async ({ page }) => {
  let rejectClear = true, attempts = 0;
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/a' || entry.method !== 'PATCH' || entry.data.notes_highlights !== null) return false;
    attempts += 1;
    if (!rejectClear) return false;
    await route.fulfill({ status: 503, json: { error: 'Synthetic highlight outage.' } });
    return true;
  } });
  await openPack(page);
  await highlight(page);
  await expect.poll(() => state.packs.a.a.notes_highlights?.ranges.length).toBe(1);
  await page.locator('#hl-clear-all').click();
  await expect.poll(() => attempts).toBeGreaterThan(0);
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.locator('#notes-view p')).toContainText('Study this synthetic example');
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(0);
  rejectClear = false;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(() => state.packs.a.a.notes_highlights).toBeNull();
  expect(attempts).toBeGreaterThan(1);
  expect(state.errors).toEqual([]);
});

test('highlight storage and network failures explain that changes are still unsaved', async ({ page }, testInfo) => {
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/a' || entry.method !== 'PATCH' || !entry.data.notes_highlights) return false;
    await route.fulfill({ status: 503, json: { error: 'Synthetic highlight outage.' } });
    return true;
  } });
  await openPack(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (/hl_ranges_|:study_cache:/.test(key)) throw new DOMException('Synthetic quota reached', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await highlight(page);
  await expect(page.locator('#notes-highlight-status')).toBeVisible();
  await expect(page.locator('#notes-highlight-status')).toContainText(/Highlights could not be saved.*Keep this tab open/);
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(1);
  expect(state.packs.a.a.notes_highlights).toBeUndefined();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.getSelection().removeAllRanges();
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
      await settleResponses(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`highlight-unsaved-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
  }
  expect(state.errors).toEqual([]);
});

test('an owned legacy highlight remains recoverable if migration cannot write device storage', async ({ page }) => {
  const state = await installStudy(page);
  await openPack(page);
  await highlight(page);
  await expect.poll(() => state.packs.a.a.notes_highlights?.ranges.length).toBe(1);
  const original = structuredClone(state.packs.a.a.notes_highlights);
  const pending = { ...original, updated_at: original.updated_at + 100,
    ranges: original.ranges.map(range => ({ ...range, color: 'green' })) };
  await page.addInitScript(value => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('lp_ui_v2:user:a:study_cache:highlights:')) localStorage.removeItem(key);
    localStorage.setItem('hl_ranges_a', JSON.stringify(value));
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, payload) {
      if (key.includes(':study_cache:')) throw new DOMException('Synthetic quota reached', 'QuotaExceededError');
      return originalSet.call(this, key, payload);
    };
  }, pending);
  await page.reload();
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveAttribute('data-hl', 'green');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hl_ranges_a')))).toEqual(pending);
  expect((await studyRecords(page)).filter(record => record.value.kind === 'highlights')).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('Write and Match retain their exact local position after reload', async ({ page }) => {
  const state = await installStudy(page);
  state.packs.a.a.flashcards.push(...Array.from({ length: 4 }, (_, index) => ({ front: `Extra prompt ${index}`, back: `Extra answer ${index}` })));
  state.packs.a.a.flashcards_count = 6;
  await page.goto('/study?pack_id=a&mode=learn');
  await chooseMode(page, 'write');
  const prompt = await page.locator('#write-prompt').textContent();
  await page.locator('#write-input').fill('My saved attempt');
  await page.locator('#write-check-btn').click();
  const feedback = await page.locator('#write-feedback').textContent();
  await page.locator('#learn-change-mode-btn').click();
  await page.reload();
  await chooseMode(page, 'write');
  await expect(page.locator('#write-prompt')).toHaveText(prompt);
  await expect(page.locator('#write-input')).toHaveValue('My saved attempt');
  await expect(page.locator('#write-input')).toBeDisabled();
  await expect(page.locator('#write-feedback')).toHaveText(feedback);
  await page.locator('#learn-change-mode-btn').click();
  await chooseMode(page, 'match');
  await page.locator('.match-cell').filter({ hasText: /^First prompt$/ }).click();
  await page.locator('.match-cell').filter({ hasText: /^First answer$/ }).click();
  await expect(page.locator('.match-cell.matched')).toHaveCount(2);
  await page.locator('.match-cell').filter({ hasText: /^Second prompt$/ }).click();
  const order = await page.locator('.match-cell').allTextContents();
  await page.locator('#learn-change-mode-btn').click();
  await page.reload();
  await chooseMode(page, 'match');
  expect(await page.locator('.match-cell').allTextContents()).toEqual(order);
  await expect(page.locator('.match-cell.matched')).toHaveCount(2);
  await expect(page.locator('.match-cell.selected')).toHaveText('Second prompt');
  expect(state.errors).toEqual([]);
});

test('a late initial planned response cannot reopen study after explicit sign out', async ({ page }) => {
  const opening = deferred(), logout = deferred();
  const state = await installStudy(page, { route: async (route, fixture, entry) => {
    if (entry.path === '/api/session/logout') { await logout.promise; await route.fulfill({ json: { ok: true } }); return true; }
    if (!entry.path.endsWith('/session_focus/run')) return false;
    await opening.promise;
    await route.fulfill({ json: { session: fixture.session, run: fixture.run } });
    return true;
  } });
  await page.goto('/study?pack_id=a&mode=learn&plan_item_id=session_focus');
  await expect(page.locator('#setup-overlay')).toBeVisible();
  const request = page.waitForRequest(candidate => candidate.url().endsWith('/session_focus/run'));
  await page.locator('#setup-start-btn').click();
  await request;
  const loggingOut = page.waitForRequest(candidate => candidate.url().endsWith('/api/session/logout'));
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#signout-btn').evaluate(button => button.click());
  await loggingOut;
  const response = page.waitForResponse(candidate => candidate.url().endsWith('/session_focus/run'));
  opening.resolve();
  await response;
  await settleResponses(page);
  await expect(page.locator('#learn-stage')).not.toHaveClass(/visible/);
  expect(state.checkpoints).toEqual([]);
  expect(await studyRecords(page)).toEqual([]);
  logout.resolve();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(state.errors).toEqual([]);
});

test('successful pack deletion warns when its device data cannot be removed', async ({ page }) => {
  const state = await installStudy(page);
  await page.goto('/study');
  await expect(page.locator('#pack-list [data-pack-id="a"]')).toBeVisible();
  await seedPackRecords(page, 'a');
  await page.evaluate(() => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (/planned_run_|learning_session_|hl_ranges_|:study_cache:/.test(key)) throw new DOMException('Synthetic storage failure', 'SecurityError');
      return original.call(this, key);
    };
  });
  await page.locator('#pack-list [data-pack-id="a"] .pack-select-control').click();
  await page.locator('#delete-selected-packs-btn').click();
  await page.locator('#confirm-modal-confirm').click();
  await expect.poll(() => state.packs.a.a).toBeUndefined();
  await expect(page.locator('#pack-list [data-pack-id="a"]')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('Some study data could not be cleared from this device.');
  await expect(page.locator('#toast')).not.toHaveText('Study pack deleted.');
  expect(state.errors).toEqual([]);
});

for (const content of ['answers', 'reading time']) {
  for (const backupFails of [false, true]) {
    test(`${content} survives a conflicting mode${backupFails ? ' when device backup fails' : ' in a durable device backup'}`, async ({ page }) => {
      const state = await installStudy(page);
      await openPlanned(page);
      const pending = { ...structuredClone(state.run), mode_generation: 0, checkpoint_revision: 100,
        answers: content === 'answers' ? { fc_0: { type: 'fc', correct: true } } : {},
        pending_reviews: content === 'answers' ? [{ id: 'fc_0', action: 'good', key: 'fc_0:first' }] : [],
        notes_seconds: 90, active_seconds: 90, slot_seconds: 90 };
      await page.locator('#learn-change-mode-btn').click();
      const cached = await page.evaluate(value => {
        const key = Object.keys(localStorage).find(candidate => candidate.includes(':study_cache:planned:')) || 'planned_run_a_run_focus';
        const record = JSON.parse(localStorage.getItem(key));
        return { key, value: JSON.stringify(record.schema ? { ...record, pending: true, payload: value } : value) };
      }, pending);
      state.run.mode_generation = 1;
      await page.addInitScript(({ record, fail }) => {
        localStorage.setItem(record.key, record.value);
        if (!fail) return;
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.includes(':study_cache:conflict:') || key.endsWith('_conflict')) throw new DOMException('Synthetic quota reached', 'QuotaExceededError');
          return original.call(this, key, value);
        };
      }, { record: cached, fail: backupFails });
      await page.reload();
      await expect(page.locator('#setup-overlay')).toBeVisible();
      const checkpoints = state.checkpoints.length;
      await page.locator('#setup-start-btn').click();
      if (backupFails) {
        await expect(page.locator('#toast')).toBeVisible();
        await expect(page.locator('#toast')).toContainText('Your earlier unsynced attempt could not be saved on this device. Keep this tab open.');
        await expect(page.locator('#toast')).not.toContainText('kept on this device');
        const records = await plannedRecords(page);
        expect(records).toHaveLength(1);
        const preserved = records[0].value.payload || records[0].value;
        expect(preserved.pending_reviews).toEqual(pending.pending_reviews);
        expect(preserved.notes_seconds).toBe(90);
        expect(state.checkpoints).toHaveLength(checkpoints);
      } else {
        await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
        const records = (await studyRecords(page)).filter(record => record.value.kind === 'conflict' || record.key.endsWith('_conflict'));
        expect(records).toHaveLength(1);
        if (records[0].value.kind === 'conflict') expect(records[0].value.pending).toBe(true);
        const preserved = records[0].value.payload || records[0].value;
        expect(preserved.pending_reviews).toEqual(pending.pending_reviews);
        expect(preserved.notes_seconds).toBe(90);
        expect(preserved.active_seconds).toBe(90);
      }
      expect(state.errors).toEqual([]);
    });
  }
}

test('a late profile response cannot restore account caches during explicit logout', async ({ page }) => {
  const profile = deferred(), logout = deferred();
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.path === '/api/session/logout') { await logout.promise; await route.fulfill({ json: { ok: true } }); return true; }
    if (entry.path !== '/api/auth/user') return false;
    await profile.promise;
    await route.fulfill({ json: {
      uid: 'a', email: 'a@example.test', allowed: true, onboarding_completed: true, email_verified: true,
      credits: { lecture_standard: 1, lecture_extended: 2, slides: 3, interview_short: 4, interview_medium: 5, interview_long: 6 },
    } });
    return true;
  } });
  await page.goto('/study');
  await expect(page.locator('#pack-list')).toContainText('Pack A');
  await expect.poll(() => state.requests.some(entry => entry.path === '/api/auth/user')).toBe(true);
  await seedPackRecords(page, 'a');
  const loggingOut = page.waitForRequest(request => request.url().endsWith('/api/session/logout'));
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#signout-btn').evaluate(button => button.click());
  await loggingOut;
  const response = page.waitForResponse(result => result.url().endsWith('/api/auth/user'));
  profile.resolve();
  await response;
  await settleResponses(page);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key =>
    /^lp_ui_v2:user:a:(?:shell_profile|credits_breakdown|study_cache:)/.test(key) || key === 'lp_ui_v2:shell_profile:last'
  ))).toEqual([]);
  logout.resolve();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(state.errors).toEqual([]);
});

for (const action of ['sign out', 'delete the pack', 'migrate local study data']) {
  test(`unparseable and other-account legacy data survive ${action}`, async ({ page }) => {
    const state = await installStudy(page);
    await openPack(page);
    await highlight(page);
    await expect.poll(() => state.packs.a.a.notes_highlights?.ranges.length).toBe(1);
    await writeHighlightCache(page, structuredClone(state.packs.a.a.notes_highlights), true);
    await page.reload();
    await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(1);
    expect(await page.evaluate(() => localStorage.getItem('hl_ranges_a'))).toBeNull();
    const retained = {
      hl_ranges_a: '{unparseable replacement after validation',
      learning_session_a_a_practice: '{unparseable learning state',
      planned_run_a_run_focus: '{unparseable planned state',
      learning_session_b_a_practice: JSON.stringify({ version: 'another account', private_answer: 'Keep another account data' }),
      planned_run_b_run_other: JSON.stringify({ uid: 'b', activity_id: 'run_other', private_answer: 'Keep another account attempt' }),
    };
    await page.evaluate(values => {
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    }, retained);
    if (action === 'sign out') {
      await page.locator('#signout-btn').evaluate(button => button.click());
      await expect(page).toHaveURL(/\/dashboard$/);
    } else if (action === 'delete the pack') {
      await page.locator('#pack-list [data-pack-id="a"] .pack-select-control').click();
      await page.locator('#delete-selected-packs-btn').click();
      await page.locator('#confirm-modal-confirm').click();
      await expect.poll(() => state.packs.a.a).toBeUndefined();
      await expect(page.locator('#toast')).toHaveText('Study pack deleted.');
    } else {
      await page.goto('/study?pack_id=a&mode=learn');
      await chooseMode(page, 'write');
      await page.locator('#write-input').fill('A new scoped answer');
      await page.locator('#learn-change-mode-btn').click();
    }
    expect(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), Object.keys(retained))).toEqual(retained);
    expect(state.errors).toEqual([]);
  });
}

test('a late progress summary for the previous account cannot replace the current account goal', async ({ page }) => {
  const oldSummary = deferred();
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-progress/summary') return false;
    if (entry.uid === 'a') await oldSummary.promise;
    await route.fulfill({ json: { daily_goal: entry.uid === 'a' ? 91 : 7, due_today: 0, studied_today: 0, current_streak: 0 } });
    return true;
  } });
  await page.goto('/study');
  await expect.poll(() => state.requests.some(entry => entry.path === '/api/study-progress/summary' && entry.uid === 'a')).toBe(true);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#pack-list')).toContainText('Other account pack');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('daily_goal_b'))).toBe('7');
  const response = page.waitForResponse(result => result.url().endsWith('/api/study-progress/summary') && result.request().headers().authorization === 'Bearer token-a');
  oldSummary.resolve();
  await response;
  await settleResponses(page);
  expect(await page.evaluate(() => localStorage.getItem('daily_goal_b'))).toBe('7');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp_ui_v2:user:b:dashboard_summary'))?.goal)).not.toBe(91);
  expect(state.errors).toEqual([]);
});
