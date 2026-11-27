const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test('a restored account processes imported audio in its chosen language', async ({ page }) => {
  const { browserErrors } = await installAccountFixture(page);
  const preferences = { output_language: 'french', onboarding_completed: true };
  await page.route('**/api/verify-email', route => route.fulfill({ json: { allowed: true } }));
  await page.route('**/api/auth/user', route => route.fulfill({ json: {
    uid: 'a', preferences,
    credits: { lecture_standard: 10, lecture_extended: 0, slides: 0, interview_short: 10, interview_medium: 0, interview_long: 0 },
  } }));
  await page.route('**/api/user-preferences', route => route.fulfill({ json: { preferences } }));
  await page.route('**/api/import-audio-url', route => route.fulfill({
    status: 202, json: { job_id: 'sample-import' },
  }));
  await page.route('**/api/import-audio-url/sample-import', route => route.fulfill({ json: {
    status: 'complete', audio_import_token: 'sample-token', file_name: 'lecture.mp3', size_bytes: 2400,
  } }));
  await page.route('**/upload', route => route.fulfill({ json: { job_id: 'sample-transcript' } }));
  await page.route('**/status/sample-transcript', route => route.fulfill({ json: { status: 'processing' } }));

  await page.goto('/lecture-notes');
  await expect(page.locator('#sign-in-required')).toBeHidden();
  await page.locator('#study-pack-title-input').fill('Morning lecture');
  await page.locator('#pdf-input').setInputFiles({
    name: 'slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 Synthetic slides'),
  });
  await page.locator('#advanced-settings-toggle').click();
  await expect(page.locator('#output-language-label')).toContainText('French');
  await page.locator('#output-language-button').click();
  await page.locator('#output-language-menu [data-value="spanish"]').click();
  await page.locator('#other-audio-toggle').click();
  await page.locator('#audio-url-input').fill('https://example.test/lecture.m3u8');
  await page.locator('#audio-url-fetch-btn').click();
  await expect(page.locator('#audio-name')).toHaveText('lecture.mp3');

  const upload = page.waitForRequest(request => new URL(request.url()).pathname === '/upload');
  await page.locator('#process-button').click();
  const request = await upload;
  const form = await new Response(request.postDataBuffer(), {
    headers: { 'Content-Type': request.headers()['content-type'] },
  }).formData();
  expect(request.headers().authorization).toBe('Bearer token-a');
  expect(form.get('audio_import_token')).toBe('sample-token');
  expect(form.get('output_language')).toBe('spanish');
  expect(browserErrors).toEqual([]);
});

test('an interview author can select audio from an imported URL', async ({ page }) => {
  const { browserErrors } = await installAccountFixture(page);
  const preferences = { onboarding_completed: true };
  await page.route('**/api/verify-email', route => route.fulfill({ json: { allowed: true } }));
  await page.route('**/api/auth/user', route => route.fulfill({ json: {
    uid: 'a', preferences, credits: { interview_short: 1 },
  } }));
  await page.route('**/api/user-preferences', route => route.fulfill({ json: { preferences } }));
  const imports = [];
  await page.route('**/api/import-audio-url', route => {
    imports.push(route.request().postDataJSON().url);
    return route.fulfill({ status: 202, json: { job_id: 'interview-import' } });
  });
  await page.route('**/api/import-audio-url/interview-import', route => route.fulfill({ json: {
    status: 'complete', audio_import_token: 'interview-token', file_name: 'interview.mp3', size_bytes: 2400,
  } }));

  await page.goto('/interview-transcription');
  await expect(page.locator('#sign-in-required')).toBeHidden();
  await page.locator('#other-audio-toggle').click();
  const url = 'https://example.test/interview.m3u8';
  await page.locator('#audio-url-input').fill(url);
  await page.locator('#audio-url-fetch-btn').click();
  await expect(page.locator('#audio-name')).toHaveText('interview.mp3', { timeout: 4000 });
  expect(imports).toEqual([url]);
  expect(browserErrors).toEqual([]);
});
