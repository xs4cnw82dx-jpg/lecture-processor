const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

for (const scenario of [
  { name: 'archived-only goals', goalStatus: 'archived', sessionStatus: null, canClear: false },
  { name: 'archived goals and completed sessions', goalStatus: 'archived', sessionStatus: 'completed', canClear: false },
  { name: 'archived goals with a remaining session', goalStatus: 'archived', sessionStatus: 'planned', canClear: true },
  { name: 'an active goal without sessions', goalStatus: 'active', sessionStatus: null, canClear: true },
]) {
  test(`clear-plan availability matches ${scenario.name}`, async ({ page }, testInfo) => {
    const fixture = await installAccountFixture(page);
    await page.route(/\/api\/study-plan\?/, route => route.fulfill({ json: {
      preferences: { timezone: 'UTC', availability: [], availability_configured: false,
        default_session_minutes: 45, reminder_offset_minutes: 30, revision: 1 },
      goals: [{ goal_id: 'saved-goal', title: 'Saved anatomy goal', exam_date: '2099-01-01',
        pack_ids: [], status: scenario.goalStatus, revision: 1 }],
      sessions: scenario.sessionStatus ? [{ id: 'saved-session', title: 'Anatomy review',
        status: scenario.sessionStatus, date: '2099-01-01', time: '09:00', duration: 30,
        planned_outcomes: {}, pack_id: '' }] : [],
      progress: { goals: [], due_cards: 0 }, study_packs: [], calendar_feeds: [],
      pace: { card_minutes: 1, question_minutes: 2, personalized: false },
    } }));
    await page.goto('/plan');
    await expect(page.locator('#study-plan-workspace')).toBeVisible();
    if (scenario.canClear) {
      await expect(page.locator('#clear-study-plan-btn')).toBeVisible();
    } else {
      await expect(page.locator('#clear-study-plan-btn')).toBeHidden();
      await expect(page.locator('#new-study-goal-label')).toHaveText('Set up my plan');
    }
    if (scenario.name === 'archived-only goals') {
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
          await page.screenshot({ path: testInfo.outputPath(`empty-plan-${theme}-${width}.png`),
            fullPage: true, animations: 'disabled' });
        }
      }
    }
    expect(fixture.browserErrors).toEqual([]);
  });
}
