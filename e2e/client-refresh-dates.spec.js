const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

async function serveSources(page) {
  await page.route(/\/static\/js\/(index-app|workout|workout-utils)(\.min)?\.js(?:\?.*)?$/, route => {
    const name = new URL(route.request().url()).pathname.split('/').pop().replace('.min.js', '.js');
    const source = process.env.CLIENT_REFRESH_DATE_SOURCE_DIR
      ? path.join(process.env.CLIENT_REFRESH_DATE_SOURCE_DIR, name)
      : path.resolve('static/js', process.env.CLIENT_REFRESH_DATE_MINIFIED ? name.replace('.js', '.min.js') : name);
    return route.fulfill({ contentType: 'application/javascript', path: source });
  });
}

function workoutTemplate() {
  const preferencesHead = fs.readFileSync(path.resolve('templates/_preferences_head.html'), 'utf8').replace(/\{#[\s\S]*?#\}/g, '');
  return fs.readFileSync(path.resolve('templates/workout.html'), 'utf8')
    .replace(/\{% include '_preferences_head.html' %\}/g, preferencesHead)
    .replace(/\{\{\s*url_for\('static', filename=(?:workout(?:_utils)?_js_asset or )?'([^']+)'\)\s*\}\}/g, '/static/$1');
}

async function installWorkout(page, scenario, activeCycle = true) {
  const fixture = await installAccountFixture(page);
  await serveSources(page);
  await page.clock.setFixedTime(new Date(scenario.instant));
  const payload = {
    seed: { start_tests: [], warmup_defaults: [], available_loads: { backpack_kg: [0, 5], dumbbell_per_hand_kg: [0, 5] } },
    profile: {
      revision: 1, bodyweight_kg: 65, handle_weight_kg: 2, optional_day_enabled: false,
      training_days: { A: 1, B: 3, C: 5, D: 6 }, start_tests: [],
      settings: { default_rest_seconds: 90, timer_volume: 0.75, warmup_steps: [] },
    },
    exercises: [], routines: [], cycles: [], active_session: null,
    active_cycle: activeCycle ? { id: 'synthetic-cycle', name: 'Example cycle', start_monday: scenario.monday } : null,
    occurrences: scenario.dates.map(date => ({
      id: 'day-' + date, week: 1, day: 'A', name: 'Workout ' + date, date, status: 'planned',
      phase: 'Build', optional: false, exercises: [],
    })),
    history: [], previous_values: {}, bodyweight: [], shares: [],
    statistics: { summary: {}, weekly: {}, muscle_targets: [], exercise_history: {}, bodyweight: [], records: {} },
  };
  const savedWeights = [];
  await page.route('**/admin/workout', route => route.fulfill({ contentType: 'text/html', body: workoutTemplate() }));
  await page.route('**/api/admin/workout/bootstrap', route => route.fulfill({ json: payload }));
  await page.route('**/api/admin/workout/statistics', route => route.fulfill({ json: payload.statistics }));
  await page.route('**/api/admin/workout/bodyweight', route => {
    const entry = route.request().postDataJSON();
    savedWeights.push(entry);
    return route.fulfill({ json: { entry, profile: payload.profile } });
  });
  await page.goto('/admin/workout');
  await expect(page.locator('#workout-loading')).toBeHidden();
  return { ...fixture, savedWeights };
}

const scenarios = [
  {
    name: 'Amsterdam shortly after midnight', zone: 'Europe/Amsterdam', instant: '2026-07-13T22:30:00Z',
    today: '2026-07-14', monday: '2026-07-13', dates: ['2026-07-13', '2026-07-14', '2026-07-15'],
  },
  {
    name: 'Los Angeles shortly before midnight', zone: 'America/Los_Angeles', instant: '2026-07-14T06:30:00Z',
    today: '2026-07-13', monday: '2026-07-13', dates: ['2026-07-13', '2026-07-14', '2026-07-15'],
  },
  {
    name: 'Amsterdam at midday', zone: 'Europe/Amsterdam', instant: '2026-07-15T12:00:00Z',
    today: '2026-07-15', monday: '2026-07-13', dates: ['2026-07-14', '2026-07-15', '2026-07-16'],
  },
];

for (const scenario of scenarios) {
  test.describe(scenario.name, () => {
    test.use({ timezoneId: scenario.zone });

    test('bodyweight entry defaults to and saves the local calendar date', async ({ page }, testInfo) => {
      const fixture = await installWorkout(page, scenario);
      await page.locator('[data-workout-nav="progress"]').click();
      await page.locator('#workout-add-weight').click();
      await expect(page.locator('#workout-weight-date')).toHaveValue(scenario.today);
      if (scenario === scenarios[0]) {
        await expect.poll(() => page.evaluate(() => window.LecturePreferences.get().ready)).toBe(true);
        for (const width of [1440, 375]) {
          await page.setViewportSize({ width, height: 900 });
          for (const theme of ['light', 'dark']) {
            await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.screenshot({ path: testInfo.outputPath(`workout-bodyweight-${theme}-${width}.png`), animations: 'disabled' });
          }
        }
      }
      await page.getByRole('button', { name: 'Save entry', exact: true }).click();
      await expect(page.locator('#workout-toast')).toHaveText('Bodyweight saved.');
      expect(fixture.savedWeights).toEqual([{ date: scenario.today, weight_kg: 65 }]);
      expect(fixture.browserErrors).toEqual([]);
    });

    test('new calendar starts on this local Monday', async ({ page }) => {
      const fixture = await installWorkout(page, scenario, false);
      await page.getByRole('button', { name: 'Set up 10-week calendar', exact: true }).click();
      await expect(page.locator('#workout-cycle-start')).toHaveValue(scenario.monday);
      expect(fixture.browserErrors).toEqual([]);
    });

    test('next workout is selected using the local calendar date', async ({ page }) => {
      const fixture = await installWorkout(page, scenario);
      await expect(page.locator('.workout-schedule-card.is-next')).toContainText('Workout ' + scenario.today);
      expect(fixture.browserErrors).toEqual([]);
    });
  });
}

test('an idle creation page does not force token refresh and later requests still acquire a token', async ({ page }) => {
  const fixture = await installAccountFixture(page);
  await serveSources(page);
  await page.clock.install({ time: new Date('2026-07-14T12:00:00Z') });
  await page.route('**/api/verify-email', route => route.fulfill({ json: { allowed: true } }));
  const profileHeaders = [];
  await page.route('**/api/auth/user', route => {
    profileHeaders.push(route.request().headers().authorization);
    return route.fulfill({ json: {
      credits: { lecture_standard: 5, lecture_extended: 0, slides: 2, interview_short: 1, interview_medium: 0, interview_long: 0 },
      preferences: { onboarding_completed: true },
    } });
  });
  await page.goto('/lecture-notes');
  await page.clock.runFor(1);
  await expect(page.locator('#shell-account')).toBeVisible();
  await expect.poll(() => profileHeaders.length).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    window.testForcedTokenCalls = 0;
    window.testRequestTokenCalls = 0;
    window.testAccount.currentUser.getIdToken = force => {
      if (force) {
        window.testForcedTokenCalls += 1;
        return Promise.reject(new Error('Synthetic token refresh outage'));
      }
      window.testRequestTokenCalls += 1;
      return Promise.resolve('synthetic-fresh-request-token');
    };
  });
  await page.clock.runFor(10 * 60 * 1000 + 50);
  expect.soft(await page.evaluate(() => window.testForcedTokenCalls)).toBe(0);
  expect(fixture.browserErrors).toEqual([]);
  const callsBefore = await page.evaluate(() => window.testRequestTokenCalls);
  expect(await page.evaluate(async () => (await window.authenticatedFetch('/api/auth/user')).ok)).toBe(true);
  expect(await page.evaluate(() => window.testRequestTokenCalls)).toBeGreaterThan(callsBefore);
  expect(profileHeaders.at(-1)).toBe('Bearer synthetic-fresh-request-token');
});
