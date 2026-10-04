const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });
test.skip(process.env.PLANNER_STATEFUL_FIXTURE !== '1', 'Requires isolated real planner/progress APIs');
const headers = { Authorization: 'Bearer planner-fixture-token' };

async function setup(page, request) {
  await request.post('/__planner-fixture/reset');
  await page.addInitScript(() => {
    const user = { uid: 'planner-fixture-user', email: 'planner@example.test', getIdToken: () => Promise.resolve('planner-fixture-token') };
    const auth = { currentUser: user, setPersistence: () => Promise.resolve(), authStateReady: () => Promise.resolve(), onAuthStateChanged: callback => { queueMicrotask(() => callback(user)); return () => {}; } };
    const factory = () => auth; factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: factory };
  });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.route('**/api/auth/user', route => route.fulfill({ json: { uid: 'planner-fixture-user', email_verified: true, onboarding_completed: true, allowed: true } }));
  const response = await request.put('/api/study-plan/items/integrated_session', { headers, data: {
    pack_id: 'fixture_mixed', title: 'Mixed planned study', date: new Date().toISOString().slice(0, 10),
    time: '17:00', duration: 45, planned_outcomes: { flashcards: 4, questions: 2 }
  } });
  expect(response.status()).toBe(201);
  await page.goto('/study?pack_id=fixture_mixed&mode=learn&plan_item_id=integrated_session');
  await expect(page.locator('#setup-overlay')).toBeVisible();
}

async function choose(page, mode) {
  const cards = page.locator('.lesson-card[data-lesson]');
  for (const card of await cards.all()) {
    if (await card.getAttribute('aria-disabled') === 'true' || (await card.getAttribute('class')).includes('unavailable')) continue;
    const selected = await card.getAttribute('aria-pressed') === 'true';
    if (selected !== (await card.getAttribute('data-lesson') === mode)) await card.click();
  }
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toHaveClass(/visible/);
  await expect(page.locator('#learn-session-tools [data-pause]')).toHaveText('Pause');
}

async function progress(request) {
  const response = await request.get('/api/study-progress', { headers });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('shared Library viewer writes actual planned answers once, switches modes and resumes saved question', async ({ page, request }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await setup(page, request);
  await choose(page, 'flashcards');
  await page.locator('#learn-f-flip').click();
  await page.locator('[data-review-action="good"]').click();
  await expect.poll(async () => Object.values((await progress(request)).card_states.fixture_mixed || {}).reduce((sum, state) => sum + state.seen, 0)).toBe(1);
  // Settings uses the same pane as the original Library launch.
  await page.locator('#learn-change-mode-btn').click();
  await expect(page.locator('#setup-main-content')).toBeVisible();
  await choose(page, 'notes');
  await expect(page.locator('#learn-notes-content')).toContainText('Movement notes');
  await page.locator('#learn-change-mode-btn').click();
  await choose(page, 'test');
  await page.locator('#learn-q-options').getByRole('button', { name: 'Yes', exact: true }).click();
  await expect.poll(async () => (await progress(request)).card_states.fixture_mixed?.q_0?.seen).toBe(1);
  await page.reload();
  await expect(page.locator('#setup-overlay')).toBeVisible();
  await choose(page, 'test');
  await expect(page.locator('#learn-q-score')).toContainText('1/2');
  await expect(page.locator('#learn-q-options').getByRole('button', { name: 'Yes', exact: true })).toBeDisabled();
  expect((await progress(request)).card_states.fixture_mixed.q_0.seen).toBe(1);
  await page.locator('[data-finish]').click();
  const plan = await (await request.get('/api/study-plan', { headers })).json();
  expect(plan.sessions.find(session => session.id === 'integrated_session').status).toBe('planned');
  await page.screenshot({ path: testInfo.outputPath('integrated-planned-library-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('integrated-planned-library-mobile.png'), animations: 'disabled' });
  expect(await page.locator('#learn-stage').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('a lost checkpoint response and reload cannot lose or double-credit a planned review', async ({ page, request }) => {
  await setup(page, request);
  await choose(page, 'flashcards');
  let dropped = false;
  await page.route('**/api/study-plan/runs/*', async route => {
    const payload = route.request().postDataJSON();
    if (!dropped && (payload.pending_reviews || []).length) {
      dropped = true;
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.locator('#learn-f-flip').click();
  await page.locator('[data-review-action="good"]').click();
  await expect.poll(() => dropped).toBe(true);
  await expect.poll(async () => Object.values((await progress(request)).card_states.fixture_mixed || {}).reduce((sum, state) => sum + state.seen, 0)).toBe(1);
  await page.reload();
  await expect(page.locator('#setup-overlay')).toBeVisible();
  await choose(page, 'flashcards');
  await expect(page.locator('#learn-session-tools [data-save]')).toHaveText('Progress saved');
  const restored = await progress(request);
  expect(Object.values(restored.card_states.fixture_mixed).reduce((sum, state) => sum + state.seen, 0)).toBe(1);
  expect(restored.summary.today_progress).toBe(1);
});
