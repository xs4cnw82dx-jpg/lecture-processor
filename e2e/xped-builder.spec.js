const { test, expect } = require('@playwright/test');
const model = require('../static/js/elearning-model.js');

async function editorFixture(page, options = {}) {
  const exp = {
    ...model.createExpeditionPreset('showcase', 'Course draft', 'en'),
    role: options.role || 'owner', revision: 1,
  };
  const writes = [];
  const translations = [];
  await page.route('https://**', route => route.abort());
  await page.route('**/static/js/firebase-bootstrap.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      const listeners = [];
      const makeUser = uid => uid && ({uid, getIdToken: async () => uid});
      const auth = {
        currentUser: makeUser(sessionStorage.getItem('editorAccount') || 'author'),
        onAuthStateChanged(fn) { listeners.push(fn); queueMicrotask(() => fn(auth.currentUser)); }
      };
      window.switchEditorAccount = uid => {
        sessionStorage.setItem('editorAccount', uid); auth.currentUser = makeUser(uid);
        listeners.forEach(fn => fn(auth.currentUser));
      };
      window.LectureProcessorBootstrap = {
        getAuth: () => auth,
        onAuthStateReady: (service, cb) => service.onAuthStateChanged(cb)
      };`,
  }));
  await page.route('**/api/elearning/grant-session', route => route.fulfill({
    json: { accessToken: 'local-grant', targetLanguage: 'de', expeditionId: 'visual' },
  }));
  await page.route('**/api/elearning/expeditions/visual**', async route => {
    const req = route.request();
    if (req.headers().authorization === 'Bearer second') {
      await route.fulfill({ status: 403, json: { error: 'Access unavailable' } });
    } else if (req.url().endsWith('/lease')) {
      await route.fulfill({ json: { granted: true, lease_token: 'local-lease' } });
    } else if (req.url().endsWith('/translations')) {
      translations.push(req.postDataJSON());
      if (options.waitForTranslation) await options.waitForTranslation(translations.length);
      await route.fulfill({ json: { expedition: { ...exp, revision: ++exp.revision } } });
    } else if (req.method() === 'PUT') {
      writes.push({ token: req.headers().authorization, body: req.postDataJSON() });
      await route.fulfill({ json: { expedition: { ...exp, revision: ++exp.revision } } });
    } else {
      await route.fulfill({ json: { expedition: exp } });
    }
  });
  return { writes, translations, exp };
}

test('phone editor switches between outline, editable canvas and inspector without scrolling past the entire expedition', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const fixture = await editorFixture(page);
  await page.goto('/physio/elearning/visual/edit');
  await expect(page.locator('#el-canvas-card .xped-hero-title')).toBeVisible();
  await expect(page.locator('#el-outline')).toBeHidden();
  await page.locator('.el-pane-btn[data-pane=outline]').click();
  await page.locator('.el-step-row').first().click();
  await expect(page.locator('#el-stage .xped-step-title')).toBeVisible();
  await expect(page.locator('#el-outline')).toBeHidden();
  await page.locator('.el-pane-btn[data-pane=inspector]').click();
  await page.locator('[data-insp=step]').click();
  const name = page.getByLabel('Station Name (EN)');
  await name.fill('');
  await name.pressSequentially('Opening question');
  await expect(name).toBeFocused();
  await expect.poll(() => fixture.writes.at(-1)?.body.modules[0].title.en).toBe('Opening question');
  await page.getByRole('button', { name: 'Editor tools' }).click();
  await expect(page.getByRole('button', { name: 'More expedition actions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Editor tools' })).toBeFocused();
  await page.locator('[data-mode=preview]').click();
  await expect(page.locator('#el-preview-container .xped-hero-title')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test('translation grant omits author controls and preserves newer typing across an earlier save response', async ({ page }) => {
  let finishFirst;
  const firstSave = new Promise(resolve => { finishFirst = resolve; });
  const fixture = await editorFixture(page, { role: 'translate', waitForTranslation: n => n === 1 && firstSave });
  await page.goto('/elearning/translate/local-grant');
  const field = page.locator('#el-translate-rows textarea').first();
  await expect(field).toBeVisible();
  await expect(page.locator('#el-share-btn')).toBeHidden();
  await expect(page.locator('[data-mode=edit]')).toBeHidden();
  await field.fill('Erster Entwurf');
  await expect.poll(() => fixture.translations.length).toBe(1);
  await field.fill('Zweiter Entwurf');
  finishFirst();
  await expect.poll(() => fixture.translations.length).toBe(2);
  expect(Object.values(fixture.translations[1].textUpdates)).toContain('Zweiter Entwurf');
  await expect(field).toHaveValue('Zweiter Entwurf');
  await expect(page.locator('#el-tr-autosave')).toHaveText('Saved');
});

test('a signed-in account change clears an unsaved expedition before the pending edit can use the other account', async ({ page }) => {
  const fixture = await editorFixture(page);
  await page.goto('/physio/elearning/visual/edit');
  await expect(page.locator('#el-canvas-card .xped-hero-title')).toBeVisible();
  await page.locator('#el-exp-title').fill('Private draft');
  await page.evaluate(() => window.switchEditorAccount('second'));
  await expect(page.locator('.el-editor-unavailable')).toHaveText('Access unavailable');
  await expect(page.locator('#el-mode-edit')).toBeHidden();
  await expect(page.locator('#el-canvas-card')).toBeEmpty();
  expect(fixture.writes).toEqual([]);
});

for (const translator of [false, true]) {
  test('private hero media loads once using the ' + (translator ? 'translator grant' : 'author session'), async ({ page }) => {
    const fixture = await editorFixture(page, { role: translator ? 'translate' : 'owner' });
    fixture.exp.startPage.heroMedia = { kind: 'asset', assetId: 'demo-image' };
    const requests = [];
    await page.route('**/api/elearning/expeditions/visual/assets/demo-image', route => {
      requests.push(route.request().headers());
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64'),
      });
    });
    await page.goto(translator ? '/elearning/translate/local-grant' : '/physio/elearning/visual/edit');
    const image = page.locator(translator ? '#el-tr-preview-stage .xped-hero-art img' : '#el-canvas-card .xped-hero-art img');
    await expect.poll(() => image.evaluate(el => el.complete && el.naturalWidth === 1)).toBe(true);
    await page.locator('[data-mode=preview]').click();
    await expect(page.locator('#el-preview-container .xped-hero-art img')).toHaveAttribute('src', /^blob:/);
    expect(requests).toHaveLength(1);
    expect(requests[0][translator ? 'x-elearning-access' : 'authorization']).toBe(translator ? 'local-grant' : 'Bearer author');
  });
}

test('undo after a successful structural save keeps the acknowledged revision', async ({ page }) => {
  const fixture = await editorFixture(page);
  await page.goto('/physio/elearning/visual/edit');
  await expect(page.locator('#el-canvas-card .xped-hero-title')).toBeVisible();
  await page.locator('#el-add-module-btn').click();
  await page.locator('[data-recipe=blank]').click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  await expect(page.locator('#el-save-state')).toHaveText('Saved');
  await page.locator('#el-undo-btn').click();
  await expect.poll(() => fixture.writes.length).toBe(2);
  expect(fixture.writes[1].body.base_revision).toBe(2);
  expect(fixture.writes[1].body.modules).toHaveLength(fixture.exp.modules.length);
});
