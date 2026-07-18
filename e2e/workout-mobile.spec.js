const { test, expect } = require('@playwright/test');
const path = require('path');

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

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
