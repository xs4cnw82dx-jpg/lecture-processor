const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'parallel' });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

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

async function openPack(page) {
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#notes-view p')).toContainText('synthetic paragraph');
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
  await expect(page.locator(`#notes-view mark[data-hl="${color}"]`)).toHaveCount(1);
}

async function cacheRecord(page, uid, kind, id) {
  return page.evaluate(({ uid, kind, id }) => JSON.parse(localStorage.getItem(`lp_ui_v2:user:${uid}:study_cache:${kind}:${encodeURIComponent(id)}`) || 'null'), { uid, kind, id });
}

async function seedConflicts(page) {
  await page.evaluate(() => {
    const cache = window.LectureProcessorStudyCache, token = cache.capture('a');
    for (const id of ['focus', 'other']) cache.set(token, 'conflict', `run_${id}`, {
      activity_id: `run_${id}`, plan_item_id: `session_${id}`, pack_id: 'a', checkpoint_revision: 3,
      pending_reviews: [{ key: 'first', answer: `Keep ${id}` }],
    }, { packId: 'a', pending: true });
    localStorage.setItem('planned_run_a_run_focus_conflict', '{unparseable legacy conflict');
  });
}

async function startPlanned(page) {
  await expect(page.locator('#setup-overlay')).toBeVisible();
  for (const card of await page.locator('.lesson-card[data-lesson]').all()) {
    if ((await card.getAttribute('class')).includes('unavailable')) continue;
    if ((await card.getAttribute('aria-pressed') === 'true') !== (await card.getAttribute('data-lesson') === 'flashcards')) await card.click();
  }
  await page.locator('#setup-start-btn').click();
}

for (const status of [403, 404]) {
  test(`a matching highlight ${status} acknowledgement settles durable pending without claiming server success`, async ({ page }) => {
    const state = await fixture(page); state.patchStatus = status;
    await openPack(page);
    await highlight(page);
    await expect.poll(() => state.patches.length).toBe(1);
    await expect(page.locator('#notes-highlight-status')).toContainText('Highlights remain on this device; this pack cannot be updated.');
    await expect.poll(async () => (await cacheRecord(page, 'a', 'highlights', 'a'))?.pending ?? false).toBe(false);
    const saved = await cacheRecord(page, 'a', 'highlights', 'a');
    if (saved) expect(saved.payload.ranges).toHaveLength(1);
    expect(await page.evaluate(() => window.LectureProcessorStudyCache.hasPending('a'))).toBe(false);
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.locator('#signout-btn').evaluate(button => button.click());
    await expect.poll(() => state.requests.some(entry => entry.path === '/api/session/logout')).toBe(true);
    expect(dialogs).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test('a transient highlight failure preserves pending progress', async ({ page }) => {
  const state = await fixture(page); state.patchStatus = 503;
  await openPack(page);
  await highlight(page);
  await expect.poll(() => state.patches.length).toBeGreaterThan(0);
  expect((await cacheRecord(page, 'a', 'highlights', 'a')).pending).toBe(true);
  expect(await page.evaluate(() => window.LectureProcessorStudyCache.hasPending('a'))).toBe(true);
});

test('an older highlight 403 cannot drop a newer pending edit', async ({ page }) => {
  const state = await fixture(page), held = deferred();
  state.patchReply = async (route, _entry, count) => {
    if (count === 1) await held.promise;
    await route.fulfill({ status: count === 1 ? 403 : 503, json: { error: 'Synthetic rejection.' } });
  };
  try {
    await openPack(page);
    await highlight(page);
    await expect.poll(() => state.patches.length).toBe(1);
    await highlight(page, 'green');
    const latest = await cacheRecord(page, 'a', 'highlights', 'a');
    held.resolve();
    await expect.poll(() => state.patches.length).toBeGreaterThanOrEqual(2);
    const current = await cacheRecord(page, 'a', 'highlights', 'a');
    expect(current.pending).toBe(true);
    expect(current.payload).toEqual(latest.payload);
  } finally { held.resolve(); }
});

test('a permanent response in one tab cannot acknowledge a newer pending highlight from another tab', async ({ page, context }) => {
  const first = await fixture(page), held = deferred();
  first.patchReply = async route => { await held.promise; await route.fulfill({ status: 403, json: { error: 'Synthetic rejection.' } }); };
  const otherPage = await context.newPage();
  const second = await fixture(otherPage); second.patchStatus = 503;
  try {
    await openPack(page);
    await highlight(page);
    await expect.poll(() => first.patches.length).toBe(1);
    await openPack(otherPage);
    await highlight(otherPage, 'green');
    await expect.poll(() => second.patches.length).toBeGreaterThan(0);
    const latest = await cacheRecord(otherPage, 'a', 'highlights', 'a');
    const response = page.waitForResponse(candidate => candidate.url().endsWith('/api/study-packs/a') && candidate.request().method() === 'PATCH');
    held.resolve(); await response;
    await page.waitForTimeout(250);
    const current = await cacheRecord(otherPage, 'a', 'highlights', 'a');
    expect(current.pending).toBe(true);
    expect(current.payload).toEqual(latest.payload);
  } finally { held.resolve(); await otherPage.close(); }
});

test('a prior account highlight 404 cannot acknowledge retained pending progress after an identity change', async ({ page }) => {
  const state = await fixture(page), held = deferred();
  state.patchReply = async route => { await held.promise; await route.fulfill({ status: 404, json: { error: 'Pack missing.' } }); };
  try {
    await openPack(page);
    await highlight(page);
    await expect.poll(() => state.patches.length).toBe(1);
    const before = await cacheRecord(page, 'a', 'highlights', 'a');
    await page.evaluate(() => window.testAccount.switchTo('b'));
    await expect(page.locator('#pack-list')).toContainText('Pack b');
    const response = page.waitForResponse(candidate => candidate.url().endsWith('/api/study-packs/a') && candidate.request().method() === 'PATCH');
    held.resolve(); await response;
    await page.waitForTimeout(250);
    const after = await cacheRecord(page, 'a', 'highlights', 'a');
    expect(after.pending).toBe(true);
    expect(after.payload).toEqual(before.payload);
  } finally { held.resolve(); }
});

for (const status of [404, 503]) {
  test(`an observed planned open ${status} ${status === 404 ? 'settles only its removed-session backup' : 'retains the conflict backup'}`, async ({ page }) => {
    const state = await fixture(page); state.openStatus = status;
    await page.goto('/study?pack_id=a&mode=learn&plan_item_id=session_focus');
    await expect(page.locator('#setup-overlay')).toBeVisible();
    await seedConflicts(page);
    await startPlanned(page);
    await expect.poll(() => state.requests.filter(entry => entry.path.endsWith('/session_focus/run')).length).toBe(1);
    if (status === 404) await expect.poll(() => cacheRecord(page, 'a', 'conflict', 'run_focus')).toBeNull();
    else expect((await cacheRecord(page, 'a', 'conflict', 'run_focus')).pending).toBe(true);
    expect((await cacheRecord(page, 'a', 'conflict', 'run_other')).pending).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('planned_run_a_run_focus_conflict'))).toBe('{unparseable legacy conflict');
    expect(state.requests.some(entry => entry.path === '/api/study-plan')).toBe(false);
  });
}

test('an observed missing planned checkpoint stops obsolete writers and clears only its scoped records', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/study?pack_id=a&mode=learn&plan_item_id=session_focus');
  await startPlanned(page);
  await expect(page.locator('[data-pause]')).toHaveText('Pause');
  await seedConflicts(page);
  state.checkpointStatus = 404;
  await page.locator('[data-pause]').click();
  await expect.poll(() => cacheRecord(page, 'a', 'planned', 'run_focus')).toBeNull();
  expect(await cacheRecord(page, 'a', 'conflict', 'run_focus')).toBeNull();
  expect((await cacheRecord(page, 'a', 'conflict', 'run_other')).pending).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('online'));
  });
  await page.waitForTimeout(250);
  expect(await cacheRecord(page, 'a', 'planned', 'run_focus')).toBeNull();
  expect(await cacheRecord(page, 'a', 'conflict', 'run_focus')).toBeNull();
});

test('a removed planned session no longer forces the unsynced sign-out confirmation', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/study?pack_id=a&mode=learn&plan_item_id=session_focus');
  await startPlanned(page);
  await expect(page.locator('[data-pause]')).toHaveText('Pause');
  state.checkpointStatus = 404;
  await page.locator('[data-pause]').click();
  await expect.poll(() => cacheRecord(page, 'a', 'planned', 'run_focus')).toBeNull();
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.locator('#signout-btn').evaluate(button => button.click());
  await expect.poll(() => state.requests.some(entry => entry.path === '/api/session/logout')).toBe(true);
  expect(dialogs).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const status of [404, 503]) {
  test(`a planned mode switch ${status} ${status === 404 ? 'stops its removed session' : 'retains recoverable work'}`, async ({ page }) => {
    const state = await fixture(page);
    await page.goto('/study?pack_id=a&mode=learn&plan_item_id=session_focus');
    await startPlanned(page);
    await expect(page.locator('[data-pause]')).toHaveText('Pause');
    await seedConflicts(page);
    const opens = state.requests.filter(entry => entry.path.endsWith('/session_focus/run')).length;
    state.openStatus = status;
    await page.locator('#learn-change-mode-btn').click();
    await startPlanned(page);
    await expect.poll(() => state.requests.filter(entry => entry.path.endsWith('/session_focus/run')).length).toBe(opens + 1);
    await expect(page.locator('#setup-session-context')).toContainText('Study session unavailable.');
    if (status === 404) {
      await expect.poll(() => cacheRecord(page, 'a', 'planned', 'run_focus')).toBeNull();
      expect(await cacheRecord(page, 'a', 'conflict', 'run_focus')).toBeNull();
      const writes = state.requests.filter(entry => entry.path.startsWith('/api/study-plan/')).length;
      await page.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('pagehide'));
      });
      await page.waitForTimeout(250);
      expect(state.requests.filter(entry => entry.path.startsWith('/api/study-plan/'))).toHaveLength(writes);
      expect(await cacheRecord(page, 'a', 'planned', 'run_focus')).toBeNull();
    } else {
      expect(await cacheRecord(page, 'a', 'planned', 'run_focus')).not.toBeNull();
      expect((await cacheRecord(page, 'a', 'conflict', 'run_focus')).pending).toBe(true);
    }
    expect((await cacheRecord(page, 'a', 'conflict', 'run_other')).pending).toBe(true);
    expect(state.errors).toEqual([]);
  });
}

test('an old delete confirmation remains inactive after asynchronous account-switch work settles', async ({ page }) => {
  const state = await fixture(page);
  await openPack(page);
  await page.locator('#export-menu-btn').click();
  await page.locator('#delete-pack-btn').click();
  await expect(page.locator('#confirm-modal-overlay')).toBeVisible();
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#confirm-modal-overlay')).toBeHidden();
  await page.locator('#confirm-modal-confirm').evaluate(button => button.click());
  await page.waitForTimeout(250);
  expect(state.requests.filter(entry => entry.method === 'DELETE')).toEqual([]);
  expect(Object.keys(state.packs)).toEqual(['a', 'b']);
});

test.describe('additional cache boundaries', () => {
  for (const failure of [401, 409, 429, 'network']) {
    test(`a highlight ${failure} failure remains pending for a later retry`, async ({ page }) => {
      const state = await fixture(page);
      state.patchReply = route => failure === 'network'
        ? route.abort('failed')
        : route.fulfill({ status: failure, json: { error: 'Synthetic retryable failure.' } });
      await openPack(page);
      await highlight(page);
      await expect.poll(() => state.patches.length).toBeGreaterThan(0);
      await expect(page.locator('#notes-highlight-status')).toContainText('will retry syncing');
      const current = await cacheRecord(page, 'a', 'highlights', 'a');
      expect(current.pending).toBe(true);
      expect(current.payload.ranges).toHaveLength(1);
      expect(await page.evaluate(() => window.LectureProcessorStudyCache.hasPending('a'))).toBe(true);
      expect(state.errors).toEqual([]);
    });
  }

  test('an older highlight 404 cannot drop a newer pending edit', async ({ page }) => {
    const state = await fixture(page), held = deferred();
    state.patchReply = async (route, _entry, count) => {
      if (count === 1) await held.promise;
      await route.fulfill({ status: count === 1 ? 404 : 503, json: { error: 'Synthetic rejection.' } });
    };
    try {
      await openPack(page);
      await highlight(page);
      await expect.poll(() => state.patches.length).toBe(1);
      await highlight(page, 'green');
      const latest = await cacheRecord(page, 'a', 'highlights', 'a');
      held.resolve();
      await expect.poll(() => state.patches.length).toBeGreaterThanOrEqual(2);
      const current = await cacheRecord(page, 'a', 'highlights', 'a');
      expect(current.pending).toBe(true);
      expect(current.payload).toEqual(latest.payload);
      expect(state.patches[1].data.notes_highlights).toEqual(latest.payload);
      expect(state.errors).toEqual([]);
    } finally { held.resolve(); }
  });

  test('a late highlight 403 preserves both accounts pending edits after switching', async ({ page }) => {
    const state = await fixture(page), held = deferred();
    state.patchReply = async (route, entry) => {
      if (entry.uid === 'a') await held.promise;
      await route.fulfill({ status: entry.uid === 'a' ? 403 : 503, json: { error: 'Synthetic rejection.' } });
    };
    try {
      await openPack(page);
      await highlight(page);
      await expect.poll(() => state.patches.filter(entry => entry.uid === 'a').length).toBe(1);
      const first = await cacheRecord(page, 'a', 'highlights', 'a');
      await page.evaluate(() => window.testAccount.switchTo('b'));
      await expect(page.locator('#pack-list')).toContainText('Pack b');
      await page.locator('#pack-list [data-pack-id="b"] [data-pack-open]').click();
      await expect(page.locator('#notes-view p')).toContainText('synthetic paragraph');
      await highlight(page, 'green');
      await expect.poll(() => state.patches.filter(entry => entry.uid === 'b').length).toBeGreaterThan(0);
      const second = await cacheRecord(page, 'b', 'highlights', 'b');
      const response = page.waitForResponse(candidate => candidate.url().endsWith('/api/study-packs/a') && candidate.request().method() === 'PATCH');
      held.resolve(); await response;
      await page.waitForTimeout(250);
      for (const [uid, original] of [['a', first], ['b', second]]) {
        const current = await cacheRecord(page, uid, 'highlights', uid);
        expect(current.pending).toBe(true);
        expect(current.payload).toEqual(original.payload);
      }
      await expect(page.locator('#notes-view mark[data-hl="green"]')).toHaveCount(1);
      expect(state.errors).toEqual([]);
    } finally { held.resolve(); }
  });

  test('a missing planned completion disposes its controller before later lifecycle events', async ({ page }) => {
    const state = await fixture(page);
    await page.clock.install();
    await page.route('**/api/study-plan/items/session_focus/completion', route => {
      state.requests.push({ path: '/api/study-plan/items/session_focus/completion', method: 'POST', uid: 'a' });
      return route.fulfill({ status: 404, json: { error: 'Study session unavailable.' } });
    });
    await page.goto('/study?pack_id=a&mode=learn&plan_item_id=session_focus');
    await startPlanned(page);
    await expect(page.locator('[data-pause]')).toHaveText('Pause');
    await page.locator('#learn-f-flip').click();
    await page.locator('[data-review-action="good"]').click();
    await expect.poll(() => Object.keys(state.run.answers).length).toBe(1);
    await seedConflicts(page);
    await page.locator('[data-finish]').click();
    await expect.poll(() => state.requests.filter(entry => entry.path.endsWith('/completion')).length).toBe(1);
    await expect.poll(() => cacheRecord(page, 'a', 'planned', 'run_focus')).toBeNull();
    expect(await cacheRecord(page, 'a', 'conflict', 'run_focus')).toBeNull();
    expect((await cacheRecord(page, 'a', 'conflict', 'run_other')).pending).toBe(true);
    const writes = state.requests.filter(entry => entry.path.startsWith('/api/study-plan/')).length;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('online'));
    });
    await page.clock.runFor(31_000);
    await page.waitForTimeout(250);
    expect(state.requests.filter(entry => entry.path.startsWith('/api/study-plan/'))).toHaveLength(writes);
    expect(await cacheRecord(page, 'a', 'planned', 'run_focus')).toBeNull();
    expect(await cacheRecord(page, 'a', 'conflict', 'run_focus')).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('planned_run_a_run_focus_conflict'))).toBe('{unparseable legacy conflict');
    expect(state.errors).toEqual([]);
  });

  test('a held planned checkpoint 404 cannot clear retained or new-account work', async ({ page }) => {
    const state = await fixture(page), held = deferred(), entered = deferred();
    try {
      await page.goto('/study?pack_id=a&mode=learn&plan_item_id=session_focus');
      await startPlanned(page);
      await expect(page.locator('[data-pause]')).toHaveText('Pause');
      await seedConflicts(page);
      await page.route('**/api/study-plan/runs/run_focus', async route => {
        state.requests.push({ path: '/api/study-plan/runs/run_focus', method: 'PUT', uid: 'a' });
        entered.resolve(); await held.promise;
        await route.fulfill({ status: 404, json: { error: 'Study session unavailable.' } });
      });
      await page.locator('[data-pause]').click();
      await entered.promise;
      const previous = await cacheRecord(page, 'a', 'planned', 'run_focus');
      await page.evaluate(() => window.testAccount.switchTo('b'));
      await expect(page.locator('#pack-list')).toContainText('Pack b');
      await page.evaluate(() => {
        const cache = window.LectureProcessorStudyCache, token = cache.capture('b');
        for (const kind of ['planned', 'conflict']) cache.set(token, kind, 'run_focus', {
          activity_id: 'run_focus', plan_item_id: 'session_focus', uid: 'b', pack_id: 'b',
          checkpoint_revision: 7, pending_reviews: [{ key: 'other-owner', answer: 'Keep this answer' }],
        }, { packId: 'b', pending: true });
      });
      const next = await cacheRecord(page, 'b', 'planned', 'run_focus');
      const response = page.waitForResponse(candidate => candidate.url().endsWith('/runs/run_focus'));
      held.resolve(); await response;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForTimeout(250);
      const retained = await cacheRecord(page, 'a', 'planned', 'run_focus');
      expect(retained.pending).toBe(true);
      expect(retained.payload).toEqual(previous.payload);
      expect((await cacheRecord(page, 'a', 'conflict', 'run_focus')).pending).toBe(true);
      for (const kind of ['planned', 'conflict']) {
        const current = await cacheRecord(page, 'b', kind, 'run_focus');
        expect(current.pending).toBe(true);
        expect(current.payload).toEqual(next.payload);
      }
      expect(state.errors).toEqual([]);
    } finally { held.resolve(); }
  });
});
