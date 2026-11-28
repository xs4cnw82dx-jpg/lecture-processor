const { test, expect } = require('@playwright/test');
const { editorFixture } = require('./helpers/xped-editor');

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

test('the report shows measured time, drop-off, weekly activity and keeps its filters in the address', async ({ page }) => {
  await editorFixture(page);
  const data = reportData();
  const requests = [];
  await page.route('**/visual/responses**', route => {
    if (route.request().resourceType() === 'document') return route.continue();
    requests.push(new URL(route.request().url()).search);
    return route.fulfill({ json: data });
  });
  await page.goto('/physio/elearning/visual/responses');

  const time = page.locator('#el-resp-time');
  await expect(time.getByRole('heading', { name: 'Time spent' })).toBeVisible();
  await expect(time.locator('.el-time-figures')).toContainText('Median active time15 min');
  await expect(time.locator('.el-time-figures')).toContainText('Middle half10–21 min');
  await expect(time.locator('.el-time-figures')).toContainText('Sessions with measured time30');
  const opening = time.locator('details').filter({ hasText: 'Opening' });
  await expect(opening.locator('.el-chart-flag')).toHaveText('longer than estimated');
  await expect(time.locator('details').filter({ hasText: 'Plan' }).locator('.el-chart-flag')).toHaveCount(0);
  await expect(opening.locator('.el-time-steps')).toBeHidden();
  await opening.locator('summary').click();
  await expect(opening.locator('.el-time-steps .el-chart-row').filter({ hasText: 'Explainer' })).toContainText('7:45 min');

  const reach = page.locator('#el-resp-funnel');
  await expect(reach.locator('.el-chart-row').filter({ hasText: 'Explainer' }).locator('.el-chart-drop')).toHaveText('−12 (−30%)');
  await expect(reach.locator('.el-chart-drop.is-largest')).toHaveCount(1);

  const trend = page.locator('#el-resp-trend');
  await expect(trend.getByRole('img')).toHaveAttribute('aria-label', '3 weeks: 40 sessions started, 22 completed.');
  await expect(trend.locator('table tbody tr')).toHaveCount(3);

  const cards = page.locator('#el-resp-blocks > article h2');
  await expect(cards).toHaveText(['Mostly answered well', 'Often misunderstood']);
  await page.getByRole('button', { name: 'Least often correct first' }).click();
  await expect(cards).toHaveText(['Often misunderstood', 'Mostly answered well']);
  await expect(page.getByRole('button', { name: 'Least often correct first' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: /Period/ }).click();
  await page.getByRole('option', { name: 'Last 30 days' }).click();
  await expect.poll(() => requests.at(-1)).toBe('?days=30');
  await expect(page).toHaveURL(/\/visual\/responses\?days=30$/);
  await page.reload();
  await expect.poll(() => requests.at(-1)).toBe('?days=30');
  await expect(page.getByRole('button', { name: /Period/ })).toContainText('Last 30 days');
});

test('a course without measured time says so instead of showing zero', async ({ page }) => {
  await editorFixture(page);
  const data = reportData();
  data.summary.timedSessions = 0;
  data.summary.activeSeconds = null;
  data.stations.forEach(station => { station.time = null; });
  data.funnel.forEach(row => { row.time = null; });
  data.weekly = [{ week: '2026-11-16', started: 40, completed: 22 }];
  await page.route('**/visual/responses**', route => (route.request().resourceType() === 'document'
    ? route.continue() : route.fulfill({ json: data })));
  await page.goto('/physio/elearning/visual/responses');
  await expect(page.locator('#el-resp-time')).toContainText('No measured time yet.');
  await expect(page.locator('#el-resp-time .el-time-figures')).toHaveCount(0);
  await expect(page.locator('#el-resp-kpis .el-split-stats')).toContainText('Median active time—');
  await expect(page.locator('#el-resp-trend')).toBeHidden();
});
