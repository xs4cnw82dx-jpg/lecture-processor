const { test, expect, prepareAcademyPage } = require('./helpers/academy-preview');

test.beforeEach(async ({ page, academyOrigin }) => { await prepareAcademyPage(page, academyOrigin); });

for (const width of [1440,390]) {
  test('preferences float above the page without moving the header at ' + width, async ({ page, academyOrigin }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(academyOrigin + '/expedities');
    const header = page.locator('[data-ac-header]');
    const toggle = page.locator('#ac-settings-toggle');
    const panel = page.locator('#ac-settings-popover');
    const initial = await header.boundingBox();
    // Capture intermediate animation frames. The old disclosure briefly grew to
    // four times its height and then returned to its initial size.
    const heights = await header.evaluate(node => {
      const trigger = node.querySelector('#ac-settings-toggle');
      const samples = [node.getBoundingClientRect().height];
      trigger.click();
      return new Promise(resolve => {
        const start = performance.now();
        function collect() {
          samples.push(node.getBoundingClientRect().height);
          if (performance.now() - start < 330) requestAnimationFrame(collect);
          else resolve(samples);
        }
        requestAnimationFrame(collect);
      });
    });
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    await expect(panel).toBeVisible();
    expect((await panel.boundingBox()).y).toBeGreaterThan(initial.y + initial.height - 3);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await panel.getByRole('button', { name: 'Nederlands' }).focus();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await page.getByRole('heading').first().click();
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test('an open settings menu stays open while a first page load finishes', async ({ page, academyOrigin }) => {
  // A deferred image keeps window.load/pageshow pending while the toolbar is interactive.
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/static/images/xped/logo_nl.svg*', async route => { await pending; await route.continue(); });
  try {
    await page.goto(academyOrigin + '/expedities', {waitUntil:'domcontentloaded'});
    await page.locator('#ac-settings-toggle').click();
    await expect(page.locator('#ac-settings-popover')).toBeVisible();
    release();
    await page.waitForLoadState('load');
    await expect(page.locator('#ac-settings-popover')).toBeVisible();
  } finally { release(); }
});

test('desktop navigation, collapsed rail and keyboard page search', async ({ page, academyOrigin }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(academyOrigin + '/expedities');
  const rail = page.locator('#ac-rail');
  await expect(rail.getByRole('link', { name: 'Expedities' })).toHaveAttribute('aria-current','page');
  const initialWidth = (await rail.boundingBox()).width;
  await page.getByRole('button', { name: 'Zijbalk inklappen' }).click();
  expect((await rail.boundingBox()).width).toBeLessThan(initialWidth);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Zijbalk uitklappen' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const finder = page.getByRole('dialog', { name: 'Zoek een pagina' });
  await expect(finder).toBeVisible();
  await finder.getByRole('searchbox').fill('vertal');
  await expect(finder.getByRole('link')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(academyOrigin + '/vertalingen');
  await expect(page.getByRole('heading', { name: 'Vertalingen', exact: true })).toBeVisible();
});

test('mobile drawer traps focus and returns it to the opener', async ({ page, academyOrigin }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(academyOrigin + '/expedities');
  const opener = page.getByRole('button', { name: 'Navigatie openen' });
  await opener.click();
  const drawer = page.getByRole('dialog', { name: 'Werkruimte' });
  await expect(drawer).toBeVisible();
  for (let n = 0; n < 12; n++) {
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await drawer.getByRole('link', { name: 'Instellingen' }).click();
  await expect(page).toHaveURL(academyOrigin + '/instellingen');
  await expect(page.getByRole('heading', { name:'Instellingen',exact:true })).toBeVisible();
});

test('the results and translation indexes show the courses available to each role', async ({ page, academyOrigin }) => {
  await page.route('**/api/elearning/expeditions', route => route.fulfill({json:{expeditions:[
    {id:'one', title:'Een route', role:'owner', enabledLanguages:['nl','de'],defaultLanguage:'nl', languageCoverage:{de:{needsReview:2}}},
    {id:'two', title:'Eine Route', role:'translate', enabledLanguages:['nl','de'],defaultLanguage:'de'},
    {id:'gone', title:'Verwijderd', role:'owner', deletionPending:true},
  ]}}));
  await page.goto(academyOrigin + '/resultaten');
  const entries = page.locator('#ac-index-list');
  await expect(entries.getByRole('link')).toHaveCount(1);
  await expect(entries.getByRole('link')).toHaveAttribute('href','/expedities/one/resultaten');
  await page.goto(academyOrigin + '/vertalingen');
  await expect(entries.getByRole('link')).toHaveCount(2);
  await expect(entries.getByRole('link',{name:/Te controleren/})).toHaveAttribute('href','/expedities/one/bewerken?modus=vertalen&taal=de');
  await expect(entries.getByRole('link',{name:/Eine Route/})).toHaveAttribute('href','/expedities/two/bewerken?modus=vertalen&taal=nl');
});

test('the public xPED wordmark follows the theme and fits beside the German settings button', async ({ page, academyOrigin }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([{name:'xped-language', value:'de', url:academyOrigin}]);
  await page.emulateMedia({colorScheme:'light'});
  await page.goto(academyOrigin + '/privacy');
  const header = page.locator('header');
  const brand = header.getByRole('link', { name: 'xPED Academy, zur Übersicht' });
  const mark = brand.locator('img:visible');
  await expect(mark).toHaveCount(1);
  await mark.evaluate(image => image.decode());
  await expect(mark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(brand).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const settings = header.getByRole('button',{name:'Einstellungen'});
  const left = await brand.boundingBox(), right = await settings.boundingBox();
  expect(left.x + left.width).toBeLessThanOrEqual(right.x);
  expect(right.x + right.width).toBeLessThanOrEqual(390);
  const lightAsset = await mark.getAttribute('src');
  await page.emulateMedia({colorScheme:'dark'});
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(mark).toHaveCount(1);
  await expect(mark).not.toHaveAttribute('src',lightAsset);
  await mark.evaluate(image => image.decode());
  await expect(brand).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
});
