const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');

async function plannedLibrary(page, { notes = false, chooseMode = 'flashcards', capturePicker = false, timerMode = 'countdown' } = {}) {
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
  let run = { activity_id: 'run_focus', uid: 'owner', plan_item_id: 'session_focus', study_mode: 'review', mode_generation: 0, generation: 0, source: 'tracked', content_fingerprint: 'content_v1', queue: notes ? [{ id: 'notes', type: 'notes', seconds: 60 }] : [{ id: 'fc_0', type: 'fc', index: 0, reason: 'Due today' }, { id: 'fc_1', type: 'fc', index: 1, reason: 'New' }, { id: 'q_0', type: 'q', index: 0, reason: 'New' }],
    answers: {}, retry_done: [], active_seconds: 0, slot_seconds: 0, notes_seconds: 0, duration_seconds: 2700, timer_mode: 'countdown', run_status: 'paused', checkpoint_revision: 0 };
  const checkpoints = [], completions = [], progressWrites = [], starts = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body = {};
    if (path.endsWith('/session_focus/run')) {
      const data = request.postDataJSON(); starts.push(data);
      if (data.study_mode && data.study_mode !== run.study_mode) { run.mode_generation += 1; run.study_mode = data.study_mode; run.checkpoint_revision += 1; }
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
  await expect(page.locator('#setup-overlay')).toBeVisible();
  if (capturePicker) {
    require('node:fs').mkdirSync('/tmp/product-feedback-learning-evidence',{recursive:true});
    await page.screenshot({path:'/tmp/product-feedback-learning-evidence/picker-planned-'+page.viewportSize().width+'.png',animations:'disabled'});
  }
  if (timerMode === 'pomodoro') { await page.locator('#setup-timer-wrap .app-select-button').click(); await page.getByRole('option', {name: /Pomodoro/}).click(); }
  await choose(page, notes ? 'notes' : chooseMode);
  return { checkpoints, completions, progressWrites, starts, run: () => run };
}

async function choose(page, mode) {
  await expect(page.locator('#setup-overlay')).toBeVisible();
  for (const card of await page.locator('.lesson-card[data-lesson]').all()) {
    if ((await card.getAttribute('class')).includes('unavailable')) continue;
    const selected = await card.getAttribute('aria-pressed') === 'true';
    if (selected !== (await card.getAttribute('data-lesson') === mode)) await card.click();
  }
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
  await expect(page.locator('[data-pause]')).toHaveText('Pause');
}
async function switchMode(page, mode) {
  await page.locator('#learn-change-mode-btn').click();
  await choose(page, mode);
}
async function rate(page, action) {
  if (!(await page.locator('#learn-flashcard-inner').getAttribute('class')).includes('flipped')) await page.locator('#learn-f-flip').click();
  await page.locator('[data-review-action="' + action + '"]').click();
}

test('planned Library viewer reviews pictures, preserves first attempts and retries, and finishes explicitly', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = await plannedLibrary(page);
  await page.locator('#learn-f-list-btn').click();
  await page.locator('[data-peek-index]').filter({hasText:'Where does the sartorius muscle originate?'}).click();
  await page.locator('#learn-f-list-btn').click();
  await page.locator('#learn-f-flip').click();
  const picture = page.locator('#learn-stage .study-picture-open img').first();
  await expect(picture).toHaveJSProperty('naturalWidth', 360);
  await page.getByRole('button', { name: /Enlarge Picture for/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Picture viewer' })).toBeVisible();
  await page.getByRole('button', { name: 'Close picture', exact: true }).click();
  await rate(page, 'retry');
  const forward = await page.locator('#learn-f-next').isEnabled();
  await page.locator(forward ? '#learn-f-next' : '#learn-f-prev').click();
  await expect(page.locator('#learn-flashcard-front')).toContainText('What movement does the biceps perform?');
  await rate(page, 'good');
  await page.locator(forward ? '#learn-f-prev' : '#learn-f-next').click();
  await expect(page.locator('#learn-flashcard-front')).toContainText('Where does the sartorius muscle originate?');
  await rate(page, 'good');
  await expect.poll(() => fixture.run().retry_done).toEqual(['fc_0']);
  await switchMode(page, 'test');
  await expect(page.locator('#learn-q-options button')).toHaveCount(2);
  await page.locator('#learn-q-options').getByRole('button', { name: 'Flexion', exact: true }).click();
  await expect.poll(() => Object.keys(fixture.run().answers).length).toBe(3);
  expect(fixture.run().answers.fc_0.correct).toBe(false);
  expect(fixture.completions).toHaveLength(0);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('planned-library-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('planned-library-mobile.png') });
  expect(await page.locator('#learn-stage').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.locator('[data-finish]').click();
  await expect(page.locator('[data-phase]')).toHaveText('Session complete');
  expect(fixture.completions).toHaveLength(1);
  await expect(page.locator('[data-finish]')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('partial progress restores the exact Library position after reload without empty completion', async ({ page }) => {
  const fixture = await plannedLibrary(page);
  await rate(page, 'good');
  await page.locator('#learn-f-next').click();
  await expect(page.locator('#learn-f-progress')).toHaveText('Card 2 of 2');
  const savedFront = await page.locator('#learn-flashcard-front').textContent();
  await page.reload();
  await expect(page.locator('#setup-session-context')).toContainText('saved');
  await choose(page, 'flashcards');
  await expect(page.locator('#learn-flashcard-front')).toHaveText(savedFront);
  await expect(page.locator('[data-targets]')).toContainText('1 / 3');
  await page.locator('[data-finish]').click();
  await expect(page.locator('[data-save]')).toContainText('remaining planned targets');
  expect(fixture.completions).toHaveLength(0);
});

test('notes start immediately and completion requires the allocated focused reading time', async ({ page }) => {
  await page.clock.install();
  const fixture = await plannedLibrary(page, { notes: true, timerMode: 'pomodoro' });
  await page.locator('[data-finish]').click();
  expect(fixture.completions).toHaveLength(0);
  await page.clock.runFor(59000);
  await page.locator('[data-finish]').click();
  expect(fixture.completions).toHaveLength(0);
  // Cross the full reading interval regardless of the one-second ticker's start offset.
  await page.clock.runFor(2000);
  await page.locator('[data-finish]').click();
  await expect.poll(() => fixture.run().notes_seconds).toBeGreaterThanOrEqual(60);
  await expect(page.locator('[data-phase]')).toHaveText('Session complete');
  expect(fixture.completions).toHaveLength(1);
});

test('Pomodoro excludes break time, locks study controls during breaks and pauses hidden tabs', async ({ page }) => {
  await page.clock.install();
  const fixture = await plannedLibrary(page, { timerMode: 'pomodoro' });
  await page.clock.fastForward(25 * 60 * 1000);
  await expect(page.locator('[data-phase]')).toHaveText('Break');
  await expect(page.locator('#learn-mode-content')).toHaveAttribute('inert', '');
  await page.clock.fastForward(5 * 60 * 1000);
  await expect(page.locator('[data-phase]')).toHaveText('Focus');
  expect(fixture.run().active_seconds).toBe(1500);
  expect(fixture.run().slot_seconds).toBe(1800);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(10 * 60 * 1000);
  expect(fixture.run().slot_seconds).toBe(1800);
  await expect(page.locator('[data-pause]')).toHaveText('Continue');
  await page.locator('[data-finish]').click();
  expect(fixture.completions).toHaveLength(0);
});

test('planned setup starts the chosen Practice test viewer on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await plannedLibrary(page, { chooseMode: 'test', capturePicker: true });
  expect(fixture.starts.at(-1).study_mode).toBe('test');
  await expect(page.locator('#learn-q-text')).toHaveText('Which movement bends the elbow?');
  await expect(page.locator('#setup-overlay')).toBeHidden();
});

test('mode changes flush local pending progress before selecting the next viewer', async ({ page }) => {
  const fixture = await plannedLibrary(page);
  await page.addInitScript(() => {
    const key = 'planned_run_owner_run_focus';
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    Object.assign(saved, {slot_seconds:60,active_seconds:60,checkpoint_revision:100,answers:{fc_0:{type:'fc',correct:true}},pending_reviews:[{id:'fc_0',action:'good',key:'fc_0:first'}]});
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await choose(page, 'test');
  expect(fixture.run().answers.fc_0).toEqual({ type: 'fc', correct: true });
  expect(fixture.run().slot_seconds).toBeGreaterThanOrEqual(60);
  expect(fixture.starts.at(-1).study_mode).toBe('test');
  expect(fixture.checkpoints.some(checkpoint => checkpoint.pending_reviews.some(review => review.key === 'fc_0:first'))).toBe(true);
});
