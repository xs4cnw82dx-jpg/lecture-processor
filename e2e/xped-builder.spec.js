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
      const body = req.postDataJSON();
      writes.push({ token: req.headers().authorization, body });
      if (options.saveStructure) return options.saveStructure(route, body, exp);
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
  await expect(page.locator('#el-preview-container .xped-step-title')).toBeVisible();
  await page.locator('#el-pv-from-start').click();
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

async function exitWouldPrompt(page) {
  return page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
}

test('a focused multiline canvas draft stays editable across validation, correction and in-flight saves', async ({ page }) => {
  let finishFirst;
  const pending = new Promise(resolve => { finishFirst = resolve; });
  const accepted = [];
  const fixture = await editorFixture(page, { async saveStructure(route, body) {
    const value = body.startPage.subtitle.en;
    if (value.length > 1000) return route.fulfill({ status: 400, json: { error: 'Use at most 1000 characters.' } });
    accepted.push(value);
    if (accepted.length === 1) await pending;
    return route.fulfill({ json: { expedition: { ...body, revision: body.base_revision + 1 } } });
  } });
  await page.goto('/physio/elearning/visual/edit');
  const subtitle = page.locator('#el-canvas-card .xped-hero-subtitle');
  await subtitle.fill('x'.repeat(1001));
  expect(await exitWouldPrompt(page)).toBe(true);
  await expect(page.locator('#el-save-state')).toHaveText('Save paused');
  await expect(subtitle).toHaveText('x'.repeat(1001));
  await expect(subtitle).toBeFocused();
  await subtitle.fill('First');
  await subtitle.press('End');
  await subtitle.press('Enter');
  await page.keyboard.type('Second');
  await expect.poll(() => accepted[0]).toBe('First\nSecond');
  await subtitle.press('ArrowLeft');
  await page.keyboard.type('!');
  finishFirst();
  await expect.poll(() => accepted[1]).toBe('First\nSecon!d');
  await expect(page.locator('#el-save-state')).toHaveText('Saved');
  await expect(subtitle).toBeFocused();
  expect(await exitWouldPrompt(page)).toBe(false);
  expect(fixture.writes.at(-1).body.base_revision).toBe(2);
});

test('step titles, block headings and rich text save while focused; visiting an untouched fallback keeps it untouched', async ({ page }) => {
  const fixture = await editorFixture(page);
  fixture.exp.modules[0].steps[0].blocks = [model.createBlock('richtext')];
  await page.goto('/physio/elearning/visual/edit');
  await page.locator('.el-step-row').first().click();
  const title = page.locator('#el-canvas-card .xped-step-title');
  await title.fill('First steps');
  await expect.poll(() => fixture.writes.at(-1)?.body.modules[0].steps[0].title.en).toBe('First steps');
  const body = page.locator('.xped-richtext-editor');
  await body.fill('Line A\nLine B');
  await expect.poll(() => fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0].data.body.en).toBe('Line A\nLine B');
  const heading = page.locator('#el-canvas-card .xped-question-text').first();
  await heading.fill('Key idea');
  await expect.poll(() => fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0].data.heading.en).toBe('Key idea');
  await expect(page.locator('#el-save-state')).toHaveText('Saved');
  const count = fixture.writes.length;
  await title.focus();
  await heading.focus();
  expect(await exitWouldPrompt(page)).toBe(false);
  expect(fixture.writes.length).toBe(count);
});

test('translation review follows the accepted source edit and clears after reviewing the destination', async ({ page }) => {
  const fixture = await editorFixture(page, { saveStructure(route, body, exp) {
    Object.assign(exp, body);
    exp.startPage.title._review = { de: true };
    return route.fulfill({ json: { expedition: { ...exp, revision: ++exp.revision } } });
  } });
  fixture.exp.startPage.title.de = 'Vorhandene Übersetzung';
  await page.route('**/api/elearning/expeditions/visual/translations', async route => {
    const changes = route.request().postDataJSON();
    fixture.exp.startPage.title.de = changes.textUpdates['startPage.title'];
    delete fixture.exp.startPage.title._review;
    await route.fulfill({ json: { expedition: { ...fixture.exp, revision: ++fixture.exp.revision } } });
  });
  await page.goto('/physio/elearning/visual/edit');
  await page.locator('#el-canvas-card h1').fill('New source');
  await page.locator('[data-mode=translate]').click();
  const row = page.locator('.el-tr-row').filter({ has: page.getByRole('textbox', { name: 'Start Page · Title (DE)', exact: true }) });
  await expect(row).toHaveAttribute('data-status', 'needs_review');
  const target = row.getByRole('textbox');
  await target.fill('Neue Übersetzung');
  await expect(page.locator('#el-tr-autosave')).toHaveText('Saved');
  await expect(target).toBeFocused();
  await expect(row).toHaveAttribute('data-status', 'translated');
  await expect(row.locator('.el-status-inline')).toHaveText('Done');
  await page.locator('[data-mode=preview]').click();
  await page.locator('[data-mode=translate]').click();
  await expect(row).toHaveAttribute('data-status', 'translated');
});

test('removing unused uploads confirms the selection and prunes only affected undo history', async ({ page }) => {
  const fixture = await editorFixture(page);
  fixture.exp.startPage.heroMedia = { kind: 'asset', assetId: 'old-hero' };
  const removed = [];
  const unused = [
    { id: 'old-hero', kind: 'image', filename: 'Map.webp', size: 125_000 },
    { id: 'keep-audio', kind: 'audio', filename: 'Narration.ogg', size: 200_000 },
  ];
  await page.route('**/api/elearning/expeditions/visual/assets', route => route.fulfill({
    json: { unused, revision: fixture.exp.revision },
  }));
  await page.route('**/api/elearning/expeditions/visual/assets/*', route => {
    if (route.request().method() === 'DELETE') {
      removed.push({ id: route.request().url().split('/').pop(), ...route.request().postDataJSON() });
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64'),
    });
  });
  await page.goto('/physio/elearning/visual/edit');
  await page.getByText('Official xPED Illustrations', { exact: true }).click();
  await page.getByRole('button', { name: 'None', exact: true }).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  const open = async () => {
    await page.getByRole('button', { name: 'More expedition actions' }).click();
    await page.getByRole('menuitem', { name: 'Free unused media' }).click();
  };
  await open();
  const dialog = page.getByRole('dialog', { name: 'Free unused media' });
  await expect(dialog.getByLabel(/Map.webp/)).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(removed).toEqual([]);
  await open();
  await dialog.getByLabel(/Narration.ogg/).uncheck();
  await dialog.getByRole('button', { name: 'Remove selected files' }).click();
  await expect(dialog).toBeHidden();
  expect(removed).toEqual([{ id: 'old-hero', lease_token: 'local-lease', base_revision: 2 }]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
