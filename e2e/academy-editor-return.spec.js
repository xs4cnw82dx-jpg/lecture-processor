const { test, expect } = require('./helpers/academy-service');
const Model = require('../static/js/elearning-model');

test('a course tab opens the editor and Escape returns to that tab after a saved change', async ({ academyPage: page, academyOrigin, request }) => {
  const title = 'Samen leren';
  const options = { headers: { Authorization: 'Bearer academy-preview-token' }, data: Model.createExpeditionPreset('blank', title, 'nl') };
  const created = await request.post(academyOrigin + '/api/elearning/expeditions', options);
  expect(created.ok()).toBeTruthy();
  const { expedition } = await created.json();
  const course = academyOrigin + '/expedities/' + expedition.id;
  const endpoint = '**/api/elearning/expeditions/' + expedition.id;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(course + '#delen');
  await expect(page.locator('#xc-delen')).toBeVisible();
  await page.locator('#xc-edit').click();
  const back = page.locator('#el-back-link');
  const rail = page.getByRole('navigation', { name: 'Hoofdnavigatie' });
  const input = page.locator('#el-exp-title');
  await expect(input).toBeEnabled();
  await expect(rail).toBeVisible();
  await expect(page.locator('#ac-nav-toggle')).toBeHidden();
  await expect(back).toHaveJSProperty('href', course + '#delen');
  await expect(page).toHaveTitle('Bewerken · Samen leren · xPED Academy');
  await page.locator('#el-add-module-btn').click();
  await expect(page.locator('#el-module-recipe-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#el-module-recipe-dialog')).toBeHidden();
  await expect(input).toBeVisible();

  let allowSave = false;
  await page.route(endpoint, route => route.request().method() === 'PUT' && !allowSave
    ? route.fulfill({status:503, json:{error:'Tijdelijk niet bereikbaar'}}) : route.continue());
  await input.fill('Samen leren onderweg');
  const status = page.locator('#el-save-state');
  await expect(status).toHaveText('Opslaan…');
  await input.press('Escape');
  await expect(input).toBeFocused();
  await expect(status).toHaveText('Niet opgeslagen');
  await page.locator('[data-mode="edit"]').click();
  const stay = page.waitForEvent('dialog').then(async dialog => { expect(dialog.type()).toBe('beforeunload'); await dialog.dismiss(); });
  await page.keyboard.press('Escape');
  await stay;
  await expect(input).toHaveValue('Samen leren onderweg');
  allowSave = true;
  await page.locator('#el-save-retry').click();
  await expect(status).toHaveText('Opgeslagen');
  await expect(page).toHaveTitle('Bewerken · Samen leren onderweg · xPED Academy');
  await status.focus();
  await expect(page.getByRole('tooltip')).toContainText(/Laatst opgeslagen om \d{2}:\d{2}/);
  await page.locator('[data-mode="edit"]').focus();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(course + '#delen');
  await expect(page.locator('#xc-delen')).toBeVisible();
  await expect(page.locator('#xc-title')).toHaveText('Samen leren onderweg');
});

test('the content-language selector follows the saved fields of the active course', async ({academyPage: page, academyOrigin, request}) => {
  const headers = {Authorization:'Bearer academy-preview-token'};
  const draft = Model.createExpeditionPreset('blank', 'Taaldekking', 'nl');
  draft.enabledLanguages = ['nl', 'de'];
  const response = await request.post(academyOrigin + '/api/elearning/expeditions', { headers, data:draft });
  expect(response.ok()).toBeTruthy();
  const {expedition} = await response.json();
  const url = academyOrigin + '/expedities/' + expedition.id;
  async function germanCoverage() {
    const courses = await (await request.get(academyOrigin + '/api/elearning/expeditions', {headers})).json();
    const counts = courses.expeditions.find(course => course.id === expedition.id).languageCoverage.de;
    return new Intl.NumberFormat('nl-NL', {style:'percent'}).format((counts.translated-counts.needsReview)/counts.total);
  }
  const before = await germanCoverage();
  await page.goto(url + '/bewerken');
  await expect(page.locator('#el-exp-title')).toBeEnabled();
  const lang = page.getByRole('button', {name:/^Inhoudstaal:/});
  await lang.click();
  await page.getByRole('option', {name:'Deutsch (DE) · '+before, exact:true}).click();
  await expect(lang).toHaveText('Inhoudstaal: DE · '+before);
  const subtitle = page.locator('#el-canvas-card .xped-hero-subtitle');
  const previous = expedition.startPage.subtitle.de;
  await subtitle.fill(previous ? '' : 'Ein neuer Untertitel');
  await expect(page.locator('#el-save-state')).toHaveText('Opgeslagen');
  const after = await germanCoverage();
  expect(after).not.toBe(before);
  await expect(lang).toHaveText('Inhoudstaal: DE · '+after);
  await page.setViewportSize({width:900,height:900});
  await page.locator('#ac-nav-toggle').click();
  await expect(page.getByRole('dialog',{name:'Werkruimte'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'Werkruimte'})).toBeHidden();
  await expect(page.locator('#el-exp-title')).toBeVisible();
});

test('editor toolbar values open named selection lists in each work mode', async ({academyPage: page, academyOrigin, request}) => {
  const created = await request.post(academyOrigin + '/api/elearning/expeditions', {
    headers:{Authorization:'Bearer academy-preview-token'}, data:Model.createExpeditionPreset('blank','Keuzelijsten','nl')
  });
  expect(created.ok()).toBeTruthy();
  const {expedition} = await created.json();
  await page.goto(academyOrigin + '/expedities/' + expedition.id + '/bewerken');
  await expect(page.locator('#el-exp-title')).toBeEnabled();
  async function check(host) {
    const picker = page.locator(host);
    const trigger = picker.getByRole('button');
    await expect(trigger).toHaveAttribute('aria-haspopup','listbox');
    await trigger.press('Enter');
    const list = picker.getByRole('listbox');
    const chosen = list.getByRole('option',{selected:true});
    await expect(chosen).toBeFocused();
    await chosen.press('Escape');
    await expect(trigger).toBeFocused();
  }
  await check('#el-edit-lang-host');
  await page.locator('[data-mode=translate]').click();
  for (const key of ['source','target','filter']) await check('#el-tr-' + key + '-host');
  await page.locator('[data-mode=preview]').click();
  await check('#el-preview-lang-host');
});


test('an editor can find a destination station by typing in a long course', async ({academyPage: page, academyOrigin, request}) => {
  const course = Model.createExpeditionPreset('blank','Lange route','nl');
  course.modules = Array.from({length:10}, (_, i) => {
    const station = Model.createModule('blank', i);
    station.title.nl = 'Bestemming ' + (i + 1);
    return station;
  });
  course.modules[0].steps.push(Model.createStep('Tweede stap','Second step'));
  const created = await request.post(academyOrigin + '/api/elearning/expeditions', {
    headers:{Authorization:'Bearer academy-preview-token'}, data:course
  });
  expect(created.ok()).toBeTruthy();
  const {expedition} = await created.json();
  const step = expedition.modules[0].steps[0].id;
  await page.setViewportSize({width:1440,height:900});
  await page.goto(academyOrigin + '/expedities/' + expedition.id + '/bewerken?module=' + expedition.modules[0].id + '&step=' + step);
  const picker = page.getByRole('button',{name:/Naar station verplaatsen|Verplaatsen naar station/});
  await picker.click();
  const search = page.getByRole('combobox',{name:'Opties doorzoeken'});
  await expect(search).toBeFocused();
  await search.fill('Bestemming 9');
  const match = page.getByRole('option',{name:'Bestemming 9',exact:true});
  await expect(match).toBeVisible();
  await search.press('Enter');
  await expect(page.locator('#el-save-state')).toHaveText('Opgeslagen');
  await expect.poll(async () => {
    const saved = await request.get(academyOrigin + '/api/elearning/expeditions/' + expedition.id, {headers:{Authorization:'Bearer academy-preview-token'}});
    return (await saved.json()).expedition.modules[8].steps.some(row => row.id === step);
  }).toBe(true);
});
