const { test, expect } = require('@playwright/test');

async function installLibrary(page) {
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
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/study-folders') body = { folders };
    else if (path === '/api/study-folders/anatomy' && request.method() === 'PATCH') {
      Object.assign(folders[0], request.postDataJSON());
      body = { ok: true, folder: folders[0] };
    } else if (path.endsWith('/share')) body = { access_scope: 'private', share_url: '' };
    else if (path === '/api/study-packs') body = { study_packs: [], has_more: false };
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
      if (width < 600) expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await folder.locator('[data-edit-folder]').click();
    await expect(page.locator('#folder-name-input')).toHaveValue('Anatomy and physiology');
    await page.locator('#folder-modal-close').click();
    await folder.locator('[data-new-subfolder]').click();
    await expect(page.locator('#folder-modal-title')).toHaveText('Create Folder');
    await expect(page.locator('#folder-name-input')).toHaveValue('');
    await page.locator('#folder-modal-close').click();
    await folder.locator('[data-share-folder]').click();
    await expect(page.locator('#share-modal-title')).toHaveText('Share Folder');
    await page.locator('#share-modal-close').click();
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
