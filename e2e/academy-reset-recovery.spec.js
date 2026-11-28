const { test, expect } = require('./helpers/academy-service');

const reportPath = '/api/elearning/expeditions/reset-example/responses';
const pagePath = '/expedities/reset-example/resultaten';
const title = 'Ontspanning <in rust>';

function results(offer, courseTitle = title, feedback = []) {
  return {
    expedition: {id: 'reset-example', title: courseTitle, defaultLanguage: 'nl', modules: []},
    statisticsReset: offer, summary: {totalSessions: 0, completedSessions: 0}, cohorts: [], stations: [], funnel: [],
    pilotFeedback: feedback.map(comment => ({cohort: 'default', language: 'nl', comment})),
  };
}

test('an interrupted reset resumes the same operation without removing new results', async ({academyPage: page, academyOrigin}) => {
  const offer = {version: 'old', pending: true, totalSessions: 0};
  const finished = {version: 'new', pending: false, totalSessions: 1};
  const bodies = [];
  let current = results(offer);
  await page.route('**' + reportPath + '*', route => route.fulfill({json: current}));
  await page.route('**' + reportPath + '/reset', route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) return route.fulfill({status: 202, json: {reset: true, pending: true}});
    if (bodies.length === 2) return route.abort('failed');
    current = results(finished, title, ['Nieuw na de wisactie']);
    return route.fulfill({json: {reset: true, pending: false}});
  });
  await page.goto(academyOrigin + pagePath + '?cohort=oud');
  await page.getByRole('button', {name: 'Wissen hervatten'}).click();
  const dialog = page.getByRole('dialog', {name: 'Wissen hervatten?'});
  await expect(dialog).toContainText(title);
  await expect(dialog.getByRole('button', {name: 'Annuleren'})).toBeFocused();
  await dialog.getByRole('button', {name: 'Wissen hervatten'}).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', {name: 'Opnieuw proberen'}).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Nieuw na de wisactie/)).toBeVisible();
  expect(new URL(page.url()).searchParams.has('cohort')).toBe(false);
  expect(bodies).toEqual(Array(3).fill({version: 'old', confirmTitle: title}));
});

test('a renamed course requires a new confirmation after refreshing the report', async ({academyPage: page, academyOrigin}) => {
  const offer = {version: 'current', pending: false, totalSessions: 7};
  let current = results(offer);
  let posts = 0;
  await page.route('**' + reportPath + '*', route => route.fulfill({json: current}));
  await page.route('**' + reportPath + '/reset', route => {
    posts++;
    current = results(offer, 'Nieuwe titel');
    return route.fulfill({status: 409, json: {error: 'Course changed'}});
  });
  await page.goto(academyOrigin + pagePath + '?days=7');
  const openReset = page.getByRole('button', {name: 'Statistieken wissen', exact: true});
  await openReset.click();
  const dialog = page.getByRole('dialog', {name: 'Statistieken wissen?'});
  await expect(dialog).toContainText(title);
  await expect(dialog).toContainText('7 gedeelde sessies in de hele expeditie.');
  await dialog.getByRole('button', {name: 'Definitief wissen'}).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/De expeditie of de statistieken zijn intussen gewijzigd/)).toBeVisible();
  await openReset.click();
  await expect(dialog).toContainText('Nieuwe titel');
  await dialog.getByRole('button', {name: 'Annuleren'}).click();
  expect(posts).toBe(1);
});

test('a report without owner permission exposes no reset action', async ({academyPage: page, academyOrigin}) => {
  await page.route('**' + reportPath + '*', route => route.fulfill({json: results(undefined)}));
  await page.goto(academyOrigin + pagePath);
  await expect(page.getByText(title, {exact: true}).last()).toBeVisible();
  await expect(page.getByRole('button', {name: 'Statistieken wissen', exact: true})).toHaveCount(0);
});

test('the German confirmation fits a small screen and Escape returns focus to the owner action', async ({academyPage: page, academyOrigin}, testInfo) => {
  await page.context().addCookies([{name: 'xped-language', value: 'de', url: academyOrigin}]);
  await page.setViewportSize({width: 375, height: 730});
  await page.route('**' + reportPath + '*', route => route.fulfill({json: results({version: '1', pending: false, totalSessions: 1})}));
  await page.goto(academyOrigin + pagePath);
  const trigger = page.getByRole('button', {name: 'Statistiken löschen', exact: true});
  await trigger.click();
  const dialog = page.getByRole('dialog', {name: 'Statistiken löschen?'});
  await expect(dialog).toContainText('1 geteilte Sitzung');
  await expect(dialog.getByRole('button', {name: 'Endgültig löschen'})).toBeInViewport();
  await page.screenshot({path: testInfo.outputPath('reset-confirmation.png'), animations: 'disabled'});
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
