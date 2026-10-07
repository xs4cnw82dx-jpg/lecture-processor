const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });
const pack = {
  study_pack_id: 'collision', title: 'Overview', mode: 'manual', folder_id: 'folder',
  notes_markdown: '# Save\n\nToday\n\nOverview', flashcards_count: 1, test_questions_count: 1,
  flashcards: [{ front: 'Today', back: 'Save' }],
  test_questions: [{ question: 'Overview', options: ['Save', 'Today'], answer: 'Save', explanation: 'Settings' }],
};

async function fixture(page) {
  const base = await installAccountFixture(page);
  await page.route(/\/static\/(js|css)\/[^/?]+(?:\?.*)?$/, route => {
    const name = new URL(route.request().url()).pathname.replace(/\.min\.(js|css)$/, '.$1');
    const local = path.resolve('.' + name);
    return fs.existsSync(local) ? route.fulfill({ path: local, contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css' }) : route.continue();
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === '/api/auth/user') body = { uid: 'a', email: 'Save@example.test', is_admin: false, preferences: {}, has_created_study_pack: true };
    else if (url.pathname === '/api/user-preferences') body = { preferences: { interface_language: 'en', theme: 'light' } };
    else if (url.pathname === '/api/study-folders') body = { folders: [{ folder_id: 'folder', name: 'Today', parent_folder_id: '' }] };
    else if (url.pathname === '/api/study-packs') body = { study_packs: [pack], has_more: false };
    else if (url.pathname === '/api/study-packs/collision') body = pack;
    else if (url.pathname === '/api/study-plan/membership') body = { pack_ids: ['collision'] };
    else if (url.pathname === '/api/study-progress/due') body = { due_count: 1, packs: [{ study_pack_id: 'collision', title: 'Overview', due_count: 1, cards: [{ id: 'fc_0', front: 'Save' }] }] };
    else if (url.pathname.includes('progress')) body = { active_plan_pack_ids: ['collision'], current_streak: 1, due_today: 1, daily_goal: 20, today_progress: 0, card_states: {}, daily_progress: {} };
    else if (url.pathname === '/api/planner/sessions') body = { sessions: [{ id: 'session', pack_id: 'collision', title: 'Today', pack_title: 'Overview', date: '2999-10-10', time: '17:00', status: 'planned' }] };
    else if (url.pathname === '/api/voice-notes') body = { voice_notes: [{ study_pack_id: 'voice', title: 'Save', source_transcript: 'Today', mode: 'voice-note', created_at: 1700000000 }] };
    else if (url.pathname === '/api/study-packs/voice') body = { study_pack_id: 'voice', title: 'Save', source_transcript: 'Today', notes_markdown: 'Today', mode: 'voice-note' };
    else if (url.pathname === '/api/batch/jobs') body = { batches: [{ batch_id: 'batch', batch_title: 'Save', mode: 'audio-transcription', status: 'complete', total_rows: 1, completed_rows: 1, created_at: 1700000000 }] };
    return route.fulfill({ json: body });
  });
  return base;
}

async function dutch(page) {
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
}

async function startMode(page, mode) {
  await expect(page.locator('#setup-main-content')).toBeVisible();
  for (const name of ['flashcards', 'test', 'write', 'match', 'notes']) {
    const card = page.locator('#lesson-card-' + name);
    if (await card.isVisible() && !await card.isDisabled() && (await card.getAttribute('aria-pressed') === 'true') !== (name === mode)) await card.click();
  }
  await page.locator('#setup-start-btn').click();
}

test('Dashboard names and due card text remain original beside Dutch controls', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/dashboard');
  await expect(page.locator('#dashboard-page')).toHaveAttribute('data-load-state', 'ready');
  await page.locator('#dash-due-open').click();
  await expect(page.locator('.dashboard-due-cards li')).toHaveText('Save');
  await dutch(page);
  await expect(page.locator('#dash-continue-title')).toHaveText('Today');
  await expect(page.locator('#dash-sessions-list .list-item h3')).toHaveText('Today');
  await expect(page.locator('#dash-packs-list .list-item h3')).toHaveText('Overview');
  await expect(page.locator('.dashboard-due-cards li')).toHaveText('Save');
  await expect(page.locator('.dashboard-due-pack-head h3')).toHaveText('Overview');
  await expect(page.locator('#shell-physio-panel a[href="/physio"]')).toHaveText('Klinische werkruimte');
  expect(f.browserErrors).toEqual([]);
});

test('Library notes, folder and pack titles retain exact source text', async ({ page }) => {
  await fixture(page);
  await page.goto('/study?pack_id=collision');
  await expect(page.locator('#notes-view')).toContainText('Today');
  await dutch(page);
  await expect(page.locator('#pack-summary-title')).toHaveText('Overview');
  await expect(page.locator('[data-folder-id="folder"] .item-title')).toHaveText('Today');
  await expect(page.locator('#notes-view h1')).toHaveText('Save');
  await expect(page.locator('#notes-view p').first()).toHaveText('Today');
  await page.locator('.pack-details-disclosure > summary').click();
  await page.locator('#pack-folder-button').click();
  await expect(page.locator('#pack-folder-menu [data-value="folder"]')).toHaveText('Today');
  await expect(page.locator('#pack-folder-label')).toHaveText('Today');
});

for (const mode of ['flashcards', 'test', 'write']) {
  test('learning ' + mode + ' never translates the prompt or answer', async ({ page }) => {
    await fixture(page);
    await page.goto('/study?pack_id=collision&mode=learn');
    await expect(page.locator('#setup-pack-name')).toHaveText('Overview');
    await dutch(page);
    await expect(page.locator('#setup-pack-name')).toHaveText('Overview');
    await startMode(page, mode);
    await expect(page.locator('#learn-title')).toHaveText('Overview');
    if (mode === 'flashcards') {
      await expect(page.locator('#learn-flashcard-front')).toHaveText('Today');
      await expect(page.locator('#learn-flashcard-back')).toHaveText('Save');
    } else if (mode === 'write') {
      await expect(page.locator('#write-prompt')).toHaveText('Today');
      await page.locator('#write-reveal-btn').click();
      await expect(page.locator('#write-feedback')).toContainText('Save');
    } else {
      await expect(page.locator('#learn-q-text')).toHaveText('Overview');
      await expect(page.locator('#learn-q-options .quiz-option')).toHaveText(['Save', 'Today']);
      await page.locator('#learn-q-options .quiz-option').first().click();
      await expect(page.locator('#learn-q-options .quiz-option').first()).toHaveClass(/correct/);
      await expect(page.locator('#learn-q-expl')).toHaveText('Settings');
    }
  });
}

test('batch names remain original after list rendering and language round-trip', async ({ page }) => {
  await fixture(page);
  await page.goto('/batch_status?view=completed');
  await expect(page.locator('.bs-batch-title')).toHaveText('Save');
  await dutch(page);
  await expect(page.locator('.bs-batch-title')).toHaveText('Save');
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(page.locator('.bs-batch-title')).toHaveText('Save');
});

test('translation preserves unmatched whitespace and copied user options', async ({ page }) => {
  await fixture(page);
  await page.goto('/study?pack_id=collision');
  await expect(page.locator('#notes-view')).toContainText('Today');
  await dutch(page);
  expect(await page.evaluate(() => window.LectureI18n.t('  A   unique   title  '))).toBe('  A   unique   title  ');
  // Exercise the real shared enhancer on the populated Builder folder selector.
  await page.locator('.pack-details-disclosure > summary').click();
  await page.locator('#open-builder-btn').click();
  await expect(page.locator('#builder-folder-select-value')).toHaveText('Today');
  await expect(page.locator('#builder-folder-select-menu [data-value="folder"]')).toHaveText('Today');
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(page.locator('#builder-folder-select-value')).toHaveText('Today');
});
