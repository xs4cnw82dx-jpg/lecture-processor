const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

const NOTICE = 'Audio playback is unavailable because this temporary audio file has been deleted.';

function makePack(id, title, audioMessage) {
  return {
    study_pack_id: id, title, mode: 'voice-note', folder_id: '',
    notes_markdown: '# ' + title + '\n\nSynthetic notes for this pack. '.repeat(6),
    flashcards: [], test_questions: [], flashcards_count: 0, test_questions_count: 0,
    has_audio_playback: false, has_audio_sync: false,
    audio_unavailable_reason: audioMessage ? 'missing_audio_file' : '',
    audio_unavailable_message: audioMessage || '',
  };
}

async function installStudy(page) {
  const account = await installAccountFixture(page);
  const state = {
    ...account, writes: [],
    packs: { a: makePack('a', 'Pack A', NOTICE), b: makePack('b', 'Pack B', '') },
  };
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.route('https://browser.sentry-cdn.com/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') state.writes.push({ path, method: request.method() });
    let body = {};
    if (path === '/api/auth/user') body = { uid: 'a', credits: 100, credits_version: 2, preferences: { onboarding_completed: true } };
    else if (path === '/api/user-preferences') body = { preferences: { interface_language: 'en', theme: 'light' } };
    else if (path === '/api/study-folders') body = { folders: [] };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') body = { jobs: [] };
    else if (path === '/api/study-packs') body = { study_packs: Object.values(state.packs), has_more: false };
    else if (/^\/api\/study-packs\/[^/]+$/.test(path)) body = structuredClone(state.packs[path.split('/').pop()] || {});
    else if (path.includes('study-progress')) body = { card_states: {}, daily_progress: {}, timezone: 'UTC' };
    await route.fulfill({ json: body });
  });
  return state;
}

async function buttonGeometry(page) {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
    };
    const notice = document.getElementById('notes-audio-unavailable');
    return {
      button: box(document.getElementById('notes-fullscreen-btn')),
      notes: box(document.getElementById('notes-view')),
      notice: notice.hidden ? null : box(notice),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

function expectButtonOnNotes(geometry, inset) {
  const { button, notes, notice } = geometry;
  expect(Math.abs(button.top - notes.top - inset)).toBeLessThanOrEqual(1);
  expect(Math.abs(notes.right - button.right - inset)).toBeLessThanOrEqual(1);
  if (notice) expect(button.top).toBeGreaterThanOrEqual(notice.bottom);
  expect(geometry.overflow).toBe(false);
}

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`notes fullscreen button stays on the notes below the audio notice at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const state = await installStudy(page);
      const inset = width <= 600 ? 14 : 18;

      await page.goto('/study?pack_id=a');
      await expect(page.locator('#notes-view')).toContainText('Synthetic notes');
      await page.evaluate(value => window.LPTheme.apply({ theme: value }), theme);
      await expect(page.locator('#notes-audio-unavailable')).toHaveText(NOTICE);
      await expect(page.locator('#notes-fullscreen-btn')).toBeVisible();
      expectButtonOnNotes(await buttonGeometry(page), inset);
      await page.locator('.notes-view-surface').screenshot({ path: testInfo.outputPath(`notice-${theme}-${width}.png`), animations: 'disabled' });

      await page.goto('/study?pack_id=b');
      await expect(page.locator('#notes-view')).toContainText('Synthetic notes');
      await expect(page.locator('#notes-audio-unavailable')).toBeHidden();
      expectButtonOnNotes(await buttonGeometry(page), inset);

      expect(state.writes).toEqual([]);
      expect(state.browserErrors).toEqual([]);
    });
  }
}
