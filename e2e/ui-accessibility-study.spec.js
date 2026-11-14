const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');

async function installStudy(page) {
  const state = { creates: [], errors: [] };
  const pack = {
    study_pack_id: 'accessible', title: 'Accessible study pack', mode: 'manual', folder_id: '',
    notes_markdown: '# Circulation\n\nA steady heartbeat supports circulation.',
    flashcards_count: 2, test_questions_count: 0,
    flashcards: [{ front: 'First question', back: 'First definition' }, { front: 'Second question', back: 'Second definition' }],
    test_questions: [],
  };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => {
    const user = { uid: 'accessibility-study', getIdToken: () => Promise.resolve('fixture-token') };
    const auth = { currentUser: user, setPersistence: () => Promise.resolve(), authStateReady: () => Promise.resolve(),
      onAuthStateChanged: callback => { queueMicrotask(() => callback(user)); return () => {}; } };
    function factory() { return auth; }
    factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: factory };
    localStorage.setItem('lp-preferences', JSON.stringify({ language: 'en', theme: 'light' }));
  });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  if (process.env.UI_ACCESSIBILITY_SOURCE) {
    await page.route(/\/static\/js\/(study|ux-utils)\.min\.js(?:\?.*)?$/, route => {
      const name = new URL(route.request().url()).pathname.split('/').pop().replace('.min.js', '.js');
      return route.fulfill({ contentType: 'application/javascript', body: readFileSync(`static/js/${name}`, 'utf8') });
    });
  }
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let payload = {};
    if (path === '/api/auth/user') payload = { uid: 'accessibility-study', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/user-preferences') payload = { preferences: { interface_language: 'en', theme: 'light' } };
    else if (path === '/api/study-folders') payload = { folders: [] };
    else if (path === '/api/study-plan/membership') payload = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (path === '/api/study-packs') {
      if (request.method() === 'POST') state.creates.push(request.postDataJSON());
      payload = { study_packs: [pack], has_more: false };
    } else if (path === '/api/study-packs/accessible') {
      if (request.method() === 'PATCH') Object.assign(pack, request.postDataJSON());
      payload = pack;
    } else if (path.includes('study-progress')) payload = { card_states: {}, daily_progress: {} };
    await route.fulfill({ json: payload });
  });
  return state;
}

async function openSetup(page) {
  await page.goto('/study?pack_id=accessible&mode=learn');
  await expect(page.locator('#setup-overlay')).toBeVisible();
  await expect(page.locator('#setup-main-content')).toBeVisible();
}

async function openFlashcardList(page) {
  await openSetup(page);
  for (const lesson of ['flashcards', 'test', 'write', 'match', 'notes']) {
    const button = page.locator(`#lesson-card-${lesson}`);
    if (!await button.isVisible() || !await button.isEnabled()) continue;
    if ((await button.getAttribute('aria-pressed') === 'true') !== (lesson === 'flashcards')) await button.click();
  }
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-stage')).toBeVisible();
  await page.locator('#learn-f-list-btn').click();
  await expect(page.locator('[data-peek-index]')).toHaveCount(2);
}

for (const fallback of [false, true]) {
  test(`builder begins in the title input${fallback ? ' without the shared modal helper' : ''}`, async ({ page }) => {
    const state = await installStudy(page);
    await page.goto('/study?pack_id=accessible');
    await expect(page.locator('#pack-title')).toHaveValue('Accessible study pack');
    if (fallback) await page.evaluate(() => { window.LectureProcessorUx.openModalOverlay = undefined; });
    await page.locator('#create-pack-btn').click();
    await expect(page.locator('#builder-title-input')).toBeFocused();
    await page.keyboard.press('Enter');
    expect(state.creates).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

for (const key of ['Enter', 'Space']) {
  test(`flashcard definition button handles ${key} without activating its parent row`, async ({ page }) => {
    const state = await installStudy(page);
    await openFlashcardList(page);
    const secondRow = page.locator('[data-peek-index="1"]');
    await secondRow.locator('[data-peek-reveal]').press(key);
    await expect(secondRow.locator('[data-peek-hide]')).toBeVisible();
    await expect(page.locator('[data-peek-index="0"]')).toHaveClass(/active/);
    await secondRow.locator('[data-peek-hide]').press(key);
    await expect(secondRow.locator('[data-peek-reveal]')).toBeVisible();
    expect(state.errors).toEqual([]);
  });
}

test('the flashcard row itself remains keyboard activatable', async ({ page }) => {
  await installStudy(page);
  await openFlashcardList(page);
  await page.locator('[data-peek-index="1"]').press('Enter');
  await expect(page.locator('[data-peek-index="1"]')).toHaveClass(/active/);
});

test('highlight buttons expose their labels and current selection', async ({ page }) => {
  await installStudy(page);
  await page.goto('/study?pack_id=accessible');
  await expect(page.locator('#pack-title')).toHaveValue('Accessible study pack');
  await expect(page.getByRole('button', { name: 'Yellow highlight', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const color of ['green', 'eraser', 'yellow']) {
    await page.locator(`[data-hl-color="${color}"]`).click();
    await expect(page.locator('.hl-btn[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator(`[data-hl-color="${color}"]`)).toHaveAttribute('aria-pressed', 'true');
  }
});

test('algorithm presets expose selection and clear it when a slot changes', async ({ page }) => {
  await installStudy(page);
  await openSetup(page);
  await page.locator('#setup-tab-algorithm').click();
  await page.locator('.algo-preset[data-preset="random"]').click();
  await expect(page.locator('.algo-preset[data-preset="random"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.algo-preset[aria-pressed="true"]')).toHaveCount(1);
  await page.locator('.algo-slot').first().click();
  await expect(page.locator('.algo-preset[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('.algo-preset[aria-pressed="false"]')).toHaveCount(5);
});

for (const motion of ['reduce', 'no-preference']) {
  test(`new card and question scrolling honors ${motion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await installStudy(page);
    await page.addInitScript(() => {
      window.scrollRequests = [];
      Element.prototype.scrollIntoView = function (options) { window.scrollRequests.push(options); };
    });
    await page.goto('/study?pack_id=accessible');
    await expect(page.locator('#pack-title')).toHaveValue('Accessible study pack');
    await page.locator('#editor-tab-flashcards').click();
    await page.locator('#add-flashcard-btn').click();
    await page.locator('#editor-tab-test').click();
    await page.locator('#add-question-btn').click();
    await page.locator('#create-pack-btn').click();
    await page.locator('#builder-tab-flashcards').click();
    await page.locator('#builder-add-card-btn').click();
    await page.locator('#builder-tab-test').click();
    await page.locator('#builder-add-question-btn').click();
    const requests = await page.evaluate(() => window.scrollRequests.filter(options => options?.block === 'center'));
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(requests.every(options => options.behavior === (motion === 'reduce' ? 'auto' : 'smooth'))).toBe(true);
  });
}
