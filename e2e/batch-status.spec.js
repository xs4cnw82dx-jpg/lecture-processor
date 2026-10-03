const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });
const failed = {
  batch_id: 'failed', batch_title: 'Hoofdpijn en Scoliose Batch-test 1', mode: 'lecture-notes', processing_strategy: 'batch',
  status: 'error', total_rows: 2, completed_rows: 0, failed_rows: 2, credits_charged: 2, credits_refunded: 2,
  credits_refund_pending: 0, completion_email_status: 'sent', created_at: 1772790540,
  error_message: 'Google Gemini was temporarily unavailable while this batch was running.',
  rows: [1, 2].map((n) => ({ row_id: 'row-' + n, ordinal: n, status: 'error', error: '503 UNAVAILABLE <script>neverRun()</script>' })),
};
async function fixture(page, entries = [failed]) {
  const base = await installAccountFixture(page);
  const batches = structuredClone(entries);
  let offline = false;
  const downloads = [];
  await page.route('**/api/batch/jobs?*', (route) => route.fulfill({ status: offline ? 503 : 200, contentType: 'application/json', body: JSON.stringify(offline ? { error: 'Connection interrupted' } : { batches }) }));
  await page.route(/\/api\/(?:instant-)?batch\/jobs\/[^/?]+(?:[/?].*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/')[4];
    const batch = batches.find((b) => b.batch_id === id);
    if (url.pathname.endsWith('/visibility')) {
      if (typeof route.request().postDataJSON().archived !== 'boolean') return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"archived must be boolean"}' });
      Object.assign(batch, route.request().postDataJSON(), { archived_at: Date.now() / 1000 });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ batch_id: id, archived: batch.archived, archived_at: batch.archived_at }) });
    }
    if (url.pathname.includes('/download')) {
      downloads.push({ path: url.pathname, authorization: route.request().headers().authorization });
      return route.fulfill({ contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="results.zip"' }, body: 'example download' });
    }
    return route.fulfill({ status: offline ? 503 : 200, contentType: 'application/json', body: JSON.stringify(offline ? { error: 'Connection interrupted' } : batch) });
  });
  return { ...base, batches, downloads, offline(value) { offline = value; } };
}

test('compact dashboard, focused details, dismissal and state survive refresh', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/batch_status');
  await expect(page.getByText('Active batches', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Needs attention/ }).click();
  await page.getByRole('link', { name: 'View details' }).click();
  await expect(page).toHaveURL(/batch_status\/failed/);
  await expect(page.locator('#batch-form')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'All 2 credits refunded' })).toBeVisible();
  await expect(page.getByText('2 charged · 2 refunded', { exact: true })).toBeVisible();
  await expect(page.locator('.bs-heading')).toBeInViewport();
  await page.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(page.locator('.bs-message')).toHaveCount(0);
  await page.locator('[data-key="failure-row-1"] > summary').click();
  await page.locator('[data-key="raw-row-1"] > summary').click();
  await expect(page.locator('[data-key="raw-row-1"] pre')).toHaveText('503 UNAVAILABLE <script>neverRun()</script>');
  f.batches[0].updated_at = 1772790600;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('[data-key="raw-row-1"]')).toHaveAttribute('open', '');
  await page.reload();
  await expect(page.locator('.bs-message')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to batches' }).click();
  await expect(page).toHaveURL(/view=attention/);
  expect(f.browserErrors).toEqual([]);
});

test('archive, restore, undo and direct links retain results across reloads', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/batch_status');
  await page.getByRole('button', { name: /Needs attention/ }).click();
  await page.locator('.bs-overflow summary').click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.locator('#batch-dashboard-rows')).toContainText('No matches');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View details' })).toBeVisible();
  await page.getByRole('link', { name: 'View details' }).click();
  await page.getByRole('button', { name: 'Archive batch' }).click();
  await expect(page.locator('.bs-eyebrow')).toContainText('Archived');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Restore batch' })).toBeVisible();
  await page.goto('/batch_status?view=archived');
  await page.locator('.bs-overflow summary').click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.locator('#batch-dashboard-rows')).toContainText('No matches');
  expect(f.batches[0].credits_refunded).toBe(2);
  expect(f.browserErrors).toEqual([]);
});

test('refresh failure preserves results and authenticated instant partial ZIP remains available', async ({ page }) => {
  const f = await fixture(page, [{ ...failed, status: 'partial', processing_strategy: 'instant', completed_rows: 1, failed_rows: 1, credits_refunded: 1, can_download_zip: true, rows: [{ row_id: 'row-1', ordinal: 1, status: 'complete' }] }]);
  await page.goto('/batch_status/failed');
  await expect(page.getByText('1 of 2 completed · 1 failed', { exact: true })).toBeVisible();
  f.offline(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.bs-refresh-error')).toContainText('Couldn’t refresh');
  await expect(page.getByText('1 of 2 completed · 1 failed', { exact: true })).toBeVisible();
  f.offline(false);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.bs-refresh-error')).toBeHidden();
  await page.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  await expect.poll(() => f.downloads.length).toBe(1);
  expect(f.downloads[0]).toEqual({ path: '/api/instant-batch/jobs/failed/download.zip', authorization: 'Bearer token-a' });
  expect(f.browserErrors).toEqual([]);
});

test('submission focuses compact status once and archive preserves selected uploads', async ({ page }) => {
  const f = await fixture(page, [{ ...failed, mode: 'slides-only' }]);
  await page.route('**/api/batch/jobs', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ batch_id: 'failed', status: 'queued', total_rows: 2 }) }));
  await page.goto('/batch_mode_slides_extraction');
  await page.locator('#batch-title').fill('My selected uploads');
  const inputs = page.locator('input[type="file"][data-field="slides"]');
  await expect(inputs).toHaveCount(2);
  for (const input of await inputs.all()) await input.setInputFiles({ name: 'slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF test') });
  await page.getByRole('button', { name: 'Start batch', exact: true }).click();
  await expect(page.locator('#batch-status-panel')).toContainText('All 2 credits refunded');
  await expect(page.locator('#batch-status-panel')).toBeFocused();
  await page.locator('#batch-title').focus();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Archive batch' }).click();
  await expect(page.locator('#batch-status-panel')).toBeHidden();
  await expect(page.locator('#batch-title')).toHaveValue('My selected uploads');
  expect(await inputs.first().evaluate((el) => el.files[0].name)).toBe('slides.pdf');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#batch-status-panel')).toBeVisible();
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#batch-status-panel')).toBeHidden();
  await expect(page.locator('#batch-title')).toHaveValue('');
  expect(f.browserErrors).toEqual([]);
});

test('responsive long content and limited rows remain accessible', async ({ page }) => {
  const f = await fixture(page, [{ ...failed, batch_title: 'A very long batch title '.repeat(12), rows_limited: true, rows_returned: 100, total_rows: 120 }]);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/batch_status');
    await expect(page.getByRole('link', { name: 'View details' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/batch-dashboard-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: 'View details' }).click();
    await expect(page.getByRole('button', { name: 'Show more items' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/batch-detail-${width}.png`, fullPage: true });
  }
  expect(f.browserErrors).toEqual([]);
});

test('late list responses cannot undo archive, even when the list changes during the write', async ({ page }) => {
  const f = await fixture(page);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let writing = false;
  await page.route('**/api/batch/jobs/failed/visibility', async (route) => {
    writing = true;
    await pending;
    f.batches[0].archived = true;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ batch_id: 'failed', archived: true, archived_at: 12 }) });
  });
  await page.goto('/batch_status');
  await page.locator('.bs-overflow summary').click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect.poll(() => writing).toBe(true);
  f.batches[0].updated_at = 100;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  release();
  await expect(page.locator('#batch-dashboard-rows')).not.toContainText(failed.batch_title);
  await page.getByRole('button', { name: /Archived/ }).click();
  await expect(page.locator('#batch-dashboard-rows')).toContainText(failed.batch_title);
  expect(f.browserErrors).toEqual([]);
});

test('polling settles refunds, stops on completion, and preserves expanded details and keyboard focus', async ({ page }) => {
  const f = await fixture(page, [{ ...failed, status: 'processing', credits_refunded: 0, credits_refund_pending: 2 }]);
  let reads = 0;
  page.on('request', (request) => { if (/\/api\/batch\/jobs\/failed\?/.test(request.url())) reads++; });
  await page.clock.install();
  await page.goto('/batch_status/failed');
  await expect(page.getByRole('heading', { name: '2 credit refunds pending' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive batch' })).toHaveCount(0);
  await page.locator('[data-key="technical"] > summary').click();
  f.batches[0].status = 'error';
  await page.clock.runFor(20010);
  await expect(page.getByRole('button', { name: 'Archive batch' })).toBeVisible();
  await expect(page.locator('[data-key="technical"] > summary')).toBeFocused();
  f.batches[0].credits_refunded = 2; f.batches[0].credits_refund_pending = 0;
  await page.clock.runFor(20010);
  await expect(page.getByRole('heading', { name: 'All 2 credits refunded' })).toBeVisible();
  await expect(page.locator('[data-key="technical"]')).toHaveAttribute('open', '');
  const settled = reads;
  await page.clock.runFor(60010);
  expect(reads).toBe(settled);
  expect(f.browserErrors).toEqual([]);
});

test('ordinary desktop and mobile details show the outcome immediately', async ({ page }) => {
  await fixture(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/batch_status');
    await expect(page.getByRole('link', { name: 'View details' })).toBeVisible();
    await page.screenshot({ path: `test-results/batch-dashboard-normal-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: 'View details' }).click();
    await expect(page.getByRole('heading', { name: 'All 2 credits refunded' })).toBeInViewport();
    await expect(page.getByRole('link', { name: 'Start a new batch', exact: true })).toBeInViewport();
    await expect(page.getByRole('link', { name: 'Start a new batch', exact: true })).toHaveCSS('color', 'rgb(255, 255, 255)');
    await page.screenshot({ path: `test-results/batch-detail-normal-${width}.png`, fullPage: true });
  }
});

test('views filter every status, active work comes first, and browser Back restores filters', async ({ page }) => {
  const entries = ['complete', 'partial', 'error', 'queued', 'processing'].map((status, n) => ({ ...failed, batch_id: status, batch_title: status + ' batch', status, created_at: 100 - n, mode: n === 0 ? 'slides-only' : 'lecture-notes' }));
  const f = await fixture(page, entries);
  await page.goto('/batch_status');
  const rows = page.locator('.bs-list-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText('queued batch');
  await page.getByRole('button', { name: /Completed 1/ }).click();
  await expect(rows).toHaveCount(1);
  await page.locator('#batch-filters > summary').click();
  await page.locator('#batch-dashboard-mode-filter').selectOption('slides-only');
  await page.getByRole('link', { name: 'View details' }).click();
  await page.goBack();
  await expect(page).toHaveURL(/view=completed&mode=slides-only/);
  await expect(page.locator('#batch-dashboard-mode-filter')).toHaveValue('slides-only');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(rows).toHaveCount(5);
  expect(f.browserErrors).toEqual([]);
});

test('failed archive keeps the batch and exposes the server error', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/batch/jobs/failed/visibility', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Could not save. Try again."}' }));
  await page.goto('/batch_status/failed');
  await page.getByRole('button', { name: 'Archive batch' }).click();
  await expect(page.locator('#batch-notice')).toContainText('Could not save. Try again.');
  await expect(page.getByRole('button', { name: 'Archive batch' })).toBeEnabled();
  await expect(page.locator('.bs-eyebrow')).not.toContainText('Archived');
});
