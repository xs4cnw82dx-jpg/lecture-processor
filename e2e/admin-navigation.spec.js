const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });

const asset = process.env.USE_MINIFIED_JS_ASSETS === '1' ? 'admin.min.js' : 'admin.js';
const python = existsSync('.venv/bin/python') ? path.resolve('.venv/bin/python')
  : existsSync('venv/bin/python') ? path.resolve('venv/bin/python') : 'python3';
const html = execFileSync(python, ['-c', `
import sys
from flask import Flask, render_template
app = Flask(__name__, template_folder=sys.argv[1], static_folder=sys.argv[2])
with app.test_request_context('/admin'):
    print(render_template('admin.html', admin_js_asset='js/' + sys.argv[3]))
`, path.resolve('templates'), path.resolve('static'), asset], { encoding: 'utf8', env: { PATH: process.env.PATH } });
const pricing = JSON.parse(readFileSync('config/model_pricing.json', 'utf8'));

async function openAdmin(page, { hash = '', language = 'en', theme = 'light' } = {}) {
  const state = { requests: [], errors: [] };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.addInitScript((preferences) => {
    localStorage.setItem('lp-preferences', JSON.stringify(preferences));
    const user = { uid: 'synthetic-admin', email: 'admin@example.invalid', getIdToken: async () => 'synthetic-token' };
    const auth = { currentUser: user, onAuthStateChanged(callback) { queueMicrotask(() => callback(user)); } };
    window.LectureProcessorBootstrap = { getAuth: () => auth };
  }, { language, theme });
  await page.route('https://**', (route) => route.abort());
  await page.route('**/static/js/firebase-bootstrap.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route('**/admin', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    state.requests.push(pathname);
    const payload = pathname === '/api/admin/model-pricing' ? pricing
      : pathname === '/api/admin/overview' ? { metrics: { total_users: 3 }, runtime_checks: { firebase_ready: true }, deployment: {} }
        : pathname === '/api/user-preferences' ? { preferences: { interface_language: language, theme } } : {};
    return route.fulfill({ json: payload });
  });
  await page.goto(`/admin${hash}`);
  await expect(page.locator('#dashboard')).toBeVisible();
  return state;
}

const visibleViews = (page) => page.locator('[data-admin-view]:visible');

test('grouped menus open one page at a time and load its data on first visit', async ({ page }) => {
  const state = await openAdmin(page);
  await expect(visibleViews(page)).toHaveCount(1);
  await expect(page.locator('[data-admin-view="overview"]')).toBeVisible();
  await expect(page.locator('#admin-page-title')).toHaveText('Overview');
  await expect(page.locator('#admin-tab-overview')).toHaveAttribute('aria-current', 'page');
  expect(state.requests).not.toContain('/api/admin/cost-analysis');

  const costs = page.locator('[data-admin-menu="costs"]');
  await costs.click();
  await expect(costs).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#admin-menu-costs')).toBeVisible();
  await page.locator('#admin-menu-costs').getByRole('link', { name: /Job cost analyzer/ }).click();
  await expect(page.locator('#admin-menu-costs')).toBeHidden();
  await expect(page).toHaveURL(/#costs\/analyzer$/);
  await expect(visibleViews(page)).toHaveCount(1);
  await expect(page.locator('[data-admin-view="costs/analyzer"]')).toBeVisible();
  await expect(page.locator('#admin-page-title')).toHaveText('Job cost analyzer');
  await expect(page.locator('#admin-period-filters')).toBeHidden();
  await expect(costs).toHaveClass(/is-current/);
  await expect.poll(() => state.requests.filter((p) => p === '/api/admin/cost-analysis').length).toBe(1);

  await page.goBack();
  await expect(page.locator('[data-admin-view="overview"]')).toBeVisible();
  await expect(page.locator('#admin-period-filters')).toBeVisible();
  await page.goForward();
  await expect(page.locator('[data-admin-view="costs/analyzer"]')).toBeVisible();
  // Returning to a page does not reload its data.
  expect(state.requests.filter((p) => p === '/api/admin/cost-analysis')).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test('menus work from the keyboard and a deep link opens its page directly', async ({ page }) => {
  await openAdmin(page, { hash: '#users/credits' });
  await expect(page.locator('[data-admin-view="users/credits"]')).toBeVisible();
  await expect(page.locator('#admin-page-title')).toHaveText('Credits and grants');
  const activity = page.locator('[data-admin-menu="activity"]');
  await activity.focus();
  await page.keyboard.press('ArrowDown');
  const items = page.locator('#admin-menu-activity a');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#admin-menu-activity')).toBeHidden();
  await expect(activity).toBeFocused();
  await activity.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-admin-view="activity/trends"]')).toBeVisible();
  await expect(page.locator('#admin-page-title')).toBeFocused();
});

for (const theme of ['light', 'dark']) {
  for (const language of ['en', 'nl']) {
    test(`admin navigation fits desktop and phone in ${language} ${theme}`, async ({ page }, testInfo) => {
      await openAdmin(page, { language, theme });
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const toggle = page.locator('#admin-nav-toggle');
        if (width <= 1100) {
          await expect(toggle).toBeVisible();
          await toggle.click();
          await expect(page.locator('#admin-nav')).toBeVisible();
        } else {
          await expect(toggle).toBeHidden();
        }
        await page.locator('[data-admin-menu="activity"]').click();
        await expect(page.locator('#admin-menu-activity')).toBeVisible();
        if (language === 'nl') await expect(page.locator('[data-admin-menu="activity"]')).toContainText('Activiteit');
        expect(await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width && box.right > innerWidth + 1 && !el.closest('.table-wrap,.app-select-menu');
        }).length)).toBe(0);
        await page.screenshot({ path: testInfo.outputPath(`admin-nav-${width}.png`), animations: 'disabled' });
        await page.locator('#admin-menu-activity').getByRole('link').first().click();
        await expect(page.locator('[data-admin-view="activity/trends"]')).toBeVisible();
        if (width <= 1100) await expect(page.locator('#admin-nav')).toBeHidden();
        await page.evaluate(() => { window.location.hash = 'overview'; });
      }
    });
  }
}

test('empty admin tables explain themselves to screen readers', async ({ page }) => {
  await openAdmin(page, { hash: '#batches' });
  const empty = page.locator('#admin-batch-jobs-body .admin-table-empty-state');
  await expect(empty).toContainText('No batch jobs match these filters');
  await expect(empty).toHaveAttribute('role', 'status');
  for (const view of ['activity/jobs', 'users/credits']) {
    await page.goto('/admin#' + view);
    const state = page.locator('[data-admin-view="' + view + '"] .admin-table-empty-state').first();
    await expect(state).toHaveText(/^No /);
    await expect(state).toHaveAttribute('role', 'status');
  }
});

test('stale audio clean-up asks first and announces its result', async ({ page }) => {
  const state = await openAdmin(page, { hash: '#system/health' });
  const button = page.locator('#admin-clean-stale-audio-btn');
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Clean stale audio flags?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeEnabled();
  expect(state.requests).not.toContain('/api/admin/maintenance/study-audio/cleanup-stale');
  await button.click();
  await page.getByRole('dialog').getByRole('button', { name: /Clean|Confirm|Continue/ }).click();
  const status = page.locator('#admin-clean-stale-audio-status');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveText('0 checked, 0 cleaned, 0 stale found.');
  expect(state.requests).toContain('/api/admin/maintenance/study-audio/cleanup-stale');
  await expect(button).toBeEnabled();
});
