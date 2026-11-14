const { test, expect } = require('@playwright/test');

async function isolate(page, { signedIn = true, packs = 24 } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.addInitScript(({ signedIn }) => {
    const user = signedIn ? { uid: 'shell-fixture', email: 'shell@example.test', getIdToken: () => Promise.resolve('synthetic-token') } : null;
    const auth = { currentUser: user, setPersistence: () => Promise.resolve(), authStateReady: () => Promise.resolve(),
      onAuthStateChanged: callback => { queueMicrotask(() => callback(user)); return () => {}; } };
    function factory() { return auth; }
    factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: factory };
    localStorage.setItem('lp-preferences', JSON.stringify({ language: 'en', theme: 'light' }));
  }, { signedIn });
  const studyPacks = Array.from({ length: packs }, (_, index) => ({
    study_pack_id: `synthetic-pack-${index}`, title: `Synthetic study pack ${index + 1}`,
    mode: 'study-pack', flashcards_count: 20, test_questions_count: 10,
    folder_id: '', in_plan: false, workload: { cards_remaining: 20, total_minutes: 40 },
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path === '/api/auth/user') json = { uid: 'shell-fixture', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/user-preferences') json = { preferences: { interface_language: 'en', theme: 'light' } };
    else if (path === '/api/study-plan') json = {
      preferences: { timezone: 'UTC', availability: [], availability_configured: false, default_session_minutes: 45, revision: 1 },
      goals: [], sessions: [], study_packs: studyPacks, calendar_feeds: [], progress: {},
      pace: { card_minutes: 1, question_minutes: 2, personalized: false },
    };
    else if (path === '/api/study-packs') json = { study_packs: studyPacks, has_more: false };
    else if (path === '/api/study-folders') json = { folders: [] };
    else if (path === '/api/study-plan/membership') json = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') json = { jobs: [] };
    else if (path === '/api/books') json = { books: [] };
    return route.fulfill({ json });
  });
}

const routes = [
  '/', '/features', '/helpcenter', '/FAQ', '/privacy', '/terms', '/dashboard', '/study',
  '/plan', '/stats', '/settings', '/calendar', '/lecture-notes', '/tools', '/voice-notes',
  '/document-reader', '/lecture-downloader', '/general-transcriber', '/batch_mode', '/batch_status',
  '/buy_credits', '/physio', '/admin', '/admin/workout', '/workout-shares/synthetic',
  '/shared/synthetic', '/books', '/video-overlay-builder', '/synthetic-missing-page',
];

for (const path of routes) {
  test(`shared font and one focusable main landmark: ${path}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    const page = await context.newPage();
    try {
      await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
      await page.goto(path);
      expect(await page.locator('main').count()).toBe(1);
      expect(await page.locator('main').getAttribute('id')).toBe('main-content');
      expect(await page.locator('main').getAttribute('tabindex')).toBe('-1');
      const fontLinks = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links
        .filter(link => link.href.includes('fonts.googleapis.com') && new URL(link.href).searchParams.getAll('family').some(family => family.startsWith('Inter:')))
        .map(link => link.href));
      expect(fontLinks).toHaveLength(1);
      expect(await page.locator('a.skip-link[href="#main-content"]').count()).toBe(1);
    } finally {
      await context.close();
    }
  });
}

for (const path of ['/features', '/dashboard', '/admin']) {
  test(`first Tab reveals skip link and Enter focuses content: ${path}`, async ({ page }) => {
    await isolate(page);
    await page.goto(path);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });
}

test('sidebar container stays out of Tab order on desktop and open mobile navigation', async ({ page }) => {
  await isolate(page);
  await page.goto('/dashboard');
  const sidebar = page.locator('#app-shell-sidebar');
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
  await expect(sidebar).not.toHaveAttribute('tabindex');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toHaveAttribute('tabindex', '-1');
  await expect(sidebar).toHaveAttribute('inert', '');
  await page.locator('#app-shell-menu-btn').click();
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
  await expect(sidebar).not.toHaveAttribute('tabindex');
  await expect(sidebar.locator('a').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sidebar).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('#app-shell-menu-btn')).toBeFocused();
});

for (const width of [390, 1280]) {
  test(`empty wizard selection stays visible beside Continue at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await isolate(page);
    await page.goto('/plan');
    await page.locator('#new-study-goal-btn').click();
    await expect(page.locator('#wizard-pack-list .wizard-pack-option')).toHaveCount(24);
    await page.locator('#wizard-next-btn').click();
    const error = page.locator('#wizard-pack-error');
    await expect(error).toBeVisible();
    await expect(error).toBeInViewport();
    await expect(error).toHaveAttribute('tabindex', '-1');
    expect(await error.evaluate(node => !!node.closest('.wizard-footer'))).toBe(true);
    const errorBox = await error.boundingBox();
    const continueBox = await page.locator('#wizard-next-btn').boundingBox();
    expect(Math.abs(errorBox.y - continueBox.y)).toBeLessThan(100);
    await error.focus();
    await expect(error).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`wizard-${width}.png`), fullPage: true });
  });
}

test('highlight swatches have accessible initial selection and notes has a check indicator', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    await page.goto('/study');
    for (const color of ['yellow', 'green', 'blue', 'pink']) {
      const swatch = page.locator(`[data-hl-color="${color}"]`);
      expect(await swatch.getAttribute('aria-label')).toBe(`${color[0].toUpperCase()}${color.slice(1)} highlight`);
      expect(await swatch.getAttribute('aria-pressed')).toBe(color === 'yellow' ? 'true' : 'false');
    }
    expect(await page.locator('#lesson-card-notes .lesson-card-check svg').count()).toBe(1);
  } finally {
    await context.close();
  }
});

test('Books keeps shelf scrolling and editor viewport after adding its landmark', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await isolate(page, { signedIn: false });
  await page.goto('/books');
  const shelf = page.locator('#library');
  await expect(shelf).toBeVisible();
  const shelfBox = await shelf.boundingBox();
  expect(Math.round(shelfBox.height)).toBe(830);
  expect(await shelf.evaluate(node => getComputedStyle(node).overflowY)).toBe('auto');
  await page.getByRole('button', { name: '＋ New book', exact: true }).click();
  await page.getByRole('button', { name: 'Picture book A little room for a big adventure.', exact: true }).click();
  const workspace = page.locator('#workspace');
  await expect(workspace).toBeVisible();
  await expect(page.locator('#save-state')).toHaveText('Saved on this device');
  await expect(page.locator('#book-dialog')).not.toBeVisible();
  const box = await workspace.boundingBox();
  expect(Math.round(box.height)).toBe(830);
  expect(box.y + box.height).toBeLessThanOrEqual(901);
  expect(await page.locator('body').evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(1280);
  await page.screenshot({ path: testInfo.outputPath('books-workspace.png'), fullPage: true });
});
