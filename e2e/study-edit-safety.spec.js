const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function makePack(id, title) {
  return {
    study_pack_id: id, title, mode: 'manual', folder_id: '',
    notes_markdown: `# ${title}\n\nStudy this synthetic example before reviewing the cards.`,
    flashcards_count: 1, test_questions_count: 1,
    flashcards: [{ front: `${title} prompt`, back: `${title} answer` }],
    test_questions: [{ question: `${title} question`, options: ['Yes', 'No'], answer: 'Yes' }],
  };
}

async function installLibrary(page, options = {}) {
  const state = {
    packs: { a: makePack('a', 'Pack A'), b: makePack('b', 'Pack B') },
    requests: [], patches: [], errors: [],
  };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(({ theme, cachedJob }) => {
    const user = { uid: 'edit-fixture', email: 'edit@example.test', getIdToken: () => Promise.resolve('fixture-token') };
    const auth = {
      currentUser: user, setPersistence: () => Promise.resolve(), authStateReady: () => Promise.resolve(),
      onAuthStateChanged: callback => { queueMicrotask(() => callback(user)); return () => {}; },
    };
    function factory() { return auth; }
    factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: factory };
    localStorage.setItem('lp-preferences', JSON.stringify({ language: 'en', theme }));
    localStorage.setItem('lp-preferences:edit-fixture', JSON.stringify({ language: 'en', theme }));
    if (cachedJob) localStorage.setItem('lp_ui_v2:user:edit-fixture:active_runtime_jobs', JSON.stringify([cachedJob]));
    window.editFixtureFetches = [];
    const originalFetch = window.fetch;
    window.fetch = function (url, init = {}) {
      window.editFixtureFetches.push({
        path: new URL(url, location.href).pathname, method: init.method || 'GET',
        keepalive: init.keepalive === true, body: init.body || null,
      });
      return originalFetch.apply(this, arguments);
    };
  }, { theme: options.theme || 'light', cachedJob: options.cachedJob || null });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  // Optional baseline is executable behavior, used to prove regressions fail before the fix.
  if (process.env.STUDY_EDIT_TEST_SOURCE) {
    const source = readFileSync(process.env.STUDY_EDIT_TEST_SOURCE, 'utf8');
    await page.route(/\/static\/js\/study(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', body: source }));
  }
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const entry = { path, method: request.method(), payload: request.postDataJSON() };
    state.requests.push(entry);
    if (options.route && await options.route(route, state, entry)) return;
    let payload = {};
    if (path === '/api/auth/user') payload = { uid: 'edit-fixture', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/user-preferences') payload = { preferences: { interface_language: 'en', theme: options.theme || 'light' } };
    else if (path === '/api/study-folders') payload = { folders: [] };
    else if (path === '/api/study-plan/membership') payload = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (path === '/api/study-packs' && entry.method === 'POST') {
      const id = `created-${Object.keys(state.packs).length + 1}`;
      state.packs[id] = { ...makePack(id, entry.payload.title), ...structuredClone(entry.payload),
        study_pack_id: id, flashcards_count: entry.payload.flashcards.length, test_questions_count: entry.payload.test_questions.length };
      payload = { ok: true, study_pack_id: id };
    }
    else if (path === '/api/study-packs') payload = { study_packs: Object.values(state.packs), has_more: false };
    else if (/^\/api\/study-packs\/[^/]+$/.test(path)) {
      const id = path.split('/').pop();
      const pack = state.packs[id];
      if (!pack) return route.fulfill({ status: 404, json: { error: 'Pack unavailable.' } });
      if (entry.method === 'PATCH') {
        state.patches.push(entry);
        if (options.beforePatch) await options.beforePatch(id, entry.payload, state);
        Object.assign(pack, structuredClone(entry.payload));
        payload = { ok: true, study_pack_id: id };
      } else {
        // Capture at request time, as an actual server response would.
        payload = structuredClone(pack);
        if (options.beforeGet) await options.beforeGet(id, state);
      }
    } else if (path.includes('study-progress')) payload = { card_states: {}, daily_progress: {} };
    await route.fulfill({ json: payload });
  });
  return state;
}

const openButton = (page, id) => page.locator(`#pack-list [data-pack-id="${id}"] [data-pack-open]`);
const getCount = (state, path) => state.requests.filter(entry => entry.path === path && entry.method === 'GET').length;

async function openInitialPack(page) {
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  await expect(page.locator('#notes-view')).toContainText('Study this synthetic example');
  await page.locator('.pack-details-disclosure > summary').click();
}

async function editTitle(page, value) {
  if (!await page.locator('#pack-title').isVisible()) await page.locator('.pack-details-disclosure > summary').click();
  await page.locator('#pack-title').fill(value);
}

async function selectParagraph(page) {
  await page.locator('#notes-view p').evaluate(paragraph => {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

async function highlightParagraph(page) {
  await selectParagraph(page);
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(1);
}

test('an edit followed immediately by another pack saves only its original pack', async ({ page }) => {
  const nextGet = deferred();
  const state = await installLibrary(page, { beforeGet: id => id === 'b' ? nextGet.promise : undefined });
  await openInitialPack(page);
  const originalB = structuredClone(state.packs.b);
  await page.locator('#pack-title').fill('Pack A edited');
  await openButton(page, 'b').click();
  await expect.poll(() => state.packs.a.title).toBe('Pack A edited');
  expect(state.packs.b).toEqual(originalB);
  nextGet.resolve();
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  expect(state.patches.map(entry => entry.path)).toEqual(['/api/study-packs/a']);
  expect(state.errors).toEqual([]);
});

test('the latest pack selection wins over an older slow pack response', async ({ page }) => {
  const oldGet = deferred();
  let returnedA = false;
  const state = await installLibrary(page, { beforeGet: async id => {
    if (id === 'a') { await oldGet.promise; returnedA = true; }
  } });
  await page.goto('/study');
  await openButton(page, 'a').click();
  await expect.poll(() => getCount(state, '/api/study-packs/a')).toBe(1);
  await openButton(page, 'b').click();
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  oldGet.resolve();
  await expect.poll(() => returnedA).toBe(true);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  await expect(page.locator('#pack-list [data-pack-id="b"]')).toHaveAttribute('aria-current', 'true');
  expect(state.errors).toEqual([]);
});

test('late progress for the previous pack cannot reset the next pack edit baseline', async ({ page }) => {
  const progressA = deferred();
  const state = await installLibrary(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-progress/packs/a') return false;
    await progressA.promise;
    await route.fulfill({ json: { card_states: {} } });
    return true;
  } });
  await page.goto('/study');
  await openButton(page, 'a').click();
  await expect.poll(() => getCount(state, '/api/study-progress/packs/a')).toBe(1);
  await openButton(page, 'b').click();
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  await editTitle(page, 'Pack B revised');
  progressA.resolve();
  await expect.poll(() => state.packs.b.title).toBe('Pack B revised');
  expect(state.packs.a.title).toBe('Pack A');
  expect(state.errors).toEqual([]);
});

test('a completed background job refreshes the list without reopening the edited pack', async ({ page }) => {
  const activeJobs = deferred();
  const cachedJob = { job_id: 'synthetic-job', status: 'processing', study_pack_title: 'New synthetic pack', started_at: 1 };
  const state = await installLibrary(page, { cachedJob, route: async (route, _state, entry) => {
    if (entry.path !== '/api/runtime-jobs/active') return false;
    await activeJobs.promise;
    await route.fulfill({ json: { jobs: [] } });
    return true;
  } });
  await page.route('**/status/synthetic-job', route => route.fulfill({ json: { status: 'complete' } }));
  await openInitialPack(page);
  await expect.poll(() => getCount(state, '/api/runtime-jobs/active')).toBe(1);
  await page.locator('#pack-title').fill('Edit during completion');
  activeJobs.resolve();
  await expect.poll(() => getCount(state, '/api/study-packs')).toBe(2);
  await expect(page.locator('#pack-title')).toHaveValue('Edit during completion');
  await expect.poll(() => state.packs.a.title).toBe('Edit during completion');
  expect(getCount(state, '/api/study-packs/a')).toBe(1);
  expect(state.errors).toEqual([]);
});

test('a failed pack load restores the previous selection and leaves its editor usable', async ({ page }) => {
  const state = await installLibrary(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/b') return false;
    await route.fulfill({ status: 503, json: { error: 'Pack temporarily unavailable.' } });
    return true;
  } });
  await openInitialPack(page);
  await openButton(page, 'b').click();
  await expect(page.locator('#toast')).toContainText('Pack temporarily unavailable.');
  await expect(page.locator('#pack-list [data-pack-id="a"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  await page.locator('#pack-title').fill('Still editing A');
  await expect.poll(() => state.packs.a.title).toBe('Still editing A');
  expect(state.packs.b.title).toBe('Pack B');
  expect(state.errors).toEqual([]);
});

for (const workspace of ['builder', 'learn']) {
  test(`background completion leaves an open ${workspace} workspace alone`, async ({ page }) => {
    const activeJobs = deferred();
    const cachedJob = { job_id: 'synthetic-job', status: 'processing', study_pack_title: 'New synthetic pack', started_at: 1 };
    const state = await installLibrary(page, { cachedJob, route: async (route, _state, entry) => {
      if (entry.path !== '/api/runtime-jobs/active') return false;
      await activeJobs.promise;
      await route.fulfill({ json: { jobs: [] } });
      return true;
    } });
    await page.route('**/status/synthetic-job', route => route.fulfill({ json: { status: 'complete' } }));
    await openInitialPack(page);
    if (workspace === 'builder') {
      await page.locator('#open-builder-btn').click();
      await expect(page.locator('#builder-overlay')).toBeVisible();
    } else {
      await page.locator('#open-learn-btn').click();
      await expect(page.locator('#setup-overlay')).toBeVisible();
      await page.locator('#setup-start-btn').click();
      await page.locator('[data-study-mode="flashcards"]').click();
      await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
    }
    activeJobs.resolve();
    await expect(page.locator('#toast')).toContainText('ready in your library');
    await page.waitForLoadState('networkidle');
    expect(getCount(state, '/api/study-packs')).toBe(1);
    expect(getCount(state, '/api/study-packs/a')).toBe(1);
    await expect(page.locator(workspace === 'builder' ? '#builder-overlay' : '#learn-stage')).toBeVisible();
    expect(state.errors).toEqual([]);
  });
}

test('switching during a save also retains the edit made while that save was in flight', async ({ page }) => {
  const firstSave = deferred();
  let saves = 0;
  const state = await installLibrary(page, { beforePatch: async id => {
    if (id === 'a' && ++saves === 1) await firstSave.promise;
  } });
  await openInitialPack(page);
  await page.locator('#pack-title').fill('First edit');
  await expect.poll(() => state.patches.length).toBe(1);
  await page.locator('#pack-title').fill('Latest edit');
  await openButton(page, 'b').click();
  firstSave.resolve();
  await expect.poll(() => state.packs.a.title).toBe('Latest edit');
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  expect(state.packs.b.title).toBe('Pack B');
  await editTitle(page, 'B independently edited');
  await expect.poll(() => state.packs.b.title).toBe('B independently edited');
  expect(state.packs.a.title).toBe('Latest edit');
  expect(state.errors).toEqual([]);
});

test('a failed save keeps the typed content open until a successful retry', async ({ page }) => {
  let failSave = true;
  const state = await installLibrary(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/a' || entry.method !== 'PATCH' || !failSave) return false;
    await route.fulfill({ status: 503, json: { error: 'Save temporarily unavailable.' } });
    return true;
  } });
  await openInitialPack(page);
  await page.locator('#pack-title').fill('Keep this unsaved edit');
  await openButton(page, 'b').click();
  await expect(page.locator('#toast')).toContainText('Save temporarily unavailable.');
  await expect(page.locator('#pack-title')).toHaveValue('Keep this unsaved edit');
  await expect(page.locator('#pack-list [data-pack-id="a"]')).toHaveAttribute('aria-current', 'true');
  expect(getCount(state, '/api/study-packs/b')).toBe(0);
  failSave = false;
  await openButton(page, 'b').click();
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  expect(state.packs.a.title).toBe('Keep this unsaved edit');
  expect(state.errors).toEqual([]);
});

test('multiple pack choices during a save finish on the most recent choice', async ({ page }) => {
  const firstSave = deferred();
  let saves = 0;
  const state = await installLibrary(page, { beforePatch: async id => {
    if (id === 'a' && ++saves === 1) await firstSave.promise;
  } });
  state.packs.c = makePack('c', 'Pack C');
  await openInitialPack(page);
  await page.locator('#pack-title').fill('First edit');
  await expect.poll(() => state.patches.length).toBe(1);
  await page.locator('#pack-title').fill('Final A edit');
  await openButton(page, 'b').click();
  await openButton(page, 'c').click();
  firstSave.resolve();
  await expect(page.locator('#pack-title')).toHaveValue('Pack C');
  await expect.poll(() => state.packs.a.title).toBe('Final A edit');
  await expect(page.locator('#pack-list [data-pack-id="c"]')).toHaveAttribute('aria-current', 'true');
  expect(state.packs.b.title).toBe('Pack B');
  expect(state.packs.c.title).toBe('Pack C');
  expect(state.errors).toEqual([]);
});

test('creating a pack after an inline edit preserves both packs independently', async ({ page }) => {
  const state = await installLibrary(page);
  await openInitialPack(page);
  await page.locator('#pack-title').fill('A edit before creating');
  await page.locator('#create-pack-btn').click();
  await expect(page.locator('#builder-overlay')).toBeVisible();
  await page.locator('#builder-title-input').fill('Created in Builder');
  await page.locator('#builder-save-btn').click();
  await expect(page.locator('#builder-stat-dirty')).toHaveText('Saved');
  await page.locator('#builder-exit-btn').click();
  await expect(page.locator('#builder-overlay')).toBeHidden();
  await expect(page.locator('#pack-title')).toHaveValue('Created in Builder');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(() => state.packs.a.title).toBe('A edit before creating');
  expect(state.packs.a.flashcards[0].front).toBe('Pack A prompt');
  expect(state.packs['created-3'].title).toBe('Created in Builder');
  expect(state.packs['created-3'].flashcards).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('Builder autosave updates inline fields before a later lifecycle save', async ({ page }) => {
  const state = await installLibrary(page);
  await openInitialPack(page);
  await page.locator('#open-builder-btn').click();
  await expect(page.locator('#builder-overlay')).toBeVisible();
  await page.locator('#builder-title-input').fill('A edited in Builder');
  await expect.poll(() => state.packs.a.title).toBe('A edited in Builder');
  await expect(page.locator('#builder-stat-dirty')).toHaveText('Saved');
  await page.locator('#builder-exit-btn').click();
  await expect(page.locator('#builder-overlay')).toBeHidden();
  await expect(page.locator('#pack-title')).toHaveValue('A edited in Builder');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(state.packs.a.title).toBe('A edited in Builder');
  expect(state.errors).toEqual([]);
});

for (const eventName of ['pagehide', 'visibilitychange']) {
  test(`${eventName} flushes pending edits and highlights with keepalive`, async ({ page }) => {
    await page.clock.install();
    const state = await installLibrary(page);
    await openInitialPack(page);
    await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 50).toISOString()));
    await selectParagraph(page);
    await page.clock.runFor(120);
    if (await page.locator('#notes-view mark[data-hl]').count() === 0) await page.clock.runFor(900);
    await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(1);
    expect(state.patches).toHaveLength(0);
    await page.locator('#pack-title').fill('Saved when leaving');
    await page.evaluate(name => {
      if (name === 'visibilitychange') {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event(name));
      } else window.dispatchEvent(new PageTransitionEvent(name));
    }, eventName);
    await expect.poll(() => state.packs.a.title).toBe('Saved when leaving');
    await expect.poll(() => state.packs.a.notes_highlights?.ranges.length).toBe(1);
    const saves = await page.evaluate(() => window.editFixtureFetches.filter(entry => entry.method === 'PATCH' && entry.path === '/api/study-packs/a'));
    expect(saves.some(entry => JSON.parse(entry.body).title === 'Saved when leaving' && entry.keepalive)).toBe(true);
    expect(saves.some(entry => JSON.parse(entry.body).notes_highlights?.ranges.length === 1 && entry.keepalive)).toBe(true);
    expect(state.errors).toEqual([]);
  });
}

test('beforeunload warns for a pending inline save and clears after acknowledgement', async ({ page }) => {
  const pendingSave = deferred();
  const state = await installLibrary(page, { beforePatch: () => pendingSave.promise });
  await openInitialPack(page);
  const warningActive = () => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
  expect(await warningActive()).toBe(false);
  await page.locator('#pack-title').fill('Pending save');
  expect(await warningActive()).toBe(true);
  await expect.poll(() => state.patches.length).toBe(1);
  expect(await warningActive()).toBe(true);
  pendingSave.resolve();
  await expect(page.locator('#pack-save-status')).toHaveText('Saved');
  expect(await warningActive()).toBe(false);
});

for (const newer of ['local', 'server']) {
  test(`reload keeps the newer ${newer} highlight payload`, async ({ page }) => {
    const state = await installLibrary(page);
    await openInitialPack(page);
    await highlightParagraph(page);
    await expect.poll(() => state.packs.a.notes_highlights?.ranges.length).toBe(1);
    const original = structuredClone(state.packs.a.notes_highlights);
    const local = { ...original, updated_at: original.updated_at + 100,
      ranges: original.ranges.map(range => ({ ...range, color: 'green' })) };
    state.packs.a.notes_highlights = { ...original, updated_at: original.updated_at + (newer === 'server' ? 200 : 50),
      ranges: original.ranges.map(range => ({ ...range, color: 'blue' })) };
    await page.evaluate(payload => localStorage.setItem('hl_ranges_a', JSON.stringify(payload)), local);
    await page.reload();
    await expect(page.locator('#notes-view mark[data-hl]')).toHaveAttribute('data-hl', newer === 'local' ? 'green' : 'blue');
    await expect.poll(() => state.packs.a.notes_highlights?.ranges[0]?.color).toBe(newer === 'local' ? 'green' : 'blue');
    expect(state.errors).toEqual([]);
  });
}

test('an unsynced highlight clear survives reload and is sent again', async ({ page }) => {
  let failClears = true;
  let clearAttempts = 0;
  const state = await installLibrary(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/a' || entry.method !== 'PATCH' || entry.payload.notes_highlights !== null) return false;
    clearAttempts += 1;
    if (!failClears) return false;
    await route.fulfill({ status: 503, json: { error: 'Highlight save temporarily unavailable.' } });
    return true;
  } });
  await openInitialPack(page);
  await highlightParagraph(page);
  await expect.poll(() => state.packs.a.notes_highlights?.ranges.length).toBe(1);
  await page.locator('#hl-clear-all').click();
  await expect.poll(() => clearAttempts).toBeGreaterThan(0);
  expect(state.packs.a.notes_highlights.ranges).toHaveLength(1);
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.locator('#notes-view')).toContainText('Study this synthetic example');
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(0);
  failClears = false;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(() => state.packs.a.notes_highlights).toBeNull();
  expect(clearAttempts).toBeGreaterThan(1);
  expect(state.errors).toEqual([]);
});

test('an older failed highlight save cannot replace newer highlights in either pack', async ({ page }) => {
  const oldResponse = deferred();
  let highlightAttempts = 0;
  const state = await installLibrary(page, { route: async (route, _state, entry) => {
    if (entry.path !== '/api/study-packs/a' || entry.method !== 'PATCH' || !entry.payload.notes_highlights) return false;
    highlightAttempts += 1;
    if (highlightAttempts !== 1) return false;
    await oldResponse.promise;
    await route.fulfill({ status: 503, json: { error: 'Highlight save temporarily unavailable.' } });
    return true;
  } });
  await openInitialPack(page);
  await highlightParagraph(page);
  await expect.poll(() => highlightAttempts).toBe(1);
  await page.locator('[data-hl-color="green"]').click();
  await highlightParagraph(page);
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveAttribute('data-hl', 'green');
  await openButton(page, 'b').click();
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  await page.locator('[data-hl-color="blue"]').click();
  await highlightParagraph(page);
  oldResponse.resolve();
  await expect.poll(() => state.packs.a.notes_highlights?.ranges[0]?.color).toBe('green');
  await expect.poll(() => state.packs.b.notes_highlights?.ranges[0]?.color).toBe('blue');
  expect(state.errors).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`saved library editor remains readable at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      const state = await installLibrary(page, { theme });
      await page.setViewportSize({ width, height: 960 });
      await openInitialPack(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.locator('#pack-title').fill('Revised synthetic notes');
      await expect.poll(() => state.packs.a.title).toBe('Revised synthetic notes');
      await expect(page.locator('#pack-save-status')).toHaveText('Saved');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('#toast')).not.toHaveClass(/visible/);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: testInfo.outputPath(`library-edit-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      expect(state.errors).toEqual([]);
    });
  }
}
