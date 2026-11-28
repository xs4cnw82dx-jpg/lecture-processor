const {test, expect} = require('./helpers/academy-service');

test('German learners see the course title, original wordmark and formal time-sharing notice', async ({academyPage: page, academyOrigin, request}) => {
  const headers = {Authorization: 'Bearer academy-preview-token'};
  const course = {
    title: 'Interne werktitel', defaultLanguage: 'nl', enabledLanguages: ['nl', 'de'],
    startPage: {title: {nl: 'Pijn begrijpen', de: 'Schmerz verstehen'}},
    modules: [{id: 'station', title: {nl: 'Onderweg', de: 'Unterwegs'}, steps: [{id: 'anfang', title: {nl: 'Eerste stap', de: 'Erster Schritt'}, blocks: []}]}],
  };
  const created = await request.post(academyOrigin + '/api/elearning/expeditions', {headers, data: course});
  expect(created.status()).toBe(201);
  const {expedition} = await created.json();
  const sharing = await request.post(academyOrigin + '/api/elearning/expeditions/' + expedition.id + '/sharing', {
    headers, data: {action: 'update_public', enabled: true, collectResponses: true}
  });
  expect(sharing.ok()).toBe(true);
  const {share} = await sharing.json();
  await page.setViewportSize({width: 390, height: 844});
  await page.emulateMedia({colorScheme: 'light'});
  // Older personal sessions stored their chosen language before course cookies existed.
  await page.addInitScript(token => localStorage.setItem('xped_el_progress_' + token, JSON.stringify({lang: 'de'})), share.token);
  await page.goto(academyOrigin + '/start/' + share.token);
  await expect(page).toHaveURL(/\?lang=de$/);
  await expect(page.getByRole('heading', {name: 'Schmerz verstehen', level: 1})).toBeVisible();
  await expect(page).toHaveTitle('Schmerz verstehen · xPED Academy');

  const mark = page.locator('#el-player-home-btn img');
  const visibleAsset = () => mark.evaluate(async image => { await image.decode(); return new URL(image.currentSrc).pathname.split('/').at(-1); });
  await expect.poll(visibleAsset).toBe('logo_de_light.svg');
  await expect(page.locator('.el-player-product')).toBeHidden();
  await test.step('the original colours are preserved on a dark learner header', async () => {
    await page.emulateMedia({colorScheme: 'dark'});
    await expect.poll(visibleAsset).toBe('logo_de.svg');
    await expect(mark).toHaveCSS('filter', 'none');
    const path = test.info().outputPath('german-phone-header.png');
    await page.locator('.el-player-header').screenshot({path});
    await test.info().attach('german-phone-header', {path, contentType: 'image/png'});
  });
  await page.setViewportSize({width: 1000, height: 780});
  await expect(page.locator('.el-player-product')).toHaveText('Academy');
  await expect(page.locator('.el-player-product')).toBeVisible();
  const png = page.locator('link[rel=icon][type="image/png"]');
  await expect(png).toHaveAttribute('sizes', '32x32');
  const favicon = await page.request.get(new URL(await png.getAttribute('href'), page.url()).href);
  expect(favicon.ok()).toBe(true);
  const data = await favicon.body();
  expect([data.readUInt32BE(16), data.readUInt32BE(20)]).toEqual([32,32]);
  await expect(page.locator('link[rel=icon][type="image/svg+xml"]')).toHaveAttribute('href', /logo_de\.svg/);

  await page.locator('.xped-hero-cta-row button').click();
  await expect(page.getByText('Das Kursteam erhält Ihren Fortschritt, Ihre aktive Zeit pro Schritt und Ihre Antworten einschließlich eigener Texte unter einer Sitzungskennung.')).toBeVisible();
});
