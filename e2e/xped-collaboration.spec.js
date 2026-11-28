const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createServer } = require('node:net');
const { once } = require('node:events');
const Model = require('../static/js/elearning-model');
let origin, preview;

test.beforeAll(async () => {
  const portProbe = createServer().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  origin = 'http://127.0.0.1:' + port;
  preview = spawn(existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3', ['scripts/run_ui_preview.py', '--academy-memory', '--port', String(port)], { stdio: 'ignore' });
  await expect.poll(async () => { try { return (await fetch(origin + '/healthz')).status; } catch (_) { return 0; } }, { timeout: 20000 }).toBe(200);
});
test.afterAll(async () => {
  if (preview && preview.exitCode === null && !preview.signalCode) { const done = once(preview, 'exit'); preview.kill(); await done; }
});
async function post(url, body, token = 'academy-preview-token') {
  const result = await fetch(origin + url, { method:'POST', headers:{ Authorization:'Bearer ' + token, 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  expect(result.ok).toBe(true);
  return result.json();
}
async function account(page, role = 'owner') {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(role => {
    let app;
    const user = {
      uid: role === 'owner' ? 'studio-owner' : 'preview-' + role,
      email: (role === 'owner' ? 'studio' : role) + '@example.test', emailVerified:true,
      getIdToken: async () => 'academy-preview-' + (role === 'owner' ? 'token' : role),
    };
    const auth = { currentUser: user, onAuthStateChanged(fn) { queueMicrotask(() => fn(user)); return () => {}; } };
    window.firebase = { app() { if (!app) throw new Error('Missing test app'); return app; }, initializeApp(options) { return app = {options}; }, auth: () => auth };
  }, role);
}
async function createCourse(title) {
  const body = Model.createExpeditionPreset('bps-skeleton', title, 'nl');
  return (await post('/api/elearning/expeditions', body)).expedition;
}
async function choose(select, value) {
  // Exercise the visible custom control when the full integrated component kit is present.
  const label = await select.locator('option[value="' + value + '"]').textContent();
  const trigger = select.locator('xpath=following-sibling::*[1]').getByRole('button', {name:/./}).first();
  if (await select.isVisible()) await select.selectOption(value);
  else { await trigger.click(); await select.page().getByRole('option', { name:label, exact:true }).click(); }
}

for (const width of [390, 1440]) {
  test('owner manages a real learner link, translator grant and permission undo at ' + width + 'px', async ({ page }, info) => {
    await account(page);
    const course = await createCourse('Samen op pad ' + width);
    await page.setViewportSize({width, height:width===390?844:900});
    const url = origin + '/expedities/' + course.id;
    const snapshots = async name => {
      await page.evaluate(() => document.fonts.ready);
      await info.attach(name, { body:await page.screenshot({path: process.env.XPED_COLLAB_EVIDENCE ? process.env.XPED_COLLAB_EVIDENCE + '/' + name + '-' + width + '.png' : undefined}), contentType:'image/png' });
    };
    await page.goto(url);
    await expect(page.getByRole('heading',{name:course.title})).toBeVisible();
    await expect(page.locator('#xc-stations li')).toHaveCount(3);
    await expect(page.locator('#xc-cover img')).toHaveAttribute('src', course.startPage.heroMedia.staticPath);
    await expect(page.locator('#xc-cover img')).toBeVisible();
    await snapshots('hub');
    await page.getByRole('link',{name:'Delen en toegang',exact:true}).click();
    const enabled = page.getByRole('switch',{name:/Deelnemerslink actief/});
    await enabled.check();
    await expect(page.locator('#xc-sharing-status')).toHaveText('Opgeslagen');
    const collect = page.getByRole('switch',{name:/Antwoorden verzamelen/});
    await collect.uncheck();
    const peers = page.getByRole('switch',{name:/Groepsresultaten tonen/});
    await expect(peers).toBeDisabled();
    await expect(peers).toHaveAccessibleDescription(/Zet Antwoorden verzamelen aan/);
    await collect.check();
    await expect(peers).toBeEnabled();
    const shareURL = await page.locator('#xc-learner-link a').getAttribute('href');
    await expect(page.locator('#xc-learner-link a')).toHaveAccessibleName(shareURL.replace(/^https?:\/\//,''));
    await expect(page.locator('#xc-learner-link .xc-url-suffix')).toHaveText(shareURL.slice(-4));
    const linkResponse = await page.request.get(shareURL); expect(linkResponse.status()).toBe(200);
    await page.locator('#xc-learner-link').getByRole('button',{name:'QR',exact:true}).click();
    const qr = page.getByRole('dialog', { name: /QR-code|QR-Code/ });
    const dialog = page.locator('#xc-dialog');
    const download = page.waitForEvent('download');
    await qr.getByRole('button',{name:'PNG downloaden'}).click();
    expect((await download).suggestedFilename()).toBe('xped-qr.png');
    await qr.getByRole('button',{name:'Sluiten',exact:true}).last().click();

    await page.getByRole('button',{name:'Link maken',exact:true}).click();
    await dialog.getByLabel('Naam van de ontvanger').fill('Vertaalpartner');
    await dialog.getByRole('button',{name:'Link maken',exact:true}).click();
    const grantRow = page.locator('#xc-grants li').filter({hasText:'Vertaalpartner'});
    await expect(grantRow).toBeVisible();
    const grantURL = await grantRow.getByRole('link').getAttribute('href');
    const token = grantURL.split('/').pop();
    const exchange = () => page.request.post(origin + '/api/elearning/grant-session', {data:{token}});
    expect((await exchange()).status()).toBe(200);
    await grantRow.getByRole('button',{name:'Intrekken'}).click();
    await grantRow.getByRole('button',{name:'Bevestigen'}).click();
    await expect(grantRow).toHaveCount(0);
    expect((await exchange()).status()).toBe(404);
    await page.getByRole('button',{name:'Ongedaan maken'}).click();
    await expect(grantRow).toBeVisible(); expect((await exchange()).status()).toBe(200);
    await expect(page.getByRole('status').filter({hasText:'Toegang hersteld'})).toContainText('Toegang hersteld');
    await snapshots('sharing');
    await page.locator('[data-view=instellingen]').click();
    await page.getByRole('button',{name:'Link vernieuwen'}).click();
    await dialog.getByLabel('Typ de titel van de expeditie').fill('Anders');
    await dialog.getByRole('button',{name:'Link vernieuwen'}).click();
    await expect(dialog.getByRole('alert')).toContainText('precies');
    await dialog.getByLabel('Typ de titel van de expeditie').fill(course.title);
    await dialog.getByRole('button',{name:'Link vernieuwen'}).click();
    await expect(dialog).toBeHidden();
    expect([404, 410]).toContain((await page.request.get(shareURL)).status());
    await page.locator('[data-view=delen]').click();
    await expect(page.locator('#xc-learner-link a')).not.toHaveAttribute('href',shareURL);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('team assignments grant actual scoped author and translator access', async ({ page, browser }, info) => {
  const course = await createCourse('Vertalen in de Studio');
  await account(page);
  await page.goto(origin + '/team');
  await expect(page.getByRole('heading',{name:'Team',exact:true})).toBeVisible();
  const invite = page.getByRole('button',{name:'Uitnodigen'});
  await invite.click();
  const form = page.locator('#xc-dialog');
  await form.getByLabel('E-mailadres').fill('translator@example.test');
  await choose(form.locator('select[name=role]'), 'translate');
  await form.getByRole('checkbox',{name:course.title}).check();
  await form.getByRole('button',{name:'Toegang verlenen'}).click();
  await expect(form).toBeHidden();
  await page.goto(origin + '/team?persoon=translator%40example.test');
  const person = page.locator('#xc-team-list tr').filter({hasText:'translator@example.test'});
  await expect(person).toBeFocused();
  await expect(person).toContainText('Vertaler');
  const personCourses = person.getByRole('button',{name:/Expedities van/});
  await personCourses.click();
  const assignedCourses = page.getByRole('dialog',{name:/translator/i});
  await expect(assignedCourses.getByRole('link',{name:course.title})).toHaveAttribute('href','/expedities/'+course.id);
  await page.keyboard.press('Escape');
  await expect(assignedCourses).toBeHidden();
  await expect(personCourses).toBeFocused();
  if (process.env.XPED_COLLAB_EVIDENCE) await page.screenshot({path:process.env.XPED_COLLAB_EVIDENCE+'/team-1440.png'});
  const context = await browser.newContext();
  try {
    await page.goto(origin + '/expedities/' + course.id + '#vertalingen');
    await page.getByRole('button',{name:/Streefdatum vertaling/}).click();
    const today = page.getByRole('dialog',{name:'Kies een datum'}).locator('[data-date][aria-current]');
    const deadline = await today.getAttribute('data-date');
    await today.click();
    await page.getByRole('button',{name:'Datum opslaan'}).click();
    await expect(page.getByRole('status').filter({hasText:'Streefdatum opgeslagen'})).toContainText('Streefdatum opgeslagen');
    const translator = await context.newPage();
    await account(translator, 'translator');
    await translator.goto(origin);
    await expect(translator.getByRole('row').filter({hasText:course.title}).locator('time')).toHaveAttribute('datetime',deadline);
    await translator.goto(origin + '/expedities/' + course.id);
    await expect(translator.locator('#xc-deadline-label time')).toHaveAttribute('datetime',deadline);
    await expect(translator.getByRole('link',{name:'Vertalen',exact:true})).toHaveAttribute('href', /modus=vertalen&taal=de/);
    await expect(translator.getByRole('heading',{name:'Vertaling naar DE'})).toBeVisible();
    await expect(translator.locator('.xc-translation-action a').first()).toHaveAttribute('href', /modus=vertalen.*veld=/);
    await expect(translator.getByRole('link',{name:'Delen en toegang'})).toHaveCount(0);
    await translator.goto(origin + '/team');
    await expect(translator.getByText('Je hebt geen toegang tot deze pagina.')).toBeVisible();
    await expect(translator.getByRole('button',{name:'Uitnodigen'})).toHaveCount(0);
  } finally { await context.close(); }
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach('team-phone', {body:await page.screenshot({path:process.env.XPED_COLLAB_EVIDENCE ? process.env.XPED_COLLAB_EVIDENCE+'/team-390.png' : undefined}),contentType:'image/png'});
});

test('library duplicates immediately from the keyboard and restores focus on success or failure', async ({page}) => {
  await account(page);
  const course = await createCourse('Kleine stappen');
  await page.goto(origin + '/expedities');
  const original = page.locator('[data-expedition-row="' + course.id + '"]');
  const menu = original.getByRole('button',{ name:/More actions|Meer acties|Weitere Aktionen/ });
  const duplicate = page.getByRole('menuitem',{name:/Duplicate|Dupliceren|Duplizieren/});
  let fail = true, release;
  await page.route('**/expeditions/' + course.id + '/duplicate', async route => {
    await new Promise(resolve => { release = resolve; });
    if (fail) return route.fulfill({status:503,json:{error:'Tijdelijk niet beschikbaar.'}});
    return route.continue();
  });
  const pending = page.locator('[data-pending-copy="' + course.id + '"]');
  async function begin() {
    await menu.focus();
    await page.keyboard.press('Enter');
    await duplicate.focus();
    await page.keyboard.press('Enter');
    await expect(pending).toBeVisible();
    await expect(pending).toHaveAttribute('aria-busy','true');
    await expect(pending).toContainText('Kopie van Kleine stappen');
    await expect(pending).toBeFocused();
    await expect.poll(() => typeof release).toBe('function');
  }
  await begin();
  release();
  await expect(pending).toHaveCount(0);
  await expect(menu).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('Tijdelijk');
  fail = false; release = undefined;
  await begin();
  release();
  await expect(pending).toHaveCount(0);
  const copied = page.locator('.is-just-duplicated');
  await expect(copied).toContainText('Kopie van Kleine stappen');
  await expect(copied.locator('.el-exp-card-actions a').first()).toBeFocused();
  const savedId = await copied.getAttribute('data-expedition-row');
  expect(savedId).not.toBe(course.id);
  await expect(page.getByRole('status').getByRole('link',{name:'Openen'})).toHaveAttribute('href','/expedities/' + savedId);
});

test('library command links open only the controls the author can use', async ({page}) => {
  await account(page);
  await page.goto(origin + '/expedities?actie=nieuw');
  await expect(page.locator('#el-create-dialog')).toBeVisible();
  await expect(page.locator('#el-new-title')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.goto(origin + '/expedities?actie=importeren');
  await expect(page.locator('#el-import-json-btn')).toBeFocused();
});
