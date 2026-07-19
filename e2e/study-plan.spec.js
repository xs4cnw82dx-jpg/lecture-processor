const { test, expect } = require('@playwright/test');

function isoDate(offsetDays) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function installSignedInPlanner(page, options = {}) {
  const firebaseStub = `
    (function () {
      var user = { uid: 'e2e-user', email: 'student@example.com', displayName: 'Student', getIdToken: function () { return Promise.resolve('e2e-token'); } };
      var auth = { currentUser: user, setPersistence: function () { return Promise.resolve(); }, authStateReady: function () { return Promise.resolve(); }, onAuthStateChanged: function (callback) { setTimeout(function () { callback(user); }, 0); return function () {}; }, signOut: function () { return Promise.resolve(); } };
      function authFactory() { return auth; }
      authFactory.Auth = { Persistence: { LOCAL: 'local' } };
      window.firebase = { app: function () { return {}; }, initializeApp: function () { return {}; }, auth: authFactory };
    })();
  `;
  await page.addInitScript({ content: firebaseStub });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));

  const packs = Array.from({ length: options.packCount || 18 }, (_, index) => ({
    study_pack_id: `pack_question_${index + 1}`,
    title: `Question pack ${index + 1}`,
    flashcards_count: 0,
    test_questions_count: 40 + index,
    folder_id: '',
    folder_name: '',
    in_plan: false,
    workload: { questions_remaining: 40 + index, total_minutes: 92 }
  }));
  const today = isoDate(0);
  const tomorrow = isoDate(1);
  const missed = isoDate(-1);
  const fixture = {
    preferences: { timezone: 'UTC', availability: [0, 1, 2, 3, 4].map(weekday => ({ weekday, start: '19:00', end: '21:00' })), default_session_minutes: 45, reminder_offset_minutes: 30, revision: 1 },
    goals: options.withGoal === false ? [] : [{ goal_id: 'goal_e2e', title: 'Question final', exam_date: isoDate(21), pack_ids: ['pack_question_1'], status: 'active', revision: 1 }],
    sessions: options.sessions || [
      { id: 'session_today', title: 'Practice Question pack 1', date: today, time: '19:00', duration: 45, pack_id: 'pack_question_1', pack_title: 'Question pack 1', goal_id: 'goal_e2e', origin: 'automatic', locked: false, status: 'planned', revision: 1, planned_outcomes: { flashcards: 0, questions: 20, notes_minutes: 0 } },
      { id: 'session_tomorrow', title: 'Practice Question pack 1', date: tomorrow, time: '19:00', duration: 45, pack_id: 'pack_question_1', pack_title: 'Question pack 1', goal_id: 'goal_e2e', origin: 'automatic', locked: true, status: 'planned', revision: 1, planned_outcomes: { flashcards: 0, questions: 20, notes_minutes: 0 } },
      ...(options.missed ? [{ id: 'session_missed', title: 'Missed questions', date: missed, time: '19:00', duration: 45, pack_id: 'pack_question_1', goal_id: 'goal_e2e', origin: 'automatic', locked: false, status: 'planned', revision: 1, planned_outcomes: { questions: 20 } }] : [])
    ],
    progress: { planned_minutes: 90, completed_minutes: 45, cards_reviewed: 0, questions_answered: 26, correct: 20, incorrect: 6, accuracy_percent: 77, current_streak: 4, due_cards: 0, goals: [{ goal_id: 'goal_e2e', title: 'Question final', exam_date: isoDate(21), remaining_minutes: 180, scheduled_minutes: 180, on_track: true, needs_rebalance: !!options.missed }] },
    study_packs: packs,
    calendar_feeds: [],
    pace: { card_minutes: 1, question_minutes: 2, personalized: false },
    range: { from: isoDate(-7), to: isoDate(70) }
  };
  let failNextItemSave = false;

  await page.route('**/api/study-plan**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === '/api/study-plan' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    if (path === '/api/study-plan/membership') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pack_ids: fixture.goals.flatMap(goal => goal.pack_ids) }) });
    if (path === '/api/study-plan/preview' && method === 'POST') {
      const requestBody = request.postDataJSON();
      const proposal = {
        proposal_id: 'proposal_e2e', goal: Object.assign({ goal_id: requestBody.goal.goal_id || 'goal_created', revision: 0 }, requestBody.goal), preferences: requestBody.preferences,
        summary: { required_minutes: 92, scheduled_minutes: 90, shortage_minutes: 2, capacity_minutes: 450 },
        sessions: [{ id: 'sp_proposal_001', title: 'Study Question pack 1', date: tomorrow, time: '19:00', duration: 45, pack_id: requestBody.goal.pack_ids[0], pack_title: 'Question pack 1', goal_id: requestBody.goal.goal_id || 'goal_created', origin: 'automatic', locked: false, status: 'planned', revision: 1, planned_outcomes: { flashcards: 0, questions: 20, notes_minutes: 0 } }]
      };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ proposal }) });
    }
    if (path === '/api/study-plan/apply' && method === 'POST') {
      fixture.goals = [{ goal_id: 'goal_created', title: 'Question exam', exam_date: isoDate(30), pack_ids: ['pack_question_1'], status: 'active', revision: 1 }];
      fixture.sessions = [{ id: 'sp_proposal_001', title: 'Study Question pack 1', date: tomorrow, time: '19:00', duration: 45, pack_id: 'pack_question_1', pack_title: 'Question pack 1', goal_id: 'goal_created', origin: 'automatic', locked: false, status: 'planned', revision: 1, planned_outcomes: { flashcards: 0, questions: 20, notes_minutes: 0 } }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, session_ids: ['sp_proposal_001'], replayed: false }) });
    }
    if (path.startsWith('/api/study-plan/items/') && method === 'PUT') {
      if (failNextItemSave) {
        failNextItemSave = false;
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This session changed in another tab.', code: 'revision_conflict' }) });
      }
      const id = path.split('/').pop();
      const body = request.postDataJSON();
      const current = fixture.sessions.find(session => session.id === id) || {};
      const session = Object.assign({}, current, body, { id, revision: Number(current.revision || 0) + 1 });
      fixture.sessions = fixture.sessions.filter(item => item.id !== id).concat(session);
      return route.fulfill({ status: current.id ? 200 : 201, contentType: 'application/json', body: JSON.stringify({ ok: true, session }) });
    }
    if (path === '/api/study-plan/calendar-feeds' && method === 'POST') {
      const feed = { feed_id: 'feed_e2e', name: 'My phone', reminder_offset_minutes: 30, created_at: Date.now() / 1000, revoked_at: 0 };
      fixture.calendar_feeds = [feed];
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, feed, subscription_url: 'https://example.test/calendar/feed/feed_e2e.secret.ics' }) });
    }
    if (path === '/api/study-plan/calendar-feeds/feed_e2e' && method === 'DELETE') {
      fixture.calendar_feeds[0].revoked_at = Date.now() / 1000;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, feed: fixture.calendar_feeds[0] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  return { fixture, failNextSave: () => { failNextItemSave = true; } };
}

test('signed-in user creates a useful plan from many unfiled question-only packs', async ({ page }) => {
  await installSignedInPlanner(page, { withGoal: false, packCount: 24 });
  await page.goto('/plan?add_pack=pack_question_1');

  await expect(page.locator('#plan-wizard-overlay')).toBeVisible();
  await expect(page.locator('#wizard-pack-list .wizard-pack-option')).toHaveCount(24);
  await expect(page.locator('#wizard-pack-list input[value="pack_question_1"]')).toBeChecked();
  await page.locator('#wizard-next-btn').click();
  await page.locator('#wizard-goal-title').fill('Question exam');
  await page.locator('#wizard-exam-date').fill(isoDate(30));
  await page.locator('#wizard-next-btn').click();
  await page.locator('[data-availability-preset="daily"]').click();
  await page.locator('#wizard-next-btn').click();

  await expect(page.locator('#wizard-preview-sessions')).toContainText('Question pack 1');
  await expect(page.locator('#wizard-capacity-warning')).toContainText('stays within your availability');
  await page.locator('#wizard-next-btn').click();
  await expect(page.locator('#plan-wizard-overlay')).toBeHidden();
  await expect(page.locator('#next-session-content')).toContainText('Question pack 1');
  await expect(page.locator('#next-session-content a[href*="focus=test"][href*="plan_item_id="]')).toBeVisible();
});

test('desktop progress, failed-save rollback, missed catch-up, and calendar revoke are reliable', async ({ page }) => {
  const mock = await installSignedInPlanner(page, { missed: true });
  await page.goto('/plan?view=progress');
  await expect(page.locator('#progress-summary-grid')).toContainText('26');
  await expect(page.locator('#progress-summary-grid')).toContainText('77%');

  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.locator('[data-calendar-session="session_today"]').click();
  await page.locator('#session-editor-time').fill('21:00');
  mock.failNextSave();
  await page.locator('#session-editor-save').click();
  await expect(page.locator('#study-plan-toast')).toContainText('visible change was undone');
  await expect(page.locator('[data-calendar-session="session_today"] .calendar-session-time')).toContainText('19:00');

  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.locator('#rebalance-card')).toBeVisible();
  await page.locator('#review-rebalance-btn').click();
  await expect(page.locator('#plan-wizard-overlay')).toBeVisible();
  await page.locator('#plan-wizard-close').click();

  await page.getByRole('button', { name: 'Progress' }).click();
  await page.locator('#progress-calendar-connections-btn').click();
  await page.locator('#calendar-feed-name').fill('My phone');
  await page.locator('#calendar-feed-create-btn').click();
  await expect(page.locator('#calendar-feed-url')).toHaveValue(/feed_e2e\.secret\.ics/);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-feed-revoke]').click();
  await expect(page.locator('#calendar-feed-list')).toContainText('Revoked');
});

test('mobile agenda supports rescheduling and completing a question session', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSignedInPlanner(page);
  await page.goto('/plan?view=schedule');

  await expect(page.locator('#week-calendar')).toBeHidden();
  await expect(page.locator('#mobile-agenda')).toBeVisible();
  const todayRow = page.locator('#mobile-agenda [data-session-id="session_today"]');
  await todayRow.locator('[data-edit]').click();
  await page.locator('#session-editor-time').fill('20:30');
  await page.locator('#session-editor-save').click();
  await expect(page.locator('#mobile-agenda [data-session-id="session_today"] .session-row-time')).toContainText('20:30');
  await page.locator('#mobile-agenda [data-session-id="session_today"] [data-complete]').click();
  await expect(page.locator('#mobile-agenda [data-session-id="session_today"]')).toHaveClass(/is-completed/);
});

test('Study Plan controls and dialogs remain keyboard and screen-reader friendly', async ({ page }) => {
  await installSignedInPlanner(page);
  await page.goto('/plan');

  const duplicateIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicateIds).toEqual([]);

  const unnamedControls = await page.evaluate(() => [...document.querySelectorAll('button, input:not([type="hidden"]), select, textarea')]
    .filter(element => element.getClientRects().length > 0)
    .filter(element => !(
      element.getAttribute('aria-label')
      || element.getAttribute('aria-labelledby')
      || element.getAttribute('title')
      || (element.labels && element.labels.length)
      || element.textContent.trim()
    ))
    .map(element => element.outerHTML));
  expect(unnamedControls).toEqual([]);

  const progressTab = page.getByRole('button', { name: 'Progress' });
  await progressTab.focus();
  await page.keyboard.press('Enter');
  await expect(progressTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#study-plan-view-progress')).toBeVisible();

  const createButton = page.locator('#new-study-goal-btn');
  await createButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#plan-wizard-overlay')).toBeVisible();
  await expect(page.locator('#plan-wizard-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#plan-wizard-overlay')).toBeHidden();
  await expect(createButton).toBeFocused();
});
