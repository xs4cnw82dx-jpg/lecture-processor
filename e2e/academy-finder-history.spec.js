const { test, expect } = require('./helpers/academy-preview');

const memberEmail = 'reviewer+west@example.test';
const courseId = 'course-49aa';

test.beforeEach(async ({page, academyOrigin}) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === academyOrigin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const observers = new Set();
    const user = uid => uid && ({uid, emailVerified:true, getIdToken:async () => uid});
    const auth = {
      currentUser:user(sessionStorage.getItem('fixture-member') || 'member-a'),
      onAuthStateChanged(fn) { observers.add(fn); queueMicrotask(() => fn(this.currentUser)); return () => observers.delete(fn); },
    };
    window.selectFixtureMember = uid => {
      auth.currentUser = user(uid);
      sessionStorage.setItem('fixture-member', uid || '');
      observers.forEach(fn => fn(auth.currentUser));
    };
    let app;
    window.firebase = {
      app() { if (!app) throw new Error('Not initialized'); return app; },
      initializeApp(options) { app = {options}; return app; },
      auth: () => auth,
    };
  });
});

async function showFinder(page) {
  await page.waitForLoadState('load');
  await page.keyboard.press('Control+k');
  const finder = page.getByRole('dialog', {name:'Zoek een pagina'});
  await expect(finder).toBeVisible();
  return finder;
}

function payload(title, admin = true) {
  return {canCreate:admin, studioAdmin:admin, items:title ? [{type:'course',course:courseId,title,role:'owner'}] : [],
    people:admin ? [memberEmail] : []};
}

test('Finder reopens recent destinations in the same tab using current names and permissions', async ({page, academyOrigin}) => {
  let title = 'Een besloten wandeling';
  let admin = true;
  await page.route('**/api/academy/navigation', route => route.fulfill({json:payload(title, admin)}));
  await page.goto(academyOrigin + '/expedities');
  let finder = await showFinder(page);
  await finder.getByRole('combobox').fill('besloten');
  await finder.getByRole('option', {name:title, exact:true}).click();
  await expect(page).toHaveURL(academyOrigin + '/expedities/' + courseId);

  title = 'De hernoemde wandeling';
  finder = await showFinder(page);
  let recent = finder.locator('[data-ac-recent]');
  await expect(recent.getByRole('option')).toHaveText(title);
  await expect(finder.getByRole('option').first()).toHaveText(title);
  await finder.getByRole('combobox').fill('reviewer');
  await finder.getByRole('option', {name:memberEmail}).click();
  await expect(page).toHaveURL(academyOrigin + '/team?persoon=' + encodeURIComponent(memberEmail));
  await page.reload();
  finder = await showFinder(page);
  recent = finder.locator('[data-ac-recent]');
  await expect(recent.getByRole('option')).toHaveText([memberEmail, title]);
  await page.keyboard.press('ArrowDown');
  await expect(finder.getByRole('combobox')).toBeFocused();
  await expect(finder.getByRole('combobox')).toHaveAttribute('aria-activedescendant', await recent.getByRole('option').first().getAttribute('id'));

  const stored = await page.evaluate(() => JSON.stringify(sessionStorage));
  for (const identifyingText of [memberEmail, encodeURIComponent(memberEmail), title, 'Een besloten wandeling']) {
    expect(stored).not.toContain(identifyingText);
  }
  await finder.getByRole('combobox').fill('instelling');
  await finder.getByRole('option', {name:'Instellingen',exact:true}).click();
  await expect(page).toHaveURL(academyOrigin + '/instellingen');
  admin = false;
  title = '';
  finder = await showFinder(page);
  recent = finder.locator('[data-ac-recent]');
  await expect(recent.getByRole('option')).toHaveText(['Instellingen']);
  await expect(finder.getByRole('option', {name:memberEmail})).toHaveCount(0);
  await expect(finder.getByRole('option', {name:'Instellingen',exact:true})).toHaveCount(1);
});

test('a delayed search cannot restore the previous member’s history after an account switch or sign-out', async ({page, academyOrigin}) => {
  let paused = false, release;
  const pending = new Promise(resolve => { release = resolve; });
  let previousRequest = false;
  await page.route('**/api/academy/navigation', async route => {
    const owner = route.request().headers().authorization === 'Bearer member-a';
    if (owner && paused) { previousRequest = true; await pending; }
    await route.fulfill({json:payload(owner ? 'Oude route' : 'Nieuwe route', owner)});
  });
  await page.goto(academyOrigin + '/expedities');
  let finder = await showFinder(page);
  await finder.getByRole('combobox').fill('oude route');
  await finder.getByRole('option', {name:'Oude route',exact:true}).click();
  await expect(page).toHaveURL(academyOrigin + '/expedities/' + courseId);
  paused = true;
  finder = await showFinder(page);
  try {
    await expect.poll(() => previousRequest).toBe(true);
    await expect(finder.locator('[data-ac-recent]')).toBeHidden();
    await page.evaluate(() => window.selectFixtureMember('member-b'));
    await finder.getByRole('combobox').fill('nieuwe route');
    await expect(finder.getByRole('option', {name:'Nieuwe route',exact:true})).toBeVisible();
    release();
    await finder.getByRole('combobox').fill('');
    await expect(finder.locator('[data-ac-recent]')).toBeHidden();
    await finder.getByRole('combobox').fill('oude route');
    await expect(finder.getByRole('option', {name:'Oude route',exact:true})).toHaveCount(0);
    await finder.getByRole('combobox').fill('nieuwe route');
    await finder.getByRole('option', {name:'Nieuwe route',exact:true}).click();
    await showFinder(page);
    await expect(finder.locator('[data-ac-recent] a')).toHaveText(['Nieuwe route']);
    await page.evaluate(() => window.selectFixtureMember(null));
    await expect(finder.locator('[data-ac-recent]')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('xped.finder.history'))).toBeNull();
  } finally { release(); }
});

test('an author can select from a long permission-scoped course and person list without leaving the search field', async ({page, academyOrigin}) => {
  const courses = Array.from({length:12}, (_, i) => ({type:'course',course:'course-' + i,title:'Leermodule ' + i,role:'owner'}));
  const people = Array.from({length:10}, (_, i) => 'teamlid' + i + '@example.test');
  await page.route('**/api/academy/navigation', route => route.fulfill({json:{canCreate:true, studioAdmin:true, items:courses, people}}));
  await page.goto(academyOrigin + '/expedities');
  let finder = await showFinder(page);
  const query = finder.getByRole('combobox');
  await query.fill('leermodule 11');
  const course = finder.getByRole('option',{name:'Leermodule 11',exact:true});
  await expect(course).toBeVisible();
  await query.press('ArrowUp');
  await expect(query).toBeFocused();
  await expect(query).toHaveAttribute('aria-activedescendant',await course.getAttribute('id'));
  await query.press('Enter');
  await expect(page).toHaveURL(academyOrigin + '/expedities/course-11');
  finder = await showFinder(page);
  const search = finder.getByRole('combobox');
  await search.fill('teamlid9');
  await expect(finder.getByRole('option')).toHaveCount(1);
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page).toHaveURL(academyOrigin + '/team?persoon=' + encodeURIComponent(people[9]));
});
