const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function pack(id, title) {
  return {
    study_pack_id: id, title, mode: 'manual', folder_id: '',
    notes_markdown: '# ' + title + '\n\nSynthetic notes for this study pack.',
    flashcards: [{ front: 'Question', back: 'Answer' }], flashcards_count: 1,
    test_questions: [], test_questions_count: 0,
  };
}

async function installLibrary(page, options = {}) {
  const fixture = await installAccountFixture(page);
  const state = { ...fixture, packs: { a: pack('a', 'Pack A'), b: pack('b', 'Pack B') }, events: [] };
  await page.route(/\/static\/js\/study(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({
    contentType: 'application/javascript', path: process.env.STUDY_PACK_ACTIONS_SOURCE || path.resolve('static/js/study.js'),
  }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const entry = { path: url.pathname, method: request.method(), body: request.postDataJSON() };
    state.events.push(entry);
    if (options.route && await options.route(route, state, entry)) return;
    let payload = {};
    if (entry.path === '/api/user-preferences') payload = { preferences: { interface_language: 'en', theme: options.theme || 'light' } };
    else if (entry.path === '/api/auth/user') payload = { uid: 'a', preferences: { onboarding_completed: true } };
    else if (entry.path === '/api/study-folders') payload = { folders: [] };
    else if (entry.path === '/api/study-plan/membership') payload = { pack_ids: [] };
    else if (entry.path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (entry.path === '/api/study-packs') payload = { study_packs: Object.values(state.packs), has_more: false };
    else if (/^\/api\/study-packs\/[^/]+$/.test(entry.path)) {
      const id = entry.path.split('/').pop();
      if (entry.method === 'DELETE') { delete state.packs[id]; payload = { ok: true }; }
      else if (entry.method === 'PATCH') { Object.assign(state.packs[id], entry.body); payload = { ok: true, study_pack_id: id }; }
      else payload = structuredClone(state.packs[id]);
    } else if (entry.path.includes('study-progress')) payload = { card_states: {}, daily_progress: {} };
    await route.fulfill({ json: payload });
  });
  return state;
}

test('the opened pack owns its delete action alongside its other actions', async ({ page }) => {
  const state = await installLibrary(page);
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  const actions = page.locator('#pack-editor-wrap').getByRole('button', { name: /Pack actions/ });
  await expect(actions).toBeVisible();
  await actions.click();
  await expect(page.getByRole('menuitem', { name: 'Delete current study pack', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Export Lecture Notes', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete current study pack', exact: true }).click();
  await expect(page.locator('#confirm-modal-overlay')).toBeVisible();
  await expect(page.locator('#confirm-modal-message')).toContainText('Pack A');
  expect(state.events.filter(entry => entry.method === 'DELETE')).toEqual([]);
  expect(state.browserErrors).toEqual([]);
});

const openPack = (page, id) => page.locator(`#pack-list [data-pack-id="${id}"] [data-pack-open]`).click();
const deletedIds = state => state.events.filter(entry => entry.method === 'DELETE').map(entry => entry.path.split('/').pop());

async function selectPack(page, title) {
  const checkbox = page.getByRole('checkbox', { name: 'Select ' + title, exact: true });
  await checkbox.locator('..').click();
  await expect(checkbox).toBeChecked();
}

async function currentPackDelete(page) {
  await page.locator('#export-menu-btn').click();
  await page.getByRole('menuitem', { name: 'Delete current study pack', exact: true }).click();
}

test('without an opened or checked pack no destructive pack action is offered', async ({ page }) => {
  const state = await installLibrary(page);
  await page.goto('/study');
  await expect(page.locator('#pack-list [data-pack-id]')).toHaveCount(2);
  await expect(page.locator('.library-content-head').getByRole('button')).toHaveCount(0);
  await expect(page.locator('#export-menu-btn')).toBeHidden();
  await expect(page.locator('#delete-selected-packs-btn')).toBeHidden();
  expect(deletedIds(state)).toEqual([]);
});

for (const scope of ['current', 'selected']) {
  test(`${scope} pack deletion keeps its explicit target when another pack is checked`, async ({ page }) => {
    const state = await installLibrary(page);
    await page.goto('/study?pack_id=a');
    await expect(page.locator('#pack-title')).toHaveValue('Pack A');
    await selectPack(page, 'Pack B');
    await expect(page.locator('#pack-selection-count')).toHaveText('1 pack selected');
    if (scope === 'current') await currentPackDelete(page);
    else await page.getByRole('button', { name: 'Delete selected (1)', exact: true }).click();
    const deleted = scope === 'current' ? 'a' : 'b';
    const retained = scope === 'current' ? 'b' : 'a';
    await expect(page.locator('#confirm-modal-message')).toContainText('Pack ' + deleted.toUpperCase());
    await page.locator('#confirm-modal-confirm').click();
    await expect.poll(() => Object.keys(state.packs)).toEqual([retained]);
    expect(deletedIds(state)).toEqual([deleted]);
    if (scope === 'selected') await expect(page.locator('#pack-title')).toHaveValue('Pack A');
    expect(state.browserErrors).toEqual([]);
  });
}

test('bulk deletion states the selection count and deletes exactly the checked packs', async ({ page }) => {
  const state = await installLibrary(page);
  await page.goto('/study');
  await selectPack(page, 'Pack A');
  await selectPack(page, 'Pack B');
  await expect(page.locator('#pack-selection-count')).toHaveText('2 packs selected');
  await page.getByRole('button', { name: 'Delete selected (2)', exact: true }).click();
  await expect(page.locator('#confirm-modal-message')).toContainText('Delete 2 study packs');
  await page.locator('#confirm-modal-confirm').click();
  await expect.poll(() => deletedIds(state)).toEqual(['a', 'b']);
  await expect(page.locator('#pack-list [data-pack-id]')).toHaveCount(0);
  expect(state.browserErrors).toEqual([]);
});

test('switching packs closes the old menu and binds deletion to the opened pack', async ({ page }) => {
  const state = await installLibrary(page);
  await page.goto('/study?pack_id=a');
  await page.getByRole('button', { name: 'Pack actions for Pack A', exact: true }).click();
  await openPack(page, 'b');
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  await expect(page.locator('#export-menu-list')).toBeHidden();
  await expect(page.locator('#export-menu-btn')).toHaveAccessibleName('Pack actions for Pack B');
  await currentPackDelete(page);
  await expect(page.locator('#confirm-modal-message')).toContainText('Pack B');
  await page.locator('#confirm-modal-confirm').click();
  await expect.poll(() => Object.keys(state.packs)).toEqual(['a']);
  expect(deletedIds(state)).toEqual(['b']);
});

test('deletion drains a pending save before sending DELETE', async ({ page }) => {
  const patchStarted = deferred();
  const releasePatch = deferred();
  const state = await installLibrary(page, { route: async (_route, _state, entry) => {
    if (entry.method !== 'PATCH') return false;
    patchStarted.resolve();
    await releasePatch.promise;
    return false;
  } });
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  await page.locator('.pack-details-disclosure > summary').click();
  await page.locator('#pack-title').fill('Edited Pack A');
  await currentPackDelete(page);
  await expect(page.locator('#confirm-modal-message')).toContainText('Edited Pack A');
  await page.locator('#confirm-modal-confirm').click();
  await patchStarted.promise;
  expect(deletedIds(state)).toEqual([]);
  releasePatch.resolve();
  await expect.poll(() => deletedIds(state)).toEqual(['a']);
  expect(state.events.find(entry => entry.method === 'PATCH').body.title).toBe('Edited Pack A');
  expect(state.packs.b.title).toBe('Pack B');
});

test('a failed save prevents deletion and retains the typed content', async ({ page }) => {
  const state = await installLibrary(page, { route: async (route, _state, entry) => {
    if (entry.method !== 'PATCH') return false;
    await route.fulfill({ status: 503, json: { error: 'Synthetic save outage' } });
    return true;
  } });
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  await page.locator('.pack-details-disclosure > summary').click();
  await page.locator('#pack-title').fill('Keep this edit');
  await currentPackDelete(page);
  await page.locator('#confirm-modal-confirm').click();
  await expect(page.locator('#toast')).toContainText('Save your changes before deleting study packs.');
  await expect(page.locator('#pack-title')).toHaveValue('Keep this edit');
  expect(deletedIds(state)).toEqual([]);
  expect(Object.keys(state.packs)).toEqual(['a', 'b']);
});

test('completion of a slow deletion preserves a subsequently opened pack', async ({ page }) => {
  const deleteStarted = deferred();
  const releaseDelete = deferred();
  const state = await installLibrary(page, { route: async (_route, _state, entry) => {
    if (entry.method !== 'DELETE') return false;
    deleteStarted.resolve();
    await releaseDelete.promise;
    return false;
  } });
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  await currentPackDelete(page);
  await page.locator('#confirm-modal-confirm').click();
  await deleteStarted.promise;
  await openPack(page, 'b');
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  releaseDelete.resolve();
  await expect(page.locator('#pack-list [data-pack-id="a"]')).toHaveCount(0);
  await expect(page.locator('#pack-editor-wrap')).toBeVisible();
  await expect(page.locator('#pack-title')).toHaveValue('Pack B');
  expect(deletedIds(state)).toEqual(['a']);
});

test('changing accounts during confirmation never sends the old deletion', async ({ page }) => {
  const state = await installLibrary(page);
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  await currentPackDelete(page);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await page.locator('#confirm-modal-confirm').click();
  await expect(page.locator('#confirm-modal-overlay')).toBeHidden();
  expect(deletedIds(state)).toEqual([]);
  expect(Object.keys(state.packs)).toEqual(['a', 'b']);
});

test('keyboard navigation reaches Delete and cancellation restores its menu trigger', async ({ page }) => {
  const state = await installLibrary(page);
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack A');
  const trigger = page.locator('#export-menu-btn');
  await trigger.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#delete-pack-btn')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await expect(page.locator('#delete-pack-btn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Delete Study Pack', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirm-modal-overlay')).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(deletedIds(state)).toEqual([]);
});

for (const width of [1440, 375]) {
  for (const theme of ['light', 'dark']) {
    test(`pack actions fit and remain accessible at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      const state = await installLibrary(page, { theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/study?pack_id=a');
      await expect(page.locator('#pack-title')).toHaveValue('Pack A');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const trigger = page.locator('#export-menu-btn');
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await page.locator('#delete-pack-btn').scrollIntoViewIfNeeded();
      await expect(page.locator('#delete-pack-btn')).toBeVisible();
      await expect.poll(async () => (await page.locator('#delete-pack-btn').boundingBox()).height).toBeGreaterThanOrEqual(44);
      const bounds = await page.locator('#delete-pack-btn').boundingBox();
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`pack-actions-${theme}-${width}.png`), animations: 'disabled' });
      await page.locator('#delete-pack-btn').click();
      await expect(page.locator('#confirm-modal-message')).toContainText('Pack A');
      await page.locator('#confirm-modal-cancel').click();
      await expect(trigger).toBeFocused();
      expect(deletedIds(state)).toEqual([]);
      expect(state.browserErrors).toEqual([]);
    });
  }
}
