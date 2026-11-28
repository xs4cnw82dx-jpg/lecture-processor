const { test, expect } = require('@playwright/test');
const { signedIn } = require('./helpers/xped-library');
const { editorFixture } = require('./helpers/xped-editor');

const base = '/physio/elearning';
const collection = '**/api/elearning/expeditions';
const cover = '/static/images/xped/xped-wandelaar-met-kaart.png';
function expedition(id, options = {}) {
  return {
    id, title: 'Pijn begrijpen en samen een volgende stap kiezen', role: 'owner',
    enabledLanguages: ['nl', 'de'], moduleCount: 3, stepCount: 7,
    updatedAt: 1763917200, coverMedia: { kind: 'xped', staticPath: cover },
    languageCoverage: { nl: { total: 10, translated: 10 }, de: { total: 10, translated: 6, needsReview: 2 } },
    ...options,
  };
}

test('empty library starts at the title and announces exactly one pending creation', async ({ page }) => {
  await signedIn(page);
  let finish;
  const creating = new Promise(resolve => { finish = resolve; });
  const writes = [];
  await page.route(collection, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { expeditions: [] } });
    writes.push(route.request().postDataJSON());
    await creating;
    return route.fulfill({ status: 503, json: { error: 'Try again.' } });
  });
  await page.goto(base);
  await page.getByRole('button', { name: 'Create expedition', exact: true }).press('Enter');
  const title = page.getByLabel('Expedition Title');
  await expect(title).toBeFocused();
  await title.fill('Schmerzen verstehen');
  await page.getByRole('button', { name: /Primary Authoring Language/ }).click();
  await page.getByRole('option', { name: 'Deutsch (DE)' }).click();
  await page.getByRole('button', { name: /Starting Structure/ }).click();
  await page.getByRole('option', { name: 'Interactive example' }).click();
  await expect(page.locator('#el-template-preview')).toContainText('Myth vs. Fact');
  const submit = page.locator('#el-create-confirm');
  const width = (await submit.boundingBox()).width;
  await title.press('Enter');
  await expect(page.locator('#el-create-progress')).toHaveText('Creating expedition…');
  await title.press('Enter');
  await expect(submit).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(Math.abs(width - (await submit.boundingBox()).width)).toBeLessThan(2);
  expect(writes).toHaveLength(1);
  expect(writes[0].startPage.title).toMatchObject({ de: 'Schmerzen verstehen', en: '', nl: '' });
  expect(writes[0].modules).toHaveLength(2);
  expect(writes[0].modules.flatMap(m => m.steps)).toHaveLength(5);
  finish();
  await expect(submit).toBeEnabled();
});

test('same-name covers, readiness and fresh timestamps survive filtering and duplicate focus follows the new ID', async ({ page }) => {
  await signedIn(page);
  const records = Array.from({ length: 20 }, (_, index) => expedition('exp-' + index, index > 1 ? { title: 'Activiteit ' + index } : {}));
  records[1].coverMedia = { kind: 'asset', assetId: 'foto' };
  await page.route(collection, route => route.fulfill({ json: { expeditions: records } }));
  await page.route('**/api/elearning/expeditions/exp-1/assets/foto', async route => {
    expect(route.request().headers().authorization).toBe('Bearer author');
    const file = await route.fetch({ url: new URL(cover, page.url()).href });
    await route.fulfill({ response: file });
  });
  await page.route('**/exp-1/duplicate', route => {
    const copy = expedition('new-copy');
    records.push(copy);
    return route.fulfill({ json: { expedition: copy } });
  });
  await page.goto(base);
  const rows = page.locator('.el-exp-row');
  await expect(rows).toHaveCount(20);
  const search = page.getByRole('searchbox', { name: 'Search expeditions' });
  await search.fill('PIJN');
  await expect(rows).toHaveCount(2);
  const second = rows.nth(1);
  await expect(second.locator('.el-exp-thumb img')).toHaveAttribute('src', /^blob:/);
  await expect(rows.first().locator('.el-exp-thumb img')).toHaveAttribute('src', cover);
  const time = second.locator('time');
  await time.focus();
  await expect(time).toBeFocused();
  expect(await time.getAttribute('aria-label')).toContain(await time.getAttribute('title'));
  await second.getByRole('button', { name: 'DE 60% · review' }).click();
  await expect(second).toContainText('6 of 10 fields translated · 2 need review');
  await search.fill('absent');
  await page.getByRole('button', { name: 'Clear search' }).press('Enter');
  await expect(rows).toHaveCount(20);
  records[1].updatedAt = Math.floor(Date.now() / 1000);
  await page.reload();
  await expect(rows.nth(1).locator('time')).toHaveText('Updated just now');
  await rows.nth(1).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  const copy = page.locator('.is-just-duplicated').getByRole('link', { name: 'Open copy' });
  await expect(copy).toBeFocused();
  await expect(copy).toHaveAttribute('href', base + '/new-copy/edit');
  await copy.press('Enter');
  await expect(page).toHaveURL(/new-copy\/edit$/);
});

test('import previews validate without creating and close when the account changes', async ({ page }) => {
  await signedIn(page);
  let writes = 0;
  await page.route(collection, route => {
    if (route.request().method() === 'POST') ++writes;
    return route.fulfill({ json: { expeditions: [expedition('one'), expedition('two')] } });
  });
  await page.route('**/api/elearning/import-preview', route => {
    if (!route.request().postDataJSON().modules) return route.fulfill({ status: 400, json: { error: 'Missing stations.' } });
    return route.fulfill({ json: { title: 'Piloot', stationCount: 2, stepCount: 4, enabledLanguages: ['nl', 'de'] } });
  });
  await page.goto(base);
  const file = modules => ({ name: 'pilot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ title: 'Piloot', modules })) });
  const input = page.locator('#el-import-json-input');
  await input.setInputFiles(file());
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Missing stations.');
  await expect(page.locator('#el-import-confirm')).toBeDisabled();
  await page.locator('#el-import-cancel').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await input.setInputFiles(file([]));
  await expect(page.locator('#el-import-summary')).toContainText('2 stations · 4 steps · NL, DE');
  await page.locator('#el-import-cancel').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.el-exp-row')).toHaveCount(2);
  const search = page.getByRole('searchbox');
  await search.fill('Pijn');
  await input.setInputFiles(file([]));
  await expect(page.locator('#el-import-confirm')).toBeEnabled();
  await page.evaluate(() => window.switchAccount(null));
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(search).toBeHidden();
  await expect(page.locator('main')).not.toContainText('Pijn begrijpen');
  expect(writes).toBe(0);
});

function reportData() {
  const loc = value => ({ de: value, en: value, nl: value });
  const balance = id => ({ id, type: 'balance_scale', settings: {}, data: {} });
  const first = { id: 'first', title: loc('Check-in'), blocks: [
    { id: 'poll', type: 'mcq', settings: { allowMultiple: true }, data: {
      question: loc('What helped?'), options: ['a', 'b', 'c'].map(id => ({ id, label: loc('Choice ' + id) })),
    } },
    { id: 'writing', type: 'reflection', data: { prompt: loc('What stood out?') } }, balance('bal1'),
  ] };
  const stations = [
    { id: 'mod1', title: loc('Opening'), steps: [first] },
    { id: 'mod2', title: loc('Follow-up'), steps: [{ id: 'second', title: loc('Check-in'), blocks: [balance('bal2')] }] },
  ];
  return { expedition: { id: 'visual', title: 'Course draft', modules: stations, defaultLanguage: 'nl' },
    cohorts: ['pilot-1', 'pilot-2'], summary: { totalSessions: 12, completionRate: 75, medianSeconds: 300 },
    funnel: [
      { moduleId: 'mod1', moduleTitle: loc('Opening'), stepId: 'first', stepTitle: loc('Check-in'), reached: 12 },
      { moduleId: 'mod2', moduleTitle: loc('Follow-up'), stepId: 'second', stepTitle: loc('Check-in'), reached: 6 },
    ], blockStats: {
      poll: { count: 2, counts: { a: 2, b: 1 } },
      writing: { count: 12, samples: Array.from({ length: 12 }, (_, i) => 'Reflection ' + (i + 1)), sampleTotal: 12 },
      bal1: { count: 1, avgLoad: 2, avgResource: 2 }, bal2: { count: 1, avgLoad: 3, avgResource: 2 },
    }, stepComments: [
      { stepId: 'second', moduleId: 'mod2', stepTitle: 'Check-in', comment: 'Explain this step.' },
      { stepId: 'removed', stepTitle: 'Old check-in', comment: 'Earlier comment.' },
    ] };
}

test('response filters keep their scope, counts and comment destinations clear', async ({ page }) => {
  const { exp } = await editorFixture(page);
  const data = reportData();
  exp.modules[0].steps[0].title = exp.modules[1].steps[0].title = { en: 'Check-in', nl: 'Check-in', de: 'Check-in' };
  data.stepComments[0].stepId = exp.modules[1].steps[0].id;
  data.stepComments[0].moduleId = exp.modules[1].id;
  data.expedition.modules[1].id = exp.modules[1].id;
  data.expedition.modules[1].steps[0].id = exp.modules[1].steps[0].id;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const downloads = [];
  await page.route('**/visual/responses**', async route => {
    if (route.request().resourceType() === 'document') return route.continue();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('.csv')) {
      downloads.push(url.search);
      return route.fulfill({ contentType: 'text/csv', body: 'testers\n2' });
    }
    if (url.searchParams.has('language')) await pending;
    return route.fulfill({ json: data });
  });
  await page.goto(base + '/visual/responses');
  const stats = page.locator('#el-resp-blocks');
  await expect(stats).toContainText('Share of 2 respondents');
  const choice = name => stats.locator('.el-chart-row').filter({ hasText: name }).locator('.el-chart-value');
  await expect(choice('Choice a')).toHaveText('2 100%');
  await expect(choice('Choice b')).toHaveText('1 50%');
  await expect(choice('Choice c')).toHaveText('0 0%');
  const completion = page.locator('#el-resp-kpis');
  await expect(completion.getByRole('heading', { name: 'Completion rate' })).toBeVisible();
  await expect(completion.locator('.el-split-figures')).toContainText('Completed75%');
  await expect(completion.locator('.el-split-figures')).toContainText('Not completed25%');
  await expect(completion.locator('.el-split-counts')).toHaveText('9 sessions3 sessions');
  const reach = page.locator('#el-resp-funnel');
  await expect(reach.locator('.el-chart-group-title')).toHaveText(['Opening', 'Follow-up']);
  await expect(reach.locator('.el-chart-group').filter({ hasText: 'Follow-up' }).locator('.el-chart-value')).toHaveText('6 50%');
  await expect(reach.locator('.el-chart-note')).toHaveText('n = 12');
  await expect(stats).toContainText('Showing 8 of 12 reflection excerpts');
  await stats.getByRole('button', { name: 'Show 12 excerpts' }).click();
  await expect(stats).toContainText('Showing 12 of 12 reflection excerpts');
  await expect(stats.getByRole('button', { name: 'Show fewer' })).toBeFocused();
  await page.getByRole('button', { name: /Filter by cohort/ }).click();
  await page.getByRole('option', { name: 'pilot-2' }).click();
  const kpi = page.locator('#el-resp-kpis');
  const previousTop = (await kpi.boundingBox()).y;
  const previousScroll = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', { name: /Filter by language/ }).click();
  await page.getByRole('option', { name: 'Deutsch (DE)' }).click();
  await expect(page.locator('#el-response-report')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#el-resp-status')).toContainText('pilot-2 · DE');
  await expect(stats.getByRole('heading', { name: 'What helped?' })).toBeVisible();
  expect(Math.abs((await kpi.boundingBox()).y - previousTop)).toBeLessThan(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(previousScroll);
  finish();
  await expect(stats.getByRole('heading', { name: 'Belastung und Ressourcen · Station 2 · Schritt 1' })).toBeVisible();
  for (const name of ['Export filtered CSV', 'Export all CSV']) {
    const completed = page.waitForEvent('download');
    await page.getByRole('button', { name }).click();
    const file = await completed;
    expect(file.suggestedFilename()).toContain(name.includes('filtered') ? '-pilot-2-de.csv' : 'visual.csv');
  }
  expect(downloads).toEqual(['?cohort=pilot-2&language=de', '']);
  await expect(page.locator('#el-resp-comments')).toContainText('Step no longer available');
  await page.getByRole('link', { name: 'Open in builder' }).click();
  await expect(page.locator('#el-canvas-card .xped-step-title')).toContainText('Check-in');
  await expect(page.locator('#el-return-responses-link')).toHaveAttribute('href', base + '/visual/responses');
});
