const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');

const NOTES = '# Synthetic notes\n\nA steady heartbeat supports healthy circulation.';
const HIGHLIGHT_TEXT = 'A steady heartbeat supports healthy circulation.';
test.use({ timezoneId: 'Europe/Amsterdam' });

async function installStudy(page, options = {}) {
  const state = {
    pack: {
      study_pack_id: 'synthetic', title: 'Synthetic study pack', mode: 'manual', folder_id: '',
      notes_markdown: NOTES, flashcards_count: 1, test_questions_count: 0,
      flashcards: [{ front: 'What supports circulation?', back: 'A steady heartbeat.' }], test_questions: [],
    },
    patches: [], progress: [], errors: [],
  };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(({ theme }) => {
    const user = { uid: 'streak-highlight-fixture', email: 'study@example.test', getIdToken: () => Promise.resolve('fixture-token') };
    const auth = {
      currentUser: user, setPersistence: () => Promise.resolve(), authStateReady: () => Promise.resolve(),
      onAuthStateChanged: callback => { queueMicrotask(() => callback(user)); return () => {}; },
    };
    function factory() { return auth; }
    factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: factory };
    localStorage.setItem('lp-preferences', JSON.stringify({ language: 'en', theme }));
    localStorage.setItem('lp-preferences:streak-highlight-fixture', JSON.stringify({ language: 'en', theme }));
  }, { theme: options.theme || 'light' });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  if (process.env.STUDY_STREAK_HIGHLIGHT_TEST_SOURCE) {
    const source = readFileSync(process.env.STUDY_STREAK_HIGHLIGHT_TEST_SOURCE, 'utf8');
    await page.route(/\/static\/js\/study(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', body: source }));
  }
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let payload = {};
    if (path === '/api/auth/user') payload = { uid: 'streak-highlight-fixture', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/user-preferences') payload = { preferences: { interface_language: 'en', theme: options.theme || 'light' } };
    else if (path === '/api/study-folders') payload = { folders: [] };
    else if (path === '/api/study-plan/membership') payload = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (path === '/api/study-packs') payload = { study_packs: [state.pack], has_more: false };
    else if (path === '/api/study-packs/synthetic') {
      if (request.method() === 'PATCH') {
        const patch = request.postDataJSON();
        state.patches.push(patch);
        Object.assign(state.pack, structuredClone(patch));
        payload = { ok: true, study_pack_id: 'synthetic' };
      } else payload = structuredClone(state.pack);
    } else if (path.includes('study-progress')) {
      if (request.method() === 'PUT') state.progress.push(request.postDataJSON());
      payload = { card_states: {}, daily_progress: {} };
    }
    await route.fulfill({ json: payload });
  });
  return state;
}

async function openPack(page) {
  await page.goto('/study?pack_id=synthetic');
  await expect(page.locator('#pack-title')).toHaveValue('Synthetic study pack');
  await expect(page.locator('#notes-view p')).toHaveText(HIGHLIGHT_TEXT);
}

async function highlightNotes(page, state, color = 'yellow') {
  await page.locator(`[data-hl-color="${color}"]`).click();
  await page.locator('#notes-view p').evaluate(paragraph => {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveText(HIGHLIGHT_TEXT);
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveAttribute('data-hl', color);
  await expect.poll(() => state.pack.notes_highlights?.ranges[0]?.color).toBe(color);
}

async function renamePack(page, state) {
  await page.locator('.pack-details-disclosure > summary').click();
  await page.locator('#pack-title').fill('Renamed study pack');
  await expect.poll(() => state.pack.title).toBe('Renamed study pack');
  await expect(page.locator('#pack-save-status')).toHaveText('Saved');
}

test('an existing highlight survives renaming the pack and reloading', async ({ page }) => {
  const state = await installStudy(page);
  await openPack(page);
  await highlightNotes(page, state);
  await renamePack(page, state);
  await page.reload();
  await expect(page.locator('#pack-title')).toHaveValue('Renamed study pack');
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveText(HIGHLIGHT_TEXT);
  expect(state.errors).toEqual([]);
});

for (const edit of ['metadata', 'flashcard']) {
  test(`highlight changes after an inline ${edit} edit survive reloading`, async ({ page }) => {
    const state = await installStudy(page);
    await openPack(page);
    await highlightNotes(page, state);
    if (edit === 'metadata') await renamePack(page, state);
    else {
      await page.locator('#editor-tab-flashcards').click();
      await page.locator('#editor-card-back-0').fill('Regular cardiac contractions.');
      await expect.poll(() => state.pack.flashcards[0].back).toBe('Regular cardiac contractions.');
      await expect(page.locator('#pack-save-status')).toHaveText('Saved');
      await page.locator('#editor-tab-notes').click();
    }
    await highlightNotes(page, state, 'green');
    await page.reload();
    await expect(page.locator('#notes-view mark[data-hl]')).toHaveText(HIGHLIGHT_TEXT);
    await expect(page.locator('#notes-view mark[data-hl]')).toHaveAttribute('data-hl', 'green');
    expect(state.errors).toEqual([]);
  });
}

test('replacing notes with different text of the same length removes the old highlight', async ({ page }) => {
  const state = await installStudy(page);
  await openPack(page);
  await highlightNotes(page, state);
  state.pack.notes_markdown = NOTES.replace('steady', 'strong');
  expect(state.pack.notes_markdown.length).toBe(NOTES.length);
  await page.reload();
  await expect(page.locator('#notes-view p')).toHaveText(HIGHLIGHT_TEXT.replace('steady', 'strong'));
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

for (const source of ['server', 'local']) {
  test(`a legacy structured ${source} highlight survives a changed metadata timestamp`, async ({ page }) => {
    const state = await installStudy(page);
    await openPack(page);
    await highlightNotes(page, state);
    const legacy = { ...structuredClone(state.pack.notes_highlights), base_key: `synthetic:1700000000.25:${NOTES.length}` };
    state.pack.notes_highlights = source === 'server' ? legacy : null;
    await page.evaluate(payload => {
      localStorage.removeItem('hl_ranges_synthetic');
      if (payload) localStorage.setItem('hl_ranges_synthetic', JSON.stringify(payload));
    }, source === 'local' ? legacy : null);
    await page.reload();
    await expect(page.locator('#notes-view mark[data-hl]')).toHaveText(HIGHLIGHT_TEXT);
    await expect.poll(() => state.pack.notes_highlights?.ranges.length).toBe(1);
    expect(state.errors).toEqual([]);
  });
}

for (const invalid of ['another pack', 'different notes length', 'malformed timestamp']) {
  test(`a legacy highlight for ${invalid} is not applied`, async ({ page }) => {
    const state = await installStudy(page);
    await openPack(page);
    await highlightNotes(page, state);
    const keys = {
      'another pack': `other:1700000000:${NOTES.length}`,
      'different notes length': `synthetic:1700000000:${NOTES.length + 1}`,
      'malformed timestamp': `synthetic:invalid:${NOTES.length}`,
    };
    state.pack.notes_highlights.base_key = keys[invalid];
    await page.evaluate(() => localStorage.removeItem('hl_ranges_synthetic'));
    await page.reload();
    await expect(page.locator('#notes-view p')).toHaveText(HIGHLIGHT_TEXT);
    await expect(page.locator('#notes-view mark[data-hl]')).toHaveCount(0);
    expect(state.errors).toEqual([]);
  });
}

test('a matching legacy annotated HTML highlight migrates and syncs', async ({ page }) => {
  const state = await installStudy(page);
  await openPack(page);
  await highlightNotes(page, state);
  const legacy = {
    base_key: `synthetic:1700000000:${NOTES.length}`,
    annotated_html: await page.locator('#notes-view').innerHTML(),
  };
  state.pack.notes_highlights = null;
  await page.evaluate(payload => {
    localStorage.removeItem('hl_ranges_synthetic');
    localStorage.setItem('hl_html_synthetic', JSON.stringify(payload));
  }, legacy);
  await page.reload();
  await expect(page.locator('#notes-view mark[data-hl]')).toHaveText(HIGHLIGHT_TEXT);
  await expect.poll(() => state.pack.notes_highlights?.ranges.length).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('hl_html_synthetic'))).toBeNull();
  expect(state.errors).toEqual([]);
});

test('rating a card on consecutive days grows and syncs the study streak across New Year', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-12-31T12:00:00Z'));
  const state = await installStudy(page);
  await openPack(page);
  await page.locator('#open-learn-btn').click();
  for (const card of await page.locator('.lesson-card[data-lesson]').all()) {
    if (await card.getAttribute('aria-disabled') === 'true') continue;
    const selected = await card.getAttribute('aria-pressed') === 'true';
    if (selected !== (await card.getAttribute('data-lesson') === 'flashcards')) await card.click();
  }
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
  const days = ['2026-12-31', '2027-01-01', '2027-01-02'];
  for (const [index, day] of days.entries()) {
    await page.clock.setFixedTime(new Date(`${day}T12:00:00Z`));
    await page.locator('#learn-f-flip').click();
    await page.locator('[data-review-action="good"]').click();
    await expect.poll(() => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('study_streak_streak-highlight-fixture'));
      return { streak: saved?.current_streak, day: saved?.last_study_date };
    })).toEqual({ streak: index + 1, day });
    await expect.poll(() => state.progress.some(payload => payload.streak_data?.last_study_date === day
      && payload.streak_data.current_streak === index + 1)).toBe(true);
  }
  expect(state.errors).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`saved highlights persist without overflow at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      const state = await installStudy(page, { theme });
      await page.setViewportSize({ width, height: 960 });
      await openPack(page);
      await renamePack(page, state);
      await highlightNotes(page, state);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('#notes-view mark[data-hl]')).toHaveText(HIGHLIGHT_TEXT);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('#toast')).not.toHaveClass(/visible/);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: testInfo.outputPath(`study-highlights-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      expect(state.errors).toEqual([]);
    });
  }
}
