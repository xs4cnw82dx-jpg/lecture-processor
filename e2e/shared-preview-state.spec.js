const { test, expect } = require('@playwright/test');

const packs = ['alpha', 'beta'].map(id => ({
  study_pack_id: id,
  title: `${id === 'alpha' ? 'Alpha' : 'Beta'} pack`,
  mode: 'lecture-notes',
  notes_markdown: `${id === 'alpha' ? 'Alpha' : 'Beta'} notes`,
  flashcards: [],
  test_questions: [],
}));

async function fixture(page, loadPack, theme = 'light') {
  await page.route(/^https?:\/\//, route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ contentType: 'text/plain', body: '' });
  });
  await page.addInitScript(({ theme }) => {
    const auth = {
      currentUser: null,
      setPersistence: () => Promise.resolve(),
      authStateReady: () => Promise.resolve(),
      onAuthStateChanged: callback => { queueMicrotask(() => callback(null)); return () => {}; },
    };
    function factory() { return auth; }
    factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: factory };
    localStorage.setItem('lp-preferences', JSON.stringify({ language: 'en', theme }));
  }, { theme });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const pack = packs.find(item => path === `/api/shared/synthetic/packs/${item.study_pack_id}`);
    if (pack) return loadPack(route, pack);
    if (path === '/api/shared/synthetic') {
      return route.fulfill({ json: { entity_type: 'folder', folder: { name: 'Shared revision folder' }, study_packs: packs } });
    }
    return route.fulfill({ json: {} });
  });
}

for (const outcome of ['success', 'http-error', 'network-error']) {
  test(`a slow first pack ${outcome} cannot replace the pack selected later`, async ({ page }) => {
    let heldAlpha;
    await fixture(page, (route, pack) => {
      if (pack.study_pack_id === 'alpha') {
        heldAlpha = route;
        return;
      }
      return route.fulfill({ json: pack });
    });
    await page.goto('/shared/synthetic');
    await expect.poll(() => Boolean(heldAlpha)).toBe(true);
    await page.getByRole('button', { name: 'Beta pack' }).click();
    await expect(page.locator('#shared-folder-pack-title')).toHaveText('Beta pack');
    const alphaFinished = page.waitForEvent(outcome === 'network-error' ? 'requestfailed' : 'requestfinished',
      request => request.url().endsWith('/packs/alpha'));
    if (outcome === 'network-error') await heldAlpha.abort('failed');
    else await heldAlpha.fulfill(outcome === 'success' ? { json: packs[0] } : { status: 503, json: { error: 'Late Alpha failure.' } });
    await alphaFinished;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#shared-folder-pack-title')).toHaveText('Beta pack');
    await expect(page.locator('#shared-folder-notes-view')).toContainText('Beta notes');
    await expect(page.getByRole('button', { name: 'Beta pack' })).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#shared-folder-shell')).toBeVisible();
    await expect(page.locator('#shared-study-error')).toBeHidden();
  });
}

test('a failed pack stays inside the preview and the folder can navigate and retry', async ({ page }) => {
  let alphaAttempts = 0;
  await fixture(page, (route, pack) => {
    if (pack.study_pack_id === 'alpha' && ++alphaAttempts === 1) {
      return route.fulfill({ status: 503, json: { error: 'Synthetic pack temporarily unavailable.' } });
    }
    return route.fulfill({ json: pack });
  });
  await page.goto('/shared/synthetic');
  await expect(page.locator('#shared-folder-empty')).toContainText('Synthetic pack temporarily unavailable.');
  await expect(page.locator('#shared-folder-shell')).toBeVisible();
  await expect(page.locator('#shared-study-title')).toHaveText('Shared revision folder');
  await expect(page.locator('#shared-study-error')).toBeHidden();
  await page.getByRole('button', { name: 'Beta pack' }).click();
  await expect(page.locator('#shared-folder-pack-title')).toHaveText('Beta pack');
  await page.getByRole('button', { name: 'Alpha pack' }).click();
  await expect(page.locator('#shared-folder-pack-title')).toHaveText('Alpha pack');
  expect(alphaAttempts).toBe(2);
  await expect(page.locator('#shared-folder-empty')).toBeHidden();
});

test('an older success cannot replace the selected pack error and Retry loads that selection', async ({ page }) => {
  let heldAlpha;
  let betaAttempts = 0;
  await fixture(page, (route, pack) => {
    if (pack.study_pack_id === 'alpha') { heldAlpha = route; return; }
    if (++betaAttempts === 1) return route.fulfill({ status: 503, json: { error: 'Beta is temporarily unavailable.' } });
    return route.fulfill({ json: pack });
  });
  await page.goto('/shared/synthetic');
  await expect.poll(() => Boolean(heldAlpha)).toBe(true);
  const beta = page.getByRole('button', { name: 'Beta pack' });
  await beta.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#shared-folder-empty')).toContainText('Beta is temporarily unavailable.');
  const alphaFinished = page.waitForEvent('requestfinished', request => request.url().endsWith('/packs/alpha'));
  await heldAlpha.fulfill({ json: packs[0] });
  await alphaFinished;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#shared-folder-pack-preview')).toBeHidden();
  await expect(beta).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#shared-folder-empty')).toContainText('Beta is temporarily unavailable.');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('#shared-folder-pack-title')).toHaveText('Beta pack');
  await expect(page.locator('#shared-folder-empty')).toBeHidden();
  expect(betaAttempts).toBe(2);
});

test('an unavailable public link still shows the page error', async ({ page }) => {
  await fixture(page, (route, pack) => route.fulfill({ json: pack }));
  await page.route('**/api/shared/synthetic', route => route.fulfill({ status: 404, json: { error: 'This synthetic link has expired.' } }));
  await page.goto('/shared/synthetic');
  await expect(page.locator('#shared-study-error')).toContainText('This synthetic link has expired.');
  await expect(page.locator('#shared-folder-shell')).toBeHidden();
  await expect(page.locator('#shared-pack-shell')).toBeHidden();
});

test('a standalone shared pack still displays notes and revealed cards safely', async ({ page }) => {
  await fixture(page, (route, pack) => route.fulfill({ json: pack }));
  await page.route('**/api/shared/synthetic', route => route.fulfill({ json: {
    entity_type: 'study_pack', study_pack: { ...packs[0],
      notes_markdown: 'Alpha notes\n\n<script>window.sharedPreviewUnsafe = true</script>',
      flashcards: [{ front: 'Synthetic question', back: 'Synthetic answer' }],
    },
  } }));
  await page.goto('/shared/synthetic');
  await expect(page.locator('#shared-pack-shell')).toBeVisible();
  await expect(page.locator('#shared-notes-view')).toContainText('Alpha notes');
  await expect(page.locator('#shared-notes-view script')).toHaveCount(0);
  expect(await page.evaluate(() => window.sharedPreviewUnsafe)).toBeUndefined();
  await page.getByText('Reveal answer', { exact: true }).click();
  await expect(page.locator('#shared-flashcards-list .shared-card-back')).toHaveText('Synthetic answer');
  await expect(page.locator('#shared-flashcards-list .shared-card-back')).toBeVisible();
  await expect(page.locator('#shared-folder-shell')).toBeHidden();
});

test('an empty shared folder keeps its useful empty preview', async ({ page }) => {
  await fixture(page, (route, pack) => route.fulfill({ json: pack }));
  await page.route('**/api/shared/synthetic', route => route.fulfill({ json: {
    entity_type: 'folder', folder: { name: 'Empty revision folder' }, study_packs: [],
  } }));
  await page.goto('/shared/synthetic');
  await expect(page.locator('#shared-folder-pack-list')).toContainText('No packs in this shared folder');
  await expect(page.locator('#shared-folder-empty')).toContainText('Nothing to preview yet');
  await expect(page.locator('#shared-folder-pack-preview')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
});

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`preview failure stays readable at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await fixture(page, route => route.fulfill({ status: 503, json: { error: 'This pack is temporarily unavailable. Please try again.' } }), theme);
      await page.goto('/shared/synthetic');
      await expect(page.locator('#shared-folder-empty')).toContainText('This pack is temporarily unavailable.');
      await page.evaluate(value => window.LPTheme.apply({ theme: value }), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const retry = page.getByRole('button', { name: 'Retry', exact: true });
      await retry.focus();
      await expect(retry).toBeFocused();
      await expect(retry).toBeInViewport();
      await expect(page.getByRole('button', { name: 'Beta pack' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ animations: 'disabled', fullPage: true, path: testInfo.outputPath(`preview-error-${theme}-${width}.png`) });
    });
  }
}
