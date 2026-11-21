const { test, expect } = require('@playwright/test');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { resolve } = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');
test.describe.configure({ mode: 'parallel' });

async function realPlannedResponse() {
  const port = await new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const available = server.address().port;
      server.close(() => resolve(available));
    });
  });
  const python = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';
  const child = spawn(python, ['scripts/run_ui_preview.py', '--port', String(port)], {
    cwd: process.cwd(), env: { ...process.env, PLANNER_STATEFUL_FIXTURE: '1' }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: 'Bearer planner-fixture-token', 'Content-Type': 'application/json' };
  try {
    await expect.poll(async () => {
      try { return (await fetch(base + '/')).status; } catch (_) { return 0; }
    }, { timeout: 15000 }).toBe(200);
    const created = await fetch(base + '/api/study-plan/items/revision_session', { method: 'PUT', headers, body: JSON.stringify({
      pack_id: 'fixture_mixed', title: 'Planned content revision', date: new Date().toISOString().slice(0, 10),
      time: '17:00', duration: 45, planned_outcomes: { flashcards: 4, questions: 2 },
    }) });
    expect(created.status).toBe(201);
    const pack = await fetch(base + '/api/study-packs/fixture_mixed', { headers });
    const started = await fetch(base + '/api/study-plan/items/revision_session/run', {
      method: 'POST', headers, body: JSON.stringify({ study_mode: 'flashcards', timer_mode: 'countdown' }),
    });
    expect(pack.status).toBe(200); expect(started.status).toBe(200);
    return { pack: await pack.json(), start: await started.json() };
  } finally {
    if (child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const contentFields = ['notes_markdown', 'flashcards', 'test_questions'];
// The isolated preview uses source scripts unless this flag selects built assets.
const useMinifiedStudy = ['1', 'true', 'yes', 'on'].includes((process.env.USE_MINIFIED_JS_ASSETS || '').trim().toLowerCase());
const expectedStudyPath = `/static/js/study${useMinifiedStudy ? '.min' : ''}.js`;
const expectedStudyHash = createHash('sha256').update(readFileSync(resolve(__dirname, '..', '.' + expectedStudyPath))).digest('hex');

async function expectStudyAssets(state) {
  const assets = await Promise.all(state.assets);
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) expect(asset).toMatchObject({
    path: expectedStudyPath, status: 200, type: 'script', sha256: expectedStudyHash,
  });
  return assets;
}

function contentRevision(pack) {
  return createHash('sha256').update(JSON.stringify(contentFields.map(field => pack[field]))).digest('hex');
}

function makeState() {
  return {
    pack: {
      study_pack_id: 'a', title: 'Revision pack', mode: 'manual', folder_id: '',
      notes_markdown: '# Shared notes\n\nShared synthetic notes for concurrent editing.',
      flashcards: [
        { front: 'First question', back: 'First original answer', image_ids: [] },
        { front: 'Second question', back: 'Second original answer', image_ids: [] },
      ],
      test_questions: [], flashcards_count: 2, test_questions_count: 0,
    },
    patches: [], errors: [], assets: [], rejectContent: false, afterCommit: null,
  };
}

async function installPage(page, state, tab, preferences = { language: 'en', theme: 'light' }) {
  await installAccountFixture(page);
  await page.addInitScript(preferences => localStorage.setItem('lp-preferences', JSON.stringify(preferences)), preferences);
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path !== '/static/js/study.js' && path !== '/static/js/study.min.js') return;
    state.assets.push(response.body().then(body => ({
      tab, path, status: response.status(), type: response.request().resourceType(),
      sha256: createHash('sha256').update(body).digest('hex'),
    }), error => ({ tab, path, error: error.message })));
  });
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.route('https://browser.sentry-cdn.com/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/auth/user') body = { uid: 'a', credits: 100, credits_version: 2, preferences: { onboarding_completed: true } };
    else if (path === '/api/user-preferences') body = { preferences: { interface_language: preferences.language, theme: preferences.theme } };
    else if (path === '/api/study-folders') body = { folders: [] };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') body = { jobs: [] };
    else if (path === '/api/study-packs') body = { study_packs: [structuredClone(state.pack)], has_more: false };
    else if (path.includes('/images/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPRsAAAAASUVORK5CYII=', 'base64') });
    else if (path === '/api/study-packs/a' && request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      const entry = { tab, payload, status: null };
      state.patches.push(entry);
      if (state.patchStatus) {
        entry.status = state.patchStatus;
        return route.fulfill({ status: state.patchStatus, json: { error: 'This pack cannot be updated.', error_code: state.patchCode || 'invalid_request' } });
      }
      const changesContent = contentFields.some(field => Object.hasOwn(payload, field));
      const revision = contentRevision(state.pack);
      // Stage-one compatibility permits absent tokens, so the released client
      // exposes its real lost-update behavior instead of only a missing-field failure.
      const stale = Object.hasOwn(payload, 'base_content_revision') && payload.base_content_revision !== revision;
      if (changesContent && (state.rejectContent || stale)) {
        entry.status = 409;
        return route.fulfill({ status: 409, json: {
          error: 'This study pack changed elsewhere. Reload it before saving your changes.',
          error_code: 'content_revision_conflict', content_revision: revision,
        } });
      }
      for (const [field, value] of Object.entries(payload)) {
        if (field !== 'base_content_revision') state.pack[field] = structuredClone(value);
      }
      state.pack.flashcards_count = state.pack.flashcards.length;
      state.pack.test_questions_count = state.pack.test_questions.length;
      body = { ok: true, study_pack_id: 'a', content_revision: contentRevision(state.pack) };
      entry.status = 200;
      if (state.afterCommit) await state.afterCommit(entry);
      if (state.missingAck) delete body.content_revision;
    } else if (path === '/api/study-packs/a') {
      if (state.beforeGet) await state.beforeGet();
      if (state.getStatus) return route.fulfill({ status: state.getStatus, json: { error: 'This pack cannot be loaded.' } });
      body = { ...structuredClone(state.pack), content_revision: contentRevision(state.pack) };
      if (state.missingToken) delete body.content_revision;
    } else if (path.includes('study-progress')) body = { card_states: {}, daily_progress: {}, timezone: 'UTC' };
    return route.fulfill({ json: body });
  });
}

async function openPack(page) {
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Revision pack');
  await expect(page.locator('#notes-view')).toContainText('Shared synthetic notes');
}

async function openCards(page) {
  await page.locator('#editor-tab-flashcards').click();
  // Library card rows start closed; Edit opens the first one for editing.
  if (!await page.locator('#editor-card-back-0').isVisible()) await page.locator('#flashcard-editor-list [data-row-index="0"] > summary').click();
  await expect(page.locator('#editor-card-back-0')).toBeVisible();
}

async function editCard(page, index, answer) {
  const field = page.locator(`#editor-card-back-${index}`);
  if (!await field.isVisible()) await page.locator(`[data-row-index="${index}"] > summary`).click();
  await field.fill(answer);
}

async function editTitle(page, title) {
  if (!await page.locator('#pack-title').isVisible()) await page.locator('.pack-details-disclosure > summary').click();
  await page.locator('#pack-title').fill(title);
}

async function expectBuilderNoticeToFit(page) {
  const notice = page.locator('#builder-edit-notice');
  await expect(notice).toBeVisible();
  const bounds = await notice.evaluate(element => {
    const rail = element.closest('.builder-rail').getBoundingClientRect();
    return [element, ...element.querySelectorAll('p, button, select')].map(child => {
      const box = child.getBoundingClientRect();
      return { text: child.textContent, left: box.left, right: box.right,
        railLeft: rail.left, railRight: rail.right,
        scrollWidth: child.scrollWidth, clientWidth: child.clientWidth };
    });
  });
  for (const bound of bounds) {
    expect(bound.left, bound.text).toBeGreaterThanOrEqual(bound.railLeft);
    expect(bound.right, bound.text).toBeLessThanOrEqual(bound.railRight);
    expect(bound.scrollWidth, bound.text).toBeLessThanOrEqual(bound.clientWidth + 1);
  }
  for (const button of await notice.locator('button').all()) await expect(button).toBeInViewport();
}

async function resetFullPageCapture(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.getSelection()?.removeAllRanges();
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function twoEditors(page, context, state) {
  const other = await context.newPage();
  await Promise.all([installPage(page, state, 'first'), installPage(other, state, 'second')]);
  await Promise.all([openPack(page), openPack(other)]);
  expect((await expectStudyAssets(state)).map(asset => asset.tab).sort()).toEqual(['first', 'second']);
  return other;
}

const unsavedWarning = page => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
const tabPatches = (state, tab) => state.patches.filter(entry => entry.tab === tab);

test('two inline card editors keep the first save and preserve the rejected second draft', async ({ page, context }) => {
  const state = makeState();
  const other = await twoEditors(page, context, state);
  await Promise.all([openCards(page), openCards(other)]);
  await editCard(page, 0, 'First tab saved answer');
  await expect.poll(() => state.pack.flashcards[0].back).toBe('First tab saved answer');
  await editCard(other, 1, 'Second tab local answer');
  await expect.poll(() => tabPatches(state, 'second').length).toBe(1);
  expect(state.errors).toEqual([]);
  expect(state.pack.flashcards[0].back).toBe('First tab saved answer');
  expect(state.pack.flashcards[1].back).toBe('Second original answer');
  expect(tabPatches(state, 'second')[0].status).toBe(409);
  await expect(other.locator('#editor-card-back-1')).toHaveValue('Second tab local answer');
  expect(await unsavedWarning(other)).toBe(true);
});

test('an older Builder card draft cannot replace a newer inline card save', async ({ page, context }) => {
  const state = makeState();
  const other = await twoEditors(page, context, state);
  await openCards(page);
  await other.locator('#open-builder-btn').click();
  await other.locator('#builder-tab-flashcards').click();
  await other.locator('[data-fc-row="1"] > summary').click();
  await editCard(page, 0, 'Saved while Builder was open');
  await expect.poll(() => state.pack.flashcards[0].back).toBe('Saved while Builder was open');
  await other.locator('#builder-fc-back-1').fill('Builder local answer');
  await expect.poll(() => tabPatches(state, 'second').length).toBe(1);
  expect(state.errors).toEqual([]);
  expect(state.pack.flashcards[0].back).toBe('Saved while Builder was open');
  expect(state.pack.flashcards[1].back).toBe('Second original answer');
  expect(tabPatches(state, 'second')[0].status).toBe(409);
  await expect(other.locator('#builder-fc-back-1')).toHaveValue('Builder local answer');
  expect(await unsavedWarning(other)).toBe(true);
});

test('an observed content conflict keeps its draft and stops automatic lifecycle retries', async ({ page }) => {
  await page.clock.install();
  const state = makeState();
  await installPage(page, state, 'first');
  await openPack(page);
  await openCards(page);
  await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 50).toISOString()));
  state.rejectContent = true;
  await editCard(page, 0, 'Keep this rejected answer');
  await page.clock.runFor(1000);
  await expect.poll(() => state.patches[0]?.status).toBe(409);
  await expect(page.locator('#pack-save-status')).not.toHaveText('Saving...');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
  });
  await page.clock.runFor(2000);
  await expect(page.locator('#pack-save-status')).not.toHaveText('Saving...');
  expect(state.errors).toEqual([]);
  expect(state.pack.flashcards[0].back).toBe('First original answer');
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Keep this rejected answer');
  expect(await unsavedWarning(page)).toBe(true);
  expect(state.patches).toHaveLength(1);
});

test('a second local edit uses its own acknowledged save and keeps both changes', async ({ page }) => {
  const state = makeState();
  const firstReply = deferred();
  state.afterCommit = async () => { if (state.patches.length === 1) await firstReply.promise; };
  await installPage(page, state, 'first');
  await openPack(page);
  await openCards(page);
  try {
    await editCard(page, 0, 'First local saved answer');
    await expect.poll(() => state.pack.flashcards[0].back).toBe('First local saved answer');
    await editCard(page, 1, 'Queued local answer');
    firstReply.resolve();
    await expect.poll(() => state.pack.flashcards[1].back).toBe('Queued local answer');
    await expect(page.locator('#pack-save-status')).toHaveText('Saved');
    expect(state.pack.flashcards[0].back).toBe('First local saved answer');
    expect(state.patches.map(entry => entry.status)).toEqual([200, 200]);
    expect(await unsavedWarning(page)).toBe(false);
    expect(state.errors).toEqual([]);
  } finally { firstReply.resolve(); }
});

test('Builder preserves a second local edit while its first acknowledgement is held', async ({ page }) => {
  const state = makeState(), reply = deferred(); let firstRevision;
  state.afterCommit = () => { if (state.patches.length === 1) { firstRevision = contentRevision(state.pack); return reply.promise; } };
  await installPage(page, state, 'first'); await openPack(page);
  await page.locator('#open-builder-btn').click(); await page.locator('#builder-tab-flashcards').click();
  try {
    await page.locator('#builder-fc-back-0').fill('First Builder edit');
    await expect.poll(() => state.pack.flashcards[0].back).toBe('First Builder edit');
    await page.locator('[data-fc-row="1"] > summary').click();
    await page.locator('#builder-fc-back-1').fill('Later Builder edit');
    reply.resolve();
    await expect.poll(() => state.pack.flashcards[1].back).toBe('Later Builder edit');
    await expect(page.locator('#builder-stat-dirty')).toHaveText('Saved');
    expect(state.patches).toHaveLength(2);
    expect(state.patches[1].payload.base_content_revision).toBe(firstRevision);
    expect(state.pack.flashcards[0].back).toBe('First Builder edit');
    expect(await draftRecords(page)).toEqual([]);
  } finally { reply.resolve(); }
});

test('opening Builder drains an inline request and its later edit before transfer', async ({ page }) => {
  const state = makeState(), reply = deferred();
  state.afterCommit = () => state.patches.length === 1 ? reply.promise : undefined;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  try {
    await editCard(page, 0, 'Inline first edit');
    await expect.poll(() => state.pack.flashcards[0].back).toBe('Inline first edit');
    await page.locator('#open-builder-btn').click();
    await expect(page.locator('#builder-overlay')).toBeHidden();
    await editCard(page, 1, 'Inline later edit');
    reply.resolve();
    await expect(page.locator('#builder-overlay')).toBeVisible();
    await page.locator('#builder-tab-flashcards').click();
    await expect(page.locator('#builder-fc-back-0')).toHaveValue('Inline first edit');
    await expect(page.locator('#builder-fc-back-1')).toHaveValue('Inline later edit');
    expect(state.pack.flashcards[1].back).toBe('Inline later edit');
    expect(state.patches).toHaveLength(2);
  } finally { reply.resolve(); }
});

test('an inline metadata edit remains independent of a newer card revision', async ({ page, context }) => {
  const state = makeState();
  const other = await twoEditors(page, context, state);
  await openCards(page);
  await editCard(page, 0, 'New shared card answer');
  await expect.poll(() => state.pack.flashcards[0].back).toBe('New shared card answer');
  await editTitle(other, 'Independent metadata title');
  await expect.poll(() => state.pack.title).toBe('Independent metadata title');
  await expect(other.locator('#pack-save-status')).toHaveText('Saved');
  expect(state.pack.flashcards[0].back).toBe('New shared card answer');
  expect(tabPatches(state, 'second').map(entry => entry.status)).toEqual([200]);
  expect(state.errors).toEqual([]);
});

test('a Builder title-only edit preserves a newer card revision from another tab', async ({ page, context }) => {
  const state = makeState();
  const other = await twoEditors(page, context, state);
  await openCards(page);
  await other.locator('#open-builder-btn').click();
  await expect(other.locator('#builder-title-input')).toBeVisible();
  await editCard(page, 0, 'Remote content must stay');
  await expect.poll(() => state.pack.flashcards[0].back).toBe('Remote content must stay');
  await other.locator('#builder-title-input').fill('Builder metadata title');
  await expect.poll(() => state.pack.title).toBe('Builder metadata title');
  expect(state.errors).toEqual([]);
  expect(state.pack.flashcards[0].back).toBe('Remote content must stay');
  await expect(other.locator('#builder-stat-dirty')).toHaveText('Saved');
});

test('a rejected pagehide card draft remains recoverable after reloading the pack', async ({ page }) => {
  const state = makeState();
  await installPage(page, state, 'first');
  await openPack(page);
  await openCards(page);
  state.rejectContent = true;
  await editCard(page, 0, 'Recover this rejected local answer');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => state.patches[0]?.status).toBe(409);
  expect(state.pack.flashcards[0].back).toBe('First original answer');
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Recover this rejected local answer');
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await openCards(page);
  expect(state.errors).toEqual([]);
  expect(state.pack.flashcards[0].back).toBe('First original answer');
  await page.locator('#pack-edit-notice [data-edit-action="recover"]').click();
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Recover this rejected local answer');
  expect(await unsavedWarning(page)).toBe(true);
});

const draftRecords = page => page.evaluate(() => window.LectureProcessorStudyCache.listPending('a', 'pack-edit', { packId: 'a' }).records);
const recoverDraft = page => page.locator('#pack-edit-notice [data-edit-action="recover"]').click();
const reviewDraft = page => page.locator('#pack-edit-notice [data-edit-action="review"]').click();

for (const editor of ['inline cards', 'Builder notes']) {
  test(`planned session response remains an editable baseline for ${editor}`, async ({ page }) => {
    const response = await realPlannedResponse();
    const uid = response.start.run.uid, packId = response.pack.study_pack_id;
    const patches = [], errors = []; let packGets = 0;
    let run = structuredClone(response.start.run);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(uid => {
      const user = { uid, email: 'planner@example.test', getIdToken: () => Promise.resolve('planner-fixture-token') };
      const auth = { currentUser: user, setPersistence: () => Promise.resolve(), authStateReady: () => Promise.resolve(),
        onAuthStateChanged: callback => { queueMicrotask(() => callback(user)); return () => {}; } };
      const factory = () => auth; factory.Auth = { Persistence: { LOCAL: 'local' } };
      window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: factory };
      localStorage.setItem('lp-preferences', JSON.stringify({ language: 'en', theme: 'light' }));
    }, uid);
    await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.route('https://browser.sentry-cdn.com/**', route => route.abort());
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      let body = {};
      if (path === '/api/auth/user') body = { uid, email_verified: true, onboarding_completed: true, allowed: true };
      else if (path === '/api/user-preferences') body = { preferences: { interface_language: 'en', theme: 'light' } };
      else if (path === '/api/study-folders') body = { folders: [] };
      else if (path === '/api/study-plan/membership') body = { pack_ids: [packId] };
      else if (path === '/api/runtime-jobs/active') body = { jobs: [] };
      else if (path === '/api/study-packs') body = { study_packs: [response.pack], has_more: false };
      else if (path === '/api/study-plan/items/revision_session/run') body = response.start;
      else if (path === '/api/study-plan/runs/' + run.activity_id) {
        run = { ...run, ...request.postDataJSON() }; body = { run };
      } else if (path === '/api/study-packs/' + packId) {
        if (request.method() === 'PATCH') {
          const payload = request.postDataJSON();
          const status = payload.base_content_revision === response.start.run.content_fingerprint ? 200 : 409;
          patches.push({ payload, status });
          if (status !== 200) return route.fulfill({ status, json: { error: 'Content revision differs.', error_code: 'content_revision_conflict' } });
          Object.assign(response.pack, payload);
          body = { ok: true, content_revision: contentRevision(response.pack) };
        } else { packGets += 1; body = response.pack; }
      } else if (path.includes('study-progress')) body = { card_states: {}, daily_progress: {}, timezone: 'UTC' };
      return route.fulfill({ json: body });
    });
    await page.goto('/study?pack_id=' + packId + '&mode=learn&plan_item_id=revision_session');
    await expect(page.locator('#setup-overlay')).toBeVisible();
    for (const card of await page.locator('.lesson-card[data-lesson]').all()) {
      if (await card.getAttribute('aria-disabled') === 'true' || (await card.getAttribute('class')).includes('unavailable')) continue;
      if ((await card.getAttribute('aria-pressed') === 'true') !== (await card.getAttribute('data-lesson') === 'flashcards')) await card.click();
    }
    await page.locator('#setup-start-btn').click();
    await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
    await page.locator('#learn-back-library-btn').click();
    await expect(page.locator('#learn-stage')).not.toHaveClass(/visible/);
    if (editor === 'inline cards') {
      await openCards(page); await editCard(page, 0, 'Edited after planned learning');
    } else {
      await page.locator('#open-builder-btn').click();
      await page.locator('#builder-notes-input').fill('# Notes edited after planned learning');
    }
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].status).toBe(200);
    expect(patches[0].payload.base_content_revision).toBe(response.start.pack.content_revision);
    expect(patches[0].payload.base_content_revision).toBe(response.start.run.content_fingerprint);
    if (editor === 'inline cards') expect(patches[0].payload.flashcards[0].back).toBe('Edited after planned learning');
    else expect(patches[0].payload.notes_markdown).toBe('# Notes edited after planned learning');
    await expect(page.locator(editor === 'inline cards' ? '#pack-save-status' : '#builder-stat-dirty')).toHaveText('Saved');
    await expect(page.locator('#pack-edit-notice')).toBeHidden();
    await expect(page.locator('#builder-edit-notice')).toBeHidden();
    expect(packGets).toBe(1);
    expect(errors).toEqual([]);
  });
}

test('an over-limit pending draft collection displays its read warning and preserves every record', async ({ page }) => {
  const state = makeState(); await installPage(page, state, 'first'); await openPack(page);
  const before = await page.evaluate(revision => {
    const cache = window.LectureProcessorStudyCache, token = cache.capture('a');
    const prefix = 'lp_ui_v2:user:a:study_cache:pack-edit:';
    const id = crypto.randomUUID();
    const payload = { schema: 1, pack_id: 'a', editor_session_id: 'other-tab', snapshot_id: id, edit_generation: 1,
      editor_mode: 'inline', base_content_revision: revision, changes: { notes_markdown: 'Pending synthetic notes' },
      saved_at: Date.now(), phase: 'pending' };
    if (!cache.set(token, 'pack-edit', id, payload, { packId: 'a', pending: true })) throw new Error('Synthetic draft setup failed');
    const seed = JSON.parse(localStorage.getItem(prefix + id));
    for (let index = 1; index < 51; index += 1) {
      const next = structuredClone(seed); next.id = crypto.randomUUID(); next.payload.snapshot_id = next.id;
      next.write_id = crypto.randomUUID(); next.fences.key = '';
      localStorage.setItem(prefix + next.id, JSON.stringify(next));
    }
    const records = Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => [key, localStorage.getItem(key)]).sort();
    if (!records.every(([key]) => cache.get('a', 'pack-edit', key.slice(prefix.length)))) throw new Error('Synthetic draft fences invalid');
    return { records, result: cache.listPending('a', 'pack-edit', { packId: 'a' }) };
  }, contentRevision(state.pack));
  expect(before.records).toHaveLength(51);
  expect(before.result).toEqual({ ok: false, records: [] });
  page.once('dialog', dialog => dialog.accept()); await page.reload();
  await expect(page.locator('#pack-edit-notice')).toContainText('Some device drafts could not be read or cleared. Keep this tab open.');
  await expect(page.locator('#pack-edit-notice')).toBeVisible();
  const after = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('lp_ui_v2:user:a:study_cache:pack-edit:'))
    .map(key => [key, localStorage.getItem(key)]).sort());
  expect(after).toEqual(before.records);
  expect(state.patches).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('reverting before a held acknowledgement survives pagehide and reload', async ({ page }) => {
  const state = makeState(), reply = deferred();
  state.afterCommit = () => reply.promise;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  try {
    await editCard(page, 0, 'Committed while acknowledgement is held');
    await expect.poll(() => state.pack.flashcards[0].back).toBe('Committed while acknowledgement is held');
    await editCard(page, 0, 'First original answer');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(async () => (await draftRecords(page))[0]?.payload.changes.flashcards[0].back).toBe('First original answer');
    page.once('dialog', dialog => dialog.accept()); await page.reload();
    reply.resolve(); await openCards(page); await recoverDraft(page);
    await expect(page.locator('#editor-card-back-0')).toHaveValue('First original answer');
    await expect(page.locator('#pack-edit-notice')).toContainText('changed elsewhere');
    expect(state.patches).toHaveLength(1);
    expect(await unsavedWarning(page)).toBe(true);
    expect(state.errors).toEqual([]);
  } finally { reply.resolve(); }
});

test('an invalid acknowledgement preserves a later reversion through recovery', async ({ page }) => {
  const state = makeState(), reply = deferred();
  state.missingAck = true; state.afterCommit = () => reply.promise;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  try {
    await editCard(page, 0, 'Possibly saved');
    await expect.poll(() => state.pack.flashcards[0].back).toBe('Possibly saved');
    await editCard(page, 0, 'First original answer');
    reply.resolve();
    await expect(page.locator('#pack-edit-notice')).toContainText('could not be verified');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    page.once('dialog', dialog => dialog.accept()); await page.reload(); await openCards(page); await recoverDraft(page);
    await expect(page.locator('#editor-card-back-0')).toHaveValue('First original answer');
    expect(state.patches).toHaveLength(1);
  } finally { reply.resolve(); }
});

test('a missing GET token retains the draft without an unconditional replacement', async ({ page }) => {
  const state = makeState(); state.missingToken = true;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  await editCard(page, 0, 'Keep despite missing token');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.locator('#pack-edit-notice')).toContainText('could not be verified');
  expect(state.patches).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept()); await page.reload(); await openCards(page); await recoverDraft(page);
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Keep despite missing token');
  await reviewDraft(page);
  await expect(page.locator('#pack-edit-review-message')).toContainText('could not be loaded');
  expect(state.patches).toHaveLength(0);
});

for (const mode of ['inline', 'builder']) test(`${mode} metadata acknowledgement cannot advance unseen content`, async ({ page, context }) => {
  const state = makeState(), other = await twoEditors(page, context, state);
  const original = contentRevision(state.pack);
  await openCards(page);
  if (mode === 'builder') await other.locator('#open-builder-btn').click();
  await editCard(page, 0, 'Remote first answer');
  await expect.poll(() => state.pack.flashcards[0].back).toBe('Remote first answer');
  if (mode === 'builder') await other.locator('#builder-title-input').fill('Metadata draft');
  else await editTitle(other, 'Metadata draft');
  await expect.poll(() => state.pack.title).toBe('Metadata draft');
  if (mode === 'builder') {
    await other.locator('#builder-tab-flashcards').click(); await other.locator('#builder-fc-back-0').fill('Local content after metadata');
  } else { await openCards(other); await editCard(other, 0, 'Local content after metadata'); }
  await expect.poll(() => tabPatches(state, 'second').filter(entry => entry.payload.flashcards)[0]?.status).toBe(409);
  const second = tabPatches(state, 'second');
  expect(second.find(entry => entry.payload.title).payload).toEqual({ title: 'Metadata draft' });
  expect(second.find(entry => entry.payload.flashcards).payload.base_content_revision).toBe(original);
  expect(state.pack.flashcards[0].back).toBe('Remote first answer');
});

test('explicit section review preserves remote notes and can conflict again', async ({ page }) => {
  const state = makeState();
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  state.pack.notes_markdown = 'Remote notes before review';
  await editCard(page, 0, 'Local answer to review');
  await expect(page.locator('#pack-edit-notice')).toContainText('changed elsewhere');
  await reviewDraft(page);
  await expect(page.locator('#pack-edit-review-fields')).toContainText('Local answer to review');
  await page.locator('[data-review-field="flashcards"]').check();
  state.pack.notes_markdown = 'Another remote note change during review';
  await page.locator('#pack-edit-review-save').click();
  await expect.poll(() => state.patches.length).toBe(2);
  await expect(page.locator('#pack-edit-notice')).toContainText('changed elsewhere');
  expect(state.patches[1].status).toBe(409);
  expect(state.pack.flashcards[0].back).toBe('First original answer');
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Local answer to review');
  await reviewDraft(page); await page.locator('[data-review-field="flashcards"]').check();
  await page.locator('#pack-edit-review-save').click();
  await expect.poll(() => state.pack.flashcards[0].back).toBe('Local answer to review');
  expect(state.pack.notes_markdown).toBe('Another remote note change during review');
  expect(state.patches[2].payload.notes_markdown).toBeUndefined();
  await expect(page.locator('#pack-edit-notice')).toBeHidden();
  expect(await draftRecords(page)).toEqual([]);
});

test('failed review and cancelled review keep the draft and do not dispatch', async ({ page }) => {
  const state = makeState(); state.rejectContent = true;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  await editCard(page, 0, 'Draft stays through failed review');
  await expect(page.locator('#pack-edit-notice')).toContainText('changed elsewhere');
  state.getStatus = 503; await reviewDraft(page);
  await expect(page.locator('#pack-edit-review-message')).toContainText('could not be loaded');
  await page.locator('#pack-edit-review-close').click();
  state.getStatus = 0; await reviewDraft(page);
  await expect(page.locator('[data-review-field="flashcards"]')).toBeVisible();
  await page.locator('#pack-edit-review-cancel').click();
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Draft stays through failed review');
  expect(state.patches).toHaveLength(1);
  expect((await draftRecords(page)).length).toBe(1);
});

test('storage failure preserves the older durable draft and never claims the latest is device-saved', async ({ page }) => {
  const state = makeState(); state.rejectContent = true;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  await editCard(page, 0, 'Older durable answer');
  await expect(page.locator('#pack-edit-notice')).toContainText('kept on this device');
  const before = await draftRecords(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.includes(':study_cache:pack-edit:')) throw new DOMException('Synthetic quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await editCard(page, 0, 'Latest in-memory answer');
  await expect(page.locator('#pack-edit-notice')).toContainText('could not be saved on this device');
  await expect(page.locator('#pack-edit-notice')).not.toContainText('kept on this device');
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Latest in-memory answer');
  expect(await draftRecords(page)).toEqual(before);
  expect(await unsavedWarning(page)).toBe(true);
  expect(state.patches).toHaveLength(1);
});

test('two tab drafts remain separate and discarding one preserves the other', async ({ page, context }) => {
  const state = makeState(); state.rejectContent = true;
  const other = await twoEditors(page, context, state);
  await Promise.all([openCards(page), openCards(other)]);
  await editCard(page, 0, 'First tab draft'); await editCard(other, 0, 'Second tab draft');
  await expect.poll(async () => (await draftRecords(page)).length).toBe(2);
  page.once('dialog', dialog => dialog.accept()); await page.reload(); await openCards(page);
  await expect(page.locator('#pack-edit-notice select option')).toHaveCount(2);
  const records = await draftRecords(page), first = records.find(record => record.payload.changes.flashcards[0].back === 'First tab draft');
  await page.locator('#pack-edit-notice select').selectOption(first.id);
  await page.locator('#pack-edit-notice [data-edit-action="discard-record"]').click();
  await page.locator('#confirm-modal-confirm').click();
  await expect.poll(async () => (await draftRecords(page)).map(record => record.payload.changes.flashcards[0].back)).toEqual(['Second tab draft']);
  await expect(page.locator('#editor-card-back-0')).toHaveValue('First original answer');
});

test('picture removal after a text acknowledgement edits the live card', async ({ page }) => {
  const state = makeState(); state.pack.pictures_enabled = true; state.pack.flashcards[0].image_ids = ['d'.repeat(64)];
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  await editCard(page, 0, 'Text acknowledged before picture removal');
  await expect(page.locator('#pack-save-status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Remove picture', exact: true }).click();
  await expect.poll(() => state.pack.flashcards[0].image_ids).toEqual([]);
  expect(state.patches.map(entry => entry.status)).toEqual([200, 200]);
});

test('a queued metadata save is suspended during review until a new baseline is explicit', async ({ page }) => {
  const state = makeState(), reply = deferred();
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  state.pack.notes_markdown = 'Remote notes';
  await editCard(page, 0, 'Local reviewed content');
  await expect(page.locator('#pack-edit-notice')).toContainText('changed elsewhere');
  state.afterCommit = entry => entry.payload.title ? reply.promise : Promise.resolve();
  try {
    await editTitle(page, 'Metadata entered before review'); await reviewDraft(page);
    await expect(page.locator('[data-review-field="title"]')).toBeVisible();
    await page.waitForTimeout(800);
    expect(state.patches).toHaveLength(1);
    await page.locator('[data-review-field="flashcards"]').check();
    await page.locator('#pack-edit-review-save').click();
    await expect.poll(() => state.pack.flashcards[0].back).toBe('Local reviewed content');
    expect(state.pack.title).toBe('Revision pack');
    expect(state.patches[1].payload.title).toBeUndefined();
  } finally { reply.resolve(); }
});

for (const action of ['discard', 'review']) test(`${action} rendering failure retains the current draft even with device storage unavailable`, async ({ page }) => {
  const state = makeState(); state.rejectContent = true;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  await editCard(page, 0, 'Current draft survives render failure');
  await expect(page.locator('#pack-edit-notice')).toContainText('changed elsewhere');
  if (action === 'review') { await reviewDraft(page); await page.locator('[data-review-field="flashcards"]').check(); }
  await page.evaluate(() => {
    const storage = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.includes(':study_cache:pack-edit:')) throw new DOMException('Synthetic quota', 'QuotaExceededError');
      return storage.call(this, key, value);
    };
    const target = document.getElementById('notes-view');
    const html = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(target, 'innerHTML', { configurable: true, get() { return html.get.call(this); }, set(value) {
      delete this.innerHTML; throw new Error('Synthetic render failure');
    } });
  });
  if (action === 'discard') {
    await page.locator('#pack-edit-notice [data-edit-action="discard"]').click();
    await page.locator('#confirm-modal-confirm').click();
  } else await page.locator('#pack-edit-review-save').click();
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Current draft survives render failure');
  await expect(page.locator('#pack-edit-notice')).toContainText('could not be displayed');
  expect(await unsavedWarning(page)).toBe(true);
  expect(state.patches).toHaveLength(1);
  expect((await draftRecords(page))[0].payload.changes.flashcards[0].back).toBe('Current draft survives render failure');
  expect(state.errors).toEqual([]);
});

for (const mode of ['inline', 'builder']) for (const renderFailures of [1, 2]) {
  test(`${mode} draft recovery rolls back ${renderFailures} render failures without losing the pending draft`, async ({ page }) => {
    const state = makeState(); state.rejectContent = true;
    await installPage(page, state, 'first'); await openPack(page); await openCards(page);
    if (mode === 'builder') {
      await page.locator('#open-builder-btn').click(); await page.locator('#builder-tab-flashcards').click();
      await page.locator('#builder-fc-back-0').fill('Recover the complete first answer');
      await page.locator('[data-fc-row="1"] > summary').click();
      await page.locator('#builder-fc-back-1').fill('Recover the complete second answer');
    } else {
      await editCard(page, 0, 'Recover the complete first answer');
      await editCard(page, 1, 'Recover the complete second answer');
    }
    await expect.poll(async () => (await draftRecords(page))[0]?.payload.changes.flashcards[1].back)
      .toBe('Recover the complete second answer');
    await expect.poll(() => state.patches[0]?.status).toBe(409);
    page.once('dialog', dialog => dialog.accept()); await page.reload(); await openCards(page);
    const original = await draftRecords(page), patchCount = state.patches.length;
    await page.evaluate(failures => {
      const storage = Storage.prototype.setItem;
      window.restoreRecoveryStorage = () => { Storage.prototype.setItem = storage; };
      Storage.prototype.setItem = function (key, value) {
        if (key.includes(':study_cache:pack-edit:')) throw new DOMException('Synthetic quota', 'QuotaExceededError');
        return storage.call(this, key, value);
      };
      const target = document.getElementById('notes-view');
      const html = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      Object.defineProperty(target, 'innerHTML', { configurable: true, get() { return html.get.call(this); }, set(value) {
        if (failures-- > 0) throw new Error('Synthetic recovery render failure');
        delete this.innerHTML; return html.set.call(this, value);
      } });
    }, renderFailures);
    await recoverDraft(page);
    await expect(page.locator('#pack-edit-notice')).toContainText('could not be displayed');
    expect(state.errors).toEqual([]);
    expect(await draftRecords(page)).toEqual(original);
    expect(state.patches).toHaveLength(patchCount);
    expect(state.pack.flashcards.map(card => card.back)).toEqual(['First original answer', 'Second original answer']);
    expect(await unsavedWarning(page)).toBe(true);
    await expect(page.locator('#pack-edit-notice [data-edit-action="recover"]')).toBeVisible();
    if (renderFailures === 1) await expect(page.locator('#editor-card-back-0')).toHaveValue('First original answer');
    else await expect(page.locator('#editor-pane-flashcards')).toBeHidden();
    await page.evaluate(() => window.restoreRecoveryStorage());
    await recoverDraft(page);
    const prefix = mode === 'builder' ? '#builder-fc-back-' : '#editor-card-back-';
    if (mode === 'builder') await page.locator('#builder-tab-flashcards').click();
    await expect(page.locator(prefix + '0')).toHaveValue('Recover the complete first answer');
    await expect(page.locator(prefix + '1')).toHaveValue('Recover the complete second answer');
    const notice = mode === 'builder' ? '#builder-edit-notice' : '#pack-edit-notice';
    await page.locator(notice + ' [data-edit-action="review"]').click();
    await page.locator('[data-review-field="flashcards"]').check();
    state.rejectContent = false;
    await page.locator('#pack-edit-review-save').click();
    await expect.poll(() => state.pack.flashcards.map(card => card.back))
      .toEqual(['Recover the complete first answer', 'Recover the complete second answer']);
    await expect.poll(async () => (await draftRecords(page)).length).toBe(0);
    expect(state.patches).toHaveLength(patchCount + 1);
    expect(state.errors).toEqual([]);
  });
}

test('a stale recovery notice cannot revive a draft discarded in another tab', async ({ page, context }) => {
  const state = makeState(); state.rejectContent = true;
  const other = await twoEditors(page, context, state);
  await openCards(page); await editCard(page, 0, 'Discard this exact draft');
  await expect(page.locator('#pack-edit-notice')).toContainText('changed elsewhere');
  await other.reload(); await openCards(other);
  await expect(other.locator('#pack-edit-notice [data-edit-action="recover"]')).toBeVisible();
  await page.locator('#pack-edit-notice [data-edit-action="discard"]').click();
  await page.locator('#confirm-modal-confirm').click();
  await expect.poll(async () => (await draftRecords(other)).length).toBe(0);
  await recoverDraft(other);
  await expect(other.locator('#editor-card-back-0')).toHaveValue('First original answer');
  expect(await draftRecords(other)).toEqual([]);
  await expect(other.locator('#pack-edit-notice')).toBeHidden();
});

test('review waits for a held metadata acknowledgement before adopting a baseline', async ({ page }) => {
  const state = makeState(), reply = deferred();
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  state.pack.notes_markdown = 'Remote notes';
  await editCard(page, 0, 'Local content');
  await expect(page.locator('#pack-edit-notice')).toContainText('changed elsewhere');
  state.afterCommit = entry => entry.payload.title ? reply.promise : Promise.resolve();
  try {
    await editTitle(page, 'Held metadata acknowledgement');
    await expect.poll(() => state.patches.length).toBe(2);
    await reviewDraft(page);
    await expect(page.locator('#pack-edit-review-overlay')).toBeHidden();
    reply.resolve();
    await expect(page.locator('#pack-save-status')).toHaveText('Changes need review');
    await reviewDraft(page);
    await expect(page.locator('[data-review-field="flashcards"]')).toBeVisible();
    await expect(page.locator('[data-review-field="flashcards"]')).toBeInViewport();
    await expect(page.locator('#pack-edit-review-save')).toBeInViewport();
    await expect(page.locator('[data-review-field="title"]')).toHaveCount(0);
    await page.locator('[data-review-field="flashcards"]').check(); await page.locator('#pack-edit-review-save').click();
    await expect.poll(() => state.pack.flashcards[0].back).toBe('Local content');
    expect(state.pack.title).toBe('Held metadata acknowledgement');
  } finally { reply.resolve(); }
});

test('discard confirmation pauses a pending Builder save before it can commit late', async ({ page }) => {
  const state = makeState(), reply = deferred(); state.afterCommit = () => reply.promise;
  await installPage(page, state, 'first'); await openPack(page);
  await page.locator('#open-builder-btn').click(); await page.locator('#builder-tab-flashcards').click();
  try {
    await page.locator('#builder-fc-back-0').fill('Discard before the autosave timer');
    await page.locator('#builder-exit-btn').click();
    await page.locator('#builder-exit-discard').click();
    await expect(page.locator('#confirm-modal-overlay')).toBeVisible();
    await page.waitForTimeout(1700);
    expect(state.patches).toHaveLength(0);
    await page.locator('#confirm-modal-confirm').click();
    await expect(page.locator('#builder-overlay')).toBeHidden();
    reply.resolve();
    expect(state.pack.flashcards[0].back).toBe('First original answer');
    expect(await draftRecords(page)).toEqual([]);
    await openCards(page); await editCard(page, 0, 'A later independent save');
    await expect.poll(() => state.pack.flashcards[0].back).toBe('A later independent save');
    await expect(page.locator('#pack-save-status')).toHaveText('Saved');
  } finally { reply.resolve(); }
});

for (const status of [400, 403, 404, 409]) test(`a permanent ${status} remains blocked after recovery without becoming a content conflict`, async ({ page }) => {
  const state = makeState(); state.patchStatus = status;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  await editCard(page, 0, 'Permanently blocked draft');
  await expect(page.locator('#pack-edit-notice')).toContainText('could not be verified');
  await expect(page.locator('#pack-edit-notice')).not.toContainText('changed elsewhere');
  page.once('dialog', dialog => dialog.accept()); await page.reload(); await openCards(page); await recoverDraft(page);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Permanently blocked draft');
  expect(state.patches).toHaveLength(1);
  expect(await unsavedWarning(page)).toBe(true);
});

test('sign-out cancellation and repeated manual flushes do not repeat a content conflict', async ({ page }) => {
  const state = makeState(); state.rejectContent = true;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  await editCard(page, 0, 'Pending through sign-out cancellation');
  await expect(page.locator('#pack-edit-notice')).toContainText('changed elsewhere');
  for (let i = 0; i < 3; i++) expect(await page.evaluate(() => window.LectureProcessorStudyPersistence.flushPending())).toBe(false);
  const dialogs = [];
  page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.locator('#signout-btn').evaluate(button => button.click());
  await expect.poll(() => dialogs.length).toBe(1);
  expect(await page.evaluate(() => window.testAccount.currentUser.uid)).toBe('a');
  expect(state.patches).toHaveLength(1);
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Pending through sign-out cancellation');
});

test('a late acknowledgement after external sign-out cannot restore the editor or acknowledge its draft', async ({ page }) => {
  const state = makeState(), reply = deferred(); state.afterCommit = () => reply.promise;
  await installPage(page, state, 'first'); await openPack(page); await openCards(page);
  try {
    await editCard(page, 0, 'Original account draft');
    await expect.poll(() => state.pack.flashcards[0].back).toBe('Original account draft');
    await page.evaluate(() => window.testAccount.switchTo(null));
    reply.resolve();
    await expect(page.locator('#pack-editor-wrap')).toBeHidden();
    await expect(page.locator('#builder-overlay')).toBeHidden();
    expect(await page.evaluate(() => window.testAccount.currentUser)).toBeNull();
    expect(state.patches).toHaveLength(1);
    expect(state.errors).toEqual([]);
  } finally { reply.resolve(); }
});

test('sign-out during create entry cannot reopen a Builder without an account', async ({ page }) => {
  const state = makeState(); await installPage(page, state, 'first');
  await page.goto('/study');
  await expect(page.locator('#pack-list [data-pack-open]')).toBeVisible();
  await expect(page.locator('#pack-editor-wrap')).toBeHidden();
  await page.evaluate(() => {
    document.getElementById('create-pack-btn').click();
    window.testAccount.switchTo(null);
  });
  await expect(page.locator('#builder-overlay')).toBeHidden();
  await expect(page.locator('#pack-editor-wrap')).toBeHidden();
  expect(state.patches).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const language of ['en', 'nl']) for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
  test(`rendered recovery ${language} ${width} ${theme}`, async ({ page }, testInfo) => {
    const state = makeState(); state.rejectContent = true;
    state.pack.flashcards[0].back = 'Saved version';
    await page.setViewportSize({ width, height: width === 375 ? 900 : 1000 });
    await installPage(page, state, 'first', { language, theme }); await openPack(page); await openCards(page);
    await editCard(page, 0, 'Review changes');
    const notice = page.locator('#pack-edit-notice');
    await expect(notice).toContainText(language === 'nl' ? 'ergens anders gewijzigd' : 'changed elsewhere');
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('inline-conflict.png'), animations: 'disabled', fullPage: true });
    await reviewDraft(page);
    await expect(page.locator('[data-review-field="flashcards"]')).toBeVisible();
    await expect(page.locator('[data-review-field="flashcards"]')).toBeInViewport();
    await expect(page.locator('#pack-edit-review-save')).toBeInViewport();
    await expect(page.locator('.pack-edit-preview').first()).toContainText('Saved version');
    await expect(page.locator('.pack-edit-preview').last()).toContainText('Review changes');
    await expect(page.locator('[data-review-field="flashcards"]')).toHaveClass(/app-checkbox-field/);
    await page.locator('[data-review-field="flashcards"]').evaluate(input => {
      getComputedStyle(input).borderColor;
      return Promise.all(input.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    await page.locator('#pack-edit-review-overlay .modal').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const checkbox = await page.locator('[data-review-field="flashcards"]').evaluate(input => {
      const style = getComputedStyle(input), background = getComputedStyle(input.closest('.modal')).backgroundColor;
      function luminance(color) {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
          const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      }
      const borderLight = luminance(style.borderColor), backgroundLight = luminance(background);
      return { border: style.borderColor, background, contrast: (Math.max(borderLight, backgroundLight) + 0.05) / (Math.min(borderLight, backgroundLight) + 0.05) };
    });
    await testInfo.attach('review-checkbox-contrast', { body: JSON.stringify(checkbox), contentType: 'application/json' });
    expect(checkbox.contrast).toBeGreaterThanOrEqual(3);
    const choice = page.locator('[data-review-field="flashcards"]');
    expect(await choice.evaluate(input => input.closest('label').getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await page.locator('#pack-edit-review-close').focus();
    await page.keyboard.press('Tab');
    await expect(choice).toBeFocused();
    expect(await choice.evaluate(input => {
      const style = getComputedStyle(input); return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
    })).toBe(true);
    await choice.check();
    expect(await choice.evaluate(input => parseFloat(getComputedStyle(input, '::after').borderLeftWidth))).toBeGreaterThan(0);
    await choice.uncheck(); await page.locator('#pack-edit-review-close').focus();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('review.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#pack-edit-review-overlay')).toBeHidden();
    await expect(page.locator('#pack-edit-notice [data-edit-action="review"]')).toBeFocused();
    await page.locator('#pack-edit-notice [data-edit-action="discard"]').click();
    await expect(page.locator('#confirm-modal-overlay')).toBeVisible();
    await expect(page.locator('#confirm-modal-overlay')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath('discard-confirmation.png'), animations: 'disabled' });
    await page.locator('#confirm-modal-cancel').click();
    page.once('dialog', dialog => dialog.accept()); await page.reload(); await openCards(page);
    await expect(page.locator('#pack-edit-notice [data-edit-action="recover"]')).toBeVisible();
    await resetFullPageCapture(page);
    await page.screenshot({ path: testInfo.outputPath('recovery-notice.png'), animations: 'disabled', fullPage: true });
    await recoverDraft(page); await reviewDraft(page);
    await page.locator('#pack-edit-review-save').click(); // Explicitly keep the saved version.
    await expect(notice).toBeHidden();
    await page.locator('#open-builder-btn').click(); await page.locator('#builder-tab-flashcards').click();
    await page.locator('#builder-fc-back-0').fill('Builder changes for comparison');
    await expect(page.locator('#builder-edit-notice')).toBeVisible();
    await expectBuilderNoticeToFit(page);
    await page.screenshot({ path: testInfo.outputPath('builder-conflict.png'), animations: 'disabled' });
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.includes(':study_cache:pack-edit:')) throw new DOMException('Synthetic quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await page.locator('#builder-fc-back-0').fill('Latest unsaved Builder changes');
    await expect(page.locator('#builder-edit-notice')).toContainText(language === 'nl' ? 'Houd dit tabblad open' : 'Keep this tab open');
    await expectBuilderNoticeToFit(page);
    await page.screenshot({ path: testInfo.outputPath('builder-storage-failure.png'), animations: 'disabled' });
    expect(state.errors).toEqual([]);
    await expectStudyAssets(state);
  });
}
