const { test, expect, prepareAcademyPage } = require('./helpers/academy-preview');

const items = [
  { id:'a', title:'Eerste halte', shareEnabled:true, collectResponses:true },
  { id:'b', title:'Tweede halte', hasPublished:true },
  { id:'c', title:'Derde halte', role:'translate' },
].map(row => ({
  role:'owner', moduleCount:2, stepCount:3, updatedAt:1780000000,
  defaultLanguage:'nl', enabledLanguages:['nl','de'], languageCoverage:{de:{total:10,translated:8,needsReview:2}},
  ...row
}));

test('an author navigates the visible courses, opens permitted actions and reaches translation review', async ({page,academyOrigin}) => {
  await prepareAcademyPage(page,academyOrigin);
  await page.route('**/api/elearning/expeditions',r => r.fulfill({json:{expeditions:items,canCreate:true,studioAdmin:false,folders:[]}}));
  await page.setViewportSize({width:1440,height:900});
  await page.goto(academyOrigin+'/expedities');
  const table = page.getByRole('table', { name:'Expedities' });
  const first = table.getByRole('row').filter({hasText:'Eerste halte'});
  const second = table.getByRole('row').filter({hasText:'Tweede halte'});
  const third = table.getByRole('row').filter({hasText:'Derde halte'});
  const title = row => row.locator('h2 a');
  await expect(first).toContainText('Verzamelt resultaten');
  await expect(second).toContainText('Gepauzeerd');
  await expect(third).toContainText('Concept');
  await expect(first.locator('.el-exp-thumb img')).toHaveAttribute('src',/academy-.*\.webp/);
  await title(first).focus();
  await page.keyboard.press('j');
  await expect(title(second)).toBeFocused();
  await page.keyboard.press('.');
  await expect(second.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('j');
  await expect(title(third)).toBeFocused();
  await page.keyboard.press('.');
  await expect(third.getByRole('menu')).toHaveCount(0);
  await page.keyboard.press('k');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog',{name:/Sneltoetsen/})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(title(second)).toBeFocused();
  await table.getByRole('button',{name:'Expeditie',exact:true}).click();
  await expect(table.locator('tbody tr').first()).toHaveAttribute('data-expedition-row','c');
  const search = page.locator('#el-dash-search');
  await search.fill('j');
  await expect(search).toHaveValue('j');
  await expect(table).toHaveCount(0);
  await search.fill('Tweede');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(second.getByRole('link',{name:/DE · Te controleren/})).toHaveAttribute('href','/expedities/b/bewerken?modus=vertalen&taal=de&filter=controleren');
  await page.setViewportSize({width:390,height:844});
  await expect(second).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await title(second).press('Enter');
  await expect(page).toHaveURL(academyOrigin+'/expedities/b');
});

test('the owner sees the affected result count or an explicit unknown state before confirming deletion', async ({page,academyOrigin}) => {
  await prepareAcademyPage(page,academyOrigin);
  await page.route('**/api/elearning/expeditions',r => r.fulfill({json:{expeditions:items,canCreate:true,folders:[]}}));
  let countRequests = 0;
  await page.route('**/outline-results', async r => {
    countRequests++;
    if (r.request().url().includes('/a/')) await r.fulfill({json:{totalSessions:17,steps:{}}});
    else await r.fulfill({status:503,json:{error:'Tijdelijk niet beschikbaar'}});
  });
  await page.goto(academyOrigin+'/expedities');
  const select = async id => {
    await page.locator('[data-expedition-row="'+id+'"] [aria-haspopup="menu"]').click();
    await page.getByRole('menuitem',{name:'Verwijderen',exact:true}).click();
  };
  const dialog=page.locator('#el-delete-dialog');
  await expect(page.getByRole('table',{name:'Expedities'})).toBeVisible();
  expect(countRequests).toBe(0);
  await select('a');
  await expect(dialog.getByRole('status')).toHaveText(/17 opgeslagen resultaten/);
  await expect(dialog.locator('#el-delete-confirm')).toBeEnabled();
  await dialog.locator('#el-delete-cancel').click();
  await select('b');
  await expect(dialog.getByRole('status')).toContainText('aantal opgeslagen resultaten is onbekend');
  await expect(dialog.getByRole('status')).toContainText('niet meer toegankelijk');
  await expect(dialog.locator('#el-delete-confirm')).toBeEnabled();
  expect(countRequests).toBe(2);
});

test('an author filters a long folder list with an editable keyboard combobox', async ({page, academyOrigin}) => {
  await prepareAcademyPage(page, academyOrigin);
  const folders = ['Rood','Oranje','Geel','Groen','Blauw licht','Blauw donker','Paars','Grijs'].map((name, i) => ({id:'map-' + i, name}));
  const expeditions = items.map((course, i) => ({...course, role:'owner', folderId: folders[i + 3].id}));
  await page.route('**/api/elearning/expeditions', route => route.fulfill({json:{expeditions, folders, canCreate:true, studioAdmin:false}}));
  await page.goto(academyOrigin + '/expedities');
  const trigger = page.locator('#academy-folder-filter-button');
  await trigger.click();
  const search = page.getByRole('combobox', {name:'Opties doorzoeken'});
  await expect(search).toBeFocused();
  await search.fill('niet gevonden');
  await expect(page.getByRole('status').filter({hasText:'Geen opties gevonden'})).toBeVisible();
  await expect(search).not.toHaveAttribute('aria-activedescendant', /./);
  await search.fill('blauw');
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option')).toHaveCount(2);
  const dark = list.getByRole('option', {name:'Blauw donker'});
  await search.press('ArrowDown');
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('aria-activedescendant', await dark.getAttribute('id'));
  await search.press('Enter');
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('Blauw donker');
  await expect(page.getByRole('table', {name:'Expedities'}).getByRole('heading')).toHaveText(['Derde halte']);
  await trigger.press('Enter');
  await expect(search).toHaveValue('');
  await search.fill('groen');
  await search.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('Blauw donker');
});
