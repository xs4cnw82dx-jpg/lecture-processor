const { test, expect } = require('@playwright/test');
const Model = require('../static/js/elearning-model.js');

const token = 'synthetic-timing';
const apiPath = '**/api/elearning/public/' + token;

async function openCourse(page) {
  const course = Model.createExpeditionPreset('showcase', 'Op weg met pijn', 'nl');
  course.shareOptions = { collectResponses: true, collectionVersion: 'one' };
  const bodies = [];
  await page.route('https://**', route => route.abort());
  await page.route(apiPath, route => route.fulfill({ json: { expedition: course } }));
  await page.route(apiPath + '/responses', route => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { saved: true } });
  });
  await page.clock.install();
  await page.goto('/elearning/p/' + token + '?lang=nl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Op weg met pijn');
  // Freeze time so that only runFor moves the learner's clock.
  await page.clock.pauseAt(Date.now() + 60_000);
  const [first, second] = course.modules[0].steps.map(step => step.id);
  return { bodies, first, second };
}

async function hidePage(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test('a sharing learner reports active time per step, without idle or hidden time', async ({ page }) => {
  const { bodies, first, second } = await openCourse(page);
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  await page.getByRole('radio', { name: new RegExp(Model.ui('nl', 'consentShare')) }).check();
  await expect(page.getByText(Model.ui('nl', 'authorAccess'))).toBeAttached();
  await page.getByRole('button', { name: Model.ui('nl', 'next'), exact: true }).click();

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
});

test('a session that consented before the time disclosure keeps sharing answers but never sends time', async ({ page }) => {
  const storageKey = 'xped_el_progress_' + token;
  const group = storageKey + ':group:default';
  await page.addInitScript(({ storageKey, group }) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const sessionId = 'lrn_earlier-consent';
    localStorage.setItem(storageKey, JSON.stringify({ recentGroup: 'default' }));
    localStorage.setItem(group, JSON.stringify({ sessionId, sharedVisits: [], visitedStepIds: [] }));
    localStorage.setItem(group + ':consent', JSON.stringify({ choice: 'share', cohort: 'default', version: 'one', sessionId }));
  }, { storageKey, group });
  const { bodies, first } = await openCourse(page);
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  await page.clock.runFor(30_000);
  await page.getByRole('button', { name: Model.ui('nl', 'next'), exact: true }).click();
  await page.clock.runFor(1_000);
  await hidePage(page);
  await expect.poll(() => bodies.some(body => (body.visitedStepIds || []).includes(first))).toBe(true);
  expect(bodies.every(body => body.stepSeconds === undefined)).toBe(true);
});
