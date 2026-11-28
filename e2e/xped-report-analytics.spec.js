const { test, expect } = require('./helpers/academy-service');

const loc = value => ({ nl: value, en: value, de: value });
const quartiles = (median, p25, p75, count) => ({ median, p25, p75, count });

function graded(id, question, counts) {
  return { id, type: 'mcq', settings: {}, data: { question: loc(question), graded: true,
    options: [{ id: id + '_a', label: loc('Right'), isCorrect: true }, { id: id + '_b', label: loc('Wrong') }] }, counts };
}

function reportData() {
  const easy = graded('easy', 'Mostly answered well', { easy_a: 8, easy_b: 2 });
  const hard = graded('hard', 'Often misunderstood', { hard_a: 3, hard_b: 7 });
  const modules = [
    { id: 'mod1', title: loc('Opening'), estimatedMinutes: 5, steps: [
      { id: 's1', title: loc('Question'), blocks: [easy] }, { id: 's2', title: loc('Explainer'), blocks: [hard] }] },
    { id: 'mod2', title: loc('Plan'), estimatedMinutes: 10, steps: [{ id: 's3', title: loc('My plan'), blocks: [] }] },
  ];
  return {
    expedition: { id: 'visual', title: 'Course draft', defaultLanguage: 'nl', modules },
    cohorts: [], pilotFeedback: [], stepComments: [],
    summary: { totalSessions: 40, completedSessions: 22, completionRate: 55, timedSessions: 30,
      activeSeconds: quartiles(900, 600, 1260, 30) },
    stations: [
      { moduleId: 'mod1', moduleTitle: loc('Opening'), reached: 40, estimatedMinutes: 5, time: quartiles(560, 400, 700, 30) },
      { moduleId: 'mod2', moduleTitle: loc('Plan'), reached: 20, estimatedMinutes: 10, time: quartiles(300, 200, 420, 12) },
    ],
    funnel: [
      { moduleId: 'mod1', moduleTitle: loc('Opening'), stepId: 's1', stepTitle: loc('Question'), reached: 40, time: quartiles(95, 60, 140, 30) },
      { moduleId: 'mod1', moduleTitle: loc('Opening'), stepId: 's2', stepTitle: loc('Explainer'), reached: 28, time: quartiles(465, 300, 600, 24) },
      { moduleId: 'mod2', moduleTitle: loc('Plan'), stepId: 's3', stepTitle: loc('My plan'), reached: 22, time: quartiles(300, 200, 420, 12) },
    ],
    weekly: [{ week: '2026-11-02', started: 10, completed: 4 }, { week: '2026-11-09', started: 0, completed: 0 },
      { week: '2026-11-16', started: 30, completed: 18 }],
    blockStats: {
      easy: { type: 'mcq', count: 10, counts: easy.counts },
      hard: { type: 'mcq', count: 10, counts: hard.counts },
    },
  };
}

for (const size of [{width:390,height:844},{width:1280,height:900}]) {
  test('Academy reports, filters and step details are usable at ' + size.width, async ({academyPage: page, academyOrigin}, testInfo) => {
    await page.setViewportSize(size);
    const data = reportData();
    data.cohorts=['default','coaches','group-b'];
    data.funnel.forEach((step,index) => Object.assign(step,{continued:[28,22,18][index],lostFromPrevious:[null,12,6][index],
      previousReached:[null,40,28][index],gradedAnswers:10,correctAnswers:3,comments:index}));
    data.stations.forEach((station,index) => Object.assign(station,{reached:index?22:40,continued:index?18:22,lost:index?4:18,
      correctAnswers:11,gradedAnswers:20,comments:2}));
    Object.assign(data.blockStats.easy,{correctAnswers:8,gradedAnswers:10});
    Object.assign(data.blockStats.hard,{correctAnswers:3,gradedAnswers:10});
    data.weekly[1].revision={revision:4,at:1794182400};
    data.funnel[1].time = quartiles(465, 450, 480, 24);
    data.funnel[1].timeHistogram = [{fromSeconds:450, sessionCount:15}, {fromSeconds:480, sessionCount:9}];
    data.funnel[2].time = quartiles(304, 304, 304, 1);
    data.funnel[2].timeHistogram = [{fromSeconds:300, sessionCount:1}];
    data.stations[0].activeSecondsTotal=180;
    data.stations[1].activeSecondsTotal=120;
    const requests=[];
    await page.route('**/api/elearning/expeditions/visual/responses*', route=>{
      requests.push(new URL(route.request().url()).search);
      return route.fulfill({json:data});
    });
    await page.goto(academyOrigin + '/expedities/visual/resultaten');
    const time = page.locator('#el-resp-time');
    await expect(time.getByRole('heading',{name:'Tijdsbesteding'})).toBeVisible();
    await expect(time.locator('.el-time-figures')).toContainText('15 min');
    const shares = time.getByRole('table', { name: 'Aandeel in de gemeten actieve tijd per station' });
    await expect(shares.getByRole('row', { name: /Opening/ })).toContainText('60%');
    await expect(shares.getByRole('row', { name: /Plan/ })).toContainText('40%');
    const opening = time.locator('details').filter({hasText:'Opening'});
    await opening.locator('summary').click();
    await expect(opening.locator('.el-time-steps')).toContainText('7:45');
    const funnel = page.locator('#el-resp-funnel');
    await expect(funnel.locator('.el-chart-row').filter({hasText:'Explainer'})).toContainText('−12');
    await expect(funnel.getByText(/Het getal na − telt deelnemers/)).toBeVisible();
    await funnel.locator('summary').click();
    const reach = funnel.getByRole('table');
    await expect(reach.getByRole('columnheader', {name:'Uitval vanuit de vorige stap'})).toBeVisible();
    const branch = reach.getByRole('row').filter({hasText:'Explainer'});
    await expect(branch.getByRole('cell').nth(2)).toHaveText('40');
    await expect(branch.getByRole('cell').last()).toHaveText(/12 .*30/);
    await funnel.getByRole('button',{name:'Explainer'}).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading',{name:'Explainer'})).toBeVisible();
    await expect(drawer.locator('[data-detail-edit]')).toHaveAttribute('href',/bewerken\?step=s2/);
    const distribution = drawer.locator('.academy-time-histogram');
    await expect(distribution.getByRole('heading')).toHaveText('Verdeling van de actieve tijd');
    await expect(distribution.locator('progress')).toHaveCount(2);
    await distribution.locator('summary').click();
    await expect(distribution.getByRole('row').filter({hasText:'7:30–7:59'})).toContainText('15');
    await expect(distribution.getByRole('row').filter({hasText:'8:00–8:29'})).toContainText('9');
    await drawer.locator('[data-detail-next]').click();
    await expect(drawer.getByRole('heading',{name:'My plan'})).toBeVisible();
    await expect(distribution).toContainText('1 sessie · 5:00–5:29');
    await expect(distribution.locator('progress')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    const stations = page.locator('#academy-station-report');
    await stations.getByRole('button',{name:'Opening',exact:true}).click();
    await expect(stations.getByRole('button',{name:'Question',exact:true})).toBeVisible();
    await stations.getByRole('button',{name:'Bereikt',exact:true}).click();
    await expect(stations.locator('th[aria-sort]')).toHaveText('Bereikt');
    const trend = page.locator('#el-resp-trend');
    for (const theme of ['light','dark']) {
      const ratio = await trend.evaluate((panel, mode) => {
        document.documentElement.dataset.theme = mode;
        function luminance(color) {
          const channels = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(entry => {
            const value = Number(entry) / 255;
            return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
          });
          return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
        }
        const foreground = luminance(getComputedStyle(panel.querySelector('.el-trend-started')).fill);
        const background = luminance(getComputedStyle(panel).backgroundColor);
        return (Math.max(foreground,background) + .05) / (Math.min(foreground,background) + .05);
      }, theme);
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
    await trend.locator('summary').click();
    await expect(trend.getByRole('table')).toContainText('v4');
    await expect(page.locator('#el-resp-blocks > [data-step]').first()).toContainText('Often misunderstood');
    data.weekly = [data.weekly[2]];
    await page.locator('#el-resp-period').selectOption('7',{force:true});
    await expect(trend.locator('svg')).toHaveCount(0);
    await expect(trend).toContainText('Gestart 30');
    await expect(page).toHaveURL(/days=7/);
    await expect(page).toHaveTitle('Resultaten · Course draft · xPED Academy');
    await expect(funnel.getByRole('img',{name:/Bereik per station/})).toHaveAccessibleName(/Opening 100.*Plan 55/);
    await funnel.getByRole('button',{name:'Explainer'}).click();
    const editorURL = new URL(await drawer.locator('[data-detail-edit]').getAttribute('href'),academyOrigin);
    expect(new URLSearchParams(editorURL.searchParams.get('filters')).get('days')).toBe('7');
    await page.keyboard.press('Escape');
    expect(requests.some(query=>query.includes('days=7'))).toBe(true);
    await page.goto(academyOrigin + '/expedities/visual/resultaten?cohort=coaches&cohort=group-b&from=2026-10-01&to=2026-10-31');
    await expect(page.locator('#academy-filter-chips')).toContainText('coaches');
    await expect(page.locator('#academy-filter-chips')).toContainText('group-b');
    await page.locator('#academy-filter-chips').getByRole('button', {name:/coaches/}).click();
    await expect(page).not.toHaveURL(/cohort=coaches/);
    await expect(page).toHaveURL(/cohort=group-b/);
    await expect(page).toHaveURL(/from=2026-10-01/);
    const editorLink = new URL(await page.locator('#academy-report-editor').getAttribute('href'), academyOrigin);
    expect(editorLink.searchParams.get('from')).toBe('responses');
    const returnFilters = new URLSearchParams(editorLink.searchParams.get('filters'));
    expect(returnFilters.getAll('cohort')).toEqual(['group-b']);
    expect(returnFilters.get('from')).toBe('2026-10-01');
    await page.locator('#academy-station-report').scrollIntoViewIfNeeded();
    if (size.width < 600) {
      const scroller = page.getByRole('region', {name:'Vergelijk de stations'});
      expect(await scroller.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      const firstCell = scroller.getByRole('columnheader').first();
      const position = (await firstCell.boundingBox()).x;
      await scroller.focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => scroller.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
      expect(Math.abs((await firstCell.boundingBox()).x - position)).toBeLessThan(2);
      await scroller.evaluate(node => { node.scrollLeft = 0; });
    }

    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await testInfo.attach('academy-report-'+size.width,{body:await page.screenshot(),contentType:'image/png'});
  });
}

test('an Academy author can enable real outline results and retains the preference on reload', async ({academyPage: page, academyOrigin}) => {
  const { editorFixture } = require('./helpers/xped-editor');
  const { exp } = await editorFixture(page);
  const first = exp.modules[0].steps[0];
  let reads = 0;
  await page.route('**/api/elearning/expeditions/visual/outline-results', route => {
    reads++;
    return route.fulfill({json:{totalSessions:10, steps:{[first.id]:{reached:8,time:{median:100,p25:60,p75:120,count:6}}}}});
  });
  await page.goto(academyOrigin + '/expedities/visual/bewerken');
  const control = page.locator('#academy-outline-toggle input');
  await expect(control).toBeVisible();
  expect(reads).toBe(0);
  await control.check();
  const result = page.locator('.academy-builder-metric').first();
  await expect(result).toHaveText('1:40 · 80% bereikt');
  await page.reload();
  await expect(control).toBeChecked();
  await expect(result).toHaveText('1:40 · 80% bereikt');
  await control.uncheck();
  await expect(result).toHaveCount(0);
});

test('the author previews light and dark learner canvases independently of the workspace', async ({academyPage: page, academyOrigin}, testInfo) => {
  const { editorFixture } = require('./helpers/xped-editor');
  const { writes } = await editorFixture(page);
  await page.goto(academyOrigin + '/expedities/visual/bewerken');
  await page.locator('[role=tab][data-mode=preview]').click();
  const canvas = page.locator('#el-preview-container');
  const background = () => canvas.evaluate(node => getComputedStyle(node).backgroundColor);
  const appearance = page.getByRole('group', {name:'Voorbeeldweergave'});
  const light = appearance.getByRole('button', {name:'Licht'});
  const dark = appearance.getByRole('button', {name:'Donker'});
  await expect(light).toHaveAttribute('aria-pressed','true');
  const lightBackground = await background();
  const workspace = await page.evaluate(() => document.documentElement.dataset.theme);
  await dark.click();
  await expect(dark).toHaveAttribute('aria-pressed','true');
  const darkBackground = await background();
  expect(darkBackground).not.toBe(lightBackground);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(workspace);
  await testInfo.attach('dark-learner-preview', {body: await canvas.screenshot(),contentType:'image/png'});
  await page.reload();
  await page.locator('[role=tab][data-mode=preview]').click();
  await expect(dark).toHaveAttribute('aria-pressed','true');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await light.click();
  expect(await background()).toBe(lightBackground);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(writes).toHaveLength(0);
});

function explainedReport() {
  const data = reportData();
  data.summary.avgClarity = 4.2;
  data.summary.avgEngagement = 3.8;
  data.funnel.forEach((step, index) => Object.assign(step, { continued: [28, 22, 18][index], previousReached: [null, 40, 28][index] }));
  // Plan takes far less than its ten-minute estimate; a third station has too few timed sessions to compare.
  data.stations[1].time = quartiles(200, 150, 260, 12);
  data.stations.push({ moduleId: 'mod3', moduleTitle: loc('Short sample'), estimatedMinutes: 2, time: quartiles(900, 800, 1000, 3) });
  Object.assign(data.blockStats.easy, { correctAnswers: 8, gradedAnswers: 10 });
  Object.assign(data.blockStats.hard, { correctAnswers: 3, gradedAnswers: 10 });
  return data;
}

test('report figures carry their definitions, steps summarise on hover and focus, and time is compared with the estimate', async ({academyPage: page, academyOrigin}) => {
  const data = explainedReport();
  await page.route('**/api/elearning/expeditions/visual/responses*', route => route.fulfill({ json: data }));
  await page.goto(academyOrigin + '/expedities/visual/resultaten');

  const kpis = page.locator('#el-resp-kpis');
  const figure = name => kpis.locator('.el-split-figure').filter({ hasText: name });
  await expect(figure('Duidelijkheid').locator('.academy-metric-value')).toHaveText('4,2 / 5');
  await expect(figure('Betrokkenheid').locator('.academy-metric-value')).toHaveText('3,8 / 5');
  await expect(kpis).not.toContainText('inclusief pauzes');
  const median = figure('Mediane actieve tijd');
  const info = median.getByRole('button', { name: 'Uitleg bij Mediane actieve tijd' });
  await expect(median.locator('.academy-metric-definition')).toBeHidden();
  await expect(median.locator('.academy-metric-value')).toHaveAccessibleDescription(/middelste actieve tijd per sessie/);
  await info.click();
  await expect(info).toHaveAttribute('aria-expanded', 'true');
  await expect(median.locator('.academy-metric-definition')).toBeVisible();

  const funnel = page.locator('#el-resp-funnel');
  const explainer = funnel.getByRole('button', { name: 'Explainer', exact: true });
  const summary = funnel.locator('.academy-step-summary').nth(1);
  await expect(explainer).toHaveAccessibleDescription('Bereikt 28 · verder gegaan 22 · mediane actieve tijd 7:45 min');
  await expect(summary).toBeHidden();
  await explainer.hover();
  await expect(summary).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(summary).toBeHidden();
  await funnel.getByRole('button', { name: 'Question', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(explainer).toBeFocused();
  await expect(summary).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(summary).toBeHidden();

  const stations = page.locator('#el-resp-time details');
  await expect(stations.filter({ hasText: 'Opening' }).locator('.el-chart-flag')).toHaveText('+4:20 min langer dan geschat');
  await expect(stations.filter({ hasText: 'Plan' }).locator('.el-chart-flag')).toHaveText('−6:40 min korter dan geschat');
  await expect(stations.filter({ hasText: 'Short sample' }).locator('.el-chart-flag')).toHaveCount(0);

  const easy = page.locator('#el-resp-blocks > [data-step]').filter({ hasText: 'Mostly answered well' });
  await expect(easy.locator('.academy-answer-mix-text')).toHaveText('80% goed beantwoord · 8/10');
  const segments = easy.locator('.academy-answer-bar rect');
  await expect(segments).toHaveCount(2);
  await expect(segments.first()).toHaveAttribute('class', 'is-correct');
  await expect(segments.first()).toHaveAttribute('width', '80');
  await expect(segments.nth(1)).toHaveAttribute('class', 'is-other tone-0');
  await expect(easy.getByRole('button', { name: 'Stap bekijken' })).toBeVisible();
  await expect(page.locator('#el-resp-blocks > [data-step] h2').first()).toHaveText('Often misunderstood');
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('step summaries stay readable without hovering', async ({academyPage: page, academyOrigin}) => {
    const data = explainedReport();
    await page.route('**/api/elearning/expeditions/visual/responses*', route => route.fulfill({ json: data }));
    await page.goto(academyOrigin + '/expedities/visual/resultaten');
    const summary = page.locator('#el-resp-funnel .academy-step-summary').nth(1);
    await expect(summary).toBeVisible();
    await expect(summary).toHaveText('Bereikt 28 · verder gegaan 22 · mediane actieve tijd 7:45 min');
    await expect(page.locator('#el-resp-kpis .academy-metric-info').first()).toHaveCSS('width', '32px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
