const { test, expect } = require('@playwright/test');

const imageId = 'a'.repeat(64);
const secondId = 'b'.repeat(64);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPRsAAAAASUVORK5CYII=', 'base64');

async function library(page, enabled = true) {
  const firebaseStub = `(function () {
    var user = { uid: 'owner', email: 'student@example.com', displayName: 'Student', getIdToken: function () { return Promise.resolve('test-token'); } };
    var auth = { currentUser: user, setPersistence: function () { return Promise.resolve(); }, authStateReady: function () { return Promise.resolve(); }, onAuthStateChanged: function (callback) { setTimeout(function () { callback(user); }, 0); return function () {}; }, signOut: function () { return Promise.resolve(); } };
    function factory() { return auth; } factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: function () { return {}; }, initializeApp: function () { return {}; }, auth: factory };
  })();`;
  await page.addInitScript({ content: firebaseStub });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: firebaseStub }));
  const pack = { study_pack_id: 'anatomy-pack', title: 'Anatomy 1.1', mode: 'manual', pictures_enabled: enabled,
    flashcards: [{ front: 'What is the origin of the M. sartorius?', back: 'Spina iliaca anterior superior', image_ids: [imageId] }],
    flashcards_count: 1, test_questions: [], test_questions_count: 0, notes_markdown: '', folder_id: '' };
  const saves = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body = {};
    if (path.endsWith('/images') && request.method() === 'POST') {
      expect(request.headers()['content-type']).toContain('multipart/form-data');
      expect(request.headers().authorization).toBe('Bearer test-token');
      body = { image: { id: secondId } };
    } else if (path.includes('/images/')) {
      expect(request.headers().authorization).toBe('Bearer test-token');
      return route.fulfill({ contentType: 'image/png', body: png });
    } else if (path === '/api/study-packs/anatomy-pack') {
      if (request.method() === 'PATCH') { const data = request.postDataJSON(); saves.push(data); Object.assign(pack, data); body = { ok: true }; }
      else body = pack;
    } else if (path === '/api/study-packs') body = { study_packs: [pack], has_more: false };
    else if (path === '/api/study-folders') body = { folders: [] };
    else if (path === '/api/auth/user') body = { uid: 'owner', email: 'student@example.com', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (path.includes('progress')) body = { card_states: {}, daily_progress: {} };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/study?pack_id=anatomy-pack');
  await page.locator('#editor-tab-flashcards').click();
  await expect(page.locator('#editor-card-front-0')).toBeVisible();
  return { pack, saves };
}

test('private pictures can be enlarged, uploaded and survive card edits and reload', async ({ page }) => {
  const { pack, saves } = await library(page);
  await page.locator('.study-picture-open').first().scrollIntoViewIfNeeded();
  await expect(page.locator('.study-picture-open img').first()).toHaveJSProperty('naturalWidth', 1);
  await page.locator('.study-picture-open').first().click();
  await expect(page.getByRole('dialog', { name: 'Picture viewer' })).toBeVisible();
  await page.getByRole('button', { name: 'Close picture', exact: true }).click();
  await page.locator('#editor-card-front-0').fill('Edited muscle question');
  await expect.poll(() => saves.some(body => body.flashcards && body.flashcards[0].image_ids.includes(imageId))).toBe(true);
  await page.locator('.study-picture-editor input[type=file]').setInputFiles({ name: 'muscle.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => pack.flashcards[0].image_ids.length).toBe(2);
  await page.reload();
  await page.locator('#editor-tab-flashcards').click();
  await expect(page.locator('#editor-card-front-0')).toHaveValue('Edited muscle question');
  await expect(page.getByRole('button', { name: 'Remove picture', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove picture', exact: true }).last().click();
  await expect.poll(() => pack.flashcards[0].image_ids.length).toBe(1);
});

test('picture controls stay hidden for other accounts', async ({ page }) => {
  await library(page, false);
  await expect(page.getByRole('button', { name: 'Add picture', exact: true })).toHaveCount(0);
  await expect(page.locator('.study-picture-gallery')).toHaveCount(0);
});

test('builder edits preserve pictures and new uploads auto-save', async ({ page }) => {
  const { pack } = await library(page);
  await page.locator('#open-builder-btn').click();
  await page.locator('#builder-tab-flashcards').click();
  await page.locator('#builder-fc-front-0').fill('Builder muscle question');
  await expect.poll(() => pack.flashcards[0].front).toBe('Builder muscle question');
  await page.locator('#builder-flashcard-list input[type=file]').setInputFiles({ name: 'muscle.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => pack.flashcards[0].image_ids.length).toBe(2);
});
