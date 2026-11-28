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
  preview = spawn(python, ['scripts/run_ui_preview.py', '--academy-memory', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
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

for (const width of [390, 1440]) {
  test('the Google mark and label fit inside the Academy sign-in button at ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(academy + '/inloggen');
    const button = page.getByRole('button', { name: 'Doorgaan met Google', exact: true });
    const mark = button.locator('img');
    await expect(button).toBeVisible();
    await mark.evaluate(image => image.decode());
    const icon = await mark.boundingBox();
    const label = await button.getByText('Doorgaan met Google', { exact: true }).boundingBox();
    const bounds = await button.boundingBox();
    expect(icon.width).toBeGreaterThan(0);
    expect(icon.x).toBeGreaterThanOrEqual(bounds.x);
    expect(icon.x + icon.width).toBeLessThan(label.x);
    expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    await page.getByRole('button', { name: 'Wachtwoord vergeten?' }).click();
    await expect(button).toBeHidden();
  });
}

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
    const filter = page.locator('#academy-folder-filter');
    const folderTrigger = page.locator('#academy-folder-filter-button');
    const choose = async (trigger, name) => {
      await trigger.click();
      await page.getByRole('option', { name, exact: true }).click();
    };
    const dialog = page.getByRole('dialog');
    await choose(folderTrigger, 'Te beoordelen');
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
    await choose(folderTrigger, 'Te beoordelen');
    await page.getByRole('button', { name: 'Meer acties voor ' + course.title }).click();
    await page.getByRole('menuitem', { name: 'Naar map verplaatsen' }).click();
    await choose(dialog.locator('#academy-folder-destination-button'), 'Archive');
    await dialog.getByRole('button', { name: 'Verplaatsen', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Deze map is leeg' })).toBeVisible();
    await choose(folderTrigger, 'Archive');
    await expect(page.getByRole('link', { name: course.title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach('folder-library', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Map verwijderen' }).click();
    await expect(dialog).toContainText('Deelnemerslinks en antwoorden blijven beschikbaar');
    await dialog.getByRole('button', { name: 'Map verwijderen' }).click();
    await expect(filter).toHaveValue('*');
    await choose(folderTrigger, 'Zonder map');
    await expect(page.getByRole('link', { name: course.title, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: shared.title, exact: true })).toBeHidden();
  });
}

test('the Studio administrator can open Team from the library', async ({ page }) => {
  await signInToLibrary(page);
  await page.locator('#el-team-link').click();
  await expect(page).toHaveURL(academy + '/team');
  await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Uitnodigen' })).toBeVisible();
  await expect(page.locator('#el-admin-dialog')).toHaveCount(0);
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
  await page.getByRole('button', { name: /^Meer acties/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Delen en toegang' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Dupliceren' })).toHaveCount(0);
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
    test.setTimeout(120000);
    const headers = { Authorization: 'Bearer academy-preview-token' };
    const Model = require('../static/js/elearning-model');
    const course = Model.createExpeditionPreset('blank', 'Routecontrole', 'nl', { academy: true });
    const created = await page.request.post(academy + '/api/elearning/expeditions', { headers, data: course });
    expect(created.status()).toBe(201);
    const id = (await created.json()).expedition.id;
    const coursePath = '/expedities/' + id;
    const endpoint = academy + '/api/elearning/expeditions/' + id + '/sharing';
    const shared = await page.request.post(endpoint, { headers, data: { action: 'update_public', enabled: true } });
    expect(shared.status()).toBe(200);
    const token = (await shared.json()).share.token;
    const activePlayer = '/start/' + token;
    const grant = await page.request.post(endpoint, { headers, data: { action: 'create_grant', targetLanguage: 'de' } });
    expect(grant.status()).toBe(201);
    const grantPath = (await grant.json()).grant.urlPath;
    if (signedIn) {
      await page.goto(academy + '/inloggen');
      await page.evaluate(() => sessionStorage.setItem('academy-preview-user', 'studio-owner'));
    }
    const requested = [];
    page.on('request', request => requested.push(new URL(request.url())));
    const editor = coursePath + '/bewerken';
    const report = coursePath + '/resultaten';
    const aliases = {
      '/account': '/instellingen', '/signin': '/inloggen', '/physio/elearning': '/expedities',
      ['/physio/elearning/' + id + '/edit']: editor, ['/physio/elearning/' + id + '/responses']: report,
      ['/elearning/p/' + token]: activePlayer, [grantPath.replace('/vertalen/', '/elearning/translate/')]: grantPath,
    };
    for (const [alias, target] of Object.entries(aliases)) {
      const redirect = await page.request.get(academy + alias + '?lang=de', { maxRedirects: 0 });
      expect(redirect.status()).toBe(301);
      expect(redirect.headers().location).toBe(target + '?lang=de');
    }
    const paths = ['/', '/expedities', coursePath, editor, coursePath + '#delen', editor + '?modus=vertalen',
      report, '/resultaten', '/vertalingen', '/team', '/instellingen', '/hulp', '/privacy', '/inloggen', grantPath,
      activePlayer, '/start/expired-preview-token', '/missing-preview-page'];
    for (const path of paths) {
      const response = await page.goto(academy + path);
      const missing = ['/start/expired-preview-token', '/missing-preview-page'].includes(path);
      expect(response.status(), path).toBe(missing ? 404 : 200);
      await page.waitForLoadState('networkidle');
      const finalUrl = new URL(page.url());
      expect(finalUrl.origin).toBe(academy);
      expect(paths.map(item => item.split(/[?#]/)[0])).toContain(finalUrl.pathname);
      const state = await page.evaluate(() => ({
        project: window.Xped?.bootstrap?.firebaseConfig?.projectId,
        authenticated: window.firebase.auth().currentUser !== null,
        legacyRuntime: Boolean(window.LectureProcessorAuth || window.LectureProcessorBootstrap || window.LectureI18n),
        links: [
          ...Array.from(document.querySelectorAll('a[href]'), node => node.href),
          ...Array.from(document.forms, form => form.action),
          ...Array.from(document.querySelectorAll('[formaction]'), control => control.formAction),
        ],
      }));
      if (path.startsWith('/start/')) expect(state.project).toBeUndefined();
      else expect(state.project).toBe('demo-xped-academy');
      expect(state.authenticated).toBe(signedIn);
      expect(state.legacyRuntime).toBe(false);
      for (const href of state.links) {
        const url = new URL(href);
        if (url.protocol === 'mailto:') { expect(url.pathname).toBe('contact@example.test'); continue; }
        if (url.protocol === 'blob:') { expect(url.origin).toBe(academy); continue; }
        if (url.origin === 'https://xped.net') { expect(url.pathname).toMatch(/^\/(?:nl|de)\/$/); continue; }
        expect(url.origin, href).toBe(academy);
        expect(url.pathname, href).toMatch(/^\/(?:$|(?:inloggen|instellingen|team|hulp|privacy|resultaten|vertalingen|expedities)$|expedities\/[^/]+(?:\/(?:bewerken|resultaten))?$|(?:start|vertalen)\/[^/]+$|missing-preview-page$)/);
      }
    }
    const removed = await page.request.delete(academy + '/api/elearning/expeditions/' + id, { headers });
    expect(removed.status()).toBe(200);
    expect(requested.some(url => url.hostname.includes('lecture-processor') || /\/(?:firebase-bootstrap|auth-utils|app-shell|shared-ui)\.(?:js|css)$/.test(url.pathname))).toBe(false);
  });
}

for (const width of [390, 1440]) {
  test('learner chooses privacy with visible keyboard focus and finishes at ' + width + 'px', async ({ page }, testInfo) => {
    const Model = require('../static/js/elearning-model');
    const course = Model.createExpeditionPreset('blank', 'Pijn begrijpen', 'nl', { academy: true });
    course.modules[0].steps[0].blocks = [Model.createBlock('richtext')];
    course.modules.push(Model.createModule('blank', 1));
    const submissions = [];
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    // Exercise the actual initial server-render of a published course as well as the player.
    const headers = { Authorization: 'Bearer academy-preview-token' };
    const created = await page.request.post(academy + '/api/elearning/expeditions', { headers, data: course });
    expect(created.status()).toBe(201);
    const id = (await created.json()).expedition.id;
    const sharing = await page.request.post(academy + '/api/elearning/expeditions/' + id + '/sharing', {
      headers, data: { action: 'update_public', enabled: true, collectResponses: true }
    });
    expect(sharing.status()).toBe(200);
    const token = (await sharing.json()).share.token;
    await page.route('**/api/elearning/public/' + token + '/responses', route => {
      submissions.push(route.request().method());
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(academy + '/start/' + token + '?lang=nl');
    await expect(page.locator('.xped-hero-art img')).toHaveAttribute('src', course.startPage.heroMedia.staticPath);
    await expect(page.locator('.xped-hero-kicker')).toHaveCount(0);
    await page.locator('#el-comfort-trigger').click();
    const sizes = page.locator('.el-text-scale-group');
    const normal = sizes.getByRole('radio', { checked: true });
    await normal.focus();
    await page.keyboard.press('ArrowRight');
    const larger = sizes.locator('[data-scale=lg]');
    await expect(larger).toBeFocused();
    await expect(larger).toHaveAttribute('aria-checked', 'true');
    expect(await larger.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Home');
    await expect(sizes.locator('[data-scale=sm]')).toBeFocused();
    await page.locator('#el-comfort-trigger').click();
    await page.locator('.xped-hero-cta-row button').click();
    const consent = page.locator('.el-consent-card');
    await expect(consent.getByRole('heading', { name: 'Jouw gegevens' })).toBeVisible();
    const next = consent.locator('button[type=submit]');
    await expect(next).toBeEnabled();
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(consent.getByRole('alert')).toContainText('Kies');
    await expect(consent.getByRole('radio').first()).toBeFocused();
    await consent.locator('input[value=private]').check();
    await expect(consent.getByRole('alert')).toBeHidden();
    await next.click();
    await page.locator('.el-player-nav .xped-btn-primary').click();
    await page.locator('.el-milestone-card .xped-btn').first().click();
    await page.locator('.el-player-nav .xped-btn-primary').click();
    const finish = page.locator('.xped-completion-card');
    await expect(finish).toBeVisible();
    await expect(finish.locator('.academy-route-station')).toHaveCount(2);
    expect(submissions).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach('completion', { body: await page.screenshot(), contentType: 'image/png' });
  });
}

test('an author previews and replaces an existing private course cover', async ({ page }) => {
  const Model = require('../static/js/elearning-model');
  const course = {
    ...Model.createExpeditionPreset('blank', 'Mijn cursus', 'nl', { academy: true }),
    role: 'owner', revision: 1,
  };
  course.startPage.heroMedia = { kind: 'asset', assetId: 'my-cover' };
  await page.goto(academy + '/signin');
  await page.evaluate(() => sessionStorage.setItem('academy-preview-user', 'studio-owner'));
  await page.route('**/api/elearning/expeditions/visual', route => route.fulfill({ json: { expedition: course } }));
  await page.route('**/api/elearning/expeditions/visual/lease', route => route.fulfill({ json: { granted: true, lease_token: 'test-lease' } }));
  await page.route('**/api/elearning/expeditions/visual/assets/my-cover', route => {
    expect(route.request().headers().authorization).toBe('Bearer academy-preview-token');
    if (route.request().method() === 'HEAD') return route.fulfill({
      headers: { 'Content-Type': 'image/png', 'Content-Length': '31000', 'Content-Disposition': "inline; filename*=UTF-8''Mijn%20omslag.png" },
    });
    return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64') });
  });
  await page.goto(academy + '/physio/elearning/visual/edit');
  const preview = page.locator('.academy-media-file');
  await expect(preview).toContainText('Mijn omslag.png');
  await expect(preview).toContainText('1 × 1 px');
  await expect(preview).toContainText(/30[.,]3/);
  await page.locator('.el-asset-library summary').click();
  await page.locator('.el-asset-thumb').filter({ has: page.locator('img[src$="academy-rest.webp"]') }).click();
  await expect(preview).toContainText('Rustmoment');
  await expect(preview.locator('img')).toHaveAttribute('src', /academy-rest.webp$/);
});

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

test('Dutch exercise scores and German editing notices follow their own language', async ({ page, context }) => {
  const model = require('../static/js/elearning-model.js');
  const course = { ...model.createExpeditionPreset('blank', 'Oefening', 'nl'), id: 'balans', role: 'owner', revision: 1 };
  const station = course.modules[0];
  const step = station.steps[0];
  const balance = model.createBlock('balance_scale');
  balance.data.factors = [
    { id: 'belasting', category: 'load', label: { nl: 'Belasting' } },
    { id: 'herstel', category: 'resource', label: { nl: 'Herstel' } },
  ];
  step.blocks = [balance];
  let granted = true;
  await signInToLibrary(page);
  await context.addCookies([{ url: academy, name: 'xped-language', value: 'de' }]);
  await page.route('**/api/elearning/expeditions/balans', route => route.fulfill({ json: { expedition: course } }));
  await page.route('**/api/elearning/expeditions/balans/lease', route => route.fulfill({ json: {
    granted, lease_token: 'synthetic-edit', editor: { name: 'A. Auteur', updated_at: Math.floor(Date.now() / 1000) - 180 },
  } }));
  await page.goto(academy + '/expedities/balans/bewerken?module=' + station.id + '&step=' + step.id);
  const activity = page.locator('.xped-balance-stage').first();
  await expect(activity.locator('.xped-balance-status')).toContainText('In balans');
  await activity.locator('.xped-range.is-resource').press('End');
  await expect(activity.locator('.xped-balance-status')).toContainText('Sterke draagkracht');
  granted = false;
  await page.reload();
  await expect(page.getByText('A. Auteur bearbeitet diese Expedition', { exact: false })).toContainText('vor 3 Minuten');
  await expect(page.getByText('Sie können die Vorschau öffnen.', { exact: false })).toBeVisible();
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

test('creation presents localized starter descriptions before inserting any course material', async ({ page, context }) => {
  await context.addCookies([{ url: academy, name: 'xped-language', value: 'de' }]);
  await page.goto(academy + '/expedities');
  await page.evaluate(() => sessionStorage.setItem('academy-preview-user', 'studio-owner'));
  await page.reload();
  await page.getByRole('button', { name: 'Neue Expedition', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Beginnen Sie mit einer neutralen Station und einem leeren Schritt.');
  await expect(page.getByRole('dialog')).not.toContainText('Start from scratch');
});
