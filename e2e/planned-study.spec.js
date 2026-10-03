const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');

async function plannedLibrary(page, { notes = false } = {}) {
  const firebaseStub = `(function () {
    var user = { uid: 'owner', email: 'student@example.com', displayName: 'Student', getIdToken: function () { return Promise.resolve('test-token'); } };
    var auth = { currentUser: user, setPersistence: function () { return Promise.resolve(); }, authStateReady: function () { return Promise.resolve(); }, onAuthStateChanged: function (cb) { setTimeout(function () { cb(user); }, 0); return function () {}; }, signOut: function () { return Promise.resolve(); } };
    function factory() { return auth; } factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: function () { return {}; }, initializeApp: function () { return {}; }, auth: factory };
  })();`;
  await page.addInitScript({ content: firebaseStub });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: firebaseStub }));
  await page.route('**/static/js/study.min.js*', route => route.fulfill({ contentType: 'application/javascript', body: readFileSync('static/js/study.js', 'utf8') }));
  const pack = { study_pack_id: 'anatomy-pack', title: 'Anatomy 1.2 — Muscles', mode: 'manual', pictures_enabled: true,
    flashcards: notes ? [] : [{ front: 'Where does the sartorius muscle originate?', back: 'Anterior superior iliac spine', image_ids: ['a'.repeat(64)] }, { front: 'What movement does the biceps perform?', back: 'Flexion of the elbow' }],
    flashcards_count: notes ? 0 : 2, test_questions: notes ? [] : [{ question: 'Which movement bends the elbow?', options: ['Flexion', 'Extension'], answer: 'Flexion', explanation: 'Flexion decreases the angle at a joint.' }], test_questions_count: notes ? 0 : 1,
    notes_markdown: '# Active recall\nExplain the movement without looking at your notes.', folder_id: '' };
  let session = { id: 'session_focus', title: 'Study Anatomy 1.2 — Muscles', pack_id: pack.study_pack_id, duration: 45, status: 'planned', revision: 2 };
  let run = { activity_id: 'run_focus', generation: 0, source: 'tracked', content_fingerprint: 'content_v1', queue: notes ? [{ id: 'notes', type: 'notes', seconds: 60 }] : [{ id: 'fc_0', type: 'fc', index: 0, reason: 'Due today' }, { id: 'fc_1', type: 'fc', index: 1, reason: 'New' }, { id: 'q_0', type: 'q', index: 0, reason: 'New' }],
    answers: {}, retry_done: [], active_seconds: 0, slot_seconds: 0, notes_seconds: 0, duration_seconds: 2700, timer_mode: 'countdown', run_status: 'paused', checkpoint_revision: 0 };
  const checkpoints = [], completions = [], progressWrites = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body = {};
    if (path.endsWith('/session_focus/run')) {
      const data = request.postDataJSON();
      if (!run.slot_seconds) run.timer_mode = data.timer_mode || 'countdown';
      body = { session, run };
    } else if (path.endsWith('/runs/run_focus')) {
      run = { ...run, ...request.postDataJSON() }; checkpoints.push(run); body = { run };
    } else if (path.endsWith('/session_focus/completion')) {
      const data = request.postDataJSON(); completions.push(data);
      session = { ...session, status: data.action === 'reopen' ? 'planned' : 'completed', revision: session.revision + 1 }; body = { session };
    } else if (path.includes('/images/')) {
      expect(request.headers().authorization).toBe('Bearer test-token');
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180" viewBox="0 0 360 180"><rect width="360" height="180" rx="16" fill="#edf2ff"/><path d="M140 24L175 75 195 145" fill="none" stroke="#becae3" stroke-width="24" stroke-linecap="round"/><path d="M145 35Q150 95 193 134" fill="none" stroke="#f28385" stroke-width="12" stroke-linecap="round"/><text x="220" y="85" font-family="sans-serif" font-size="14" fill="#334467">Sartorius</text><path d="M168 84h40" stroke="#334467"/></svg>' });
    } else if (path === '/api/study-packs/anatomy-pack') body = pack;
    else if (path === '/api/study-packs') body = { study_packs: [pack], has_more: false };
    else if (path === '/api/study-folders') body = { folders: [] };
    else if (path === '/api/auth/user') body = { uid: 'owner', email: 'student@example.com', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [pack.study_pack_id] };
    else if (path.includes('progress')) {
      if (request.method() === 'PUT') progressWrites.push(request.postDataJSON());
      body = { ok: true, card_states: {}, daily_progress: {} };
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/study?pack_id=anatomy-pack&mode=learn&plan_item_id=session_focus');
  await expect(page.locator('.planned-study-overlay')).toBeVisible();
  return { checkpoints, completions, progressWrites, run: () => run };
}

test('planned session reviews picture cards and questions, bounded retry, explicit finish and reopen', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = await plannedLibrary(page);
  await expect(page.getByRole('button', { name: 'Reveal answer', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).click();
  const picture = page.locator('.planned-study-answer .study-picture-open img');
  await expect(picture).toHaveJSProperty('naturalWidth', 360);
  await page.screenshot({ path: testInfo.outputPath('planned-study-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('planned-study-mobile.png'), fullPage: true });
  expect(await page.locator('.planned-study-overlay').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.getByRole('button', { name: /Enlarge Picture for/ }).click();
  await expect(page.getByRole('dialog', { name: 'Picture viewer' })).toBeVisible();
  await page.getByRole('button', { name: 'Close picture', exact: true }).click();
  await page.getByRole('button', { name: 'Again', exact: true }).click();
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).click();
  await page.getByRole('button', { name: 'Got it', exact: true }).click();
  await page.getByRole('button', { name: 'Flexion', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.planned-study-work')).toContainText('One more try');
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).click();
  await page.getByRole('button', { name: 'Got it', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish session', exact: true })).toBeEnabled();
  expect(fixture.completions).toHaveLength(0);
  await page.getByRole('button', { name: 'Finish session', exact: true }).click();
  await expect(page.locator('.planned-study-work')).toContainText('Good work.');
  expect(fixture.completions).toHaveLength(1);
  expect(fixture.progressWrites.some(write => write.card_states && write.card_states['anatomy-pack'])).toBe(true);
  expect(fixture.run().retry_done).toEqual(['fc_0']);
  await page.getByRole('button', { name: 'Reopen session', exact: true }).click();
  await expect.poll(() => fixture.completions.length).toBe(2);
  expect(fixture.completions[1].action).toBe('reopen');
  expect(errors).toEqual([]);
});

test('partial progress resumes after reload without replaying the answered card', async ({ page }) => {
  const fixture = await plannedLibrary(page);
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).click();
  await page.getByRole('button', { name: 'Got it', exact: true }).click();
  await expect.poll(() => fixture.run().answers.fc_0 && fixture.run().answers.fc_0.correct).toBe(true);
  await page.reload();
  await expect(page.locator('.planned-study-work')).toContainText('What movement does the biceps perform?');
  await expect(page.locator('[data-progress-label]')).toContainText('1 / 3');
  await page.getByRole('button', { name: 'Session progress', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish session', exact: true })).toBeDisabled();
  expect(fixture.completions).toHaveLength(0);
});

test('notes progress advances on focus time and Pomodoro excludes its break', async ({ page }) => {
  await page.clock.install();
  const fixture = await plannedLibrary(page, { notes: true });
  await page.locator('[data-timer]').selectOption('pomodoro');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.clock.runFor(60000);
  await expect(page.getByRole('button', { name: 'Finish session', exact: true })).toBeEnabled();
  await expect(page.locator('[data-progress-label]')).toContainText('1 / 1');
  expect(fixture.run().notes_seconds).toBe(60);
  expect(fixture.completions).toHaveLength(0);
});

test('Pomodoro break stays inside the slot and hidden tabs pause without empty completion', async ({ page }) => {
  await page.clock.install();
  const fixture = await plannedLibrary(page);
  await page.locator('[data-timer]').selectOption('pomodoro');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.clock.fastForward(25 * 60 * 1000);
  await expect(page.locator('[data-phase]')).toContainText('Take a break');
  await expect(page.locator('.planned-study-work')).toContainText('Give your mind a moment.');
  await page.clock.fastForward(5 * 60 * 1000);
  await expect(page.locator('[data-phase]')).toContainText('Focus');
  expect(fixture.run().active_seconds).toBe(1500);
  expect(fixture.run().slot_seconds).toBe(1800);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(10 * 60 * 1000);
  expect(fixture.run().slot_seconds).toBe(1800);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Session progress', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish session', exact: true })).toBeDisabled();
  expect(fixture.completions).toHaveLength(0);
});
