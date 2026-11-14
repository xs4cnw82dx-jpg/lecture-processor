const { test, expect } = require('@playwright/test');
const { createHash } = require('node:crypto');
const { installAccountFixture } = require('./helpers/batch-fixture');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const contentFields = ['notes_markdown', 'flashcards', 'test_questions'];

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

async function installPage(page, state, tab) {
  await installAccountFixture(page);
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/static/js/study.min.js') state.assets.push(tab);
  });
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.route('https://browser.sentry-cdn.com/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/auth/user') body = { uid: 'a', credits: 100, credits_version: 2, preferences: { onboarding_completed: true } };
    else if (path === '/api/user-preferences') body = { preferences: { interface_language: 'en', theme: 'light' } };
    else if (path === '/api/study-folders') body = { folders: [] };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') body = { jobs: [] };
    else if (path === '/api/study-packs') body = { study_packs: [structuredClone(state.pack)], has_more: false };
    else if (path === '/api/study-packs/a' && request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      const entry = { tab, payload, status: null };
      state.patches.push(entry);
      const changesContent = contentFields.some(field => Object.hasOwn(payload, field));
      const revision = contentRevision(state.pack);
      // Stage-one compatibility permits absent tokens, so the released client
      // exposes its real lost-update behavior instead of only a missing-field failure.
      const stale = Object.hasOwn(payload, 'base_content_revision') && payload.base_content_revision !== revision;
      if (changesContent && (state.rejectContent || stale)) {
        entry.status = 409;
        return route.fulfill({ status: 409, json: {
          error: 'This pack changed since it was opened.',
          error_code: 'study_pack_content_conflict', content_revision: revision,
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
    } else if (path === '/api/study-packs/a') {
      body = { ...structuredClone(state.pack), content_revision: contentRevision(state.pack) };
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

async function twoEditors(page, context, state) {
  const other = await context.newPage();
  await Promise.all([installPage(page, state, 'first'), installPage(other, state, 'second')]);
  await Promise.all([openPack(page), openPack(other)]);
  expect(state.assets.sort()).toEqual(['first', 'second']);
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
  // This baseline uses the existing edit control. If recovery later requires an
  // explicit action, follow that real control before asserting the retained draft.
  await expect(page.locator('#editor-card-back-0')).toHaveValue('Recover this rejected local answer');
  expect(await unsavedWarning(page)).toBe(true);
});
