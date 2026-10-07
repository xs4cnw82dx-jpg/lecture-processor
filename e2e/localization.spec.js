const { test, expect } = require('@playwright/test');
const path = require('node:path');

async function install(page, language = 'nl') {
  await page.goto('/');
  await page.evaluate((value) => window.LectureI18n.setLanguage(value), language);
}

test('Dutch covers public navigation, page copy and accessibility and switches back to English', async ({ page }) => {
  await install(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await expect(page.locator('h1')).toContainText('Minder');
  await expect(page.locator('nav[aria-label="Publieke navigatie"]')).toBeVisible();
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(page.locator('h1')).toContainText('Less');
  await expect(page.locator('nav[aria-label="Public navigation"]')).toBeVisible();
});

test('live UI translation preserves user content, inputs, markup and event listeners', async ({ page }) => {
  await page.setContent('<html><body><button id="action" aria-label="Save">Save</button><div id="status"></div><input id="title" value="Save" placeholder="Untitled pack"><div data-user-content><h2>Save</h2><p>Today</p></div><div class="item-title">Study Plan</div><div class="markdown-body">Save</div><textarea>Today</textarea><div contenteditable="true">Next</div><div translate="no">Cancel</div></body></html>');
  for (const name of ['i18n-catalog.js', 'i18n-supplement.js', 'i18n.js']) await page.addScriptTag({ path: path.join(__dirname, '../static/js', name) });
  await page.evaluate(() => {
    document.getElementById('action').addEventListener('click', () => { document.getElementById('status').textContent = 'Loading…'; });
    window.LectureI18n.setLanguage('nl');
  });
  await expect(page.locator('#action')).toHaveText('Opslaan');
  await expect(page.locator('#action')).toHaveAttribute('aria-label', 'Opslaan');
  await expect(page.locator('#title')).toHaveValue('Save');
  await expect(page.locator('#title')).toHaveAttribute('placeholder', 'Naamloos pakket');
  await expect(page.locator('[data-user-content] h2')).toHaveText('Save');
  await expect(page.locator('.item-title')).toHaveText('Study Plan');
  await expect(page.locator('.markdown-body')).toHaveText('Save');
  await expect(page.locator('textarea')).toHaveValue('Today');
  await expect(page.locator('[contenteditable]')).toHaveText('Next');
  await expect(page.locator('[translate=no]')).toHaveText('Cancel');
  await page.locator('#action').click();
  await expect(page.locator('#status')).toHaveText('Laden…');
  await page.evaluate(() => { document.getElementById('status').textContent = 'Saved'; });
  await expect(page.locator('#status')).toHaveText('Opgeslagen');
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(page.locator('#action')).toHaveText('Save');
  await expect(page.locator('#status')).toHaveText('Saved');
  await expect(page.locator('#title')).toHaveAttribute('placeholder', 'Untitled pack');
});

test('saved interface language loads on separate pages and does not alter output language controls', async ({ page }) => {
  const { installAccountFixture } = require('./helpers/batch-fixture');
  await installAccountFixture(page);
  await page.route('**/api/verify-email', route => route.fulfill({ json: { allowed: true } }));
  await page.route('**/api/user-preferences', route => route.fulfill({ json: { preferences: { interface_language: 'nl', theme: 'light' } } }));
  await page.goto('/lecture-notes');
  await expect.poll(() => page.evaluate(() => window.LecturePreferences.get().ready)).toBe(true);
  await expect(page.locator('.hero-title')).toHaveText('Collegeaantekeningen');
  await expect(page.locator('#study-pack-title-input')).toHaveAttribute('placeholder', 'Bijvoorbeeld: Celademhaling week 3');
  const outputValue = await page.locator('#output-language-select').inputValue();
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(page.locator('#output-language-select')).toHaveValue(outputValue);
});

test('Dutch settings, planner, dashboard, tools and creation fit desktop and mobile', async ({ page }, testInfo) => {
  const { installAccountFixture } = require('./helpers/batch-fixture');
  const fs = require('node:fs');
  await installAccountFixture(page);
  await page.route('**/api/**', route => {
    const endpoint = new URL(route.request().url()).pathname;
    let json = { allowed: true, onboarding_completed: true, preferences: { interface_language: 'nl', theme: 'dark' }, user: { uid: 'a', credits: { lecture: 10, slides: 10 } }, study_packs: [], folders: [], sessions: [], batches: [] };
    if (endpoint === '/api/study-plan') json = { preferences: { timezone: 'Europe/Amsterdam', availability: [], default_session_minutes: 45 }, goals: [], sessions: [], study_packs: [], progress: { goals: [] }, calendar_feeds: [], pace: {} };
    if (endpoint === '/api/study-progress/summary') json = { active_plan_pack_ids: [], current_streak: 0, due_today: 0, daily_goal: 20, today_progress: 0 };
    return route.fulfill({ json });
  });
  for (const entry of [ ['settings', '/settings', 'Instellingen'], ['plan', '/plan', 'Studieplanning'], ['dashboard', '/dashboard', 'Elke dag een stap vooruit.'], ['tools', '/tools', 'Meer hulpmiddelen'], ['creation', '/lecture-notes', 'Collegeaantekeningen'] ]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(entry[1]);
    await expect.poll(() => page.evaluate(() => window.LecturePreferences.get().ready)).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    await expect(page.locator('h1').first()).toHaveText(entry[2]);
    await page.screenshot({ path: testInfo.outputPath(entry[0] + '-nl-desktop.png'), fullPage: true, animations: 'disabled' });
    fs.writeFileSync(testInfo.outputPath(entry[0] + '-text.txt'), await page.locator('body').innerText());
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(entry[0] + '-nl-mobile.png'), fullPage: true, animations: 'disabled' });
  }
});
