const { test, expect } = require('./helpers/academy-service');
const Model = require('../static/js/elearning-model.js');

const owner = { Authorization: 'Bearer academy-preview-token' };

async function publishAcademyCourse(request, origin) {
  const step = id => ({ id, title: { nl: id }, blocks: [] });
  const course = { title: 'Op weg met pijn', defaultLanguage: 'nl', enabledLanguages: ['nl'],
    startPage: { title: { nl: 'Op weg met pijn' } },
    modules: [{id:'station', title:{nl:'Station'}, visibleToLearners:true, steps:[step('first'),step('second'),step('third')]}] };
  const create = await request.post(origin + '/api/elearning/expeditions', { headers: owner, data: course });
  expect(create.status()).toBe(201);
  const {expedition} = await create.json();
  const share = await request.post(origin + '/api/elearning/expeditions/' + expedition.id + '/sharing', {
    headers: owner, data: {action:'update_public', enabled:true, collectResponses:true}
  });
  expect(share.ok()).toBe(true);
  const {share: {token}} = await share.json();
  const resp = await request.get(origin + '/api/elearning/public/' + token);
  expect(resp.ok()).toBe(true);
  const data = await resp.json();
  return { token, version:data.expedition.shareOptions.collectionVersion, id:expedition.id };
}

async function openCourse(page, url, token) {
  const bodies = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/elearning/public/' + token + '/responses') bodies.push(request.postDataJSON());
  });
  await page.clock.install();
  await page.goto(url + '?lang=nl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Op weg met pijn');
  await page.clock.pauseAt(Date.now() + 60_000);
  return bodies;
}

async function consentToShare(page) {
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  await page.getByRole('radio', { name: new RegExp(Model.ui('nl', 'consentShare')) }).check();
  await page.getByRole('button', { name: Model.ui('nl', 'next'), exact: true }).click();
}

async function hidePage(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test('a sharing learner reports active time per step, without idle or hidden time', async ({ academyPage: page, academyOrigin, request }) => {
  const { token, id } = await publishAcademyCourse(request, academyOrigin);
  const bodies = await openCourse(page, academyOrigin + '/start/' + token, token);
  const first = 'first', second = 'second';
  await consentToShare(page);

  await page.clock.runFor(30_000);
  await page.getByRole('button', { name: Model.ui('nl', 'next'), exact: true }).click();
  await page.clock.runFor(1_000);
  await expect.poll(() => bodies.at(-1)?.stepSeconds?.[first]).toBe(30);

  // Five quiet minutes count only up to the 60-second idle window.
  await page.clock.runFor(5 * 60_000);
  await hidePage(page);
  await expect.poll(() => bodies.at(-1)?.stepSeconds).toEqual({ [first]: 30, [second]: 60 });

  // Time while the page is hidden does not count.
  await page.clock.runFor(10 * 60_000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.mouse.wheel(0, 200);
  await page.clock.runFor(20_000);
  await hidePage(page);
  await expect.poll(() => bodies.at(-1)?.stepSeconds).toEqual({ [first]: 30, [second]: 80 });
  await expect.poll(async () => {
    const r = await request.get(academyOrigin + '/api/elearning/expeditions/' + id + '/responses', { headers: owner });
    return (await r.json()).summary.activeSeconds?.median;
  }).toBe(110);
});

test('a session that consented before the time disclosure keeps sharing answers but never sends time', async ({ academyPage: page, academyOrigin, request }) => {
  const { token, version } = await publishAcademyCourse(request, academyOrigin);
  const storageKey = 'xped_el_progress_' + token;
  const group = storageKey + ':group:default';
  await page.addInitScript(({ storageKey, group, version }) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const sessionId = 'lrn_earlier-consent';
    localStorage.setItem(storageKey, JSON.stringify({ recentGroup: 'default' }));
    localStorage.setItem(group, JSON.stringify({ sessionId, sharedVisits: [], visitedStepIds: [] }));
    localStorage.setItem(group + ':consent', JSON.stringify({ choice: 'share', cohort: 'default', version, sessionId }));
  }, { storageKey, group, version });
  const bodies = await openCourse(page, academyOrigin + '/start/' + token, token);
  const first = 'first';
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  await page.clock.runFor(30_000);
  await page.getByRole('button', { name: Model.ui('nl', 'next'), exact: true }).click();
  await page.clock.runFor(1_000);
  await hidePage(page);
  await expect.poll(() => bodies.some(body => (body.visitedStepIds || []).includes(first))).toBe(true);
  expect(bodies.every(body => body.stepSeconds === undefined)).toBe(true);
});

test('a new Lecture Processor sharing choice sends progress without measuring time', async ({page}) => {
  const token = 'synthetic-lecture-processor';
  const course = Model.createExpeditionPreset('showcase', 'Op weg met pijn', 'nl');
  course.shareOptions = {collectResponses:true, collectionVersion:'one'};
  const endpoint = '**/api/elearning/public/' + token;
  await page.route('https://**', route => route.abort());
  await page.route(endpoint, route => route.fulfill({json:{expedition:course}}));
  await page.route(endpoint + '/responses', route => route.fulfill({json:{saved:true}}));
  const bodies = await openCourse(page, '/elearning/p/' + token, token);
  await consentToShare(page);
  await page.clock.runFor(30_000);
  await page.getByRole('button', {name:Model.ui('nl','next'),exact:true}).click();
  await page.clock.runFor(1_000);
  await hidePage(page);
  await expect.poll(() => bodies.some(body => body.visitedStepIds?.length > 0)).toBe(true);
  expect(bodies.every(body => body.stepSeconds === undefined && body.activeTimeDisclosure === undefined)).toBe(true);
});
