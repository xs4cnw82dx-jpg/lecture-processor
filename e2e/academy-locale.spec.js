const {test, expect} = require('./helpers/academy-service');

const headers = {Authorization: 'Bearer academy-preview-token'};
async function seedCourse(request, origin) {
  const course = {
    title: 'Expeditie {A} #1', defaultLanguage: 'nl', enabledLanguages: ['nl', 'de'],
    startPage: {title: {nl: 'Onderweg', de: 'Schmerz verstehen'}},
    modules: [{id: 'station', title: {nl: 'Start', de: 'Anfang'}, steps: [{id: 'intro', title: {nl: 'Eerste stap', de: 'Erster Schritt'}, blocks: []}]}],
  };
  const created = await request.post(origin + '/api/elearning/expeditions', {headers, data: course});
  expect(created.status()).toBe(201);
  return (await created.json()).expedition;
}

for (const lang of ['nl', 'de']) {
  test('catalog plurals and time formats follow the server language in ' + lang, async ({academyPage: page, academyOrigin}) => {
    await page.context().addCookies([{name:'xped-language', value:lang, url:academyOrigin}]);
    await page.goto(academyOrigin + '/expedities');
    const samples = await page.evaluate(() => {
      const {t, percent, date, duration, relative} = window.Xped.i18n;
      // A late DOM mutation must not change the server-established format locale.
      document.documentElement.lang = 'en';
      return {
        counts: [0, 1, 2, 1234].map(count => t('count.steps', {count})),
        loss: [0, 1, 2].map(count => t('library.deletionImpact', {count})),
        time: date(Date.UTC(2026, 0, 2, 18, 4), {timeStyle:'short', timeZone:'UTC'}),
        ago: relative(3600, 4 * 3600 * 1000),
        percentage: [0, 4.24, 58.3, null].map(percent),
        duration: [0, 59, 900, 3900, null].map(value => duration(value, 'compact')),
        bin: duration(90, 'clock'),
      };
    });
    expect(samples.counts).toEqual(lang === 'de'
      ? ['0 Schritte', '1 Schritt', '2 Schritte', '1.234 Schritte'] : ['0 stappen', '1 stap', '2 stappen', '1.234 stappen']);
    expect(samples.loss[0]).toContain(lang === 'de' ? 'keine gespeicherten Ergebnisse' : 'geen opgeslagen resultaten');
    expect(samples.loss[1]).toContain(lang === 'de' ? '1 gespeichertes Ergebnis ist' : '1 opgeslagen resultaat is');
    expect(samples.loss[2]).toContain(lang === 'de' ? '2 gespeicherte Ergebnisse sind' : '2 opgeslagen resultaten zijn');
    expect(samples.ago).toBe(lang === 'de' ? 'vor 3 Stunden' : '3 uur geleden');
    expect(samples.time).toBe('18:04');
    expect(samples.percentage.map(value => value.replace(/\s/g,''))).toEqual(['0%', '4,2%', '58%', '—']);
    const min = lang === 'de' ? 'Min.' : 'min', hour = lang === 'de' ? 'Std.' : 'uur';
    expect(samples.duration).toEqual(['0:00 '+min, '0:59 '+min, '15:00 '+min, '1:05 '+hour, '—']);
    expect(samples.bin).toBe('1:30');
  });
}

test('German week starts on Monday and choosing a date submits the real filter', async ({academyPage: page, academyOrigin, request}) => {
  await seedCourse(request, academyOrigin);
  await page.context().addCookies([{name:'xped-language', value:'de', url:academyOrigin}]);
  await page.goto(academyOrigin+'/?from=2026-11-01&to=2026-11-28');
  const trigger = page.locator('#ao-dates .app-date-trigger').first();
  await expect(trigger).toContainText('2026');
  await trigger.click();
  const calendar = page.getByRole('dialog', {name:'Datum auswählen'});
  const weekday = calendar.locator('.app-date-grid > span');
  await expect(weekday.first()).toHaveText(/^Mo\.?$/);
  await expect(weekday.nth(6)).toHaveText(/^So\.?$/);
  const day = calendar.locator('[data-date="2026-11-02"]');
  await expect(day).toHaveAccessibleName(/Montag/);
  await day.click();
  await expect(page.locator('#ao-from')).toHaveValue('2026-11-02');
  const submitted = page.waitForRequest(req => new URL(req.url()).pathname === '/api/academy/overview' && new URL(req.url()).searchParams.get('from') === '2026-11-02');
  await page.locator('#ao-dates button[type=submit]').click();
  await submitted;
  await expect(page).toHaveURL(/from=2026-11-02/);
});

test('pseudo-locale marks dynamic messages and preserves course titles in real lists', async ({academyPage: page, academyOrigin, request}, testInfo) => {
  const course = await seedCourse(request, academyOrigin);
  await page.route('**/academy/messages/nl/*.js', async route => {
    const response = await route.fetch();
    const body = await response.text();
    const catalog = JSON.parse(body.slice('window.XpedMessages='.length, -1));
    const pseudo = text => '⟦' + text.replaceAll('e', 'ë').replaceAll('a', 'á') + '⟧';
    for (const [key, message] of Object.entries(catalog)) {
      // Preserve named variables and only accent translator-provided copy.
      const mark = text => text.split(/(\{\w+\})/g).map(part => part.startsWith('{') ? part : pseudo(part)).join('');
      if (typeof message === 'string') catalog[key] = mark(message);
      else for (const form of Object.keys(message.choices)) message.choices[form] = mark(message.choices[form]);
    }
    await route.fulfill({response, body:'window.XpedMessages=' + JSON.stringify(catalog) + ';'});
  });
  await page.goto(academyOrigin+'/expedities');
  const row = page.locator('[data-expedition-row="'+course.id+'"]');
  await expect(row.locator('h2')).toHaveText(course.title);
  await expect(row.locator('[data-column=stepCount]')).toContainText('⟦1 státion⟧⟦1 stáp⟧');
  await page.goto(academyOrigin+'/resultaten');
  const entry = page.locator('#ac-index-list a').filter({hasText:course.title}).first();
  await expect(entry.locator('strong')).toHaveText(course.title);
  await expect(entry.locator('.ac-entry-detail')).toHaveText('⟦Rësultátën bëkijkën⟧');
  await testInfo.attach('pseudo-results',{body:await page.screenshot(),contentType:'image/png'});
});

for (const width of [390, 1440]) {
  test('German Studio and learner pages fit at ' + width, async ({academyPage: page, academyOrigin, request, browser}, testInfo) => {
    test.setTimeout(75000);
    const course = await seedCourse(request, academyOrigin);
    const root = '/expedities/' + course.id;
    const sharing = await request.post(academyOrigin+'/api/elearning/expeditions/'+course.id+'/sharing', {
      headers, data: {action:'update_public', enabled:true, collectResponses:true}
    });
    expect(sharing.ok()).toBe(true);
    const {share} = await sharing.json();
    const invitation = await request.post(academyOrigin+'/api/elearning/expeditions/'+course.id+'/sharing', {
      headers, data:{action:'create_grant', role:'translate', targetLanguage:'de', label:'Übersetzungsprüfung'}
    });
    expect(invitation.ok()).toBe(true);
    const {grant} = await invitation.json();

    await page.setViewportSize({width,height:width === 390 ? 844 : 900});
    await page.context().addCookies([{name:'xped-language',value:'de',url:academyOrigin}]);
    for (const [name, path, ready] of [
      ['overview','/','#ao-rows tr'], ['library','/expedities','[data-expedition-row]'],
      ['results','/resultaten','#ac-index-list a'], ['translations','/vertalingen','#ac-index-list a'],
      ['team','/team','#xc-team-count'], ['settings','/instellingen','#ac-preferences-title'],
      ['course',root,'#xc-overzicht'], ['sharing',root+'#delen','#xc-sharing-settings'],
      ['course-translations',root+'#vertalingen','#xc-translation-heading'], ['course-settings',root+'#instellingen','#xc-instellingen'],
      ['builder',root+'/bewerken','#el-exp-title'], ['report',root+'/resultaten','#el-response-report'],
      ['translation-editor',root+'/bewerken?modus=vertalen&taal=de','#el-mode-translate'],
      ['translator-invite',grant.urlPath,'#el-mode-translate'], ['help','/hulp','main h1'],
      ['privacy','/privacy','main h1'], ['missing-page','/synthetic-missing','main h1'], ['learner','/start/'+share.token+'?lang=de','main h1'],
      ['inactive','/start/disabled-synthetic?lang=de','main h1'],
    ]) {
      await test.step(name, async () => {
        await page.goto(academyOrigin + path);
        await expect(page.locator('html')).toHaveAttribute('lang','de');
        await expect(page.locator(ready).first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth), name).toBeLessThanOrEqual(width);
        const file = testInfo.outputPath(name+'.png');
        await page.screenshot({path:file,animations:'disabled'});
        await testInfo.attach(name,{path:file,contentType:'image/png'});
      });
    }
    // Public sign-in is reached signed out. Keep its fake Firebase client in its own context.
    const guest = await browser.newContext({viewport: {width,height:900}});
    try {
      await guest.addCookies([{name:'xped-language', value:'de', url:academyOrigin}]);
      await guest.route('**/*', route => new URL(route.request().url()).origin === academyOrigin ? route.continue() : route.abort());
      await guest.addInitScript(() => {
        let app;
        const auth = {currentUser:null, onAuthStateChanged(callback) {queueMicrotask(() => callback(null)); return () => {};}};
        window.firebase = {app() {if (!app) throw Error('Not initialized'); return app;}, initializeApp(options) {app = {options}; return app;}, auth:() => auth};
      });
      const publicPage = await guest.newPage();
      await publicPage.goto(academyOrigin+'/inloggen');
      await expect(publicPage.getByRole('button',{name:'Mit Google anmelden'})).toBeVisible();
      expect(await publicPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await testInfo.attach('signin',{body:await publicPage.screenshot({animations:'disabled'}),contentType:'image/png'});
    } finally { await guest.close(); }
  });
}
