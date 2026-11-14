const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

async function dashboardFixture(page, options = {}) {
  const fixture = await installAccountFixture(page);
  const calls = { summary: 0, sessions: 0, packs: 0, due: 0 };
  const summary = { active_plan_pack_ids: ['planned'], current_streak: 3, due_today: 2, daily_goal: 20, today_progress: 4 };
  await page.route('**/api/study-progress/summary*', route => {
    calls.summary++;
    if (options.summaryFailure === 'network') return route.abort();
    return route.fulfill({ status: options.summaryFailure ? 503 : 200, json: summary });
  });
  await page.route('**/api/planner/sessions*', route => {
    calls.sessions++;
    return route.fulfill({ json: { sessions: [{ session_id: 'session', pack_id: 'planned', title: 'Practice anatomy', date: '2027-01-20', time: '19:00', status: 'planned' }] } });
  });
  await page.route('**/api/study-packs?*', route => {
    calls.packs++;
    return route.fulfill({ json: { study_packs: [{ study_pack_id: 'planned', title: 'Anatomy', mode: 'manual', flashcards_count: 2 }] } });
  });
  await page.route('**/api/study-progress/due*', route => {
    calls.due++;
    return route.fulfill({ json: { due_count: 2, packs: [{ study_pack_id: 'planned', title: 'Anatomy', due_count: 2, cards: [{ front: 'What is flexion?' }] }] } });
  });
  await page.goto('/dashboard');
  await expect(page.locator('#main-content')).toHaveAttribute('data-load-state', 'ready');
  return { ...fixture, calls, summary };
}

async function broadcast(page, payload, count = 1) {
  await page.evaluate(({ payload, count }) => {
    for (let i = 0; i < count; i++) window.LectureProcessorStudyProgressUtils.broadcastProgressEvent(payload);
  }, { payload, count });
}

for (const failure of ['http', 'network']) {
  test(`dashboard keeps saved sessions when the summary fails at ${failure} level`, async ({ page }) => {
    await dashboardFixture(page, { summaryFailure: failure });
    await expect(page.locator('#dash-sessions-list')).toContainText('Practice anatomy');
    await expect(page.locator('#dash-packs-list')).toContainText('Anatomy');
  });
}

test('dashboard applies same-account summaries without requests or changing the scoped due count', async ({ page }) => {
  await page.clock.install();
  const { calls } = await dashboardFixture(page);
  await page.locator('#dash-due-open').click();
  await expect(page.locator('#dash-due-list')).toContainText('What is flexion?');
  const before = { ...calls };
  await broadcast(page, { user_id: 'a', type: 'summary', summary: { current_streak: 7, due_today: 99, daily_goal: 30, today_progress: 12 } }, 12);
  await page.clock.fastForward(3500);
  await expect(page.locator('#dash-streak')).toHaveText('7 days');
  await expect(page.locator('#dash-goal')).toHaveText('12 / 30');
  await expect(page.locator('#dash-due')).toHaveText('2 cards');
  await expect(page.locator('#dash-due-panel')).toBeVisible();
  await expect(page.locator('#dash-due-panel')).toHaveAttribute('open', '');
  expect(calls).toEqual(before);
});

test('dashboard ignores progress broadcasts belonging to another account', async ({ page }) => {
  await page.clock.install();
  const { calls } = await dashboardFixture(page);
  const before = { ...calls };
  await broadcast(page, { user_id: 'other', type: 'summary', summary: { current_streak: 99, daily_goal: 99, today_progress: 99 } }, 5);
  await page.clock.fastForward(3500);
  await expect(page.locator('#dash-streak')).toHaveText('3 days');
  expect(calls).toEqual(before);
});

test('dashboard coalesces refresh broadcasts and preserves the open due panel', async ({ page }) => {
  await page.clock.install();
  const { calls } = await dashboardFixture(page);
  await page.locator('#dash-due-open').click();
  await expect(page.locator('#dash-due-list')).toContainText('What is flexion?');
  const before = { ...calls };
  await broadcast(page, { user_id: 'a', type: 'changed' }, 10);
  expect(calls).toEqual(before);
  await page.clock.fastForward(3500);
  await expect.poll(() => calls.summary).toBe(before.summary + 1);
  await expect(page.locator('#main-content')).toHaveAttribute('data-load-state', 'ready');
  expect(calls.sessions).toBe(before.sessions + 1);
  expect(calls.packs).toBe(before.packs + 1);
  await expect(page.locator('#dash-due-panel')).toBeVisible();
  await expect(page.locator('#dash-due-panel')).toHaveAttribute('open', '');
  await expect(page.locator('#dash-due-list')).toContainText('What is flexion?');
});

test('dashboard defers hidden-tab refreshes until the tab becomes visible', async ({ page }) => {
  await page.clock.install();
  const { calls } = await dashboardFixture(page);
  const before = { ...calls };
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await broadcast(page, { user_id: 'a', type: 'changed' }, 6);
  await page.clock.fastForward(10000);
  expect(calls).toEqual(before);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(3500);
  await expect.poll(() => calls.summary).toBe(before.summary + 1);
});

test('signed-out dashboard prompts use supporting text rather than statistic typography', async ({ page }, testInfo) => {
  await installAccountFixture(page);
  await page.goto('/dashboard');
  await page.evaluate(() => window.testAccount.switchTo(null));
  await expect(page.locator('#dash-due')).toHaveText('Sign in to review');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      const prompt = page.locator('#dash-due');
      expect(await prompt.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(16);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`dashboard-signed-out-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
  }
});
