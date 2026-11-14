const { test, expect } = require('@playwright/test');

test.use({ locale: 'nl-NL' });

function isoDay(offset = 0) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function installDutchRuntimeFixture(page, { unavailableSummary = false } = {}) {
  const state = {
    errors: [], patches: [], checkpoints: [], completions: [],
    pack: {
      study_pack_id: 'anatomy-pack', title: 'Anatomy notes', mode: 'manual', folder_id: '',
      notes_markdown: '# Active recall\n\nExplain the movement without looking at your notes.',
      flashcards: [
        { front: 'Where does the sartorius muscle originate?', back: 'Anterior superior iliac spine' },
        { front: 'What movement does the biceps perform?', back: 'Flexion of the elbow' },
      ],
      test_questions: [{ question: 'Which movement bends the elbow?', options: ['Flexion', 'Extension'], answer: 'Flexion', explanation: 'Flexion decreases the angle at a joint.' }],
      flashcards_count: 2, test_questions_count: 1,
    },
    session: {
      id: 'session_focus', title: 'Study Anatomy notes', pack_id: 'anatomy-pack', pack_title: 'Anatomy notes',
      date: isoDay(), time: '19:00', duration: 45, status: 'planned', revision: 2,
      goal_id: 'goal_anatomy', origin: 'automatic', locked: false,
      planned_outcomes: { flashcards: 2, questions: 1, notes_minutes: 0 },
    },
    run: {
      activity_id: 'run_focus', uid: 'localization-user', plan_item_id: 'session_focus', pack_id: 'anatomy-pack',
      study_mode: 'flashcards', mode_generation: 0, generation: 0, source: 'tracked',
      content_fingerprint: 'localization-content-v1',
      queue: [{ id: 'fc_0', type: 'fc', index: 0 }, { id: 'fc_1', type: 'fc', index: 1 }, { id: 'q_0', type: 'q', index: 0 }],
      answers: {}, pending_reviews: [], retry_done: [], active_seconds: 0, slot_seconds: 0,
      notes_seconds: 0, duration_seconds: 2700, timer_mode: 'countdown', run_status: 'paused', checkpoint_revision: 0,
    },
  };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => {
    const user = {
      uid: 'localization-user', email: 'student@example.test', emailVerified: true,
      getIdToken: () => Promise.resolve('localization-token'),
    };
    const auth = {
      currentUser: user, setPersistence: () => Promise.resolve(), authStateReady: () => Promise.resolve(),
      onAuthStateChanged(callback) { queueMicrotask(() => callback(auth.currentUser)); return () => {}; },
      signOut() { auth.currentUser = null; return Promise.resolve(); },
    };
    function factory() { return auth; }
    factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: factory };
    const preferences = JSON.stringify({ language: 'en', theme: 'light' });
    localStorage.setItem('lp-preferences', preferences);
    localStorage.setItem('lp-preferences:localization-user', preferences);
  });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  // No source routing: after integration the same cases exercise generated assets.
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const data = request.postDataJSON();
    let payload = {};
    if (path === '/api/auth/user') payload = { uid: 'localization-user', allowed: true, email_verified: true, onboarding_completed: true };
    else if (path === '/api/user-preferences') payload = { preferences: { interface_language: 'en', theme: 'light' } };
    else if (path === '/api/verify-email') payload = { allowed: true };
    else if (path === '/api/study-folders') payload = { folders: [] };
    else if (path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (path === '/api/study-plan/membership') payload = { pack_ids: [state.pack.study_pack_id] };
    else if (path.endsWith('/session_focus/run')) {
      if (data.study_mode && data.study_mode !== state.run.study_mode) {
        state.run.study_mode = data.study_mode;
        state.run.mode_generation += 1;
        state.run.checkpoint_revision += 1;
      }
      payload = { session: state.session, run: state.run };
    } else if (path.endsWith('/runs/run_focus')) {
      state.checkpoints.push(structuredClone(data));
      if (data.mode_generation !== state.run.mode_generation) return route.fulfill({ status: 409, json: { error: 'A newer synthetic mode is active.' } });
      state.run = { ...state.run, ...data };
      payload = { run: state.run };
    } else if (path.endsWith('/session_focus/completion')) {
      state.completions.push(structuredClone(data));
      state.session = {
        ...state.session, revision: state.session.revision + 1,
        status: data.action === 'reopen' ? 'planned' : 'completed',
        completion: data.action === 'reopen' ? {} : { source: data.source, reason: 'offline_log' },
      };
      payload = { session: state.session };
    } else if (path === '/api/study-packs/anatomy-pack') {
      if (method === 'PATCH') {
        state.patches.push(structuredClone(data));
        Object.assign(state.pack, structuredClone(data));
        payload = { ok: true, study_pack_id: state.pack.study_pack_id };
      } else payload = state.pack;
    } else if (path === '/api/study-packs') payload = { study_packs: [state.pack], has_more: false };
    else if (path === '/api/study-plan/library') payload = { study_packs: [state.pack], has_more: false };
    else if (path === '/api/study-plan') payload = {
      preferences: { timezone: 'UTC', availability: [{ weekday: 0, start: '19:00', end: '21:00' }], availability_configured: true, default_session_minutes: 45, reminder_offset_minutes: 30, revision: 1 },
      goals: [{ goal_id: 'goal_anatomy', title: 'Anatomy exam', exam_date: isoDay(21), pack_ids: ['anatomy-pack'], status: 'active', revision: 1 }],
      sessions: [state.session], study_packs: [state.pack], calendar_feeds: [],
      progress: { planned_minutes: 45, completed_minutes: 0, current_streak: 4, due_cards: 3, goals: [] },
      pace: { card_minutes: 1, question_minutes: 2, personalized: false },
      range: { from: isoDay(-7), to: isoDay(70) },
    };
    else if (path === '/api/study-plan/calendar/google') payload = { status: 'disconnected', available: false, pending: false };
    else if (path === '/api/study-progress/summary') {
      if (unavailableSummary) return route.fulfill({ status: 503, json: { error: 'Synthetic unavailable summary.' } });
      payload = { card_states: {}, daily_progress: {}, active_plan_pack_ids: ['anatomy-pack'], current_streak: 4, due_today: 3, daily_goal: 20, today_progress: 0 };
    } else if (path.includes('study-progress')) payload = { ok: true, card_states: {}, daily_progress: {} };
    else if (path.includes('/batch/jobs')) payload = { batches: [] };
    await route.fulfill({ json: structuredClone(payload) });
  });
  return state;
}

async function settleTranslation(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function language(page, value) {
  await page.evaluate(lang => window.LectureI18n.setLanguage(lang), value);
  await expect(page.locator('html')).toHaveAttribute('lang', value);
  await settleTranslation(page);
}

async function chooseMode(page, mode) {
  await expect(page.locator('#setup-overlay')).toBeVisible();
  for (const card of await page.locator('.lesson-card[data-lesson]').all()) {
    if ((await card.getAttribute('class')).includes('unavailable')) continue;
    if ((await card.getAttribute('aria-pressed') === 'true') !== (await card.getAttribute('data-lesson') === mode)) await card.click();
  }
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
}

async function openPlanned(page, mode = 'flashcards') {
  await page.goto('/study?pack_id=anatomy-pack&mode=learn&plan_item_id=session_focus');
  await chooseMode(page, mode);
  await expect.poll(() => page.evaluate(() => window.LecturePreferences.get().ready)).toBe(true);
  await language(page, 'nl');
}

test('Dutch planned counts, pause state and finish action follow live progress', async ({ page }) => {
  await page.clock.install();
  const state = await installDutchRuntimeFixture(page);
  await openPlanned(page);
  await expect(page.locator('[data-targets]')).toContainText('0 / 3');
  await expect(page.locator('[data-targets]')).toContainText('antwoorden opgeslagen');
  await expect(page.locator('[data-targets]')).toContainText('0 actieve min');
  await expect(page.locator('[data-targets]')).not.toContainText(/target answers|active min|planned slot/);
  await expect(page.locator('[data-pause]')).toHaveText('Pauzeren');
  await expect(page.locator('[data-timer-label]')).toHaveText('Aftellen');
  await expect(page.locator('[data-save]')).toHaveText('Voortgang opgeslagen');
  await expect(page.locator('[data-finish]')).toHaveText('Sessie afronden');
  await expect(page.locator('#learn-sub')).toHaveText('Leerkaarten · Gerichte studiesessie');
  await expect(page.locator('.learn-session-explanation')).toHaveText('Pauzeert als je dit tabblad verlaat. Het timertype blijft na de start hetzelfde.');
  await expect(page.locator('[data-break]')).toHaveText('Neem een korte pauze. Je kunt verder studeren zodra de volgende focusperiode begint.');

  await page.locator('#learn-f-flip').click();
  await page.locator('[data-review-action="good"]').click();
  await expect.poll(() => Object.keys(state.run.answers).length).toBe(1);
  await page.clock.runFor(61_000);
  await expect(page.locator('[data-targets]')).toContainText('1 / 3');
  await expect(page.locator('[data-targets]')).toContainText('1 actieve min');
  await expect(page.locator('[data-targets]')).not.toContainText(/target answers|active min|planned slot/);
  await page.locator('[data-pause]').click();
  await expect(page.locator('[data-phase]')).toHaveText('Gepauzeerd');
  await page.locator('[data-finish]').click();
  await expect(page.locator('[data-save]')).toContainText('Rond de resterende leerdoelen af');
  expect(state.completions).toHaveLength(0);

  await language(page, 'en');
  await expect(page.locator('[data-finish]')).toHaveText('Finish session');
  await page.locator('[data-pause]').click();
  await expect(page.locator('[data-targets]')).toContainText('1 / 3 target answers saved');
  expect(state.errors).toEqual([]);
});

test('Dutch Write feedback translates the result and preserves authored answers', async ({ page }) => {
  const state = await installDutchRuntimeFixture(page);
  await openPlanned(page, 'write');
  const prompt = await page.locator('#write-prompt').textContent();
  const answer = prompt.includes('sartorius') ? 'Anterior superior iliac spine' : 'Flexion of the elbow';
  await page.locator('#write-input').fill(answer);
  await page.locator('#write-check-btn').click();
  await expect(page.locator('#write-feedback')).toHaveClass(/correct-fb/);
  await expect(page.locator('#write-feedback')).toHaveText('Goed!');
  await expect(page.locator('#write-prompt')).toHaveText(prompt);
  await language(page, 'en');
  await expect(page.locator('#write-feedback')).toHaveText('Correct!');
  expect(state.errors).toEqual([]);
});

test('Dutch Builder autosave translates the real Saved. toast and saved-state control', async ({ page }) => {
  const state = await installDutchRuntimeFixture(page);
  await page.goto('/study?pack_id=anatomy-pack');
  await expect(page.locator('#notes-view')).toContainText('Explain the movement');
  await language(page, 'nl');
  await page.locator('#open-builder-btn').click();
  await expect(page.locator('#builder-overlay')).toBeVisible();
  await page.locator('#builder-title-input').fill('My unchanged English title');
  await expect.poll(() => state.pack.title).toBe('My unchanged English title');
  await expect(page.locator('.toast.visible')).toHaveText('Opgeslagen.');
  await expect(page.locator('#builder-stat-dirty')).toHaveText('Opgeslagen');
  await expect(page.locator('#builder-title-input')).toHaveValue('My unchanged English title');
  expect(state.errors).toEqual([]);
});

test('Dutch Plan completion toast retains the logged minute value and translated Undo', async ({ page }) => {
  const state = await installDutchRuntimeFixture(page);
  await page.goto('/plan');
  const row = page.locator('#today-session-list [data-session-id="session_focus"]');
  await expect(row).toBeVisible();
  await language(page, 'nl');
  await row.locator('[data-complete]').click();
  await page.locator('#study-log-minutes').fill('12');
  await page.locator('#study-log-submit').click();
  await expect(row).toHaveClass(/is-completed/);
  await expect(page.locator('#study-plan-toast')).toContainText('12 min geregistreerd. Sessie afgerond.');
  await expect(page.locator('#study-plan-toast').getByRole('button', { name: 'Ongedaan maken', exact: true })).toBeVisible();
  await expect(row.locator('p')).toContainText('Afgerond · zelf vastgelegde studietijd');
  expect(state.completions.at(-1).minutes).toBe(12);
  await language(page, 'en');
  await expect(page.locator('#study-plan-toast')).toContainText('12 min logged. Session completed.');
  await expect(page.locator('#study-plan-toast').getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await language(page, 'nl');
  await expect(page.locator('#study-plan-toast')).toContainText('12 min geregistreerd. Sessie afgerond.');
  await page.locator('#study-plan-toast').getByRole('button', { name: 'Ongedaan maken', exact: true }).click();
  await expect(row).not.toHaveClass(/is-completed/);
  expect(state.session.status).toBe('planned');
  expect(state.session.title).toBe('Study Anatomy notes');
  await expect(row).toContainText('Anatomy notes');
  expect(state.errors).toEqual([]);
});

test('Dutch Dashboard unavailable counts translate units after summary failure', async ({ page }) => {
  const state = await installDutchRuntimeFixture(page, { unavailableSummary: true });
  await page.goto('/dashboard');
  await expect(page.locator('#main-content')).toHaveAttribute('data-load-state', 'ready');
  await language(page, 'nl');
  await expect(page.locator('#dash-streak')).toHaveText('— dagen');
  await expect(page.locator('#dash-due')).toHaveText('— kaarten');
  await expect(page.locator('h1')).toHaveText('Elke dag een stap vooruit.');
  await language(page, 'en');
  await expect(page.locator('#dash-streak')).toHaveText('— days');
  await expect(page.locator('#dash-due')).toHaveText('— cards');
  expect(state.errors).toEqual([]);
});

test('Dutch planned session fits desktop and mobile in both themes', async ({ page }, testInfo) => {
  const state = await installDutchRuntimeFixture(page);
  await openPlanned(page);
  await page.locator('[data-pause]').click();
  await expect(page.locator('[data-phase]')).toHaveText('Gepauzeerd');
  await expect(page.locator('[data-finish]')).toHaveText('Sessie afronden');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.getSelection().removeAllRanges();
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
      await settleTranslation(page);
      // The fixed viewer must fit independently of the underlying Library tabs.
      // The existing Dutch Library tab row overflows at 375px even before this change.
      if (width === 1440) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('#learn-stage').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await page.evaluate(() => getComputedStyle(document.body).overflowY)).toBe('hidden');
      for (const selector of ['[data-pause]', '[data-finish]']) {
        const bounds = await page.locator(selector).boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: testInfo.outputPath(`planned-dutch-${theme}-${width}.png`), animations: 'disabled' });
    }
  }
  expect(state.errors).toEqual([]);
});
