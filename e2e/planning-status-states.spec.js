const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

async function installAccount(page) {
  const fixture = await installAccountFixture(page);
  // This suite verifies the served bundle too; the shared fixture serves source.
  await page.route(/\/static\/js\/batch-dashboard(?:\.min)?\.js(?:\?.*)?$/, route => route.continue());
  if (process.env.PLANNING_BASELINE_DIR) {
    await page.route(/\/static\/js\/(?:study-plan|batch-dashboard)(?:\.min)?\.js(?:\?.*)?$/, route => {
      const name = new URL(route.request().url()).pathname.split('/').pop().replace('.min.js', '.js');
      return route.fulfill({ contentType: 'application/javascript', path: path.join(process.env.PLANNING_BASELINE_DIR, name) });
    });
  }
  return fixture;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function pack(id, title) {
  return { study_pack_id: id, title, mode: 'study-pack', flashcards_count: 12, test_questions_count: 0,
    workload: { cards_remaining: 12, total_minutes: 20 } };
}

function plan(title = 'Accepted study goal', overrides = {}) {
  return {
    preferences: { timezone: 'UTC', availability: [], availability_configured: false,
      default_session_minutes: 45, reminder_offset_minutes: 30, revision: 1 },
    goals: [{ goal_id: 'goal', title, exam_date: '2099-01-01', pack_ids: ['base'], status: 'active', revision: 1 }],
    sessions: [], progress: { goals: [], due_cards: 0 },
    study_packs: [pack('base', 'Current study material')], calendar_feeds: [],
    pace: { card_minutes: 1, question_minutes: 2, personalized: false },
    ...overrides,
  };
}

async function settleRendering(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('rapid week navigation keeps the newest plan after an older response arrives', async ({ page }) => {
  const fixture = await installAccount(page);
  const earlier = deferred();
  let calls = 0;
  await page.route(/\/api\/study-plan\?/, async route => {
    const call = ++calls;
    if (call === 2) await earlier.promise;
    await route.fulfill({ json: plan(call === 2 ? 'Outdated week response' : call >= 3 ? 'Latest week response' : 'Initial plan') });
  });
  await page.goto('/plan?view=schedule');
  await expect(page.locator('#study-plan-workspace')).toBeVisible();
  await page.locator('#schedule-next-week').click();
  await expect.poll(() => calls).toBe(2);
  await page.locator('#schedule-next-week').click();
  await expect(page.locator('#goal-health-content')).toContainText('Latest week response');
  const olderResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/study-plan');
  earlier.resolve();
  await (await olderResponse).finished();
  await settleRendering(page);

  await expect(page.locator('#goal-health-content')).toContainText('Latest week response');
  await expect(page.locator('#goal-health-content')).not.toContainText('Outdated week response');
  expect(fixture.browserErrors).toEqual([]);
});

test('week navigation shares pending library pages and reuses the completed library', async ({ page }) => {
  const fixture = await installAccount(page);
  const library = deferred();
  let planCalls = 0;
  let libraryCalls = 0;
  await page.route(/\/api\/study-plan\?/, route => {
    planCalls++;
    return route.fulfill({ json: plan('Plan load ' + planCalls, { next_pack_cursor: 'older-materials' }) });
  });
  await page.route('**/api/study-plan/library?*', async route => {
    libraryCalls++;
    await library.promise;
    await route.fulfill({ json: { study_packs: [pack('older', 'Older study material')], next_cursor: '' } });
  });
  await page.goto('/plan?view=schedule');
  await expect.poll(() => libraryCalls).toBe(1);
  await page.locator('#schedule-next-week').click();
  await expect(page.locator('#goal-health-content')).toContainText('Plan load 2');
  await settleRendering(page);
  expect(libraryCalls).toBe(1);

  library.resolve();
  await page.locator('#new-study-goal-btn').click();
  await expect(page.locator('#wizard-pack-list')).toContainText('Older study material');
  await page.locator('#plan-wizard-close').click();
  await page.locator('#schedule-next-week').click();
  await expect(page.locator('#goal-health-content')).toContainText('Plan load 3');
  await page.locator('#new-study-goal-btn').click();
  await expect(page.locator('#wizard-pack-list')).toContainText('Older study material');
  expect(libraryCalls).toBe(1);
  expect(fixture.browserErrors).toEqual([]);
});

test('a delayed library page cannot leak materials into the next account', async ({ page }) => {
  const fixture = await installAccount(page);
  const oldLibrary = deferred();
  let libraryStarted = false;
  await page.route(/\/api\/study-plan\?/, route => {
    const owner = route.request().headers().authorization === 'Bearer token-b' ? 'b' : 'a';
    return route.fulfill({ json: plan('Account ' + owner, {
      study_packs: [pack(owner + '-base', owner === 'a' ? 'First account material' : 'Second account material')],
      next_pack_cursor: owner === 'a' ? 'a-private' : '',
    }) });
  });
  await page.route('**/api/study-plan/library?*', async route => {
    libraryStarted = true;
    await oldLibrary.promise;
    await route.fulfill({ json: { study_packs: [pack('a-private', 'Private first account material')], next_cursor: '' } });
  });
  await page.goto('/plan');
  await expect.poll(() => libraryStarted).toBe(true);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#goal-health-content')).toContainText('Account b');
  const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/study-plan/library');
  oldLibrary.resolve();
  await (await staleResponse).finished();
  await settleRendering(page);
  await page.locator('#new-study-goal-btn').click();

  await expect(page.locator('#wizard-pack-list')).toContainText('Second account material');
  await expect(page.locator('#wizard-pack-list')).not.toContainText('Private first account material');
  await expect(page.locator('#wizard-pack-list .wizard-pack-option')).toHaveCount(1);
  expect(fixture.browserErrors).toEqual([]);
});

async function installPlan(page, payload) {
  const fixture = await installAccount(page);
  await page.route(/\/api\/study-plan\?/, route => route.fulfill({ json: payload }));
  return fixture;
}

async function installBatches(page, entries) {
  const fixture = await installAccount(page);
  await page.route('**/api/batch/jobs?*', route => route.fulfill({ json: { batches: entries } }));
  return fixture;
}

const completedBatch = { batch_id: 'saved-batch', batch_title: 'Saved anatomy batch', mode: 'lecture-notes',
  processing_strategy: 'batch', status: 'complete', total_rows: 2, completed_rows: 2, failed_rows: 0,
  credits_charged: 2, credits_refunded: 0, created_at: 1794000000 };

test('an empty plan explains setup and hides actions that need an existing plan', async ({ page }) => {
  test.setTimeout(45000);
  const fixture = await installPlan(page, plan('', { goals: [], sessions: [] }));
  await page.goto('/plan');
  await expect(page.locator('#study-plan-workspace')).toBeVisible();

  await expect.soft(page.locator('#today-session-list')).not.toContainText('Your accepted plan');
  await expect.soft(page.locator('#clear-study-plan-btn')).toBeHidden();
  const labels = await page.locator('#new-study-goal-label, [data-setup-plan], [data-next-empty-action]').allTextContents();
  expect.soft(labels.length).toBeGreaterThan(1);
  expect.soft(labels.map(label => label.trim())).toEqual(labels.map(() => 'Set up my plan'));
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect.soft(page.locator('#schedule-goals-btn')).toBeHidden();
  await expect.soft(page.locator('#calendar-connections-btn')).toBeHidden();
  await expect.soft(page.locator('.empty-workspace-icon svg')).toBeVisible();
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect.soft(page.locator('#goal-progress-list [data-setup-plan]')).toHaveText('Set up my plan');
  expect(fixture.browserErrors).toEqual([]);
});

test('an established plan with no sessions today stays quiet and retains its management actions', async ({ page }) => {
  const fixture = await installPlan(page, plan());
  await page.goto('/plan');
  await expect(page.locator('#today-session-list')).toContainText('Your accepted plan');
  await expect(page.locator('#next-session-content')).toContainText('You are clear for now');
  await expect(page.locator('#clear-study-plan-btn')).toBeVisible();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.locator('#schedule-goals-btn')).toBeVisible();
  await expect(page.locator('#calendar-connections-btn')).toBeVisible();
  await expect(page.locator('.empty-workspace-panel')).toHaveCount(0);
  expect(fixture.browserErrors).toEqual([]);
});

test('a workspace without batches offers a clear creation action', async ({ page }) => {
  const fixture = await installBatches(page, []);
  await page.goto('/batch_status');
  const rows = page.locator('#batch-dashboard-rows');
  await expect(rows.getByRole('heading')).toHaveText('No batches yet');
  await expect(rows.getByRole('link', { name: /^(New batch|Start a batch)$/ })).toHaveAttribute('href', '/batch_mode');
  await expect(rows.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  expect(fixture.browserErrors).toEqual([]);
});

test('an empty batch view explains archived work instead of claiming filters have no matches', async ({ page }) => {
  const fixture = await installBatches(page, [{ ...completedBatch, archived: true }]);
  await page.goto('/batch_status');
  const rows = page.locator('#batch-dashboard-rows');
  await expect.soft(rows).not.toContainText('No matches');
  await expect.soft(rows).toContainText(/Archived batches:\s*1/i);
  await expect.soft(rows.getByRole('link', { name: /^(New batch|Start a batch)$/ })).toHaveAttribute('href', '/batch_mode');
  await expect.soft(rows.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await page.getByRole('button', { name: /Archived 1/ }).click();
  await expect(rows).toContainText('Saved anatomy batch');
  expect(fixture.browserErrors).toEqual([]);
});

test('a batch filter with no matches offers working filter recovery', async ({ page }) => {
  const fixture = await installBatches(page, [completedBatch]);
  await page.goto('/batch_status?mode=slides-only');
  const rows = page.locator('#batch-dashboard-rows');
  await expect(rows.getByRole('heading')).toHaveText('No matches');
  await expect(rows).toContainText(/filters/i);
  await rows.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(rows).toContainText('Saved anatomy batch');
  await expect(page.locator('#batch-dashboard-mode-filter')).toHaveValue('');
  expect(fixture.browserErrors).toEqual([]);
});

test('failed library pagination retries the unfinished page without downloading successful pages again', async ({ page }) => {
  const fixture = await installAccount(page);
  const cursors = [];
  await page.route(/\/api\/study-plan\?/, route => route.fulfill({ json: plan('Accepted study goal', { next_pack_cursor: 'page-one' }) }));
  await page.route('**/api/study-plan/library?*', route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    cursors.push(cursor);
    if (cursor === 'page-one') return route.fulfill({ json: { study_packs: [pack('older-one', 'First older material')], next_cursor: 'page-two' } });
    if (cursors.filter(value => value === 'page-two').length === 1) {
      return route.fulfill({ status: 503, json: { error: 'Synthetic temporary library outage' } });
    }
    return route.fulfill({ json: { study_packs: [pack('older-two', 'Second older material')], next_cursor: '' } });
  });
  await page.goto('/plan?view=schedule');
  await expect(page.locator('#study-plan-toast')).toContainText('Some older study packs could not be loaded');
  await page.locator('#new-study-goal-btn').click();
  await expect(page.locator('#wizard-pack-list')).toContainText('First older material');
  await page.locator('#plan-wizard-close').click();
  await page.locator('#schedule-next-week').click();
  await expect.poll(() => cursors.filter(value => value === 'page-two').length).toBe(2);
  await page.locator('#new-study-goal-btn').click();
  await expect(page.locator('#wizard-pack-list')).toContainText('First older material');
  await expect(page.locator('#wizard-pack-list')).toContainText('Second older material');
  expect(cursors).toEqual(['page-one', 'page-two', 'page-two']);
  expect(fixture.browserErrors).toEqual([]);
});

test('progress due counts state that they include all packs', async ({ page }) => {
  await installPlan(page, plan('Accepted study goal', { progress: { due_cards: 6, goals: [] } }));
  await page.goto('/plan?view=progress');
  await expect(page.getByText('6 due now · all packs', { exact: true })).toBeVisible();
  await expect(page.getByText('6 cards due · all packs', { exact: true })).toBeVisible();
});

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`planning empty states fit ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      const fixture = await installAccount(page);
      let currentPlan = plan('', { goals: [], sessions: [] });
      let batches = [];
      await page.route(/\/api\/study-plan\?/, route => route.fulfill({ json: currentPlan }));
      await page.route('**/api/batch/jobs?*', route => route.fulfill({ json: { batches } }));
      await page.setViewportSize({ width, height: 1000 });

      async function capture(name) {
        await page.evaluate(value => window.LPTheme.apply({ theme: value }), theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (name.startsWith('batch-')) {
          const alignment = await page.locator('#batch-dashboard-rows .bs-empty').evaluate(empty => {
            const bounds = empty.getBoundingClientRect();
            const controls = Array.from(empty.querySelectorAll('.bs-actions > a, .bs-actions > button'))
              .map(control => control.getBoundingClientRect());
            const left = Math.min(...controls.map(control => control.left));
            const right = Math.max(...controls.map(control => control.right));
            return { count: controls.length, offset: Math.abs((left + right) / 2 - (bounds.left + bounds.right) / 2) };
          });
          expect(alignment.count).toBeGreaterThan(0);
          expect(alignment.offset).toBeLessThanOrEqual(2);
        }
        await page.screenshot({ path: testInfo.outputPath(`${name}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      }

      await page.goto('/plan');
      await expect(page.locator('#study-plan-workspace')).toBeVisible();
      await capture('plan-empty-today');
      await page.getByRole('button', { name: 'Schedule', exact: true }).click();
      await expect(page.locator('.empty-workspace-panel')).toBeVisible();
      await capture('plan-empty-schedule');
      await page.getByRole('button', { name: 'Progress', exact: true }).click();
      await capture('plan-empty-progress');
      currentPlan = plan();
      await page.goto('/plan');
      await expect(page.locator('#goal-health-content')).toContainText('Accepted study goal');
      await capture('plan-quiet-today');

      await page.goto('/batch_status');
      await expect(page.locator('#batch-dashboard-rows h2')).toHaveText('No batches yet');
      await capture('batch-empty');
      batches = [{ ...completedBatch, archived: true }];
      await page.reload();
      await expect(page.locator('#batch-dashboard-rows')).toContainText('Archived batches:');
      await capture('batch-archived');
      batches = [completedBatch];
      await page.goto('/batch_status?mode=slides-only');
      await expect(page.locator('#batch-dashboard-rows h2')).toHaveText('No matches');
      await capture('batch-filter-empty');
      expect(fixture.browserErrors).toEqual([]);
    });
  }
}
