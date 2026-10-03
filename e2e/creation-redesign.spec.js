const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { installAccountFixture } = require('./helpers/batch-fixture');
const { expectProductControls } = require('./helpers/control-audit');

test.use({ serviceWorkers: 'block' });
const evidenceDir = process.env.CREATION_EVIDENCE_DIR || 'test-results/redesign-creation';
async function fixture(page) {
  const result = await installAccountFixture(page);
  await page.route(/\/static\/js\/(index-app|index-results-utils|reader|general-transcriber|lecture-downloader)(\.min)?\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', path: path.resolve('static/js', new URL(route.request().url()).pathname.split('/').pop().replace('.min.js', '.js')) }));
  await page.route('**/api/auth/user', route => route.fulfill({ json: { uid: 'a', preferences: { output_language: 'english', onboarding_completed: true }, credits: { lecture_standard: 10, lecture_extended: 10, slides: 10, interview_short: 10, interview_medium: 10, interview_long: 10 } } }));
  await page.route('**/api/verify-email', route => route.fulfill({ json: { allowed: true } }));
  return result;
}
const routes = ['/lecture-notes', '/slides-extraction', '/interview-transcription', '/general-transcriber', '/document-reader', '/image-reader', '/url-reader', '/lecture-downloader', '/voice-notes', '/tools'];
for (const width of [1440, 1280, 768, 390]) {
  test(`creation layouts at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    const f = await fixture(page);
    await page.setViewportSize({ width, height: 1000 });
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      await expectProductControls(page);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: `${evidenceDir}/${route.slice(1)}-${width}.png`, fullPage: true, animations: 'disabled' });
    }
    expect(f.browserErrors).toEqual([]);
  });
}
test('all batch variants retain compact options and source-specific rows', async ({ page }) => {
  test.setTimeout(120000);
  const f = await fixture(page);
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const prefix of ['batch_mode', 'instant_batch_mode']) {
      for (const suffix of ['', '_slides_extraction', '_interview_transcription', '_audio_transcription', '_text_combine']) {
        await page.goto('/' + prefix + suffix);
        await expect(page.locator('.batch-row').first()).toBeVisible();
        await page.locator('.batch-defaults > summary').click();
        await expect(page.locator('.batch-defaults')).toHaveAttribute('open', '');
        const importDisclosure = page.locator('.row-url-import').first();
        if (await importDisclosure.count()) {
          await importDisclosure.locator('summary').click();
          await expect(importDisclosure.locator('input')).toBeVisible();
        }
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({ path: `${evidenceDir}/${prefix}${suffix}-${width}.png`, fullPage: true, animations: 'disabled' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
  }
  expect(f.browserErrors).toEqual([]);
});
test('image thumbnails, optional question and removal preserve readiness', async ({ page }) => {
  await fixture(page);
  await page.goto('/image-reader');
  await expect(page.locator('#reader-question-input')).toBeHidden();
  await page.locator('#reader-file-input').setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64') });
  await expect(page.locator('.selected-file-preview')).toBeVisible();
  await expect(page.locator('#reader-run-btn')).toBeEnabled();
  await page.locator('#reader-advanced-toggle').click();
  await expect(page.locator('#reader-question-input')).toBeVisible();
  await page.locator('#reader-question-input').fill('Extract the paragraph headings.');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${evidenceDir}/image-selected.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('.selected-file-preview')).toHaveCount(0);
  await expect(page.locator('#reader-run-btn')).toBeDisabled();
});
test('voice settings and overflow stay operable on mobile', async ({ page }) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/voice-notes');
  await page.locator('[data-voice-view="settings"]').click();
  await expect(page.locator('.voice-settings')).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${evidenceDir}/voice-settings-mobile.png`, fullPage: true, animations: 'disabled' });
  await page.locator('[data-voice-view="library"]').click();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${evidenceDir}/voice-library-mobile.png`, fullPage: true, animations: 'disabled' });
  expect(f.browserErrors).toEqual([]);
});

test('reader rejects invalid URL and supports failed extraction then successful retry', async ({ page }) => {
  await fixture(page);
  let attempts = 0;
  await page.route('**/api/tools/extract', route => {
    attempts++;
    return route.fulfill(attempts === 1 ? { status: 422, json: { error: 'This page is inaccessible. Check the link and try again.' } } : { json: { output_text: 'Research findings\n\nThe study reports a clear improvement.\n'.repeat(12) } });
  });
  await page.goto('/url-reader');
  await page.locator('#reader-url-input').fill('invalid');
  await page.locator('#reader-run-btn').click();
  await expect(page.locator('#reader-status')).toContainText('valid web address');
  expect(attempts).toBe(0);
  await page.locator('#reader-url-input').fill('https://example.test/study');
  await page.locator('#reader-run-btn').click();
  await expect(page.locator('#reader-status')).toContainText('inaccessible');
  await expect(page.locator('#reader-copy-btn')).toBeDisabled();
  await page.locator('#reader-run-btn').click();
  await expect(page.locator('#reader-output-pre')).toContainText('Research findings');
  await expect(page.locator('#reader-copy-btn')).toBeEnabled();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${evidenceDir}/reader-results.png`, fullPage: true, animations: 'disabled' });
});

test('auth signup, reset and dismissal remain usable on mobile', async ({ page }) => {
  await fixture(page);
  await page.addInitScript(() => window.testAccount.switchTo(null));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/lecture-notes?auth=signin');
  await expect(page.locator('#auth-overlay')).toBeVisible();
  await page.locator('#switch-to-signup').click();
  await expect(page.locator('#signup-password-help')).toBeVisible();
  await expect(page.locator('#signup-password')).toHaveAttribute('aria-describedby', 'signup-password-help');
  await page.locator('[data-target="signup-password"]').click();
  await expect(page.locator('#signup-password')).toHaveAttribute('type', 'text');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${evidenceDir}/auth-signup-mobile.png`, fullPage: true, animations: 'disabled' });
  await page.locator('#switch-to-signin').click();
  await page.locator('#forgot-password-link').click();
  await expect(page.locator('#reset-form')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#auth-overlay')).toBeHidden();
});

for (const mode of ['lecture-notes', 'slides-extraction', 'interview-transcription']) {
  test(`${mode} options, file readiness and completed result`, async ({ page }) => {
    const f = await fixture(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route('**/upload', route => route.fulfill({ json: { job_id: 'design-result' } }));
    await page.route('**/status/design-result', route => route.fulfill({ json: { status: 'complete', result: '# How learning becomes memory\n\nA clear overview of the source material.\n\n## Key ideas\n\n- Encode information deliberately.\n- Use retrieval practice.\n\n| Concept | Meaning |\n|---|---|\n| Recall | Retrieving knowledge |', slide_text: 'Slides text', transcript: '[00:00] Speaker 1: Tell me about your learning process.\n[00:12] Speaker 2: I use retrieval practice.', flashcards: [{ front: 'What is recall?', back: 'Retrieving knowledge.' }], test_questions: [{ question: 'What helps memory?', options: ['Retrieval', 'No practice'], correct_answer: 0, explanation: 'Active retrieval builds memory.' }], study_features: 'both' } }));
    await page.goto('/' + mode);
    await expect(page.locator('#auth-overlay')).toBeHidden();
    await page.locator('#study-pack-title-input').fill('How learning becomes memory');
    if (mode !== 'interview-transcription') await page.locator('#pdf-input').setInputFiles({ name: 'memory-slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') });
    if (mode !== 'slides-extraction') await page.locator('#audio-input').setInputFiles({ name: 'memory-recording.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('test fixture audio') });
    await page.locator('#advanced-settings-toggle').click();
    await expect(page.locator('#advanced-settings-body')).toBeVisible();
    if (mode !== 'slides-extraction') await page.locator('#other-audio-toggle').click();
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: `${evidenceDir}/${mode}-expanded.png`, fullPage: true, animations: 'disabled' });
    await expect(page.locator('#process-button')).toBeEnabled();
    await page.locator('#process-button').click();
    await expect(page.locator('#results-section')).toHaveClass(/visible/);
    if (mode !== 'interview-transcription') {
      await expect(page.locator('#results-content table')).toBeVisible();
      await expect(page.locator('#results-content th')).toHaveText(['Concept', 'Meaning']);
    }
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: `${evidenceDir}/${mode}-result.png`, fullPage: true, animations: 'disabled' });
    await expect(page.locator('#upload-section')).toBeHidden();
    await page.locator('#more-actions-button').click();
    await page.locator('#new-lecture-button').click();
    await expect(page.locator('#upload-section')).toBeVisible();
    expect(f.browserErrors).toEqual([]);
  });
}

test('missing Voice audio stays disabled and overflow supports Escape', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/voice-notes');
  await page.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('lecture-processor-voice-notes', 2); request.onsuccess = () => resolve(request.result); });
    await new Promise(resolve => {
      const tx = db.transaction('notes', 'readwrite');
      tx.objectStore('notes').put({ id: 'missing-audio', owner_key: 'user:a', title: 'Lecture reflections and practical next steps', transcript: 'What I learned today\n\nActive recall strengthens memory.\n'.repeat(8), notes_markdown: '# What I learned today\n\nActive recall strengthens memory.\n'.repeat(8), status: 'synced', created_at: Date.now() / 1000 });
      tx.oncomplete = resolve;
    });
    db.close();
  });
  await page.reload();
  await page.locator('[data-voice-view="library"]').click();
  await page.locator('[data-note-open]').click();
  await expect(page.locator('#voice-audio-status')).toContainText('No downloadable audio');
  await expect(page.locator('#voice-download-audio-btn')).toBeDisabled();
  await expect(page.locator('#voice-audio-retention-note')).toBeHidden();
  const more = page.locator('#voice-detail .voice-more-actions > summary');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#voice-delete-btn')).toBeVisible();
  await expect(page.locator('#voice-delete-btn')).toBeInViewport();
  await page.screenshot({ path: `${evidenceDir}/voice-more-open-mobile.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#voice-delete-btn')).toBeHidden();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
  await page.screenshot({ path: `${evidenceDir}/voice-more-closed-mobile.png`, animations: 'disabled' });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${evidenceDir}/voice-missing-audio-mobile.png`, fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('processing failure keeps sources and supports a successful retry', async ({ page }) => {
  await fixture(page);
  let uploads = 0;
  await page.route('**/upload', route => route.fulfill({ json: { job_id: ++uploads === 1 ? 'failed-source' : 'retried-source' } }));
  await page.route('**/status/failed-source', route => route.fulfill({ json: { status: 'error', error: 'We could not read this source. Please try again.', credit_refunded: true } }));
  await page.route('**/status/retried-source', route => route.fulfill({ json: { status: 'complete', result: '# Recovered notes\n\nThe second attempt completed.', study_features: 'none' } }));
  await page.goto('/slides-extraction');
  await page.locator('#study-pack-title-input').fill('A source that can be retried');
  await page.locator('#pdf-input').setInputFiles({ name: 'retry.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') });
  await page.locator('#process-button').click();
  await expect(page.locator('#status-text')).toContainText('Your credit has been refunded');
  await expect(page.locator('.progress-title')).toHaveText('Processing stopped');
  await expect(page.locator('#pdf-name')).toHaveText('retry.pdf');
  await expect(page.locator('#process-button')).toBeEnabled();
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${evidenceDir}/processing-failed.png`, fullPage: true, animations: 'disabled' });
  await page.locator('#process-button').click();
  await expect(page.locator('#results-content')).toContainText('Recovered notes');
  expect(uploads).toBe(2);
});

test('insufficient credits explain the disabled action without starting processing', async ({ page }) => {
  const f = await fixture(page);
  await page.route('**/api/auth/user', route => route.fulfill({ json: { uid: 'a', preferences: { onboarding_completed: true }, credits: { slides: 0, lecture_standard: 0, interview_short: 0 } } }));
  let uploads = 0;
  await page.route('**/upload', route => { uploads++; return route.fulfill({ status: 402, json: { error: 'No credits' } }); });
  await page.goto('/slides-extraction');
  await page.locator('#study-pack-title-input').fill('Ready except for credits');
  await page.locator('#pdf-input').setInputFiles({ name: 'slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') });
  await expect(page.locator('#process-button')).toBeDisabled();
  await expect(page.locator('#no-credits-warning')).toBeVisible();
  await expect(page.locator('#no-credits-warning')).toContainText('credits');
  await page.screenshot({ path: `${evidenceDir}/insufficient-credits.png`, fullPage: true, animations: 'disabled' });
  expect(uploads).toBe(0);
  expect(f.browserErrors).toEqual([]);
});

test('batch incomplete rows and failed import show recoverable contextual feedback', async ({ page }) => {
  const f = await fixture(page);
  await page.route('**/api/import-audio-url', route => route.fulfill({ status: 422, json: { error: 'This lecture link has expired. Paste a fresh link.' } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/batch_mode');
  await page.locator('#batch-title').fill('Week three');
  await page.locator('#submit-batch-btn').click();
  await expect(page.locator('#batch-submit-feedback')).toContainText('slides file is required');
  await expect(page.locator('#submit-batch-btn')).toBeEnabled();
  const row = page.locator('.batch-row').first();
  await row.locator('.row-url-import > summary').click();
  await row.locator('[data-field="m3u8"]').fill('https://example.test/expired-lecture');
  await row.locator('[data-action="import-audio-url"]').click();
  await expect(row.locator('[data-field="m3u8-status"]')).toContainText('expired');
  await expect(row.locator('[data-action="import-audio-url"]')).toBeEnabled();
  await expect(row.locator('.row-url-import')).toHaveAttribute('open', '');
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${evidenceDir}/batch-incomplete-import-failure-mobile.png`, fullPage: true, animations: 'disabled' });
  expect(f.browserErrors).toEqual([]);
});

test('reduced motion and half-size viewport keep auth and source controls reachable', async ({ page }) => {
  await fixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // 640×450 represents the CSS viewport of a 1280×900 window at 200% zoom.
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto('/document-reader');
  await page.locator('#reader-advanced-toggle').click();
  await page.locator('#reader-question-input').fill('Keep the main ideas.');
  await expect(page.locator('#reader-question-input')).toBeFocused();
  expect(await page.locator('#reader-advanced-body').evaluate(el => getComputedStyle(el).transitionDuration)).toMatch(/^0s/);
  await expect(page.locator('#reader-run-btn')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addInitScript(() => window.testAccount.switchTo(null));
  await page.goto('/lecture-notes?auth=signin');
  await expect(page.locator('#auth-overlay')).toBeVisible();
  await page.locator('#switch-to-signup').click();
  await page.locator('#signup-email').fill('reader@example.test');
  await page.locator('#signup-password-confirm').fill('example-password');
  await page.locator('#signup-submit').scrollIntoViewIfNeeded();
  await expect(page.locator('#signup-submit')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidenceDir}/auth-reduced-motion-compact.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#auth-overlay')).toBeHidden();
});
