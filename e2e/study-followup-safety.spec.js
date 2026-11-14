const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ timezoneId: 'UTC' });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`Study notices remain readable at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const jobsGate = deferred();
      const job = { job_id: 'regenerate-a', status: 'processing', study_pack_title: 'Pack A' };
      const state = await installStudy(page, {
        interview: true, cachedJobs: [job],
        route: async (_route, _state, entry) => {
          if (entry.path === '/api/runtime-jobs/active') await jobsGate.promise;
          return false;
        },
      });
      state.jobs[job.job_id] = { ...job, status: 'complete', study_generation_error: 'Synthetic partial result.' };
      try {
        await openPack(page);
        await page.evaluate(value => window.LPTheme.apply({ theme: value }), theme);
        jobsGate.resolve();
        await expect(page.locator('#toast')).toHaveText('Some tools were not refreshed. Existing material was kept.');
        await expect(page.locator('#toast')).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`partial-result-${theme}-${width}.png`), animations: 'disabled' });
        await expect(page.locator('#toast')).not.toHaveClass(/visible/);
        await page.locator('#open-learn-btn').click();
        const hint = page.locator('#coding-ai-panel .coding-ai-panel-sub').filter({ hasText: 'Reject the current draft to run again.' });
        await expect(hint).toBeInViewport();
        await expect(page.locator('[data-ai-draft-action="reject"]')).toBeInViewport();
        await expect(page.locator('[data-ai-draft-action="accept"]')).toBeInViewport();
        await page.evaluate(() => { document.activeElement?.blur(); window.getSelection()?.removeAllRanges(); });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`coding-draft-${theme}-${width}.png`), animations: 'disabled' });
        await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
        await expect(page.locator('#coding-ai-panel')).toContainText('Wijs het huidige concept af om opnieuw te starten.');
        await expect(page.locator('[data-ai-draft-action="reject"]')).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`coding-draft-nl-${theme}-${width}.png`), animations: 'disabled' });
        expect(state.browserErrors).toEqual([]);
      } finally { jobsGate.resolve(); }
    });
  }
}

function makePack(id, title) {
  return {
    study_pack_id: id, title, mode: 'manual', folder_id: '',
    notes_markdown: '# ' + title + '\n\nSynthetic notes for this pack.',
    flashcards: [{ front: title + ' question', back: title + ' answer' }],
    test_questions: [], flashcards_count: 1, test_questions_count: 0,
  };
}

async function installStudy(page, options = {}) {
  const account = await installAccountFixture(page);
  const state = {
    ...account, packs: { a: makePack('a', 'Pack A'), b: makePack('b', 'Pack B') },
    requests: [], patches: [], progress: [], jobs: {},
  };
  if (options.interview) state.packs.a.mode = 'interview';
  if (options.cachedJobs) {
    await page.addInitScript(jobs => {
      localStorage.setItem('lp_ui_v2:user:a:active_runtime_jobs', JSON.stringify(jobs));
    }, options.cachedJobs);
  }
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.route('https://browser.sentry-cdn.com/**', route => route.abort());
  const handleRequest = async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const entry = { path, method: request.method(), payload: request.postDataJSON() };
    state.requests.push(entry);
    if (options.route && await options.route(route, state, entry)) return;
    let body = {};
    if (path === '/api/auth/user') body = { uid: 'a', credits: 100, credits_version: 2, preferences: { onboarding_completed: true } };
    else if (path === '/api/user-preferences') body = { preferences: { interface_language: 'en', theme: 'light' } };
    else if (path === '/api/study-folders') body = { folders: [{ folder_id: 'biology', name: 'Biology' }] };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') body = { jobs: Object.values(state.jobs).filter(job => job.status === 'processing') };
    else if (path.startsWith('/status/')) body = state.jobs[path.split('/').pop()] || { status: 'complete' };
    else if (path === '/api/study-packs') body = { study_packs: Object.values(state.packs), has_more: false };
    else if (/^\/api\/study-packs\/[^/]+$/.test(path)) {
      const id = path.split('/').pop();
      if (entry.method === 'PATCH') {
        state.patches.push(entry);
        Object.assign(state.packs[id], structuredClone(entry.payload));
        body = { ok: true, study_pack_id: id };
      } else body = structuredClone(state.packs[id]);
    } else if (path.includes('study-progress')) {
      if (entry.method === 'PUT') state.progress.push(entry.payload);
      body = { card_states: {}, daily_progress: {}, timezone: options.progressTimezone || 'UTC' };
    } else if (path.startsWith('/api/interview-coding/packs/')) {
      body = {
        pack_id: 'a', transcript: 'Synthetic interview transcript.', transcript_base_key: 'test-transcript',
        segments: [], codes: [], quotations: [], palette: [], ai_estimate: { credit_cost: 2 },
        latest_run: options.draft === false ? null : {
          run_id: 'draft-a', status: 'draft',
          proposed_codes: [{ code_id: 'theme', name: 'Learning together', color: 'teal' }],
          proposed_quotations: [],
        },
      };
    }
    await route.fulfill({ json: body });
  };
  await page.route('**/api/**', handleRequest);
  await page.route('**/status/**', handleRequest);
  return state;
}

async function openPack(page, notes = 'Synthetic notes') {
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  await expect(page.locator('#notes-view')).toContainText(notes);
}

async function editTitle(page, title) {
  if (!await page.locator('#pack-title').isVisible()) await page.locator('.pack-details-disclosure > summary').click();
  await page.locator('#pack-title').fill(title);
}

async function startFlashcards(page) {
  await page.locator('#open-learn-btn').click();
  for (const card of await page.locator('.lesson-card[data-lesson]').all()) {
    if (await card.getAttribute('aria-disabled') === 'true') continue;
    if ((await card.getAttribute('aria-pressed') === 'true') !== (await card.getAttribute('data-lesson') === 'flashcards')) await card.click();
  }
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
}

test('discarding a rejected edit before a folder change restores the retained pack editor', async ({ page }) => {
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/a' || entry.method !== 'PATCH') return false;
    await route.fulfill({ status: 400, json: { error: 'Synthetic edit was rejected.' } });
    return true;
  } });
  await openPack(page);
  await editTitle(page, 'Rejected local title');
  await page.locator('[data-folder-activate]').filter({ hasText: 'Biology' }).click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(page.locator('#confirm-modal-overlay')).toBeHidden();
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  expect(state.packs.a.title).toBe('Pack A');
  expect(state.browserErrors).toEqual([]);
});

test('a failed discard reload preserves the rejected edit until a successful retry', async ({ page }) => {
  let failReload = false;
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/a') return false;
    if (entry.method === 'PATCH' || failReload) {
      await route.fulfill({ status: entry.method === 'PATCH' ? 400 : 503, json: { error: 'Synthetic save or reload failure.' } });
      return true;
    }
    return false;
  } });
  await openPack(page);
  failReload = true;
  await editTitle(page, 'Keep this local edit');
  const folder = page.locator('[data-folder-activate]').filter({ hasText: 'Biology' });
  await folder.click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Your changes are still here.');
  await expect(page.locator('#pack-title')).toHaveValue('Keep this local edit');
  await expect(folder).not.toHaveAttribute('aria-current', 'page');
  expect(await page.locator('#pack-editor-wrap').evaluate(node => node.inert)).toBe(false);
  failReload = false;
  await folder.click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  await expect(folder).toHaveAttribute('aria-current', 'page');
  expect(state.packs.a.title).toBe('Pack A');
  expect(state.browserErrors).toEqual([]);
});

for (const serverNotesChanged of [false, true]) {
test(`discarding an inline edit preserves an independent in-flight highlight exactly once (${serverNotesChanged ? 'changed' : 'unchanged'} notes)`, async ({ page }) => {
  await page.clock.install();
  const highlightReply = deferred();
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.method !== 'PATCH' || entry.path !== '/api/study-packs/a') return false;
    if (Object.hasOwn(entry.payload, 'notes_highlights')) {
      if (entry.payload.notes_highlights) await highlightReply.promise;
    } else {
      await route.fulfill({ status: 400, json: { error: 'Synthetic metadata rejection.' } });
      return true;
    }
    return false;
  } });
  try {
    await openPack(page);
    await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 50).toISOString()));
    await page.locator('#notes-view p').evaluate(paragraph => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.clock.runFor(1600);
    await expect.poll(() => state.requests.filter(entry => entry.payload?.notes_highlights).length).toBe(1);
    await editTitle(page, 'Rejected metadata');
    if (serverNotesChanged) state.packs.a.notes_markdown = '# Replacement notes\n\nA different saved note with no matching highlight base.';
    await page.locator('[data-folder-activate]').filter({ hasText: 'Biology' }).click();
    await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
    await expect(page.locator('#pack-title')).toHaveValue('Pack A');
    await expect(page.locator('#notes-view mark')).toHaveCount(serverNotesChanged ? 0 : 1);
    highlightReply.resolve();
    await expect.poll(() => state.packs.a.notes_highlights?.ranges.length).toBe(1);
    await page.clock.runFor(2000);
    expect(state.requests.filter(entry => entry.payload?.notes_highlights)).toHaveLength(1);
    await expect(page.locator('#notes-view mark')).toHaveCount(serverNotesChanged ? 0 : 1);
    if (serverNotesChanged) {
      const oldBaseKey = state.requests.find(entry => entry.payload?.notes_highlights).payload.notes_highlights.base_key;
      expect(state.packs.a.notes_highlights.base_key).toBe(oldBaseKey);
      await page.reload();
      await expect(page.locator('#notes-view')).toContainText('A different saved note with no matching highlight base.');
      await expect(page.locator('#notes-view mark')).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('lp_ui_v2:user:a:study_cache:highlights:a'))).toBeNull();
      expect(state.requests.filter(entry => entry.payload?.notes_highlights)).toHaveLength(1);
    }
    expect(state.packs.a.title).toBe('Pack A');
    expect(state.browserErrors).toEqual([]);
  } finally { highlightReply.resolve(); }
});
}

test('discarding a rejected flashcard starts the session with its saved answer', async ({ page }) => {
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/a' || entry.method !== 'PATCH') return false;
    await route.fulfill({ status: 400, json: { error: 'Synthetic card rejection.' } });
    return true;
  } });
  await openPack(page);
  await page.locator('#editor-tab-flashcards').click();
  await page.locator('#editor-card-back-0').fill('Rejected card answer');
  await page.locator('#open-learn-btn').click();
  for (const card of await page.locator('.lesson-card[data-lesson]').all()) {
    if (await card.getAttribute('aria-disabled') === 'true') continue;
    if ((await card.getAttribute('aria-pressed') === 'true') !== (await card.getAttribute('data-lesson') === 'flashcards')) await card.click();
  }
  await page.locator('#setup-start-btn').click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
  await page.locator('#learn-f-flip').click();
  await expect(page.locator('#learn-flashcard-back')).toHaveText('Pack A answer');
  expect(state.packs.a.flashcards[0].back).toBe('Pack A answer');
  expect(state.browserErrors).toEqual([]);
});

test('a pack load failure keeps the previous coherent editor available', async ({ page }) => {
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/b') return false;
    await route.fulfill({ status: 503, json: { error: 'Synthetic pack load failure.' } });
    return true;
  } });
  await openPack(page);
  await page.locator('[data-pack-id="b"] [data-pack-open]').click();
  await expect(page.locator('#toast')).toContainText('Synthetic pack load failure.');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  await expect(page.locator('#notes-view')).toContainText('Pack A');
  await expect(page.locator('[data-pack-id="a"]')).toHaveAttribute('aria-current', 'true');
  await editTitle(page, 'Pack A after failed load');
  await expect.poll(() => state.packs.a.title).toBe('Pack A after failed load');
  expect(state.packs.b.title).toBe('Pack B');
  expect(state.browserErrors).toEqual([]);
});

for (const progressTimezone of ['UTC', 'Pacific/Kiritimati']) {
for (const blocked of [false, true]) {
  test(`a card rating updates its review date and streak in ${progressTimezone} with progress utilities ${blocked ? 'unavailable' : 'available'}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-12-31T12:00:00Z'));
    const state = await installStudy(page, { progressTimezone });
    if (blocked) await page.route('**/static/js/study-progress-utils.js', route => route.abort());
    await page.addInitScript(previousDay => localStorage.setItem('study_streak_a', JSON.stringify({ last_study_date: previousDay, current_streak: 4 })), progressTimezone === 'UTC' ? '2026-12-30' : '2026-12-31');
    await openPack(page);
    await startFlashcards(page);
    await page.locator('#learn-f-flip').click();
    await page.locator('[data-review-action="good"]').click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('card_state_a_a') || '{}').fc_0?.next_review_date)).toBe(progressTimezone === 'UTC' ? '2027-01-02' : '2027-01-03');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('study_streak_a') || '{}').current_streak)).toBe(5);
    expect(state.browserErrors).toEqual([]);
  });
}

}

test('an existing coding draft explains how to request a replacement', async ({ page }) => {
  const state = await installStudy(page, { interview: true });
  await openPack(page);
  await page.locator('#open-learn-btn').click();
  await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
  await expect(page.locator('#coding-ai-panel')).toContainText('Reject the current draft to run again.');
  await expect(page.locator('[data-ai-draft-action="reject"]')).toBeVisible();
  expect(state.browserErrors).toEqual([]);
});

test('completed regeneration reports a retained section without hiding the usable pack', async ({ page }) => {
  const job = { job_id: 'regenerate-a', status: 'processing', study_pack_title: 'Pack A', mode: 'voice-note-study-tools' };
  const state = await installStudy(page, { cachedJobs: [job] });
  state.jobs[job.job_id] = {
    ...job, status: 'complete', study_pack_id: 'a',
    study_generation_error: 'Practice questions could not be refreshed. Existing questions were kept.',
  };
  await openPack(page);
  await expect(page.locator('#toast')).toContainText('Some tools were not refreshed. Existing material was kept.');
  await expect(page.locator('#pack-editor-wrap')).toBeVisible();
  expect(state.browserErrors).toEqual([]);
});

test('a normal completed job keeps its success notice', async ({ page }) => {
  const job = { job_id: 'complete-a', status: 'processing', study_pack_title: 'Pack A' };
  const state = await installStudy(page, { cachedJobs: [job] });
  state.jobs[job.job_id] = { ...job, status: 'complete', study_pack_id: 'a', study_generation_error: null };
  await openPack(page);
  await expect(page.locator('#toast')).toContainText('Pack A is ready in your library.');
  expect(state.browserErrors).toEqual([]);
});

test('a rendering failure cannot leave an editable mix of two packs', async ({ page }) => {
  const state = await installStudy(page);
  await openPack(page);
  await page.evaluate(() => {
    const view = document.getElementById('notes-view');
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    let failed = false;
    Object.defineProperty(view, 'innerHTML', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        if (!failed && String(value).includes('Pack B')) { failed = true; throw new Error('Synthetic rendering failure.'); }
        descriptor.set.call(this, value);
      },
    });
  });
  await page.locator('[data-pack-id="b"] [data-pack-open]').click();
  await expect(page.locator('#toast')).toContainText(/render|open|display/i);
  const presentation = await page.evaluate(() => {
    const editor = document.getElementById('pack-editor-wrap');
    const selected = document.querySelector('#pack-list [data-pack-id][aria-current="true"]');
    const title = document.getElementById('pack-title');
    const id = selected?.dataset.packId;
    const expectedTitle = id === 'a' ? 'Pack A' : id === 'b' ? 'Pack B' : '';
    return {
      editable: editor.classList.contains('visible') && !editor.inert && !title.disabled,
      coherent: !!expectedTitle && title.value === expectedTitle && document.getElementById('notes-view').textContent.includes(expectedTitle),
      id, title: title.value,
    };
  });
  expect(presentation.coherent || !presentation.editable, JSON.stringify(presentation)).toBe(true);
  expect(state.patches).toEqual([]);
  await page.locator('[data-pack-id="b"] [data-pack-open]').click();
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  await expect(page.locator('#notes-view')).toContainText('Pack B');
  await editTitle(page, 'Pack B after retry');
  await expect.poll(() => state.packs.b.title).toBe('Pack B after retry');
  expect(state.packs.a.title).toBe('Pack A');
  expect(state.browserErrors).toEqual([]);
});

for (const overlap of [false, true]) {
  test(`a second completed job refreshes the list ${overlap ? 'during' : 'after'} the previous refresh`, async ({ page }) => {
    await page.clock.install();
    const initialJobs = deferred();
    const firstRefresh = deferred();
    const jobA = { job_id: 'job-a', status: 'processing', study_pack_title: 'New Pack C' };
    const jobB = { job_id: 'job-b', status: 'processing', study_pack_title: 'New Pack D' };
    const state = await installStudy(page, {
      cachedJobs: [jobA, jobB],
      route: async (route, current, entry) => {
        if (entry.path === '/api/runtime-jobs/active' && current.requests.filter(item => item.path === entry.path).length === 1) {
          await initialJobs.promise;
          await route.fulfill({ json: { jobs: [jobB] } });
          return true;
        }
        if (entry.path === '/api/study-packs' && current.requests.filter(item => item.path === entry.path).length === 2) {
          const snapshot = structuredClone(Object.values(current.packs));
          await firstRefresh.promise;
          await route.fulfill({ json: { study_packs: snapshot, has_more: false } });
          return true;
        }
        return false;
      },
    });
    state.jobs = { 'job-a': { ...jobA, status: 'complete' }, 'job-b': jobB };
    try {
      await openPack(page);
      await page.locator('#open-builder-btn').click();
      await expect(page.locator('#builder-overlay')).toBeVisible();
      await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 50).toISOString()));
      state.packs.c = makePack('c', 'New Pack C');
      initialJobs.resolve();
      await expect(page.locator('#toast')).toContainText('New Pack C is ready');
      await page.locator('#builder-exit-btn').click();
      await expect.poll(() => state.requests.filter(entry => entry.path === '/api/study-packs').length).toBe(2);
      if (!overlap) {
        firstRefresh.resolve();
        await expect(page.locator('[data-pack-id="c"] [data-pack-open]')).toBeVisible();
      }
      state.jobs['job-b'] = { ...jobB, status: 'complete' };
      state.packs.d = makePack('d', 'New Pack D');
      await page.clock.runFor(12050);
      await expect(page.locator('#toast')).toContainText('New Pack D is ready');
      firstRefresh.resolve();
      await expect(page.locator('[data-pack-id="d"] [data-pack-open]')).toBeVisible();
      expect(state.requests.filter(entry => entry.path === '/api/study-packs').length).toBe(3);
      expect(state.requests.filter(entry => entry.path === '/api/study-packs/a').length).toBe(1);
      expect(state.browserErrors).toEqual([]);
    } finally {
      initialJobs.resolve();
      firstRefresh.resolve();
    }
  });
}

for (const [backSize, failFirst] of [[1000, false], [58000, false], [58000, true]]) {
test(`lifecycle flush shares and releases the keepalive budget for a ${backSize}-byte edit (${failFirst ? 'rejected' : 'saved'}) and highlights`, async ({ page }) => {
  await page.clock.install();
  const replies = deferred();
  let rejectFirst = failFirst;
  const state = await installStudy(page, { route: async (route, _state, entry) => {
    if (entry.method === 'PATCH' && entry.path === '/api/study-packs/a') {
      await replies.promise;
      if (rejectFirst && entry.payload.flashcards) {
        rejectFirst = false;
        await route.fulfill({ status: 503, json: { error: 'Synthetic save outage.' } });
        return true;
      }
    }
    return false;
  } });
  state.packs.a.notes_markdown = '# Pack A\n\n' + 'word '.repeat(600);
  state.packs.a.notes_highlights = {
    base_key: 'a:0:' + state.packs.a.notes_markdown.length, updated_at: Date.now() / 1000,
    ranges: Array.from({ length: 500 }, (_, index) => ({ start: 6 + index * 5, end: 8 + index * 5, color: 'yellow' })),
  };
  await page.addInitScript(() => {
    const original = window.fetch;
    window.followupFetches = [];
    window.fetch = function (input, options = {}) {
      const entry = {
        method: options.method || 'GET', path: new URL(input, location.href).pathname,
        keepalive: !!options.keepalive, bytes: new Blob([options.body || '']).size, rejected: false,
      };
      window.followupFetches.push(entry);
      return original.apply(this, arguments).catch(error => { entry.rejected = true; throw error; });
    };
  });
  try {
    await openPack(page, 'word');
    await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(500);
    await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 50).toISOString()));
    await page.locator('[data-hl-color="green"]').click();
    await page.locator('#notes-view h1').evaluate(mark => {
      const range = document.createRange();
      range.selectNodeContents(mark);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      mark.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.clock.runFor(150);
    if (await page.locator('#notes-view mark[data-hl="green"]').count() === 0) await page.clock.runFor(900);
    await expect(page.locator('#notes-view mark[data-hl="green"]')).toHaveCount(1);
    await page.locator('#editor-tab-flashcards').click();
    await page.locator('#editor-card-back-0').fill('x'.repeat(backSize));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(() => state.requests.filter(entry => entry.method === 'PATCH' && entry.path === '/api/study-packs/a').length).toBe(2);
    const fetches = await page.evaluate(() => window.followupFetches.filter(entry => entry.method === 'PATCH' && entry.path === '/api/study-packs/a'));
    expect(fetches.reduce((sum, entry) => sum + (entry.keepalive ? entry.bytes : 0), 0)).toBeLessThanOrEqual(65536);
    expect(fetches.some(entry => entry.rejected)).toBe(false);
    replies.resolve();
    await expect(page.locator('#pack-save-status')).toHaveText(failFirst ? 'Save failed' : 'Saved');
    await page.locator('#editor-card-back-0').fill('y'.repeat(10000));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(() => state.packs.a.flashcards[0].back).toBe('y'.repeat(10000));
    const followup = await page.evaluate(() => window.followupFetches.filter(entry => entry.method === 'PATCH' && entry.path === '/api/study-packs/a').at(-1));
    expect(followup.keepalive).toBe(true);
    expect(followup.rejected).toBe(false);
  } finally {
    replies.resolve();
  }
});
}
