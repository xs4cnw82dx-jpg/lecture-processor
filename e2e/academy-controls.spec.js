const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createServer } = require('node:net');
const { once } = require('node:events');
const Model = require('../static/js/elearning-model');
let origin, preview, course;

test.beforeAll(async () => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  origin = 'http://127.0.0.1:' + port;
  preview = spawn(existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3', ['scripts/run_ui_preview.py', '--academy-memory', '--port', String(port)], { stdio: 'ignore' });
  await expect.poll(async () => { try { return (await fetch(origin + '/healthz')).status; } catch (_) { return 0; } }, { timeout: 20000 }).toBe(200);
  const created = await fetch(origin + '/api/elearning/expeditions', { method: 'POST',
    headers: { Authorization: 'Bearer academy-preview-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(Model.createExpeditionPreset('bps-skeleton', 'Kleine stappen vooruit', 'nl')) });
  expect(created.ok).toBe(true);
  course = (await created.json()).expedition;
});
test.afterAll(async () => {
  if (preview && preview.exitCode === null && !preview.signalCode) { const done = once(preview, 'exit'); preview.kill(); await done; }
});
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    let app;
    const user = { uid: 'studio-owner', email: 'studio@example.test', emailVerified: true, getIdToken: async () => 'academy-preview-token' };
    const auth = { currentUser: user, onAuthStateChanged(fn) { queueMicrotask(() => fn(user)); return () => {}; } };
    window.firebase = { app() { if (!app) throw new Error('Missing test app'); return app; }, initializeApp(options) { return app = { options }; }, auth: () => auth };
  });
});

test('course tabs stay on one scrolling row on a phone and show which edge hides more tabs', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(origin + '/expedities/' + course.id);
  const tabs = page.locator('nav.xc-tabs');
  await expect(tabs).toHaveClass(/academy-tab-row/);
  const tops = await tabs.locator('a').evaluateAll(links => links.map(link => Math.round(link.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  expect(await tabs.evaluate(row => row.scrollWidth > row.clientWidth)).toBe(true);
  await expect(tabs).toHaveClass(/academy-tabs-end/);
  await expect(tabs).not.toHaveClass(/academy-tabs-start/);
  await tabs.evaluate(row => { row.scrollLeft = row.scrollWidth; });
  await expect(tabs).toHaveClass(/academy-tabs-start/);
  await expect(tabs).not.toHaveClass(/academy-tabs-end/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('typing in an open action menu jumps to the matching item', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin + '/expedities');
  const row = page.locator('.el-exp-row').filter({ hasText: course.title });
  await row.locator('.el-dd-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const items = await menu.getByRole('menuitem').allTextContents();
  const target = items.map(text => text.trim()).find((text, index) => index > 0 && text);
  await page.keyboard.press(target[0].toLocaleLowerCase('nl'));
  await expect(menu.getByRole('menuitem', { name: target, exact: true })).toBeFocused();
});

test('every keyboard stop on the overview shows the shared focus ring', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin + '/');
  await page.locator('main').waitFor();
  const seen = [];
  for (let stop = 0; stop < 18; stop++) {
    await page.keyboard.press('Tab');
    const state = await page.evaluate(() => {
      const node = document.activeElement;
      if (!node || node === document.body) return null;
      const style = getComputedStyle(node);
      return { name: (node.getAttribute('aria-label') || node.textContent || node.tagName).trim().slice(0, 40),
        visible: (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2) || style.boxShadow !== 'none' };
    });
    if (state) seen.push(state);
  }
  expect(seen.length).toBeGreaterThan(5);
  expect(seen.filter(stop => !stop.visible)).toEqual([]);
});

test('a long-running create action shows one announced busy state and returns to normal on failure', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(origin + '/api/elearning/expeditions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await held;
    return route.fulfill({ status: 503, json: { error: 'Tijdelijk niet beschikbaar.' } });
  });
  await page.goto(origin + '/expedities');
  await page.locator('#el-new-expedition-btn').click();
  await page.locator('#el-new-title').fill('Een rustige start');
  const confirm = page.locator('#el-create-confirm');
  // Layout width, unaffected by the dialog's opening scale animation.
  const width = await confirm.evaluate(button => button.offsetWidth);
  await confirm.click();
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: /^Bezig: / })).toBeAttached();
  expect(await confirm.evaluate(button => button.offsetWidth)).toBe(width);
  release();
  await expect(confirm).not.toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toBeEnabled();
});

test('Academy disclosures share one animated open state and keep native keyboard behaviour', async ({ page }) => {
  await page.goto(origin + '/expedities');
  const timing = await page.evaluate(() => {
    const details = document.createElement('details');
    details.id = 'probe';
    details.innerHTML = '<summary>Meer uitleg</summary><p>Uitleg</p>';
    document.querySelector('main').append(details);
    const content = getComputedStyle(details, '::details-content');
    return { duration: content.transitionDuration, property: content.transitionProperty };
  });
  expect(timing.property).toContain('block-size');
  expect(timing.duration.split(',')[0].trim()).toBe('0.18s');
  const summary = page.locator('#probe > summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#probe')).toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(page.locator('#probe')).not.toHaveAttribute('open', '');
});
