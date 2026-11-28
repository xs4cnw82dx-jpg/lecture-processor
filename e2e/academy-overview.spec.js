const { test, expect, prepareAcademyPage } = require('./helpers/academy-preview');

const totals = {sessions: 12, completed: 7, completion: 58.3, measured: 6, medianSeconds: 270, active: 2};
const course = (id,title,role='owner') => ({id,title,role,enabledLanguages:['nl','de'],defaultLanguage:'nl',
  languageCoverage:{nl:{translated:10,total:10},de:{translated:5,total:10,needsReview:1}},
  stations:[{title:{nl:'Start'},steps:3}],estimate:12,updatedAt:1787350000,metrics:totals,owner:'studio@example.test',shareEnabled:true});
function overview(courses, extras={}) {
  return {canCreate:true,studioAdmin:true,period:{from:'2026-11-01',to:'2026-11-28'},courses,
    cohorts:['default','onderzoek'],current:totals,previous:{...totals,sessions:8},
    feedback:[{id:'pijn',title:'Pijn begrijpen',comment:'De tekeningen maakten het duidelijk.',at:1787350000}],...extras};
}
test.beforeEach(async ({page,academyOrigin}) => {
  await prepareAcademyPage(page,academyOrigin);
  await page.route('**/api/academy/preferences',route=>route.fulfill({json:{language:null}}));
});

test('first-run templates create a private Dutch expedition and open its editor', async ({page,academyOrigin}) => {
  await page.route('**/api/academy/overview*',route=>route.fulfill({json:overview([])}));
  const bodies=[];
  await page.route('**/api/elearning/expeditions',route => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({status:201,json:{expedition:{id:'nieuwe-route'}}});
  });
  await page.goto(academyOrigin);
  await expect(page.getByRole('heading',{name:'Nog geen expedities'})).toBeVisible();
  await expect(page.locator('[data-preset]')).toHaveCount(3);
  await page.getByRole('button',{name:/Drie stations/}).click();
  await expect(page).toHaveURL(/\/expedities\/nieuwe-route\/bewerken$/);
  expect(bodies).toHaveLength(1);
  expect(bodies[0].defaultLanguage).toBe('nl');
  expect(bodies[0].modules).toHaveLength(3);
});

test('dashboard filters, statistics and keyboard course links use one overview request per period', async ({page,academyOrigin}) => {
  const reads=[];
  await page.route('**/api/academy/overview*',route => {
    reads.push(new URL(route.request().url()).searchParams);
    return route.fulfill({json:overview([course('pijn','Pijn begrijpen'),course('bewegen','Weer bewegen')])});
  });
  await page.goto(academyOrigin);
  await expect(page.locator('.ao-metric-big')).toHaveText('58,3%');
  const cards = page.locator('#ao-kpis');
  await expect(cards.getByRole('button')).toHaveCount(4);
  await expect(cards.getByRole('button', {name:/Gestarte sessies/})).toContainText('+4 t.o.v. vorige periode');
  await expect(cards.locator('svg,canvas,img,[role="img"]')).toHaveCount(0);
  await expect(page.getByText('De tekeningen maakten het duidelijk.')).toBeVisible();
  await page.getByRole('button',{name:'7 dagen',exact:true}).click();
  await expect(page).toHaveURL(/days=7/);
  await expect(page.locator('#ao-rows tr')).toHaveCount(2);
  expect(reads.map(q=>q.get('days'))).toEqual([null,'7']);
  await page.getByRole('button',{name:'Routes tonen'}).click();
  await expect(page.locator('#ao-rows [role="img"]')).toHaveCount(2);
  const links=page.locator('#ao-rows a');
  await links.first().focus();
  await page.keyboard.press('j');
  await expect(links.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/expedities\/bewegen$/);
});

test('translator home, pending state, retry and a course-free invited account', async ({page,academyOrigin}) => {
  let reads=0;
  const t=course('pilot','Gesunde Bewegung','translate'); delete t.metrics;
  await page.route('**/api/academy/overview*',async route => {
    reads++;
    if (reads===1) return route.fulfill({status:503,json:{}});
    return route.fulfill({json:overview(reads===2 ? [t] : [],{canCreate:false,studioAdmin:false})});
  });
  await page.goto(academyOrigin);
  await page.getByRole('button',{name:'Opnieuw proberen'}).click();
  await expect(page.getByRole('heading',{name:'Mijn vertaalopdrachten'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Recente feedback'})).toBeHidden();
  await expect(page.getByRole('link',{name:'Gesunde Bewegung'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Te controleren (1) · DE · Gesunde Bewegung'})).toHaveAttribute('href','/expedities/pilot/bewerken?modus=vertalen&taal=de&filter=controleren');
  await page.reload();
  await expect(page.getByRole('heading',{name:'Toegang op uitnodiging'})).toBeVisible();
  await expect(page.locator('[data-preset]').first()).toBeHidden();
});

test('an admin can dismiss the archived-language notice for previously translated courses', async ({page,academyOrigin}) => {
  const legacy = course('historisch','Historische expeditie');
  legacy.enabledLanguages.push('en');
  legacy.languageCoverage.en = {translated:2,total:3};
  await page.route('**/api/academy/overview*',route=>route.fulfill({json:overview([legacy,course('nieuw','Nieuwe expeditie')])}));
  await page.goto(academyOrigin);
  const archive = page.getByRole('region',{name:'Eerder gemaakte Engelse vertalingen'});
  await expect(archive.getByRole('link')).toHaveCount(1);
  await expect(archive.getByRole('link',{name:'Historische expeditie'})).toHaveAttribute('href','/expedities/historisch');
  await archive.getByRole('button',{name:'Melding verbergen'}).click();
  await expect(archive).toBeHidden();
  await page.reload();
  await expect(page.getByRole('link',{name:'Nieuwe expeditie',exact:true})).toBeVisible();
  await expect(archive).toBeHidden();
});
