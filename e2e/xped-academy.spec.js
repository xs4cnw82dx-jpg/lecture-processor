const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createServer } = require('node:net');
const { once } = require('node:events');

let academy;
let preview;

test.beforeAll(async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  academy = 'http://127.0.0.1:' + port;
  const python = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';
  preview = spawn(python, ['scripts/run_ui_preview.py', '--academy', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  preview.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-2000); });
  await expect.poll(async () => {
    if (preview.exitCode !== null) throw new Error('Academy preview stopped: ' + diagnostics);
    try { return (await fetch(academy + '/healthz')).status; } catch (_) { return 0; }
  }, { timeout: 20000 }).toBe(200);
});

test.afterAll(async () => {
  if (preview && preview.exitCode === null && preview.signalCode === null) {
    const stopped = once(preview, 'exit');
    preview.kill('SIGTERM');
    await stopped;
  }
});

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    return origin === academy ? route.continue() : route.abort();
  });
  await page.addInitScript(() => {
    let app;
    const user = {
      uid: 'studio-owner', email: 'studio@example.test', emailVerified: sessionStorage.getItem('academy-preview-verified') !== 'false',
      getIdToken: async () => 'academy-preview-token',
    };
    const auth = {
      currentUser: sessionStorage.getItem('academy-preview-user') ? user : null,
      onAuthStateChanged(fn) { queueMicrotask(() => fn(this.currentUser)); return () => {}; },
      async signInWithEmailAndPassword(email) {
        if (email !== user.email) throw new Error('Unexpected preview identity');
        sessionStorage.setItem('academy-preview-user', user.uid);
        return { user };
      },
      async createUserWithEmailAndPassword(email) {
        this.currentUser = {
          ...user, email, emailVerified: false,
          async sendEmailVerification() { sessionStorage.setItem('verification-recipient', email); },
        };
        return { user: this.currentUser };
      },
      async sendPasswordResetEmail(email) { sessionStorage.setItem('reset-recipient', email); },
      async signOut() { sessionStorage.removeItem('academy-preview-user'); this.currentUser = null; },
    };
    window.firebase = {
      app() { if (!app) throw new Error('Not initialized'); return app; },
      initializeApp(config) {
        if (config.projectId !== 'demo-xped-academy') throw new Error('Wrong project');
        app = { options: config };
        return app;
      },
      auth: () => auth,
    };
  });
});

test('a new Studio author signs into the empty library and signs out on the Academy domain', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(academy);
  await expect(page.getByRole('heading', { name: 'Expeditions' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/signin\?next=/);
  await page.getByLabel('Email', { exact: true }).fill('studio@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(academy + '/physio/elearning');
  await expect(page.getByRole('heading', { name: 'Create your first expedition' })).toBeVisible();
  await page.getByRole('button', { name: 'Create expedition', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New expedition' })).toBeHidden();
  expect(errors).toEqual([]);
});

test('the Academy sign-in returns to the library when given an unrelated destination', async ({ page }) => {
  await page.goto(academy + '/signin?next=' + encodeURIComponent('https://other.example.test/'));
  await page.getByLabel('Email', { exact: true }).fill('studio@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(academy + '/physio/elearning');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});


test('an author can request a reset and receive a verification prompt after signing up', async ({ page }) => {
  await page.goto(academy + '/signin');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email', { exact: true }).fill('studio@example.test');
  await expect(page.getByLabel('Password', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('check your inbox');
  expect(await page.evaluate(() => sessionStorage.getItem('reset-recipient'))).toBe('studio@example.test');

  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Password', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Verification email sent');
  expect(await page.evaluate(() => sessionStorage.getItem('verification-recipient'))).toBe('studio@example.test');
  await page.getByRole('button', { name: 'Use another account' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});

test('author pages report unavailable sign-in when the Academy configuration is missing', async ({ page }) => {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const config = document.getElementById('academy-firebase-config');
      if (!config) return;
      config.remove();
      observer.disconnect();
    });
    observer.observe(document, { subtree: true, childList: true });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const path of ['/signin', '/physio/elearning', '/physio/elearning/example/edit', '/physio/elearning/example/responses']) {
    await page.goto(academy + path);
    await expect(page.getByText('Sign-in is temporarily unavailable. Reload this page to try again.', { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => window.LectureProcessorBootstrap.firebaseConfig)).toBeNull();
  }
  expect(errors).toEqual([]);
});

async function signInToLibrary(page) {
  await page.goto(academy + '/signin');
  await page.getByLabel('Email', { exact: true }).fill('studio@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(academy + '/physio/elearning');
}

for (const layout of [
  { label: 'phone in dark mode', width: 390, height: 844, theme: 'dark' },
  { label: 'desktop in light mode', width: 1280, height: 900, theme: 'light' },
]) {
  test('author organizes courses and reviews transfers on ' + layout.label, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.addInitScript(theme => localStorage.setItem('lp-preferences', JSON.stringify({ theme })), layout.theme);
    const folders = [{ id: 'account-review', name: 'Account review' }];
    const course = { id: 'one', title: 'Synthetic course', role: 'owner', moduleCount: 0, stepCount: 0, folderId: 'account-review' };
    const shared = { ...course, role: 'edit', id: 'two', title: 'Shared workshop', folderId: undefined };
    await page.route('**/api/elearning/expeditions', route => route.fulfill({
      json: { canCreate: true, studioAdmin: true, folders, expeditions: [course, shared] },
    }));
    await page.route('**/api/academy/folders', route => {
      folders.push({ id: 'personal', name: route.request().postDataJSON().name });
      return route.fulfill({ status: 201, json: { id: 'personal' } });
    });
    await page.route('**/api/academy/folders/personal', route => {
      if (route.request().method() === 'DELETE') {
        folders.pop();
        course.folderId = '';
      } else folders[1].name = route.request().postDataJSON().name;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/academy/expeditions/one/folder', route => {
      course.folderId = route.request().postDataJSON().folderId;
      return route.fulfill({ json: { ok: true } });
    });
    await signInToLibrary(page);
    const filter = page.getByLabel('Folder', { exact: true });
    const dialog = page.getByRole('dialog');
    await filter.selectOption('account-review');
    await expect(page.getByRole('link', { name: course.title, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: shared.title, exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Delete folder' })).toBeHidden();
    await page.getByRole('button', { name: 'New folder' }).click();
    await dialog.getByLabel('Folder name').fill('Placements');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(filter).toHaveValue('personal');
    await expect(page.getByRole('heading', { name: 'No expeditions in this folder' })).toBeVisible();
    await page.getByRole('button', { name: 'Rename folder' }).click();
    await dialog.getByLabel('Folder name').fill('Archive');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(filter.locator('option:checked')).toHaveText('Archive');
    await filter.selectOption('account-review');
    await page.getByRole('button', { name: 'More actions for ' + course.title }).click();
    await page.getByRole('menuitem', { name: 'Move to folder' }).click();
    await dialog.getByLabel('Destination folder').selectOption('personal');
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No expeditions in this folder' })).toBeVisible();
    await filter.selectOption('personal');
    await expect(page.getByRole('link', { name: course.title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach('folder-library', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Delete folder' }).click();
    await expect(dialog).toContainText('Learner links and responses stay available');
    await dialog.getByRole('button', { name: 'Delete folder' }).click();
    await expect(filter).toHaveValue('*');
    await filter.selectOption('');
    await expect(page.getByRole('link', { name: course.title, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: shared.title, exact: true })).toBeHidden();
  });
}

test('the Studio administrator can grant and revoke author access before creating a course', async ({ page }) => {
  const calls = [];
  const authors = new Set();
  await page.route('**/api/academy/authors', async route => {
    expect(route.request().headers().authorization).toBe('Bearer academy-preview-token');
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      calls.push(body);
      if (body.action === 'grant') authors.add(body.email.toLowerCase());
      else if (body.action === 'revoke') authors.delete(body.email);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { authors: [...authors] } });
  });
  await signInToLibrary(page);
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await page.getByRole('button', { name: 'Studio authors' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('status')).toHaveText('No invited authors yet.');
  await dialog.getByLabel('Email address', { exact: true }).filter({ visible: true }).fill('Author@example.test');
  await dialog.getByRole('button', { name: 'Add author' }).click();
  await expect(dialog.getByText('author@example.test', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Revoke' }).click();
  await dialog.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(dialog.getByRole('status')).toHaveText('No invited authors yet.');
  await expect(dialog.getByText('author@example.test', { exact: true })).toHaveCount(0);
  expect(calls).toEqual([{ action: 'grant', email: 'Author@example.test' }, { action: 'revoke', email: 'author@example.test' }]);
});

test('author invitations enable creation independently of course collaboration', async ({ page }) => {
  const library = { expeditions: [], canCreate: false, studioAdmin: false };
  await page.route('**/api/elearning/expeditions', route => route.fulfill({ json: library }));
  await signInToLibrary(page);
  await expect(page.getByRole('heading', { name: 'Author access is by invitation' })).toBeVisible();
  for (const name of ['Admin', 'New expedition', 'Import JSON', 'Create expedition']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  library.expeditions = [{ id: 'shared', title: 'Shared project', moduleCount: 0, stepCount: 0, role: 'edit' }];
  await page.reload();
  await expect(page.getByRole('link', { name: 'Open Builder' })).toHaveAttribute('href', '/physio/elearning/shared/edit');
  await expect(page.getByRole('button', { name: /^More actions/ })).toHaveCount(0);
  library.canCreate = true;
  await page.reload();
  await expect(page.getByRole('button', { name: 'New expedition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import JSON' })).toBeVisible();
  await page.getByRole('button', { name: /^More actions/ }).click();
  await expect(page.getByText('Duplicate', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Admin', exact: true })).toHaveCount(0);
});

test('an unverified author can reopen verification from the Studio', async ({ page }) => {
  await page.goto(academy);
  await page.evaluate(() => {
    sessionStorage.setItem('academy-preview-user', 'studio-owner');
    sessionStorage.setItem('academy-preview-verified', 'false');
  });
  await page.reload();
  await page.getByRole('link', { name: 'Verify your email' }).click();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resend verification email' })).toBeVisible();
});

test('Dutch privacy details include a working contact link on a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => localStorage.setItem('lp-preferences', JSON.stringify({ language: 'nl', theme: 'dark' })));
  await page.goto(academy + '/privacy');
  await expect(page.getByRole('heading', { name: 'Vragen over je gegevens' })).toBeVisible();
  await expect(page.getByText('Voor hulp bij het openen', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'contact@example.test' })).toHaveAttribute('href', 'mailto:contact@example.test');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a Studio user can download personal data and resume a confirmed deletion', async ({ page }) => {
  await signInToLibrary(page);
  await page.getByText('Settings', { exact: true }).click();
  await page.getByRole('link', { name: 'Studio account' }).click();
  await expect(page.getByRole('heading', { name: 'Studio account', exact: true })).toBeVisible();
  await page.route('**/api/academy/account/export', route => route.fulfill({
    json: { account: { email: 'studio@example.test' } },
    headers: { 'Content-Disposition': 'attachment; filename="xped-academy-account.json"' }
  }));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download account data' }).click();
  expect((await download).suggestedFilename()).toBe('xped-academy-account.json');
  const requestTimes = [];
  await page.route('**/api/academy/account/delete', route => {
    requestTimes.push(Date.now());
    const attempts = requestTimes.length;
    expect(route.request().postDataJSON()).toEqual({ confirmUid: 'studio-owner' });
    expect(route.request().headers().authorization).toBe('Bearer academy-preview-token');
    return route.fulfill({ status: attempts === 1 ? 202 : 200, headers: { 'Retry-After': '2' }, json: { complete: attempts > 1 } });
  });
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Permanently delete account' })).toBeHidden();
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  await page.getByRole('button', { name: 'Permanently delete account' }).click();
  expect(requestTimes).toHaveLength(0);
  await expect(page.getByRole('checkbox')).toHaveAccessibleDescription(/If you leave this page, return here and confirm again/);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Permanently delete account' }).click();
  await expect(page.getByRole('status')).toHaveText('Your Studio account has been deleted.');
  expect(requestTimes).toHaveLength(2);
  expect(requestTimes[1] - requestTimes[0]).toBeGreaterThanOrEqual(1900);
  await expect(page.getByRole('button', { name: 'Download account data' })).toBeHidden();
});

test('a stale sign-in can return to the account page for another confirmation', async ({ page }) => {
  await signInToLibrary(page);
  await page.goto(academy + '/account');
  await page.route('**/api/academy/account/delete', route => route.fulfill({
    status: 403, json: { error: 'Sign in again to finish deleting your account.' }
  }));
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Permanently delete account' }).click();
  await page.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(academy + '/signin?next=/account');
  await page.getByLabel('Email', { exact: true }).fill('studio@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(academy + '/account');
  await expect(page.getByRole('button', { name: 'Permanently delete account' })).toBeHidden();
});

test('switching identity invalidates an open deletion confirmation', async ({ page }) => {
  await signInToLibrary(page);
  await page.goto(academy + '/account');
  let attempts = 0;
  await page.route('**/api/academy/account/delete', route => {
    attempts += 1;
    return route.fulfill({ json: { complete: true } });
  });
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.evaluate(() => {
    const auth = window.firebase.auth();
    auth.currentUser = { ...auth.currentUser, uid: 'different-user', email: 'different@example.test' };
  });
  await page.getByRole('button', { name: 'Permanently delete account' }).click();
  await expect(page.getByRole('button', { name: 'Permanently delete account' })).toBeHidden();
  expect(attempts).toBe(0);
});
