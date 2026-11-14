const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

async function installFixture(page, theme = 'light') {
  const account = await installAccountFixture(page);
  const state = { ...account, packs: [], created: [], sessions: [], cdnRequests: [] };
  await page.route('https://cdn.jsdelivr.net/**', route => {
    state.cdnRequests.push(route.request().url());
    return route.abort();
  });
  await page.route('https://browser.sentry-cdn.com/**', route => route.abort());
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/auth/user') body = { uid: 'a', credits: 100, credits_version: 2, preferences: { onboarding_completed: true } };
    else if (path === '/api/user-preferences') body = { preferences: { interface_language: 'en', theme } };
    else if (path === '/api/study-folders') body = { folders: [] };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') body = { jobs: [] };
    else if (path.includes('study-progress')) body = { daily_goal: 20, timezone: 'Europe/Amsterdam', card_states: {}, daily_progress: {} };
    else if (path === '/api/study-packs') {
      if (request.method() === 'POST') {
        const payload = request.postDataJSON();
        state.created.push(payload);
        const id = 'imported-' + state.created.length;
        state.packs.push({ ...payload, study_pack_id: id });
        body = { ok: true, study_pack_id: id };
      } else body = { study_packs: state.packs, has_more: false };
    } else if (path.startsWith('/api/study-packs/')) {
      body = state.packs.find(pack => pack.study_pack_id === path.split('/').pop()) || {};
    } else if (path.startsWith('/api/planner/sessions/')) {
      if (request.method() === 'PUT') {
        const session = request.postDataJSON();
        state.sessions.push(session);
        body = { ok: true, session };
      }
    } else if (path === '/api/planner/sessions') body = { sessions: state.sessions };
    return route.fulfill({ json: body });
  });
  return state;
}

test('CSV import preserves quoted commas, escaped quotes and multiline fields with the CDN blocked', async ({ page }) => {
  const state = await installFixture(page);
  await page.goto('/study-pack-builder');
  await page.locator('#builder-tab-import').click();
  await page.locator('#builder-csv-input').setInputFiles({
    name: 'Quoted biology.csv', mimeType: 'text/csv',
    buffer: Buffer.from('front,back\r\n"Name, then explain","A \"\"quoted\"\" answer"\r\n"First line\nSecond line","Answer line one\nAnswer line two"\r\n'),
  });
  await expect.poll(() => state.created.length).toBe(1);
  expect(state.created[0].flashcards).toEqual([
    { front: 'Name, then explain', back: 'A "quoted" answer' },
    { front: 'First line\nSecond line', back: 'Answer line one\nAnswer line two' },
  ]);
  expect(state.cdnRequests).toEqual([]);
  expect(state.browserErrors).toEqual([]);
});

test('legacy Calendar initializes its time picker and saves typed time with the CDN blocked', async ({ page }) => {
  test.skip(process.env.STUDY_PLAN_V2 !== '0', 'The retained Calendar is tested only with its explicit legacy flag.');
  const state = await installFixture(page);
  await page.goto('/calendar');
  await page.locator('#add-session-btn').click();
  await page.locator('#session-title').fill('Synthetic biology review');
  await page.locator('#session-time').click();
  const picker = page.locator('.flatpickr-calendar.open');
  await expect(picker).toBeVisible();
  await page.locator('#session-time').fill('16:35');
  await page.locator('#session-time').press('Tab');
  await page.locator('#session-title').click();
  await expect(page.locator('#session-time')).toHaveValue('16:35');
  await page.locator('#session-save-btn').click();
  await expect.poll(() => state.sessions.length).toBe(1);
  expect(state.sessions[0].time).toBe('16:35');
  expect(state.cdnRequests).toEqual([]);
  expect(state.browserErrors).toEqual([]);
});

test('CSV header validation remains available and a corrected file reuses the loaded parser', async ({ page }) => {
  const state = await installFixture(page);
  const parserRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/papaparse.min.js')) parserRequests.push(request.url());
  });
  await page.goto('/study-pack-builder');
  await page.locator('#builder-tab-import').click();
  await page.locator('#builder-csv-input').setInputFiles({
    name: 'Wrong headers.csv', mimeType: 'text/csv', buffer: Buffer.from('front,definition\nQuestion,Answer\n'),
  });
  await expect(page.locator('#builder-import-errors')).toContainText('Missing required headers. Use: front, back');
  expect(state.created).toEqual([]);
  await page.locator('#builder-csv-input').setInputFiles({
    name: 'Corrected.csv', mimeType: 'text/csv', buffer: Buffer.from('front,back\nQuestion,Answer\n'),
  });
  await expect.poll(() => state.created.length).toBe(1);
  expect(state.created[0].flashcards).toEqual([{ front: 'Question', back: 'Answer' }]);
  expect(parserRequests).toHaveLength(1);
  expect(state.cdnRequests).toEqual([]);
  expect(state.browserErrors).toEqual([]);
});

test('Study folder dialogs load the retained date library locally only once', async ({ page }) => {
  const state = await installFixture(page);
  const assets = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.includes('/flatpickr-4.6.13/')) assets.push(request.url());
  });
  await page.goto('/study');
  await page.getByLabel('Manage folders', { exact: true }).click();
  await page.locator('#new-folder-btn').click();
  await expect(page.getByRole('dialog', { name: 'Create Folder', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.flatpickr)).toBe('function');
  await page.locator('#folder-modal-cancel').click();
  await page.getByLabel('Manage folders', { exact: true }).click();
  await page.locator('#new-folder-btn').click();
  await expect(page.getByRole('dialog', { name: 'Create Folder', exact: true })).toBeVisible();
  expect(assets).toHaveLength(2);
  expect(state.cdnRequests).toEqual([]);
  expect(state.browserErrors).toEqual([]);
});

for (const width of [1440, 375]) {
  for (const theme of ['light', 'dark']) {
    test(`CSV import controls render at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const state = await installFixture(page, theme);
      await page.goto('/study-pack-builder');
      await page.locator('#builder-tab-import').click();
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await expect(page.locator('#builder-csv-drop')).toBeVisible();
      await page.locator('#builder-csv-drop').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: testInfo.outputPath(`csv-import-${theme}-${width}.png`), animations: 'disabled' });
      expect(state.cdnRequests).toEqual([]);
      expect(state.browserErrors).toEqual([]);
    });

    test(`legacy time controls render at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      test.skip(process.env.STUDY_PLAN_V2 !== '0', 'The retained Calendar is tested only with its explicit legacy flag.');
      await page.setViewportSize({ width, height: 1000 });
      const state = await installFixture(page, theme);
      await page.goto('/calendar');
      await page.locator('#add-session-btn').click();
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await page.locator('#session-title').fill('Synthetic biology review');
      await page.locator('#session-time').click();
      await expect(page.locator('.flatpickr-calendar.open')).toBeVisible();
      const bounds = await page.locator('#session-modal-card').boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`calendar-time-${theme}-${width}.png`), animations: 'disabled' });
      expect(state.cdnRequests).toEqual([]);
      expect(state.browserErrors).toEqual([]);
    });
  }
}
