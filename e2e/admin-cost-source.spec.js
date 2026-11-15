const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'parallel' });

const asset = process.env.USE_MINIFIED_JS_ASSETS === '1' ? 'admin.min.js' : 'admin.js';
const python = existsSync('.venv/bin/python') ? path.resolve('.venv/bin/python')
  : existsSync('venv/bin/python') ? path.resolve('venv/bin/python') : 'python3';
// The server admin-cookie gate has backend coverage. Render the real template
// and includes without importing the application or substituting script source.
const html = execFileSync(python, ['-c', `
import sys
from flask import Flask, render_template
app = Flask(__name__, template_folder=sys.argv[1], static_folder=sys.argv[2])
with app.test_request_context('/admin'):
    print(render_template('admin.html', admin_js_asset='js/' + sys.argv[3]))
`, path.resolve('templates'), path.resolve('static'), asset], { encoding: 'utf8', env: { PATH: process.env.PATH } });
const pricing = JSON.parse(readFileSync('config/model_pricing.json', 'utf8'));
const copy = {
  en: { provider_reported: 'Provider reported', tariff_estimate: 'Rate estimate', mixed: 'Reported + estimated' },
  nl: { provider_reported: 'Door aanbieder gerapporteerd', tariff_estimate: 'Tariefschatting', mixed: 'Gerapporteerd + geschat' },
};
function job(jobId, cost, costSource) {
  return { job_id: jobId, email: 'test@example.invalid', mode: 'tools', status: 'complete',
    finished_at: 1794744000, token_input_total: 100, token_output_total: 30, token_total: 130,
    cost_usd: cost, cost_eur: cost * 0.93,
    ...(costSource ? { cost_source: costSource, estimated_cost_usd: 0.8 } : {}) };
}
const mixedJobs = [job('legacy', 0.2), job('reported', 0.125, 'provider_reported'),
  job('zero', 0, 'provider_reported'), job('estimate', 0.3, 'tariff_estimate'), job('mixed', 0.05, 'mixed')];

async function openAdmin(page, { language = 'en', theme = 'light', jobs = mixedJobs } = {}) {
  const state = { jobs, errors: [], assets: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (/\/static\/js\/admin(?:\.min)?\.js$/.test(pathname)) state.assets.push(pathname);
  });
  await page.addInitScript(preferences => {
    localStorage.setItem('lp-preferences', JSON.stringify(preferences));
    const user = { uid: 'synthetic-admin', email: 'admin@example.invalid', getIdToken: async () => 'synthetic-token' };
    const auth = { currentUser: user, onAuthStateChanged(callback) { queueMicrotask(() => callback(user)); } };
    window.LectureProcessorBootstrap = { getAuth: () => auth };
  }, { language, theme });
  await page.route('https://**', route => route.abort());
  await page.route('**/static/js/firebase-bootstrap.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route('**/admin', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const payload = pathname === '/api/admin/model-pricing' ? pricing
      : pathname === '/api/admin/cost-analysis' ? { jobs: state.jobs, summary: { cost_source: 'mixed' } }
        : pathname === '/api/admin/overview' ? { metrics: {}, runtime_checks: {}, deployment: {} }
          : pathname === '/api/user-preferences' ? { preferences: { interface_language: language, theme } } : {};
    return route.fulfill({ json: payload });
  });
  await page.goto('/admin');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#analyzer-jobs-body tr')).toHaveCount(jobs.length);
  expect(state.assets).toEqual([`/static/js/${asset}`]);
  return state;
}
const row = (page, index) => page.locator('#analyzer-jobs-body tr').nth(index);
const source = page => page.locator('#analyzer-selection-meta .analyzer-cost-source');

for (const language of ['en', 'nl']) for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
  test(`cost sources in ${language} at ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    const state = await openAdmin(page, { language, theme });
    await expect(row(page, 0).locator('.analyzer-cost-source')).toHaveCount(0);
    for (const [index, key] of [[1, 'provider_reported'], [2, 'provider_reported'], [3, 'tariff_estimate'], [4, 'mixed']]) {
      await expect(row(page, index).locator('td').nth(9).locator('.analyzer-cost-source')).toHaveText(copy[language][key]);
    }
    await expect(source(page)).toHaveText(copy[language].mixed);
    await expect(page.locator('#analyzer-cost-usd')).toContainText(language === 'nl' ? '0,6750' : '0.6750');
    await expect(page.locator('.admin-toast')).not.toHaveClass(/visible/);
    await page.locator('#analyzer-selection-meta').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`summary-${language}-${width}-${theme}.png`), animations: 'disabled' });
    const table = page.locator('#analyzer-jobs-body').locator('..');
    await row(page, 1).locator('td').nth(9).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`rows-${language}-${width}-${theme}.png`), animations: 'disabled' });
    const tableContainer = await table.evaluate(node => {
      const bounds = node.parentElement.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, overflow: getComputedStyle(node.parentElement).overflowX };
    });
    expect(tableContainer.left).toBeGreaterThanOrEqual(0);
    expect(tableContainer.right).toBeLessThanOrEqual(width + 1);
    expect(tableContainer.overflow).toBe('auto');
    for (const node of [page.locator('#analyzer-selection-meta'), page.locator('#analyzer-summary')]) {
      const bounds = await node.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
    // A provider-reported zero remains authoritative, independent of the full-payload summary.
    await row(page, 2).getByRole('checkbox').check();
    await expect(source(page)).toHaveText(copy[language].provider_reported);
    await expect(page.locator('#analyzer-cost-usd')).toContainText(language === 'nl' ? '0,0000' : '0.0000');
    await row(page, 0).getByRole('checkbox').check();
    await expect(source(page)).toHaveText(copy[language].mixed);
    await row(page, 2).getByRole('checkbox').uncheck();
    await expect(source(page)).toHaveCount(0);
    await row(page, 3).getByRole('checkbox').check();
    await expect(source(page)).toHaveText(copy[language].tariff_estimate);
    await page.locator('#analyzer-clear-btn').click();
    await expect(source(page)).toHaveText(copy[language].mixed);
    expect(state.errors).toEqual([]);
  });
}

test('cost-source labels survive NL refresh and EN/NL changes', async ({ page }) => {
  const state = await openAdmin(page, { language: 'nl' });
  for (const language of ['nl', 'en', 'nl']) {
    await page.evaluate(language => window.LectureI18n.setLanguage(language), language);
    await expect(source(page)).toHaveText(copy[language].mixed);
    await page.locator('#analyzer-run-btn').click();
    await expect(row(page, 1).locator('.analyzer-cost-source')).toHaveText(copy[language].provider_reported);
    await expect(source(page)).toHaveText(copy[language].mixed);
  }
  expect(state.errors).toEqual([]);
});

test('legacy-only reports retain their cost cell and selection structure', async ({ page }) => {
  const state = await openAdmin(page, { jobs: [job('legacy', 0.2)] });
  await expect(page.locator('.analyzer-cost-source')).toHaveCount(0);
  expect(await row(page, 0).locator('td').nth(9).evaluate(node => node.childElementCount)).toBe(0);
  expect(await page.locator('#analyzer-selection-meta').evaluate(node => node.childElementCount)).toBe(0);
  await expect(page.locator('#analyzer-cost-usd')).toContainText('0.2000');
  expect(state.errors).toEqual([]);
});

test('unknown cost-source fields never become markup or claims', async ({ page }) => {
  await openAdmin(page, { jobs: [job('unknown', 0.2, '<img src=x onerror=alert(1)>')] });
  await expect(page.locator('.analyzer-cost-source')).toHaveCount(0);
  await expect(page.locator('#analyzer-jobs-body img')).toHaveCount(0);
});

for (const language of ['en', 'nl']) {
  test(`calculator shares use numeric stage costs in ${language}`, async ({ page }) => {
    const state = await openAdmin(page, { language });
    const cards = page.locator('#calc-stage-grid .calc-stage-card');
    await expect(cards).toHaveCount(4);
    // Published fixture rates: .0615 + .4875 + .4200 + .0590 = 1.0280 USD.
    await expect(cards.locator('.cost-share')).toHaveText(['6.0%', '47.4%', '40.9%', '5.7%']);
    await expect(page.locator('#calc-total')).toContainText(language === 'nl' ? '1,0280' : '1.0280');
    for (const input of await cards.locator('.calc-in, .calc-out').all()) await input.fill('0');
    await expect(cards.locator('.cost-share')).toHaveText(['0.0%', '0.0%', '0.0%', '0.0%']);
    await cards.first().locator('.calc-in').fill('1000000');
    await expect(cards.locator('.cost-share')).toHaveText(['100.0%', '0.0%', '0.0%', '0.0%']);
    await expect(page.locator('#calc-total')).toContainText(language === 'nl' ? '0,3000' : '0.3000');
    expect(state.errors).toEqual([]);
  });
}
