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
      { moduleId: 'mod1', moduleTitle: loc('Opening'), estimatedMinutes: 5, time: quartiles(560, 400, 700, 30) },
      { moduleId: 'mod2', moduleTitle: loc('Plan'), estimatedMinutes: 10, time: quartiles(300, 200, 420, 12) },
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
    data.funnel.forEach((step,index) => Object.assign(step,{continued:[28,22,18][index],lostFromPrevious:[null,12,6][index],
      previousReached:[null,40,28][index],gradedAnswers:10,correctAnswers:3,comments:index}));
    data.stations.forEach((station,index) => Object.assign(station,{reached:index?22:40,continued:index?18:22,lost:index?4:18,
      correctAnswers:11,gradedAnswers:20,comments:2}));
    Object.assign(data.blockStats.easy,{correctAnswers:8,gradedAnswers:10});
    Object.assign(data.blockStats.hard,{correctAnswers:3,gradedAnswers:10});
    data.weekly[1].revision={revision:4,at:1794182400};
    const requests=[];
    await page.route('**/api/elearning/expeditions/visual/responses*', route=>{
      requests.push(new URL(route.request().url()).search);
      return route.fulfill({json:data});
    });
    await page.goto(academyOrigin + '/expedities/visual/resultaten');
    const time = page.locator('#el-resp-time');
    await expect(time.getByRole('heading',{name:'Tijdsbesteding'})).toBeVisible();
    await expect(time.locator('.el-time-figures')).toContainText('15 min');
    const opening = time.locator('details').filter({hasText:'Opening'});
    await opening.locator('summary').click();
    await expect(opening.locator('.el-time-steps')).toContainText('7:45');
    const funnel = page.locator('#el-resp-funnel');
    await expect(funnel.locator('.el-chart-row').filter({hasText:'Explainer'})).toContainText('−12');
    await funnel.getByRole('button',{name:'Explainer'}).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading',{name:'Explainer'})).toBeVisible();
    await expect(drawer.locator('[data-detail-edit]')).toHaveAttribute('href',/bewerken\?step=s2/);
    await drawer.locator('[data-detail-next]').click();
    await expect(drawer.getByRole('heading',{name:'My plan'})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    const stations = page.locator('#academy-station-report');
    await stations.getByRole('button',{name:'Opening',exact:true}).click();
    await expect(stations.getByRole('button',{name:'Question',exact:true})).toBeVisible();
    await stations.getByRole('button',{name:'Bereikt',exact:true}).click();
    await expect(stations.locator('th[aria-sort]')).toHaveText('Bereikt');
    const trend = page.locator('#el-resp-trend');
    await trend.locator('summary').click();
    await expect(trend.getByRole('table')).toContainText('v4');
    await expect(page.locator('#el-resp-blocks > [data-step]').first()).toContainText('Often misunderstood');
    await page.locator('#el-resp-period').selectOption('7',{force:true});
    await expect(page).toHaveURL(/days=7/);
    expect(requests.some(query=>query.includes('days=7'))).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await testInfo.attach('academy-report-'+size.width,{body:await page.screenshot(),contentType:'image/png'});
  });
}
