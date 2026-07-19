const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

function workoutTemplateForBrowser() {
  return fs.readFileSync(path.resolve('templates/workout.html'), 'utf8')
    .split('\n')
    .filter((line) => !line.includes('firebasejs') && !line.includes("js/firebase-bootstrap.js") && !line.includes("js/auth-utils.js"))
    .join('\n')
    .replace(/\{\{\s*url_for\('static', filename='([^']+)'\)\s*\}\}/g, '/static/$1')
    .replace(/\{\{\s*url_for\('static', filename=workout_utils_js_asset or '([^']+)'\)\s*\}\}/g, '/static/$1')
    .replace(/\{\{\s*url_for\('static', filename=workout_js_asset or '([^']+)'\)\s*\}\}/g, '/static/$1');
}

function workoutBootstrapFixture() {
  const warmupDefaults = [{ percent: 40, reps: 10 }, { percent: 60, reps: 5 }, { percent: 80, reps: 3 }];
  const exercise = {
    id: 'exercise-1', name: 'Goblet squat', muscle_group: 'Quadriceps', equipment: 'Dumbbell',
    tracking_type: 'weight_reps', load_type: 'Dumbbell', default_rest_seconds: 90,
    pair_multiplier: 1, archived: false, seeded: true,
  };
  const profile = {
    revision: 1, bodyweight_kg: 63, handle_weight_kg: 2, optional_day_enabled: true,
    training_days: { A: 1, B: 3, C: 5, D: 6 }, start_tests: [],
    settings: {
      default_rest_seconds: 90, previous_values_scope: 'same_routine', rpe_enabled: true,
      warmup_sets_in_statistics: false, smart_superset_scrolling: true, keep_awake: false,
      live_pr_notifications: true, timer_sound: true, timer_volume: 0.75,
      rest_notifications: false, warmup_steps: warmupDefaults,
    },
  };
  return {
    seed: {
      start_tests: [], warmup_defaults: warmupDefaults,
      available_loads: { backpack_kg: [0, 5, 10], dumbbell_per_hand_kg: [0, 5, 10, 15] },
    },
    profile,
    exercises: [exercise],
    routines: [{ id: 'routine-1', name: 'Full body', archived: false, seeded: true, exercises: [{ exercise_id: exercise.id, sets: 3, rep_min: 8, rep_max: 12 }] }],
    cycles: [],
    active_cycle: { id: 'cycle-1', name: '10-week program', start_monday: '2026-07-13' },
    occurrences: [{ id: 'occurrence-1', week: 1, day: 'A', name: 'Full body', date: '2026-07-19', status: 'planned', phase: 'Build', optional: false, exercises: [{ exercise_id: exercise.id }] }],
    active_session: null,
    history: [],
    previous_values: {},
    bodyweight: [{ date: '2026-07-01', weight_kg: 63.2 }, { date: '2026-07-15', weight_kg: 62.7 }],
    shares: [],
    statistics: {
      summary: { adherence_percent: 67, completed_workouts: 2, optional_d_completed: 0, total_volume_kg: 4600, total_duration_seconds: 3600 },
      weekly: { '1': { target_sets: 3, completed_sets: 2, muscles: { Quadriceps: 2 } } },
      muscle_targets: [{ muscle_group: 'Quadriceps', weekly_sets: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3] }],
      exercise_history: { 'exercise-1': [{ name: 'Goblet squat', date: '2026-07-01', estimated_1rm: 20 }, { name: 'Goblet squat', date: '2026-07-15', estimated_1rm: 22 }] },
      bodyweight: [{ date: '2026-07-01', weight_kg: 63.2 }, { date: '2026-07-15', weight_kg: 62.7 }],
      records: {},
    },
    server_date: '2026-07-19',
  };
}

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
});

test('workout mobile shell fits iPhone 13 and keeps primary targets tappable', async ({ page, request }) => {
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body class="workout-body">
    <main class="workout-app">
      <header class="workout-topbar"><div><p class="workout-eyebrow">Private admin</p><h1>Workout</h1></div><button class="workout-icon-btn" aria-label="Back"></button></header>
      <section class="workout-view">
        <div class="workout-hero"><div><p class="workout-eyebrow">10-week program</p><h2>Week 1 · Build</h2><p>A/B/C build adherence. Day D stays optional.</p></div><div class="workout-week-ring"><strong>1</strong><span>week</span></div></div>
        <section class="workout-section"><div class="workout-section-head"><h2>Scheduled</h2></div><div class="workout-schedule"><article class="workout-schedule-card"><div class="workout-schedule-main"><div class="workout-day-badge"><strong>A</strong><span>Mon</span></div><div class="workout-schedule-copy"><strong>A · Pull + chest + quads</strong><small>7 exercises</small></div><button class="workout-start-btn">Start</button></div></article></div></section>
      </section>
      <nav class="workout-bottom-nav"><button class="is-active"><span>Today</span></button><button><span>Routines</span></button><button><span>Progress</span></button><button><span>Settings</span></button></nav>
    </main>
  </body></html>`);
  await page.addStyleTag({ path: path.resolve('static/css/workout.css') });

  const layout = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    startHeight: document.querySelector('.workout-start-btn').getBoundingClientRect().height,
    navHeight: document.querySelector('.workout-bottom-nav button').getBoundingClientRect().height,
    navBottom: Math.round(document.querySelector('.workout-bottom-nav').getBoundingClientRect().bottom),
  }));
  expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.startHeight).toBeGreaterThanOrEqual(44);
  expect(layout.navHeight).toBeGreaterThanOrEqual(44);
  expect(layout.navBottom).toBe(844);

  const manifestResponse = await request.get('/static/workout-manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({ id: '/admin/workout', start_url: '/admin/workout', scope: '/admin/workout', display: 'standalone', orientation: 'portrait' });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: '/static/icons/workout-icon-v2-192.png', sizes: '192x192', type: 'image/png' }),
    expect.objectContaining({ src: '/static/icons/workout-icon-v2-512.png', sizes: '512x512', type: 'image/png' }),
  ]));

  const touchIconResponse = await request.get('/static/icons/workout-touch-v2-180.png');
  expect(touchIconResponse.ok()).toBeTruthy();
  expect(touchIconResponse.headers()['content-type']).toContain('image/png');
});

test('real Workout template supports navigation, dialogs, progress, settings, and offline feedback', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const fixture = workoutBootstrapFixture();

  await page.addInitScript((bootstrapPayload) => {
    const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    window.LectureProcessorBootstrap = {
      getAuth: () => ({}),
      onAuthStateReady: (_auth, callback) => queueMicrotask(() => callback({ uid: 'workout-e2e-admin' })),
    };
    window.LectureProcessorAuth = {
      buildSignInUrl: () => '/lecture-notes?auth=signin&next=/admin/workout',
      createAuthClient: () => ({
        authFetch: async (url, options = {}) => {
          if (url === '/api/admin/workout/bootstrap') return jsonResponse(bootstrapPayload);
          if (url === '/api/admin/workout/profile' && options.method === 'PUT') {
            const body = JSON.parse(options.body || '{}');
            bootstrapPayload.profile = Object.assign({}, bootstrapPayload.profile, body, { revision: bootstrapPayload.profile.revision + 1 });
            return jsonResponse({ ok: true, profile: bootstrapPayload.profile });
          }
          return jsonResponse({ error: `Unexpected test request: ${url}` }, 404);
        },
      }),
    };
  }, fixture);

  await page.route('**/admin/workout', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: workoutTemplateForBrowser(),
  }));
  await page.route('**/admin/workout/service-worker.js', (route) => route.fulfill({ status: 404, body: '' }));

  await page.goto('/admin/workout');
  await expect(page.locator('#workout-loading')).toBeHidden();
  await expect(page.locator('#workout-view-today')).toBeVisible();
  await expect(page.locator('#workout-routine-count')).toHaveText('1 routine');

  const layout = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    minimumNavHeight: Math.min(...Array.from(document.querySelectorAll('.workout-bottom-nav button')).map((button) => button.getBoundingClientRect().height)),
  }));
  expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.minimumNavHeight).toBeGreaterThanOrEqual(44);

  await page.getByRole('button', { name: 'Routines', exact: true }).last().click();
  await expect(page.locator('#workout-view-routines')).toBeVisible();
  await page.locator('#workout-new-routine').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#workout-new-routine-name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#workout-new-routine')).toBeFocused();

  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect(page.locator('#workout-view-progress')).toBeVisible();
  await expect(page.locator('#workout-exercise-chart .workout-chart-summary')).toContainText('Minimum');
  await expect(page.locator('#workout-muscle-bars')).toContainText('Quadriceps');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#workout-sound-toggle').uncheck();
  await expect(page.locator('#workout-settings-form [type="submit"]')).toContainText('unsaved changes');
  await expect(page.locator('#workout-settings-form [type="submit"]')).toHaveClass(/is-sticky/);
  await page.locator('#workout-settings-form [type="submit"]').click();
  await expect(page.locator('#workout-settings-form [type="submit"]')).toHaveText('Save settings');
  await expect(page.locator('#workout-settings-form [type="submit"]')).not.toHaveClass(/is-sticky/);
  await page.locator('#workout-manage-shares').click();
  await expect(page.getByRole('dialog')).toContainText('no active shared links');
  await page.locator('#workout-sheet-close').click();

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.locator('#workout-offline-banner')).toBeVisible();
  await expect(page.locator('#workout-new-routine')).toBeDisabled();
  expect(browserErrors).toEqual([]);
});
