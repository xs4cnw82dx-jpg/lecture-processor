const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

// Behaviour checks for the Dashboard's data loading (replacing source-text assertions).
async function dashboard(page, options = {}) {
  await installAccountFixture(page);
  const requests = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname + new URL(request.url()).search); });
  let failing = { sessions: !!options.failSessions, packs: !!options.failPacks };
  await page.route('**/api/study-progress/summary*', route => route.fulfill({ json: { active_plan_pack_ids: [], current_streak: 1, due_today: 2, daily_goal: 20, today_progress: 0 } }));
  await page.route('**/api/study-progress/due*', route => route.fulfill({ json: { due_count: 2, packs: [{ study_pack_id: 'notes', title: 'Anatomy notes', due_count: 2, cards: [{ front: 'What is flexion?' }] }] } }));
  await page.route('**/api/planner/sessions*', route => failing.sessions ? route.fulfill({ status: 503, json: { error: 'down' } }) : route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/study-packs?*', route => failing.packs ? route.fulfill({ status: 503, json: { error: 'down' } }) : route.fulfill({ json: { study_packs: [
    { study_pack_id: 'notes', title: 'Anatomy notes', mode: 'lecture-notes', flashcards_count: 3 },
    { study_pack_id: 'voice', title: 'Voice memo pack', mode: 'voice-note', flashcards_count: 0 },
  ] } }));
  await page.goto('/dashboard');
  await expect(page.locator('#main-content')).toHaveAttribute('data-load-state', 'ready');
  return { requests, recover: () => { failing = { sessions: false, packs: false }; } };
}

test('dashboard asks for the plan-scoped summary and a bounded recent pack list', async ({ page }) => {
  const { requests } = await dashboard(page);
  expect(requests).toContain('/api/study-progress/summary?scope=active_plan');
  await page.locator('#dash-due-open').click();
  await expect(page.locator('#dash-due-list')).toContainText('What is flexion?');
  expect(requests.some(url => url.startsWith('/api/study-progress/due?scope=active_plan'))).toBe(true);
  expect(requests).toContain('/api/study-packs?limit=10');
  expect(requests).not.toContain('/api/study-progress');
  expect(requests).not.toContain('/api/study-packs');
});

test('dashboard leaves voice-note packs out of the recent list', async ({ page }) => {
  await dashboard(page);
  await expect(page.locator('#dash-packs-list')).toContainText('Anatomy notes');
  await expect(page.locator('#dash-packs-list')).not.toContainText('Voice memo pack');
});

test('dashboard shows a retryable error instead of an empty state when lists fail to load', async ({ page }) => {
  const { recover } = await dashboard(page, { failSessions: true, failPacks: true });
  const retries = page.locator('[data-dashboard-retry]');
  await expect(retries.first()).toBeVisible();
  await expect(page.locator('#dash-packs-list')).not.toContainText('Upload your first lecture');
  recover();
  await retries.first().click();
  await expect(page.locator('#dash-packs-list')).toContainText('Anatomy notes');
});
