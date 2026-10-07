const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const { installAccountFixture } = require('./helpers/batch-fixture');

async function fixture(page, options = {}) {
  const shared = await installAccountFixture(page);
  const state = {
    a: { interface_language: 'en', theme: 'light' },
    b: { interface_language: 'en', theme: 'light' },
  };
  const requests = [];
  const control = { failSave: false, failLoad: false, pending: null };
  await page.route(/\/static\/(js|css)\/[^/?]+(?:\?.*)?$/, route => {
    const asset = new URL(route.request().url()).pathname.replace(/\.min\.(js|css)$/, '.$1');
    const source = path.resolve('.' + asset);
    if (!fs.existsSync(source)) return route.continue();
    return route.fulfill({ path: source, contentType: asset.endsWith('.js') ? 'application/javascript' : 'text/css' });
  });
  await page.route('**/api/auth/user', route => {
    const uid = route.request().headers().authorization.replace('Bearer token-', '');
    return route.fulfill({ json: {
      uid, email: uid + '@example.test', is_admin: uid === 'a' && !!options.admin,
      credits: { lecture_credits_standard: 10 }, preferences: { ...state[uid], favorite_tools: [] },
    } });
  });
  await page.route('**/api/user-preferences', async route => {
    const req = route.request();
    const uid = req.headers().authorization.replace('Bearer token-', '');
    const entry = { uid, method: req.method(), payload: req.postDataJSON() };
    requests.push(entry);
    if (control.pending && control.pending.match(entry)) {
      const pending = control.pending;
      control.pending = null;
      pending.started();
      await pending.wait;
    }
    if ((entry.method === 'PUT' && control.failSave) || (entry.method === 'GET' && control.failLoad)) {
      return route.fulfill({ status: 503, json: { error: 'Synthetic temporary failure' } });
    }
    if (entry.method === 'PUT') Object.assign(state[uid], entry.payload);
    return route.fulfill({ json: { preferences: state[uid] } });
  });
  function hold(match) {
    let release;
    let started;
    const began = new Promise(resolve => { started = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    control.pending = { match, started, wait };
    return { began, release };
  }
  return { ...shared, state, requests, control, hold };
}

async function ready(page) {
  await expect(page.locator('#settings-dark-mode')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.LecturePreferences.get().ready)).toBe(true);
}

async function setLanguage(page, language) {
  await page.locator('#settings-language-button').click();
  await page.locator('#settings-language-menu [data-value="' + language + '"]').click();
  await expect.poll(() => page.evaluate(() => window.LecturePreferences.get().saving)).toBe(false);
  await expect(page.locator('#settings-language')).toHaveValue(language);
}

test('settings save, survive navigation/reload, and appear between email and billing', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/settings');
  await ready(page);
  await page.locator('#settings-dark-mode').check();
  await expect.poll(() => f.state.a.theme).toBe('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await setLanguage(page, 'nl');
  expect(f.state.a.interface_language).toBe('nl');
  await expect(page.locator('h1')).toHaveText('Instellingen');
  await page.reload();
  await ready(page);
  await expect(page.locator('#settings-dark-mode')).toBeChecked();
  await expect(page.locator('#settings-language')).toHaveValue('nl');
  await page.goto('/tools');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#shell-account-btn').click();
  const settingsLink = page.locator('#shell-account-menu a[href="/settings"]');
  await expect(settingsLink).toBeVisible();
  expect(await settingsLink.evaluate(el => el.previousElementSibling.id)).toBe('user-email');
  expect(await settingsLink.evaluate(el => el.nextElementSibling.getAttribute('role'))).toBe('separator');
  await settingsLink.click();
  await ready(page);
  await expect(page.locator('#settings-language')).toHaveValue('nl');
  expect(f.browserErrors).toEqual([]);
});

test('save failure rolls back appearance and allows a successful retry', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/settings');
  await ready(page);
  f.control.failSave = true;
  await page.locator('#settings-dark-mode').click();
  await expect(page.locator('#settings-status')).toHaveClass(/is-error/);
  await expect(page.locator('#settings-dark-mode')).not.toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(f.state.a.theme).toBe('light');
  f.control.failSave = false;
  await page.locator('#settings-dark-mode').check();
  await expect.poll(() => f.state.a.theme).toBe('dark');
  await expect(page.locator('#settings-status')).not.toHaveClass(/is-error/);
});

test('failed load keeps controls disabled until Try again recovers', async ({ page }) => {
  const f = await fixture(page);
  f.control.failLoad = true;
  await page.goto('/settings');
  await expect(page.locator('#settings-retry')).toBeVisible();
  await expect(page.locator('#settings-dark-mode')).toBeDisabled();
  f.control.failLoad = false;
  await page.locator('#settings-retry').click();
  await ready(page);
  await expect(page.locator('#settings-retry')).toBeHidden();
});

test('late old-account save cannot change the next account or signed-out view', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/settings');
  await ready(page);
  const held = f.hold(entry => entry.uid === 'a' && entry.method === 'PUT');
  await page.locator('#settings-dark-mode').check();
  await held.began;
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await ready(page);
  await expect(page.locator('#settings-dark-mode')).not.toBeChecked();
  held.release();
  await expect.poll(() => f.state.a.theme).toBe('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(f.state.b.theme).toBe('light');
  await page.evaluate(() => window.testAccount.switchTo(null));
  await expect(page.locator('#settings-dark-mode')).toBeDisabled();
  await expect(page.locator('#settings-auth')).toBeVisible();
  expect(await page.evaluate(() => window.LecturePreferences.get().signedIn)).toBe(false);
});

test('account switch while fetching a token cancels the old-account write', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/settings');
  await ready(page);
  await page.evaluate(() => {
    window.testAccount.currentUser.getIdToken = () => new Promise(resolve => { window.releaseOldToken = () => resolve('token-a'); });
    window.pendingPreferenceUpdate = window.LecturePreferences.update({ theme: 'dark' });
  });
  await expect.poll(() => page.evaluate(() => typeof window.releaseOldToken)).toBe('function');
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await ready(page);
  const result = await page.evaluate(async () => { window.releaseOldToken(); return window.pendingPreferenceUpdate; });
  expect(result).toBe(false);
  expect(f.requests.filter(entry => entry.uid === 'a' && entry.method === 'PUT')).toEqual([]);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('Workout is admin-only in Physio and starts its protected session before navigation', async ({ page }) => {
  await fixture(page, { admin: true });
  const logins = [];
  await page.route('**/api/session/login', route => {
    logins.push(route.request().headers().authorization);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/admin/workout', route => route.fulfill({ contentType: 'text/html', body: '<h1>Protected workout destination</h1>' }));
  await page.goto('/settings');
  await ready(page);
  await page.locator('#shell-physio-trigger').click();
  await expect(page.locator('#shell-workout-link')).toBeVisible();
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#shell-workout-link')).toBeHidden();
  await page.evaluate(() => window.testAccount.switchTo('a'));
  await expect(page.locator('#shell-workout-link')).toBeVisible();
  await page.locator('#shell-workout-link').click();
  await expect(page).toHaveURL(/\/admin\/workout$/);
  expect(logins).toEqual(['Bearer token-a']);
});

for (const width of [1440, 390]) {
  test('settings appearance and overflow at ' + width + 'px', async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 960 });
    await page.goto('/settings');
    await ready(page);
    const directory = process.env.SETTINGS_SCREENSHOT_DIR;
    if (directory) { fs.mkdirSync(directory, { recursive: true }); }
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.locator('#settings-dark-mode').check();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('#settings-language-button')).toBeVisible();
      await page.locator('#settings-language-button').click();
      await expect(page.locator('#settings-language-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      if (directory) {
        await page.screenshot({ path: path.join(directory, `settings-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
      }
    }
  });
}

test('late preference hydration cannot overwrite a newly signed-in account', async ({ page }) => {
  const f = await fixture(page);
  f.state.a.theme = 'dark';
  const held = f.hold(entry => entry.uid === 'a' && entry.method === 'GET');
  await page.goto('/settings');
  await held.began;
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await ready(page);
  held.release();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#settings-dark-mode')).not.toBeChecked();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lp-preferences:b')).theme)).toBe('light');
});

test('Workout cancels a session login when the admin token arrives after account switch', async ({ page }) => {
  await fixture(page, { admin: true });
  const logins = [];
  await page.route('**/api/session/login', route => {
    logins.push(route.request().headers().authorization);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/settings');
  await ready(page);
  await page.locator('#shell-physio-trigger').click();
  await expect(page.locator('#shell-workout-link')).toBeVisible();
  await page.evaluate(() => {
    window.testAccount.currentUser.getIdToken = () => new Promise(resolve => { window.releaseAdminToken = () => resolve('token-a'); });
  });
  await page.locator('#shell-workout-link').click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseAdminToken)).toBe('function');
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await ready(page);
  await page.evaluate(() => window.releaseAdminToken());
  await expect(page.locator('#shell-workout-link')).not.toHaveAttribute('aria-busy', 'true');
  expect(logins).toEqual([]);
  await expect(page).toHaveURL(/\/settings$/);
});

test('late Workout login response clears its admin cookie after account switch', async ({ page, context }) => {
  await fixture(page, { admin: true });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const logouts = [];
  await page.route('**/api/session/login', async route => {
    started();
    await held;
    return route.fulfill({ headers: { 'Set-Cookie': 'lp_admin_session=old-admin-session; Path=/; HttpOnly; SameSite=Lax' }, json: { ok: true } });
  });
  await page.route('**/api/session/logout', route => {
    logouts.push(route.request().method());
    return route.fulfill({ headers: { 'Set-Cookie': 'lp_admin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' }, json: { ok: true } });
  });
  await page.goto('/settings');
  await ready(page);
  await page.locator('#shell-physio-trigger').click();
  await expect(page.locator('#shell-workout-link')).toBeVisible();
  await page.locator('#shell-workout-link').click();
  await began;
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await ready(page);
  release();
  await expect.poll(() => logouts.length).toBe(1);
  await expect(page.locator('#shell-workout-link')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page).toHaveURL(/\/settings$/);
  expect((await context.cookies()).filter(cookie => cookie.name === 'lp_admin_session')).toEqual([]);
});
