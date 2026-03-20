const { test, expect } = require('@playwright/test');

async function assertAppHealth(request) {
  const healthResponse = await request.get('/healthz');
  expect(healthResponse.ok()).toBeTruthy();
  const payload = await healthResponse.json();
  expect(payload).toMatchObject({ status: 'ok' });
}

test.beforeEach(async ({ request }) => {
  await assertAppHealth(request);
});

test('landing and config endpoints are healthy', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText(/Lecture Processor|Transform Lectures/i);

  const configResponse = await request.get('/api/config');
  expect(configResponse.ok()).toBeTruthy();
  const config = await configResponse.json();
  expect(config).toHaveProperty('bundles');
});

test('privacy and terms pages load', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.locator('body')).toContainText(/Privacy Policy|Privacy/i);

  await page.goto('/terms');
  await expect(page.locator('body')).toContainText(/Terms|Conditions/i);
});

test('public pages share header branding and primary CTA copy', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.public-header')).toContainText('Lecture Processor');
  await expect(page.getByRole('link', { name: /Start Studying/i })).toBeVisible();

  await page.goto('/features');
  await expect(page.locator('.public-header')).toContainText('Lecture Processor');
  await expect(page.getByRole('link', { name: /Start Studying/i })).toBeVisible();
});

test('lecture and batch pages show updated labels', async ({ page }) => {
  await page.goto('/lecture-notes');
  await expect(page.locator('body')).toContainText(/Lecture Notes/i);
  await expect(page.locator('body')).not.toContainText(/New Lecture/i);

  await page.goto('/batch_mode');
  await expect(page.locator('body')).toContainText(/Batch Processing/i);
  await expect(page.locator('body')).not.toContainText(/Batch Mode Lectures/i);
});

test('dashboard shell loads for unauthenticated user', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('#dash-streak')).toContainText('Sign in to track');
  await expect(page.locator('#dash-due')).toContainText('Sign in to review');
  await expect(page.locator('#dash-goal')).toContainText('Sign in to set goals');
  await expect(page.locator('#dash-goal-fill')).toBeHidden();
});

test('calendar signed-out CTA redirects to a working sign-in entry point', async ({ page }) => {
  await page.goto('/calendar');
  await expect(page.locator('#auth-required')).toBeVisible();
  await expect(page.locator('#add-session-btn')).toContainText('Sign in to add sessions');

  await page.locator('#add-session-btn').click();

  await page.waitForURL(/\/lecture-notes(?:\?auth=signin)?/);
  await expect(page.locator('body')).toContainText(/Lecture Notes|Sign in/i);
});

test('reader actions stay disabled until output exists', async ({ page }) => {
  await page.goto('/document-reader');
  await expect(page.locator('#reader-copy-btn')).toBeDisabled();
  await expect(page.locator('#reader-download-docx-btn')).toBeDisabled();
});

test('lecture notes audio disclosures toggle open and closed', async ({ page }) => {
  await page.goto('/lecture-notes');

  const otherAudioDisclosure = page.locator('#other-audio-disclosure');
  const advancedToggle = page.getByRole('button', { name: /Advanced settings/i });
  const advancedBody = page.locator('#advanced-settings-body');
  await expect(otherAudioDisclosure).toBeHidden();
  await expect(advancedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(advancedBody).toHaveAttribute('aria-hidden', 'true');

  await advancedToggle.click();

  await expect(advancedToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(advancedBody).toHaveAttribute('aria-hidden', 'false');
  await expect(advancedToggle).toHaveClass(/open/);

  await advancedToggle.click();

  await expect(advancedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(advancedBody).toHaveAttribute('aria-hidden', 'true');
  await expect(advancedToggle).not.toHaveClass(/open/);
});
