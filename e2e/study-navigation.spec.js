const { expectProductControls } = require('./helpers/control-audit');
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
test.beforeEach(async ({ page }) => {
  await page.route('**/static/js/study.min.js*', route => route.fulfill({ contentType: 'application/javascript', body: readFileSync('static/js/study.js', 'utf8') }));
});

async function installLibrary(page, options = {}) {
  const firebaseStub = `(function () {
    var user = { uid: 'owner', email: 'student@example.com', getIdToken: function () { return Promise.resolve('test-token'); } };
    var auth = { currentUser: user, setPersistence: function () { return Promise.resolve(); }, authStateReady: function () { return Promise.resolve(); }, onAuthStateChanged: function (callback) { setTimeout(function () { callback(user); }, 0); return function () {}; } };
    function factory() { return auth; } factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: function () { return {}; }, initializeApp: function () { return {}; }, auth: factory };
  })();`;
  await page.addInitScript({ content: firebaseStub });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: firebaseStub }));
  const folders = [{ folder_id: 'anatomy', name: 'Anatomy and physiology', parent_folder_id: '', is_pinned: false },
    { folder_id: 'muscles', name: 'Muscles of the lower limb', parent_folder_id: 'anatomy', is_pinned: false }];
  const packs = options.packs || [];
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/study-folders') body = { folders };
    else if (path === '/api/study-folders/anatomy' && request.method() === 'PATCH') {
      Object.assign(folders[0], request.postDataJSON());
      body = { ok: true, folder: folders[0] };
    } else if (path.endsWith('/share')) body = { access_scope: 'private', share_url: '' };
    else if (path === '/api/study-packs') body = { study_packs: packs, has_more: false };
    else if (path.startsWith('/api/study-packs/')) {
      const pack = packs.find(item => item.study_pack_id === path.split('/').pop());
      if (pack) {
        if (request.method() === 'PATCH') Object.assign(pack, request.postDataJSON());
        body = pack;
      }
    }
    else if (path === '/api/auth/user') body = { uid: 'owner', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (path.includes('progress')) body = { card_states: {}, daily_progress: {} };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}

for (const width of [320, 390, 1280]) {
  test(`folder names and actions remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installLibrary(page);
    await page.goto('/study');
    const folder = page.locator('#folder-list [data-folder-id="anatomy"]');
    const name = folder.locator('.item-title');
    await expect(name).toHaveText('Anatomy and physiology');
    await folder.scrollIntoViewIfNeeded();
    const nameBounds = await name.boundingBox();
    expect(nameBounds.width).toBeGreaterThan(100);
    expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(width);
    await expect(page.getByRole('button', { name: 'Create study pack', exact: true })).toBeVisible();
    const actions = folder.locator('summary');
    await actions.focus();
    await page.keyboard.press('Enter');
    for (const selector of ['[data-toggle-pin]', '[data-new-subfolder]', '[data-share-folder]', '[data-edit-folder]']) {
      const action = folder.locator(selector);
      await expect(action).toBeVisible();
      const bounds = await action.boundingBox();
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      if (width < 600) await expect.poll(async () => (await action.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    await folder.locator('[data-edit-folder]').click();
    await expect(page.locator('#folder-name-input')).toHaveValue('Anatomy and physiology');
    await page.locator('#folder-modal-close').click();
    await folder.locator('summary').click();
    await folder.locator('[data-new-subfolder]').click();
    await expect(page.locator('#folder-modal-title')).toHaveText('Create Folder');
    await expect(page.locator('#folder-name-input')).toHaveValue('');
    await page.locator('#folder-modal-close').click();
    await folder.locator('summary').click();
    await folder.locator('[data-share-folder]').click();
    await expect(page.locator('#share-modal-title')).toHaveText('Share Folder');
    await page.locator('#share-modal-close').click();
    await folder.locator('summary').click();
    await folder.locator('[data-toggle-pin]').click();
    await expect(folder.locator('.pinned-note')).toHaveText('Pinned');
    await folder.locator('summary').click();
    await expect(folder.locator('[data-toggle-pin]')).toHaveText('Unpin');
    await page.keyboard.press('Escape');
    await expect(folder.locator('details')).not.toHaveAttribute('open');
    await expect(folder.locator('summary')).toBeFocused();
  });
}

test('leaving the standalone builder updates the library heading and navigation', async ({ page }) => {
  await installLibrary(page);
  await page.goto('/study-pack-builder');
  await expect(page.locator('#builder-overlay')).toBeVisible();
  await page.locator('#builder-exit-btn').click();
  await expect(page.locator('#builder-overlay')).toBeHidden();
  await expect(page).toHaveURL(/\/study$/);
  await expect(page.locator('#study-page-heading')).toHaveText('Study Library');
  await expect(page.locator('.app-shell-title')).toHaveText('Study Library');
  await expect(page.locator('.app-shell-link[href="/study"]')).toHaveClass(/active/);
});

test('the overlay preview keeps its export aspect ratio at phone and desktop sizes', async ({ page }) => {
  await page.goto('/video-overlay-builder');
  await expect(page.locator('#overlay-stage')).toBeVisible();
  for (const width of [320, 390, 760, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => {
      const bounds = await page.locator('#overlay-stage').boundingBox();
      return Math.abs(bounds.width / bounds.height - 16 / 9);
    }).toBeLessThan(0.02);
  }
});

test('large packs create editors on demand and retain edits when switching tabs', async ({ page }) => {
  const pack = { study_pack_id: 'large', title: 'Large anatomy pack', mode: 'manual', notes_markdown: '# Anatomy notes',
    flashcards_count: 165, test_questions_count: 40,
    flashcards: Array.from({ length: 165 }, (_, index) => ({ front: `Muscle ${index}`, back: `Origin ${index}` })),
    test_questions: Array.from({ length: 40 }, (_, index) => ({ question: `Question ${index}`, options: ['A', 'B', 'C', 'D'], answer: 'A', explanation: 'Explanation' })) };
  const second = { study_pack_id: 'second', title: 'Second pack', mode: 'manual', notes_markdown: 'Other notes',
    flashcards_count: 1, test_questions_count: 0, flashcards: [{ front: 'Different card', back: 'Different answer' }], test_questions: [] };
  await installLibrary(page, { packs: [pack, second] });
  await page.goto('/study?pack_id=large');
  await expect(page.locator('#pack-title')).toHaveValue('Large anatomy pack');
  await expect(page.locator('#flashcard-editor-list .editor-card')).toHaveCount(0);
  await expect(page.locator('#question-editor-list .editor-card')).toHaveCount(0);
  await page.locator('#editor-tab-flashcards').click();
  await expect(page.locator('#flashcard-editor-list .editor-card')).toHaveCount(165);
  await expect(page.locator('#question-editor-list .editor-card')).toHaveCount(0);
  const firstCard = await page.locator('#editor-card-front-0').elementHandle();
  await page.locator('#editor-card-front-0').fill('Edited muscle');
  await page.locator('#editor-tab-test').click();
  await expect(page.locator('#question-editor-list .editor-card')).toHaveCount(40);
  await page.locator('#editor-question-text-0').fill('Edited question');
  await page.locator('#editor-tab-flashcards').click();
  await expect(page.locator('#editor-card-front-0')).toHaveValue('Edited muscle');
  expect(await firstCard.evaluate(node => node.isConnected)).toBe(true);
  await expect.poll(() => pack.flashcards[0].front).toBe('Edited muscle');
  await expect.poll(() => pack.test_questions[0].question).toBe('Edited question');
  await page.locator('#pack-list [data-pack-open]').filter({ hasText: 'Second pack' }).click();
  await expect(page.locator('#editor-card-front-0')).toHaveValue('Different card');
  await expect(page.locator('#flashcard-editor-list .editor-card')).toHaveCount(1);
  await expect(page.locator('#question-editor-list .editor-card')).toHaveCount(0);
});

test('redesigned learning workspace stays readable through library, setup and large builder', async ({ page }, testInfo) => {
  const pack = { study_pack_id: 'visual', title: 'Anatomy — movement and the lower limb', mode: 'manual', folder_id: 'anatomy', notes_markdown: '# How the lower limb moves\n\nMovement brings together muscles, joints and nerves. Build a clear picture before learning individual attachments.\n\n## A useful starting point\n\n- Identify the joint being crossed.\n- Follow the muscle from origin to insertion.\n- Explain the movement in your own words.\n\n### Active recall\n\nWhat changes when the muscle contracts?', flashcards_count: 165, test_questions_count: 40,
    flashcards: Array.from({ length: 165 }, (_, index) => ({ front: `Muscle ${index + 1}: explain its action and attachments`, back: 'Follow the muscle across the joint to understand its action.' })),
    test_questions: Array.from({ length: 40 }, (_, index) => ({ question: `Question ${index + 1}: which movement decreases the angle at a joint?`, options: ['Flexion', 'Extension', 'Rotation', 'Abduction'], answer: 'Flexion', explanation: 'Flexion decreases the angle.' })) };
  await installLibrary(page, { packs: [pack, { ...pack, study_pack_id: 'second', title: 'Neuroanatomy — pathways and clinical cases' }] });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/study?pack_id=visual');
  await expect(page.locator('#pack-summary-title')).toContainText('Anatomy');
  expect((await page.locator('.notes-view').boundingBox()).y).toBeLessThan(640);
  await expectProductControls(page);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('library-desktop.png'), fullPage: true });
  await page.locator('#open-learn-btn').click();
  await expect(page.locator('#setup-overlay')).toBeVisible();
  await expect(page.locator('#lesson-card-flashcards')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#lesson-card-test')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#lesson-card-write').click();
  await expect(page.locator('#lesson-card-write')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#lesson-card-flashcards')).toHaveAttribute('aria-pressed', 'true');
  await expectProductControls(page);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('study-setup.png') });
  await page.locator('#setup-close-btn').click();
  await page.locator('#open-builder-btn').click();
  await page.locator('[data-builder-pane="flashcards"]').click();
  await expect(page.locator('#builder-flashcard-list details')).toHaveCount(165);
  await expect(page.locator('#builder-flashcard-list details[open]')).toHaveCount(1);
  await expectProductControls(page);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('builder-desktop.png') });
  await page.locator('#builder-flashcard-list details').nth(164).locator('summary').click();
  await page.locator('#builder-fc-front-164').fill('Edited final flashcard');
  await expect(page.locator('#builder-fc-front-164')).toHaveValue('Edited final flashcard');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#builder-flashcard-list details').first().scrollIntoViewIfNeeded();
  await expectProductControls(page);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('builder-mobile.png') });
  expect(await page.locator('#builder-overlay').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});
