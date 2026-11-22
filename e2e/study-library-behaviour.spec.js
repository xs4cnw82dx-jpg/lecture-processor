const { test, expect } = require('@playwright/test');
const { withContentRevision } = require('./helpers/study-revision-fixture');
const { accessibilityProblems, reachableControlsInside } = require('./helpers/a11y-audit');

// Behaviour checks for Study Library (replacing source-text assertions).
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
  const requests = [];
  const progressUploads = [];
  const createdPacks = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname + new URL(request.url()).search); });
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/study-folders') body = { folders };
    else if (path === '/api/study-folders/anatomy' && request.method() === 'PATCH') {
      Object.assign(folders[0], request.postDataJSON());
      body = { ok: true, folder: folders[0] };
    } else if (path.endsWith('/share')) body = { access_scope: 'private', share_url: '' };
    else if (path === '/api/study-packs' && request.method() === 'POST') {
      const created = { ...request.postDataJSON(), study_pack_id: 'imported_' + (createdPacks.length + 1), mode: 'manual' };
      createdPacks.push(created);
      packs.push({ ...created, flashcards_count: created.flashcards.length, test_questions_count: created.test_questions.length });
      body = { ok: true, study_pack_id: created.study_pack_id };
    }
    else if (path === '/api/study-packs') {
      const cursor = new URL(request.url()).searchParams.get('after') || '';
      body = options.pages ? options.pages[cursor] : { study_packs: packs, has_more: false };
    }
    else if (path.startsWith('/api/study-packs/')) {
      const pack = packs.find(item => item.study_pack_id === path.split('/').pop());
      if (pack) {
        if (request.method() === 'PATCH') Object.assign(pack, request.postDataJSON());
        body = withContentRevision(pack);
      }
    }
    else if (path === '/api/auth/user') body = { uid: 'owner', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (path === '/api/study-progress' && request.method() === 'PUT') {
      progressUploads.push(request.postDataJSON());
      body = { ok: true };
    }
    else if (path.includes('progress')) body = { card_states: {}, daily_progress: {} };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { requests, progressUploads, createdPacks };
}

const card = (front, back) => ({ front, back });
const pack = (id, extra = {}) => ({ study_pack_id: id, title: 'Pack ' + id, mode: 'manual', notes_markdown: 'Notes for ' + id,
  flashcards: [card('Hip abductor?', 'Gluteus medius')], flashcards_count: 1, test_questions: [], test_questions_count: 0, ...extra });

test('first load asks for the progress summary and folders without pending packs', async ({ page }) => {
  const { requests } = await installLibrary(page, { packs: [pack('a')] });
  await page.goto('/study');
  await expect(page.locator('#pack-list .pack-list-item')).toHaveCount(1);
  expect(requests).toContain('/api/study-progress/summary');
  expect(requests).toContain('/api/study-folders?include_pending=0');
});

test('a voice-notes folder link opens Study Library on that folder', async ({ page }) => {
  await installLibrary(page, { packs: [pack('a')] });
  await page.goto('/study?folder=voice-notes');
  await expect(page.locator('#folder-list .item.active')).toContainText('Voice Notes');
});

test('the pack list loads further pages on request and keeps earlier packs', async ({ page }) => {
  const pages = {
    '': { study_packs: [pack('a'), pack('b')], has_more: true, next_cursor: 'next' },
    next: { study_packs: [pack('c')], has_more: false, next_cursor: '' },
  };
  const { requests } = await installLibrary(page, { pages });
  await page.goto('/study');
  await expect(page.locator('#pack-list .pack-list-item')).toHaveCount(2);
  await page.locator('#load-more-packs-btn').click();
  await expect(page.locator('#pack-list .pack-list-item')).toHaveCount(3);
  expect(requests.some(url => url.startsWith('/api/study-packs?') && url.includes('after=next'))).toBe(true);
  await expect(page.locator('#pack-list-actions')).toBeHidden();
});

test('a question-only pack opens on its practice test', async ({ page }) => {
  const questionsOnly = pack('q', { flashcards: [], flashcards_count: 0, notes_markdown: '',
    test_questions: [{ question: 'Which nerve?', options: ['Femoral', 'Sciatic', 'Tibial', 'Ulnar'], answer: 'Femoral', explanation: '' }], test_questions_count: 1 });
  await installLibrary(page, { packs: [questionsOnly] });
  await page.goto('/study?pack_id=q');
  await expect(page.locator('#editor-tab-test')).toHaveAttribute('aria-selected', 'true');
});

test('editor tabs move with the arrow keys and editor fields are labelled', async ({ page }) => {
  const withQuestion = pack('t', { test_questions: [{ question: 'Which nerve?', options: ['Femoral', 'Sciatic', 'Tibial', 'Ulnar'], answer: 'Femoral', explanation: '' }], test_questions_count: 1 });
  await installLibrary(page, { packs: [withQuestion] });
  await page.goto('/study?pack_id=t');
  await page.locator('#editor-tab-notes').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#editor-tab-flashcards')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#editor-tab-flashcards')).toBeFocused();
  await page.locator('#flashcard-editor-list .editor-card > summary').first().click();
  await expect(page.getByLabel('Front', { exact: true })).toHaveValue('Hip abductor?');
  await expect(page.getByLabel('Back', { exact: true })).toHaveValue('Gluteus medius');
  await page.locator('#editor-tab-test').click();
  await page.locator('#question-editor-list .editor-card > summary').first().click();
  for (const label of ['Question', 'Option A', 'Option B', 'Explanation']) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
});

test('typing a practice-test option updates the answer picker without rebuilding the editor', async ({ page }) => {
  const withQuestion = pack('o', { test_questions: [{ question: 'Which nerve?', options: ['Femoral', 'Sciatic', 'Tibial', 'Ulnar'], answer: 'Femoral', explanation: '' }], test_questions_count: 1 });
  await installLibrary(page, { packs: [withQuestion] });
  await page.goto('/study?pack_id=o');
  await page.locator('#editor-tab-test').click();
  await page.locator('#question-editor-list .editor-card > summary').first().click();
  const option = page.getByLabel('Option A', { exact: true });
  const handle = await option.elementHandle();
  await option.fill('Femoral nerve');
  await expect(option).toBeFocused();
  expect(await handle.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.locator('#question-editor-list [data-answer-button] .app-select-label').first()).toContainText('Femoral nerve');
});

test('Add to Study Plan hands the open pack to the planner', async ({ page }) => {
  await installLibrary(page, { packs: [pack('a')] });
  await page.route('**/plan?*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Plan</title>' }));
  await page.goto('/study?pack_id=a');
  await page.locator('#add-pack-to-plan-btn').click();
  await page.waitForURL(/\/plan\?add_packs=a/);
});

test('loading Study uploads no progress and one answer uploads only that pack', async ({ page }) => {
  const { progressUploads } = await installLibrary(page, { packs: [pack('a'), pack('b')] });
  await page.addInitScript(() => {
    localStorage.setItem('card_state_owner_b', JSON.stringify({ fc_0: { interval_days: 3, due_date: '2030-01-01', reviews: 2 } }));
  });
  await page.clock.install();
  await page.goto('/study');
  await expect(page.locator('#pack-list .pack-list-item')).toHaveCount(2);
  // Progress uploads are debounced; run well past the debounce before checking none was sent.
  await page.clock.runFor(5000);
  expect(progressUploads).toEqual([]);

  await page.locator('#pack-list .pack-list-item', { hasText: 'Pack a' }).click();
  await page.locator('#open-learn-btn').click();
  for (const lesson of await page.locator('.lesson-card[data-lesson]').all()) {
    if (await lesson.getAttribute('aria-disabled') === 'true') continue;
    const selected = await lesson.getAttribute('aria-pressed') === 'true';
    if (selected !== (await lesson.getAttribute('data-lesson') === 'flashcards')) await lesson.click();
  }
  await page.locator('#setup-start-btn').click();
  await page.locator('#learn-f-flip').click();
  await page.locator('[data-review-action="good"]').click();
  await page.clock.runFor(5000);
  await expect.poll(() => progressUploads.length).toBeGreaterThan(0);
  for (const upload of progressUploads) expect(Object.keys(upload.card_states)).toEqual(['a']);
});

test('importing several CSV files creates one saved pack per file and detects practice tests', async ({ page }) => {
  const { createdPacks } = await installLibrary(page, { packs: [pack('a')] });
  await page.goto('/study');
  await expect(page.locator('#pack-list .pack-list-item')).toHaveCount(1);
  await page.locator('#import-pack-csv-btn').click();
  await expect(page.locator('#builder-overlay')).toHaveClass(/visible/);
  await page.locator('#builder-csv-input').setInputFiles([
    { name: 'Hip muscles.csv', mimeType: 'text/csv', buffer: Buffer.from('front,back\nHip abductor?,Gluteus medius\nHip flexor?,Iliopsoas\n') },
    { name: 'Nerves quiz.csv', mimeType: 'text/csv',
      buffer: Buffer.from('question,option_a,option_b,option_c,option_d,answer,explanation\nWhich nerve flexes the hip?,Femoral,Sciatic,Tibial,Ulnar,A,Femoral nerve\n') },
  ]);
  await expect(page.locator('#builder-overlay')).not.toHaveClass(/visible/);
  expect(createdPacks.map(created => created.title)).toEqual(['Hip muscles', 'Nerves quiz']);
  expect(createdPacks[0].flashcards).toEqual([{ front: 'Hip abductor?', back: 'Gluteus medius' }, { front: 'Hip flexor?', back: 'Iliopsoas' }]);
  expect(createdPacks[0].test_questions).toEqual([]);
  expect(createdPacks[1].flashcards).toEqual([]);
  expect(createdPacks[1].test_questions).toHaveLength(1);
  expect(createdPacks[1].test_questions[0]).toMatchObject({ question: 'Which nerve flexes the hip?', options: ['Femoral', 'Sciatic', 'Tibial', 'Ulnar'] });
  await expect(page.locator('#pack-list .pack-list-item')).toHaveCount(3);
});

test('a voice note is not handed to Study Plan', async ({ page }) => {
  await installLibrary(page, { packs: [pack('a'), pack('v', { mode: 'voice-note', title: 'Recorded reminder' })] });
  let planOpened = false;
  await page.route('**/plan?*', route => { planOpened = true; return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Plan</title>' }); });
  await page.goto('/study?pack_id=v');
  await expect(page.locator('#pack-title')).toHaveValue('Recorded reminder');
  const addButton = page.locator('#add-pack-to-plan-btn');
  await expect(addButton).toBeHidden();
  // The handler itself also refuses voice notes, in case the button is ever shown.
  await addButton.evaluate(button => button.click());
  await expect(page.getByText('Voice notes are kept outside Study Plan', { exact: false })).toBeVisible();
  expect(planOpened).toBe(false);
  await expect(page).toHaveURL(/\/study\?/);
});

test('Study Library controls are named, not nested, and folder actions name their folder', async ({ page }) => {
  await installLibrary(page, { packs: [pack('a', { folder_id: 'anatomy' }), pack('b')] });
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack a');
  await page.waitForLoadState('networkidle');
  expect(await accessibilityProblems(page)).toEqual([]);
  const folders = page.locator('#folder-list');
  const menu = folders.locator('summary[aria-label="Folder actions for Anatomy and physiology"]');
  await expect(menu).toHaveAccessibleName('Folder actions for Anatomy and physiology');
  await menu.click();
  for (const name of ['Pin Anatomy and physiology', 'Edit Anatomy and physiology', 'Share Anatomy and physiology', 'Create subfolder in Anatomy and physiology']) {
    const action = page.locator('details.folder-action-menu[open] [aria-label="' + name + '"]');
    await expect(action).toBeVisible();
    await expect(action).toHaveAccessibleName(name);
  }
});

test('collapsed pack details stay out of keyboard reach until opened', async ({ page }) => {
  await installLibrary(page, { packs: [pack('a')] });
  await page.goto('/study?pack_id=a');
  await expect(page.locator('#pack-title')).toHaveValue('Pack a');
  await page.locator('.pack-details-disclosure > summary').click();
  const toggle = page.locator('#pack-advanced-meta-btn');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await reachableControlsInside(page, '#pack-advanced-meta-shell')).toEqual([]);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await reachableControlsInside(page, '#pack-advanced-meta-shell')).length).toBeGreaterThan(0);
  await toggle.click();
  await expect.poll(() => reachableControlsInside(page, '#pack-advanced-meta-shell')).toEqual([]);
});

test('the CSV drop area opens the file picker from the keyboard', async ({ page }) => {
  await installLibrary(page, { packs: [pack('a')] });
  await page.goto('/study');
  await expect(page.locator('#pack-list .pack-list-item')).toHaveCount(1);
  const firstChooser = page.waitForEvent('filechooser');
  await page.locator('#import-pack-csv-btn').click();
  await (await firstChooser).setFiles([]);
  const drop = page.locator('#builder-csv-drop');
  await expect(drop).toBeVisible();
  await drop.focus();
  for (const key of ['Enter', ' ']) {
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press(key === ' ' ? 'Space' : key);
    expect((await chooser).isMultiple()).toBe(true);
  }
});
