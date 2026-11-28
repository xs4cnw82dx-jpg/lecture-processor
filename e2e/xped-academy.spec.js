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
  await page.goto(academy + '/expedities');
  await expect(page.getByRole('heading', { name: 'Expedities' })).toBeVisible();
  await page.getByRole('link', { name: 'Inloggen', exact: true }).click();
  await expect(page).toHaveURL(/\/inloggen\?next=/);
  await page.getByLabel('E-mailadres', { exact: true }).fill('studio@example.test');
  await page.getByLabel('Wachtwoord', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page).toHaveURL(academy + '/expedities');
  await expect(page.getByRole('heading', { name: 'Maak je eerste expeditie' })).toBeVisible();
  await page.getByRole('button', { name: 'Expeditie maken', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await openAccountMenu(page);
  await page.locator('#academy-signout').click();
  await expect(page).toHaveURL(academy + '/');
  await page.goto(academy + '/expedities');
  await expect(page.getByRole('link', { name: 'Inloggen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nieuwe expeditie' })).toBeHidden();
  expect(errors).toEqual([]);
});

test('the Academy sign-in returns home when given an unrelated destination', async ({ page }) => {
  await page.goto(academy + '/signin?next=' + encodeURIComponent('https://other.example.test/'));
  await page.getByLabel('E-mailadres', { exact: true }).fill('studio@example.test');
  await page.getByLabel('Wachtwoord', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page).toHaveURL(academy + '/');
  await openAccountMenu(page);
  await expect(page.locator('#academy-signout')).toBeVisible();
});


test('an author can request a reset and receive a verification prompt after signing up', async ({ page }) => {
  await page.goto(academy + '/signin');
  await page.getByRole('button', { name: 'Wachtwoord vergeten?' }).click();
  await page.getByLabel('E-mailadres', { exact: true }).fill('studio@example.test');
  await expect(page.getByLabel('Wachtwoord', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Herstellink versturen' }).click();
  await expect(page.getByRole('status')).toContainText('ontvang je een e-mail');
  expect(await page.evaluate(() => sessionStorage.getItem('reset-recipient'))).toBe('studio@example.test');

  await page.getByRole('button', { name: 'Terug naar inloggen' }).click();
  await page.getByRole('button', { name: 'Account aanmaken' }).click();
  await page.getByLabel('Wachtwoord', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Account aanmaken' }).click();
  await expect(page.getByRole('heading', { name: 'Je e-mailadres bevestigen' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('De bevestigingsmail is verstuurd');
  expect(await page.evaluate(() => sessionStorage.getItem('verification-recipient'))).toBe('studio@example.test');
  await page.getByRole('button', { name: 'Ander account gebruiken' }).click();
  await expect(page.getByRole('heading', { name: 'Inloggen', exact: true })).toBeVisible();
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
    await expect(page.getByText('Inloggen is tijdelijk niet mogelijk. Laad de pagina opnieuw om het nog eens te proberen.', { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => window.Xped.bootstrap.firebaseConfig)).toBeNull();
  }
  expect(errors).toEqual([]);
});

async function openAccountMenu(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#ac-settings-toggle').click();
  await expect(page.locator('#ac-settings-toggle')).toHaveAttribute('aria-expanded', 'true');
}

async function signInToLibrary(page) {
  await page.goto(academy + '/inloggen?next=%2Fexpedities');
  await page.getByLabel('E-mailadres', { exact: true }).fill('studio@example.test');
  await page.getByLabel('Wachtwoord', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page).toHaveURL(academy + '/expedities');
}

for (const layout of [
  { label: 'phone in dark mode', width: 390, height: 844, theme: 'dark' },
  { label: 'desktop in light mode', width: 1280, height: 900, theme: 'light' },
]) {
  test('author organizes courses and reviews transfers on ' + layout.label, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.addInitScript(theme => localStorage.setItem('lp-preferences', JSON.stringify({ theme })), layout.theme);
    const folders = [{ id: 'account-review', name: 'Te beoordelen' }];
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
    const filter = page.getByLabel('Map', { exact: true });
    const dialog = page.getByRole('dialog');
    await filter.selectOption('account-review');
    await expect(page.getByRole('link', { name: course.title, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: shared.title, exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Map verwijderen' })).toBeHidden();
    await page.getByRole('button', { name: 'Nieuwe map' }).click();
    await dialog.getByLabel('Mapnaam').fill('Placements');
    await dialog.getByRole('button', { name: 'Opslaan' }).click();
    await expect(filter).toHaveValue('personal');
    await expect(page.getByRole('heading', { name: 'Deze map is leeg' })).toBeVisible();
    await page.getByRole('button', { name: 'Map hernoemen' }).click();
    await dialog.getByLabel('Mapnaam').fill('Archive');
    await dialog.getByRole('button', { name: 'Opslaan' }).click();
    await expect(filter.locator('option:checked')).toHaveText('Archive');
    await filter.selectOption('account-review');
    await page.getByRole('button', { name: 'Meer acties voor ' + course.title }).click();
    await page.getByRole('menuitem', { name: 'Naar map verplaatsen' }).click();
    await dialog.getByLabel('Doelmap').selectOption('personal');
    await dialog.getByRole('button', { name: 'Verplaatsen', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Deze map is leeg' })).toBeVisible();
    await filter.selectOption('personal');
    await expect(page.getByRole('link', { name: course.title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach('folder-library', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Map verwijderen' }).click();
    await expect(dialog).toContainText('Deelnemerslinks en antwoorden blijven beschikbaar');
    await dialog.getByRole('button', { name: 'Map verwijderen' }).click();
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
  await page.getByRole('button', { name: 'Beheer', exact: true }).click();
  await page.getByRole('button', { name: 'Studioauteurs' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('status')).toHaveText('Er zijn nog geen auteurs uitgenodigd.');
  await dialog.getByLabel('E-mailadres', { exact: true }).filter({ visible: true }).fill('Author@example.test');
  await dialog.getByRole('button', { name: 'Auteur toevoegen' }).click();
  await expect(dialog.getByText('author@example.test', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Intrekken' }).click();
  await dialog.getByRole('button', { name: 'Verwijderen bevestigen' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Er zijn nog geen auteurs uitgenodigd.');
  await expect(dialog.getByText('author@example.test', { exact: true })).toHaveCount(0);
  expect(calls).toEqual([{ action: 'grant', email: 'Author@example.test' }, { action: 'revoke', email: 'author@example.test' }]);
});

test('author invitations enable creation independently of course collaboration', async ({ page }) => {
  const library = { expeditions: [], canCreate: false, studioAdmin: false };
  await page.route('**/api/elearning/expeditions', route => route.fulfill({ json: library }));
  await signInToLibrary(page);
  await expect(page.getByRole('heading', { name: 'Auteur worden kan op uitnodiging' })).toBeVisible();
  for (const name of ['Beheer', 'Nieuwe expeditie', 'JSON importeren', 'Expeditie maken']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  library.expeditions = [{ id: 'shared', title: 'Shared project', moduleCount: 0, stepCount: 0, role: 'edit' }];
  await page.reload();
  await expect(page.getByRole('link', { name: 'Editor openen' })).toHaveAttribute('href', '/expedities/shared/bewerken');
  await expect(page.getByRole('button', { name: /^Meer acties/ })).toHaveCount(0);
  library.canCreate = true;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Nieuwe expeditie' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'JSON importeren' })).toBeVisible();
  await page.getByRole('button', { name: /^Meer acties/ }).click();
  await expect(page.getByText('Dupliceren', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Beheer', exact: true })).toHaveCount(0);
});

test('an unverified author can reopen verification from the Studio', async ({ page }) => {
  await page.goto(academy + '/expedities');
  await page.evaluate(() => {
    sessionStorage.setItem('academy-preview-user', 'studio-owner');
    sessionStorage.setItem('academy-preview-verified', 'false');
  });
  await page.reload();
  await openAccountMenu(page);
  await page.locator('#academy-verify-email').click();
  await expect(page.getByRole('heading', { name: 'Je e-mailadres bevestigen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bevestigingsmail opnieuw sturen' })).toBeVisible();
});

test('Dutch privacy details include a working contact link on a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => localStorage.setItem('lp-preferences', JSON.stringify({ language: 'nl', theme: 'dark' })));
  await page.goto(academy + '/privacy');
  await expect(page.getByRole('heading', { name: 'Vragen over je gegevens' })).toBeVisible();
  await expect(page.getByText('Heb je hulp nodig bij het openen', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'contact@example.test' })).toHaveAttribute('href', 'mailto:contact@example.test');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a Studio user can download personal data and resume a confirmed deletion', async ({ page }) => {
  await signInToLibrary(page);
  await openAccountMenu(page);
  await page.getByRole('link', { name: 'Mijn account' }).click();
  await expect(page.getByRole('heading', { name: 'Instellingen', exact: true })).toBeVisible();
  await page.route('**/api/academy/account/export', route => route.fulfill({
    json: { account: { email: 'studio@example.test' } },
    headers: { 'Content-Disposition': 'attachment; filename="xped-academy-account.json"' }
  }));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Accountgegevens downloaden' }).click();
  expect((await download).suggestedFilename()).toBe('xped-academy-account.json');
  const requestTimes = [];
  await page.route('**/api/academy/account/delete', route => {
    requestTimes.push(Date.now());
    const attempts = requestTimes.length;
    expect(route.request().postDataJSON()).toEqual({ confirmUid: 'studio-owner' });
    expect(route.request().headers().authorization).toBe('Bearer academy-preview-token');
    return route.fulfill({ status: attempts === 1 ? 202 : 200, headers: { 'Retry-After': '2' }, json: { complete: attempts > 1 } });
  });
  await page.getByRole('button', { name: 'Account verwijderen', exact: true }).click();
  await page.getByRole('button', { name: 'Annuleren' }).click();
  await expect(page.getByRole('button', { name: 'Account definitief verwijderen' })).toBeHidden();
  await page.getByRole('button', { name: 'Account verwijderen', exact: true }).click();
  await page.getByRole('button', { name: 'Account definitief verwijderen' }).click();
  expect(requestTimes).toHaveLength(0);
  await expect(page.getByRole('checkbox')).toHaveAccessibleDescription(/Verlaat je deze pagina.*bevestig opnieuw/);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Account definitief verwijderen' }).click();
  await expect(page.getByRole('status')).toHaveText('Je Studio-account is verwijderd.');
  expect(requestTimes).toHaveLength(2);
  expect(requestTimes[1] - requestTimes[0]).toBeGreaterThanOrEqual(1900);
  await expect(page.getByRole('button', { name: 'Accountgegevens downloaden' })).toBeHidden();
});

test('a stale sign-in can return to the account page for another confirmation', async ({ page }) => {
  await signInToLibrary(page);
  await page.goto(academy + '/instellingen');
  await page.route('**/api/academy/account/delete', route => route.fulfill({
    status: 403, json: { error: 'Log opnieuw in om het verwijderen van je account af te ronden.' }
  }));
  await page.getByRole('button', { name: 'Account verwijderen', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Account definitief verwijderen' }).click();
  await page.getByRole('button', { name: 'Opnieuw inloggen' }).click();
  await expect(page).toHaveURL(academy + '/inloggen?next=/instellingen');
  await page.getByLabel('E-mailadres', { exact: true }).fill('studio@example.test');
  await page.getByLabel('Wachtwoord', { exact: true }).fill('synthetic-preview-password');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page).toHaveURL(academy + '/instellingen');
  await expect(page.getByRole('button', { name: 'Account definitief verwijderen' })).toBeHidden();
});

test('switching identity invalidates an open deletion confirmation', async ({ page }) => {
  await signInToLibrary(page);
  await page.goto(academy + '/instellingen');
  let attempts = 0;
  await page.route('**/api/academy/account/delete', route => {
    attempts += 1;
    return route.fulfill({ json: { complete: true } });
  });
  await page.getByRole('button', { name: 'Account verwijderen', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.evaluate(() => {
    const auth = window.firebase.auth();
    auth.currentUser = { ...auth.currentUser, uid: 'different-user', email: 'different@example.test' };
  });
  await page.getByRole('button', { name: 'Account definitief verwijderen' }).click();
  await expect(page.getByRole('button', { name: 'Account definitief verwijderen' })).toBeHidden();
  expect(attempts).toBe(0);
});

for (const signedIn of [false, true]) {
  test('Academy page links and browser identity stay on the Academy when ' + (signedIn ? 'signed in' : 'signed out'), async ({ page }) => {
    if (signedIn) {
      await page.goto(academy + '/inloggen');
      await page.evaluate(() => sessionStorage.setItem('academy-preview-user', 'studio-owner'));
    }
    const requested = [];
    page.on('request', request => requested.push(new URL(request.url())));
    for (const path of ['/expedities', '/expedities/sample/bewerken?modus=vertalen', '/expedities/sample/resultaten', '/instellingen', '/privacy']) {
      const response = await page.goto(academy + path);
      expect(response.status()).toBe(200);
      expect(new URL(page.url()).origin).toBe(academy);
      const state = await page.evaluate(() => ({
        project: window.Xped.bootstrap.firebaseConfig.projectId,
        authenticated: window.firebase.auth().currentUser !== null,
        legacyRuntime: Boolean(window.LectureProcessorAuth || window.LectureProcessorBootstrap || window.LectureI18n),
        links: Array.from(document.querySelectorAll('a[href]'), node => node.href),
      }));
      expect(state.project).toBe('demo-xped-academy');
      expect(state.authenticated).toBe(signedIn);
      expect(state.legacyRuntime).toBe(false);
      for (const href of state.links) {
        const url = new URL(href);
        if (url.protocol === 'mailto:' || url.protocol === 'blob:') continue;
        expect(url.origin, href).toBe(academy);
        expect(url.pathname, href).not.toMatch(/^\/(?:lecture-notes|dashboard|study|admin|physio)(?:\/|$)/);
      }
    }
    expect(requested.some(url => url.hostname.includes('lecture-processor') || /\/(?:firebase-bootstrap|auth-utils|app-shell|shared-ui)\.(?:js|css)$/.test(url.pathname))).toBe(false);
  });
}

test('Dutch is the first Studio language and a signed-in German choice survives another browser visit', async ({ page, context }) => {
  let saved = null;
  await page.route('**/api/academy/preferences', async route => {
    expect(route.request().headers().authorization).toBe('Bearer academy-preview-token');
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON().language;
    return route.fulfill({ json: { language: saved } });
  });
  await signInToLibrary(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await openAccountMenu(page);
  await page.getByRole('button', { name: 'Deutsch', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('heading', { name: 'Expeditionen', exact: true })).toBeVisible();
  expect(saved).toBe('de');
  await context.clearCookies();
  await page.goto(academy + '/instellingen');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true })).toBeVisible();
  await page.goto(academy + '/privacy');
  await expect(page.getByRole('heading', { name: 'Fragen zu Ihren Daten' })).toBeVisible();
});

test('system appearance follows device changes and an explicit choice is retained', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(academy + '/instellingen');
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('main [data-academy-theme="system"]')).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.locator('main [data-academy-theme="light"]').click();
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.locator('main [data-academy-theme="system"]').click();
  await expect(root).toHaveAttribute('data-theme', 'dark');
});

test('review links open the requested field, approving its unchanged translation preserves the English archive', async ({ page }) => {
  const model = require('../static/js/elearning-model.js');
  const course = { ...model.createExpeditionPreset('blank', 'Cursus ter beoordeling', 'nl'), id: 'review', role: 'translate', revision: 1 };
  course.startPage.title = { nl: 'Welkom onderweg', de: 'Willkommen unterwegs', en: 'Retained historical text', _review: { de: true } };
  course.enabledLanguages = ['nl', 'de', 'en'];
  await signInToLibrary(page);
  await page.route('**/api/elearning/expeditions/review', route => route.fulfill({ json: { expedition: course } }));
  await page.route('**/api/elearning/expeditions/review/translations', async route => {
    const data = route.request().postDataJSON();
    expect(data.targetLanguage).toBe('de');
    expect(data.textUpdates).toEqual({ 'startPage.title': 'Willkommen unterwegs' });
    delete course.startPage.title._review;
    course.revision += 1;
    return route.fulfill({ json: { expedition: course } });
  });
  await page.goto(academy + '/expedities/review/bewerken?modus=vertalen&taal=de&veld=startPage.title');
  const row = page.locator('[data-field-key="startPage.title"]');
  await expect(row.getByRole('textbox')).toBeFocused();
  await expect(row.getByRole('textbox')).toHaveValue('Willkommen unterwegs');
  await expect(page.getByText('Deze expeditie bevat ook Engelse tekst.', { exact: false })).toBeVisible();
  await row.getByRole('button', { name: 'Vertaling goedkeuren' }).click();
  await expect.poll(() => course.revision).toBe(2);
  expect(course.startPage.title.en).toBe('Retained historical text');
});

test('dynamic interface labels use the scoped catalog and authored titles remain literal', async ({ page }) => {
  const literalTitle = 'Demo {do not translate}';
  await page.route('**/academy/messages/nl/library.js', async route => {
    const result = await route.fetch();
    const source = await result.text();
    const data = JSON.parse(source.slice('window.XpedMessages='.length, -1));
    for (const key of Object.keys(data)) data[key] = '⟦' + data[key] + '⟧';
    await route.fulfill({ response: result, body: 'window.XpedMessages=' + JSON.stringify(data) + ';' });
  });
  await page.route('**/api/elearning/expeditions', route => route.fulfill({ json: {
    expeditions: [{ id: 'pseudo', title: literalTitle, role: 'owner', defaultLanguage: 'nl', moduleCount: 1, stepCount: 1 }],
    folders: [], studioAdmin: true, canCreate: true
  } }));
  await signInToLibrary(page);
  await expect(page.getByRole('link', { name: literalTitle })).toBeVisible();
  await expect(page.getByRole('link', { name: '⟦Editor openen⟧' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/[▁�]/u);
});
