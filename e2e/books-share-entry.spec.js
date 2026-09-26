const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const M = require('../static/js/book-model.js');

// Use the production bundle; only identity and server responses are isolated.
test('a signed-out reader opens a shared book through its name dialog', async ({ page }) => {
  const source = M.book('story');
  const book = { ...source, id: 'shared-story', local: false, role: 'view', owner_uid: 'author', revision: 1, page_ids: source.pages.map((p) => p.id), deleted_page_ids: [], editor: null };
  let exchanges = 0;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/static/js/firebase-bootstrap.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `const auth={currentUser:null,onAuthStateChanged(fn){queueMicrotask(()=>fn(null));}}; window.LectureProcessorBootstrap={getAuth:()=>auth};`,
  }));
  await page.route(/\/static\/js\/book-studio(?:\.min)?\.js(?:\?.*)?$/, (route) => route.fulfill({
    contentType: 'text/javascript', body: fs.readFileSync('static/js/book-studio.min.js', 'utf8'),
  }));
  await page.route('**/api/books/share-session', async (route) => {
    exchanges++;
    expect(route.request().postDataJSON()).toEqual({ token: 'browser-entry-test', name: 'Guest reader' });
    await route.fulfill({ json: { book_id: book.id, access_token: 'scoped-reader-session' } });
  });
  await page.route('**/api/books/shared-story**', async (route) => {
    expect(route.request().headers()['x-book-access']).toBe('scoped-reader-session');
    await route.fulfill({ json: { book, pages: source.pages, assets: [] } });
  });
  await page.goto('/books/shared/browser-entry-test');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Your name', { exact: true }).fill('Guest reader');
  await page.getByRole('button', { name: 'Open book', exact: true }).click();
  await expect(page).toHaveURL(/\/books\/shared-story$/);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Add text', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Next pages', exact: true }).click();
  await expect(page.locator('#page-position')).toHaveText('1–2 / 2');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset zoom', exact: true })).toHaveText('110%');
  expect(exchanges).toBe(1);
  expect(errors).toEqual([]);
});
