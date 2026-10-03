const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

test('creation and reader disclosures are tinted before hover', async ({ page }) => {
  await installAccountFixture(page);
  for (const route of ['/lecture-notes', '/slides-extraction', '/interview-transcription', '/document-reader', '/image-reader', '/url-reader']) {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    const controls = page.locator('.processing-disclosure-toggle:visible,.advanced-settings-toggle:visible,.study-tools-toggle:visible,.advanced-toggle:visible,details.app-disclosure:not([data-app-menu]) > summary:visible');
    expect(await controls.count()).toBeGreaterThan(0);
    for (const control of await controls.all()) await expect(control).toHaveCSS('background-color', 'rgb(238, 241, 255)');
  }
});

test('batch speed switch preserves files and options in every processing type', async ({ page }) => {
  const fixture = await installAccountFixture(page);
  for (const suffix of ['', '_slides_extraction', '_interview_transcription', '_audio_transcription', '_text_combine']) {
    await page.goto('/batch_mode' + suffix);
    const toggle = page.getByRole('switch', { name: 'Instant processing' });
    await expect(page.locator('.batch-row')).toHaveCount(2);
    await page.locator('#batch-title').fill('Retain my draft');
    const fileInput = page.locator('.batch-row input[type="file"]').first();
    const name = suffix === '_text_combine' ? 'notes.txt' : suffix.includes('transcription') ? 'lecture.mp3' : 'slides.pdf';
    await fileInput.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('fixture') });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page).toHaveURL(new RegExp('/instant_batch_mode' + suffix + '$'));
    await expect(page.locator('#batch-title')).toHaveValue('Retain my draft');
    expect(await fileInput.evaluate(input => input.files[0].name)).toBe(name);
    await expect(page.locator('.mode-link.active')).toHaveAttribute('href', '/instant_batch_mode' + suffix);
    await page.goBack();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await fileInput.evaluate(input => input.files[0].name)).toBe(name);
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.app-shell-sidebar a[href="/instant_batch_mode"]')).toHaveCount(0);
  }
  expect(fixture.browserErrors).toEqual([]);
});

test('batch import instructions, tinted disclosures and mobile switch remain readable', async ({ page }, testInfo) => {
  await installAccountFixture(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/instant_batch_mode');
    const disclosure = page.locator('.row-url-import').first();
    await expect(disclosure.locator('summary')).toHaveCSS('background-color', 'rgb(238, 241, 255)');
    await disclosure.locator('summary').click();
    await expect(disclosure.getByText(/normal lecture recording page/).first()).toBeVisible();
    await expect(disclosure.getByRole('link', { name: /Brightspace walkthrough/ })).toBeVisible();
    await expect(disclosure.getByText(/DevTools/)).toBeVisible();
    await expect(page.locator('.batch-audio-retention-note')).toContainText('Clearing browser site data');
    await expect(page.locator('.batch-progress-note')).toContainText('20 seconds');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => disclosure.evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'))).toBe(false);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: testInfo.outputPath('batch-switch-' + width + '.png'), fullPage: true, animations: 'disabled' });
  }
});

test('switch submits to the chosen strategy and locks while submitting', async ({ page }) => {
  await installAccountFixture(page);
  const submissions = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/instant-batch/jobs', async route => {
    submissions.push(route.request().postData());
    await held;
    await route.fulfill({ status: 503, json: { error: 'Synthetic temporary failure. Your draft is retained.' } });
  });
  await page.goto('/batch_mode_slides_extraction');
  await page.locator('#batch-title').fill('Choose strategy');
  for (const input of await page.locator('input[data-field="slides"]').all()) {
    await input.setInputFiles({ name: 'slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-fixture') });
  }
  const toggle = page.getByRole('switch', { name: 'Instant processing' });
  await toggle.click();
  await page.locator('#submit-batch-btn').click();
  await expect.poll(() => submissions.length).toBe(1);
  await expect(toggle).toBeDisabled();
  release();
  await expect(toggle).toBeEnabled();
  await expect(page.locator('#batch-title')).toHaveValue('Choose strategy');
  expect(submissions[0]).toContain('slides.pdf');
});

test('browser Back cannot detach a running batch from its strategy or saved URL', async ({ page }) => {
  await installAccountFixture(page);
  const batch = { batch_id: 'switch-running', batch_title: 'Running slides', mode: 'slides-only', processing_strategy: 'instant', status: 'processing', total_rows: 2, completed_rows: 0, failed_rows: 0, rows: [] };
  await page.route('**/api/instant-batch/jobs', route => route.fulfill({ json: batch }));
  await page.route('**/api/batch/jobs/switch-running?*', route => route.fulfill({ json: batch }));
  await page.goto('/batch_mode_slides_extraction');
  await page.locator('#batch-title').fill(batch.batch_title);
  for (const input of await page.locator('input[data-field="slides"]').all()) {
    await input.setInputFiles({ name: 'slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-fixture') });
  }
  await page.getByRole('switch', { name: 'Instant processing' }).click();
  await page.locator('#submit-batch-btn').click();
  await expect(page).toHaveURL(/instant_batch_mode_slides_extraction\?batch_id=switch-running$/);
  await page.goBack();
  await expect(page).toHaveURL(/instant_batch_mode_slides_extraction\?batch_id=switch-running$/);
  await expect(page.getByRole('switch', { name: 'Instant processing' })).toBeDisabled();
  await page.reload();
  await expect(page).toHaveURL(/batch_status\/switch-running$/);
  await expect(page.getByRole('heading', { name: batch.batch_title, exact: true })).toBeVisible();
  await expect(page.getByText('Slides · Instant', { exact: true })).toBeVisible();
});
