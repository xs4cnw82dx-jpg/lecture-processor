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
      uid: 'studio-owner', email: 'studio@example.test', emailVerified: true,
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
