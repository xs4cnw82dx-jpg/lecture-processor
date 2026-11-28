const { test, expect } = require('./helpers/academy-service');

function holdResponse(page, pattern) {
  let pending;
  const waiting = new Promise(resolve => { pending = resolve; });
  return page.route(pattern, route => pending(route)).then(() => waiting);
}

test('the library reserves its rows during slow requests, recovers and keeps privacy in settings', async ({ academyPage: page, academyOrigin }) => {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('#el-dash-grid[aria-busy="true"]')) {
        window.initialPlaceholderVisibility = getComputedStyle(document.querySelector('.ac-loading-library')).visibility;
        observer.disconnect();
      }
    });
    observer.observe(document, {subtree:true, attributes:true, attributeFilter:['aria-busy']});
  });
  const pending = holdResponse(page, '**/api/elearning/expeditions');
  await page.goto(academyOrigin + '/expedities');
  const route = await pending;
  const skeleton = page.locator('.ac-loading-library');
  await expect(skeleton).toBeVisible();
  expect(await page.evaluate(() => window.initialPlaceholderVisibility)).toBe('hidden');
  await expect(skeleton).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#el-dash-grid')).toHaveAttribute('aria-busy', 'true');
  await route.fulfill({ status:503, json:{error:'Tijdelijk niet beschikbaar'} });
  await expect(skeleton).toBeHidden();
  await expect(page.getByRole('status').filter({hasText:'Tijdelijk niet beschikbaar'})).toBeVisible();
  const retry = holdResponse(page, '**/api/elearning/expeditions');
  await page.locator('#el-retry').click();
  await (await retry).fulfill({json:{ expeditions:[{ id:'preview', title:'Proefexpeditie', role:'owner' }], canCreate:true, folders:[] }});
  await expect(page.getByRole('link',{name:'Proefexpeditie'})).toBeVisible();
  await expect(page.locator('#el-dash-grid')).toHaveAttribute('aria-busy','false');
  await expect(skeleton).toBeHidden();
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  await page.locator('#ac-settings-toggle').click();
  await expect(page.getByRole('link',{name:'Privacy',exact:true})).toHaveAttribute('href','/privacy');
});

test('a report retains its results while a new filter is pending and exposes retry after a failure', async ({ academyPage: page, academyOrigin }) => {
  const dataset = {expedition:{id:'preview', title:'Proefexpeditie', defaultLanguage:'nl', modules:[]}, cohorts:[], summary:{ totalSessions:12, completedSessions:4 }, funnel:[], stations:[], weekly:[], blockStats:{}, pilotFeedback:[], stepComments:[]};
  const first = holdResponse(page, '**/preview/responses');
  await page.goto(academyOrigin + '/expedities/preview/resultaten');
  const skeleton = page.locator('.ac-loading-report');
  await expect(skeleton).toBeVisible();
  await expect(page.locator('.ac-report-progress')).toBeHidden();
  await (await first).fulfill({json:dataset});
  const report=page.locator('#el-response-report');
  await expect(report).toBeVisible();
  await expect(skeleton).toBeHidden();
  const pending=holdResponse(page, '**/preview/responses?**');
  await page.locator('#el-resp-period').selectOption('7', {force:true});
  await expect(report).toHaveAttribute('aria-busy','true');
  await expect(report).toHaveCSS('opacity','0.6');
  await expect(report).toContainText('12');
  await expect(skeleton).toBeHidden();
  await expect(page.locator('.ac-report-progress')).toHaveCSS('height','2px');
  await (await pending).fulfill({status:503,json:{error:'Tijdelijk niet beschikbaar'}});
  await expect(page.locator('.ac-report-progress')).toBeHidden();
  await expect(page.locator('#el-resp-status')).toContainText('Tijdelijk niet beschikbaar');
  await expect(page.locator('#el-resp-retry')).toBeVisible();
  await expect(report).toHaveCSS('opacity','1');
  await expect(report).toContainText('12');
});
