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
const normal = { ai_routing_valid: true, ai_routing_warnings: [] };
const fallback = { ai_routing_valid: false, ai_routing_warnings: [
  { stage: 'audio_transcription', reason: 'audio_lock' },
  { stage: 'notes_merge', reason: 'unsupported_provider' },
] };
const copy = {
  en: { title: 'AI routing', healthy: 'Configured', fallback: 'Review routing configuration', audio: 'Audio must use Gemini.', provider: 'Provider is not supported.' },
  nl: { title: 'AI-routering', healthy: 'Ingesteld', fallback: 'Controleer de routeringsconfiguratie', audio: 'Audio moet Gemini gebruiken.', provider: 'De aanbieder wordt niet ondersteund.' },
};

async function openAdmin(page, { language = 'en', theme = 'light', checks = normal } = {}) {
  const state = { checks, requests: [], errors: [], assets: [] };
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
    state.requests.push({ path: pathname, method: route.request().method() });
    const payload = pathname === '/api/admin/model-pricing' ? pricing : pathname === '/api/admin/overview' ? {
      metrics: {}, runtime_checks: { firebase_ready: true, gemini_ready: true, ...state.checks },
      deployment: { runtime: 'isolated', request_host: 'localhost', service_name: 'Synthetic preview' },
      data_warnings: ['Synthetic data warning retained.'],
    } : pathname === '/api/user-preferences' ? { preferences: { interface_language: language, theme } } : {};
    return route.fulfill({ json: payload });
  });
  await page.goto('/admin');
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(state.assets).toEqual([`/static/js/${asset}`]);
  return state;
}

async function refreshHealth(page) {
  const previous = await page.locator('#admin-ai-routing').elementHandle();
  await page.locator('#refresh-btn').click();
  await expect.poll(() => previous.evaluate(node => node.isConnected)).toBe(false);
  await previous.dispose();
}

for (const language of ['en', 'nl']) for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
  for (const warnings of [false, true]) {
    test(`${warnings ? 'fallback' : 'normal'} routing health in ${language} at ${width}px ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
      const state = await openAdmin(page, { language, theme, checks: warnings ? fallback : normal });
      const row = page.locator('#admin-ai-routing');
      await expect(row.locator('dt')).toHaveText(copy[language].title);
      await expect(row.getByRole('status')).toContainText(copy[language][warnings ? 'fallback' : 'healthy']);
      await expect(row.locator('li')).toHaveCount(warnings ? 2 : 0);
      if (warnings) {
        await expect(row).toContainText(copy[language].audio);
        await expect(row).toContainText(copy[language].provider);
      }
      await expect(page.locator('#admin-runtime-checks .status-row')).toHaveCount(11);
      await expect(page.locator('#admin-data-warnings')).toContainText('Synthetic data warning retained.');
      await expect(page.locator('#admin-partial-banner')).toBeVisible();
      await expect(page.locator('.admin-toast')).not.toHaveClass(/visible/);
      await row.scrollIntoViewIfNeeded();
      const bounds = await row.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      const detail = row.locator('dd');
      await expect(detail).toHaveCSS('text-align', warnings ? 'left' : 'right');
      for (const element of [detail, ...await row.locator('ul, li').all()]) {
        const inner = await element.boundingBox();
        expect(inner.x).toBeGreaterThanOrEqual(bounds.x);
        expect(inner.x + inner.width).toBeLessThanOrEqual(Math.min(bounds.x + bounds.width, width) + 1);
      }
      if (warnings) {
        const labelBounds = await row.locator('dt').boundingBox();
        const detailBounds = await detail.boundingBox();
        expect(detailBounds.y).toBeGreaterThanOrEqual(labelBounds.y + labelBounds.height);
        expect(Math.abs(detailBounds.x - bounds.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(detailBounds.width - bounds.width)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: testInfo.outputPath(`${warnings ? 'fallback' : 'normal'}-${language}-${width}-${theme}.png`), animations: 'disabled' });
      // The existing read-only cost report posts its filter payload on load.
      expect(state.requests.filter(request => request.method !== 'GET' &&
        !(request.method === 'POST' && request.path === '/api/admin/cost-analysis'))).toEqual([]);
      expect(state.errors).toEqual([]);
    });
  }
}

test('routing warnings translate on language change and clear after a healthy refresh', async ({ page }) => {
  const state = await openAdmin(page, { checks: fallback });
  const row = page.locator('#admin-ai-routing');
  await expect(row).toContainText(copy.en.audio);
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await expect(row).toContainText(copy.nl.audio);
  await expect(row).toContainText(copy.nl.provider);
  for (const checks of [normal, fallback, fallback]) {
    state.checks = checks;
    await refreshHealth(page);
    await expect(row.locator('dt')).toHaveText(copy.nl.title);
    await expect(row.getByRole('status')).toContainText(checks === normal ? copy.nl.healthy : copy.nl.fallback);
    await expect(row.locator('li')).toHaveCount(checks === normal ? 0 : 2);
    if (checks !== normal) {
      await expect(row).toContainText(copy.nl.audio);
      await expect(row).toContainText(copy.nl.provider);
      await expect(row).not.toContainText(copy.en.audio);
    }
  }
  await page.evaluate(() => window.LectureI18n.setLanguage('en'));
  await expect(row).toContainText(copy.en.audio);
  state.checks = normal;
  await refreshHealth(page);
  await expect(row.getByRole('status')).toHaveText(copy.en.healthy);
  await expect(row.locator('li')).toHaveCount(0);
  await expect(page.locator('#admin-runtime-checks .status-row')).toHaveCount(11);
  expect(state.errors).toEqual([]);
});

test('unrecognized diagnostic fields cannot become markup or expose arbitrary values', async ({ page }) => {
  const marker = '<img src=x onerror="window.routingInjected=true">synthetic-secret';
  const state = await openAdmin(page, { checks: { ai_routing_valid: false, ai_routing_warnings: [
    { stage: marker, reason: marker }, { stage: '__proto__', reason: 'constructor' }, null,
  ] } });
  const row = page.locator('#admin-ai-routing');
  await expect(row.locator('li')).toHaveCount(3);
  await expect(row).toContainText('Routing configuration is invalid.');
  await expect(row).not.toContainText('synthetic-secret');
  await expect(row.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.routingInjected)).toBeUndefined();
  expect(state.errors).toEqual([]);
});
