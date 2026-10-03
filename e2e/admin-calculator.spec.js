const { expectProductControls } = require('./helpers/control-audit');
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.browserFailures = [];
  page.on('pageerror', error => testInfo.browserFailures.push(error.message));
});

test.afterEach(async ({}, testInfo) => {
  expect(testInfo.browserFailures).toEqual([]);
});

async function openCalculator(page, futureRates = false) {
  const pricing = JSON.parse(fs.readFileSync('config/model_pricing.json', 'utf8'));
  pricing.pricing_as_of = futureRates ? '2027-01-01' : '2026-09-29';
  if (futureRates) {
    for (const rates of Object.values(pricing.models)) {
      for (const change of rates.rate_schedule || []) Object.assign(rates, change);
    }
  }
  await page.route('**/static/js/firebase-bootstrap.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: `(() => {
      const user = {uid:'pricing-test',email:'admin@example.com',getIdToken:async()=> 'test-token'};
      const auth = {currentUser:user,onAuthStateChanged(fn){queueMicrotask(()=>fn(user));}};
      window.LectureProcessorBootstrap = {getAuth:()=>auth};
    })();`,
  }));
  await page.route('**/api/admin/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === '/api/admin/model-pricing' ? pricing : path === '/api/admin/overview' ? {metrics:{total_users:124,job_count:58,success_jobs:55,failed_jobs:3,total_revenue_cents:14940,purchase_count:12,total_processed:870},deployment:{runtime:'render',request_host:'lectureprocessor.com',render_external_hostname:'lecture-processor-an-extremely-long-deployment-name.onrender.com',service_name:'lecture-processor',git_branch:'main',git_commit_short:'8449def'}} : {} });
  });
  // The server's admin session guard is covered by Python tests. Render the
  // real admin template with stub auth to isolate browser pricing behavior.
  const html = fs.readFileSync('templates/admin.html', 'utf8')
    .replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g, (_match, filename) => `/static/${filename}`)
    .replace("{{ url_for('static', filename=admin_js_asset or 'js/admin.js') }}", '/static/js/admin.min.js');
  await page.route('**/admin', route => route.fulfill({ contentType: 'text/html', body: html }));
  // Use the shipped minified asset to verify the production calculator too.
  await page.route(/\/static\/js\/admin(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({
    contentType: 'text/javascript', body: fs.readFileSync('static/js/admin.js', 'utf8'),
  }));
  await page.goto('/admin');
  await expect(page.locator('#calc-pricing-version')).toContainText(pricing.pricing_as_of);
}

async function selectScenario(page, key) {
  await page.locator('#calc-scenario-button').click();
  await page.locator(`#calc-scenario-menu [data-value="${key}"]`).click();
}

test('calculator uses current audio prices and switches Pro tiers above 200k tokens', async ({ page }) => {
  await openCalculator(page);
  await expect(page.locator('#calc-total')).toHaveText('$0.7655');
  await expect(page.locator('.calc-stage-model').first()).toContainText('Gemini 3.5 Flash-Lite');
  await selectScenario(page, 'interview_1h');
  await expect(page.locator('#calc-total')).toHaveText('$3.0000');
  const transcription = page.locator('.calc-stage-card').first();
  await expect(transcription.locator('.calc-stage-model')).toContainText('Standard >200k');
  await transcription.locator('.calc-in').fill('200000');
  await expect(transcription.locator('.calc-stage-model')).toContainText('Standard <=200k');
  await expect(transcription.locator('.cost-stage')).toHaveText('$0.8800');
  await transcription.locator('.calc-in').fill('200001');
  await expect(transcription.locator('.calc-stage-model')).toContainText('Standard >200k');
  await expect(transcription.locator('.cost-stage')).toHaveText('$1.5200');
});

test('interview coding calculator uses the scheduled Flash price change', async ({ page }) => {
  await openCalculator(page);
  await selectScenario(page, 'interview_coding');
  await expect(page.locator('#calc-total')).toHaveText('$0.0600');
  await openCalculator(page, true);
  await selectScenario(page, 'interview_coding');
  await expect(page.locator('#calc-total')).toHaveText('$0.1200');
});

 test('admin overview, credits and calculator fit desktop and mobile', async ({ page }) => {
  await openCalculator(page);
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expectProductControls(page);
    await page.locator('#admin-tab-overview').click();
    const exportMenu = page.locator('.admin-export-menu');
    await exportMenu.locator('summary').click();
    await expect(exportMenu.locator('.app-menu-panel')).toBeVisible();
    await page.screenshot({path: `/tmp/redesign-secondary-evidence/admin-export-open-${width}.png`, animations: 'disabled'});
    await exportMenu.locator('summary').press('ArrowDown');
    await expect(page.getByRole('menuitem', {name:'Export jobs CSV', exact:true})).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(exportMenu).not.toHaveAttribute('open', '');
    await expect(exportMenu.locator('summary')).toBeFocused();
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter(el => { const r=el.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !el.closest('.table-wrap,.app-select-menu'); }).map(el => ({tag:el.tagName,cls:el.className,right:Math.round(el.getBoundingClientRect().right)})).slice(0,12))).toEqual([]);
    await page.screenshot({path: `/tmp/redesign-secondary-evidence/admin-${width}.png`, fullPage: true, animations: 'disabled'});
    await page.locator('#admin-tab-credits').click();
    await page.screenshot({path: `/tmp/redesign-secondary-evidence/admin-credits-${width}.png`, fullPage: true, animations: 'disabled'});
  }
 });
