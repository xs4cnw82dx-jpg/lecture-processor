const { test, expect } = require('@playwright/test');
const { withContentRevision } = require('./helpers/study-revision-fixture');

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
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname + new URL(request.url()).search); });
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/study-folders') body = { folders };
    else if (path === '/api/study-folders/anatomy' && request.method() === 'PATCH') {
      Object.assign(folders[0], request.postDataJSON());
      body = { ok: true, folder: folders[0] };
    } else if (path.endsWith('/share')) body = { access_scope: 'private', share_url: '' };
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
    else if (path.includes('progress')) body = { card_states: {}, daily_progress: {} };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { requests };
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
