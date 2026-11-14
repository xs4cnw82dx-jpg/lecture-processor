const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

for (const helperAvailable of [false, true]) {
  test(`Plan treats pack titles as text with HTML helper ${helperAvailable ? 'available' : 'missing'}`, async ({ page }, testInfo) => {
    const fixture = await installAccountFixture(page);
    if (!helperAvailable) {
      await page.route('**/static/js/html-utils.js', route => route.abort('failed'));
    }
    const title = '<img src="invalid" onerror="window.planMarkupRan=true"> A & B \'quoted\'';
    const pack = { study_pack_id: 'example', title, mode: 'manual', flashcards_count: 1,
      test_questions_count: 0, folder_name: '', workload: { cards_remaining: 1, total_minutes: 5 } };
    await page.route('**/api/study-plan**', route => route.fulfill({ json: {
      preferences: { availability: [], timezone: 'UTC' }, goals: [], sessions: [],
      study_packs: [pack], calendar_feeds: [], progress: {}, pace: {},
    } }));
    await page.goto('/plan');
    await expect(page.locator('#study-plan-workspace')).toBeVisible();
    if (!helperAvailable) expect(await page.evaluate(() => window.LectureProcessorHtml)).toBeUndefined();
    await page.locator('#new-study-goal-btn').click();
    const option = page.locator('#wizard-pack-list .wizard-pack-option');
    await expect(option.locator('strong')).toHaveText(title);
    await expect(option.locator('img, [onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => window.planMarkupRan)).toBeUndefined();
    await option.locator('input[type="checkbox"]').check();
    await expect(option.locator('input[type="checkbox"]')).toBeChecked();
    if (!helperAvailable) {
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
          await page.screenshot({ path: testInfo.outputPath(`plan-fallback-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
        }
      }
    }
    expect(fixture.browserErrors).toEqual([]);
  });
}
