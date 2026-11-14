const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

function job(jobId, startedAt, description) {
  return {
    job_id: jobId,
    mode: 'slides-only',
    status: 'processing',
    started_at: startedAt,
    study_pack_title: jobId,
    step: 1,
    total_steps: 2,
    step_description: description,
  };
}

async function fixture(page) {
  const account = await installAccountFixture(page);
  const startedAt = Math.floor(Date.now() / 1000);
  const olderJob = job('older-run', startedAt - 60, 'Preparing the older run');
  const newerJob = job('newer-run', startedAt, 'Preparing the newer run');
  let activeJobs = [olderJob];
  const heldStatus = new Map();
  await page.route('**/api/auth/user', route => route.fulfill({ json: {
    uid: 'a',
    preferences: { output_language: 'english', onboarding_completed: true },
    credits: { slides: 10 },
  } }));
  await page.route('**/api/verify-email', route => route.fulfill({ json: { allowed: true } }));
  await page.route('**/api/runtime-jobs/active', route => route.fulfill({ json: { jobs: activeJobs } }));
  await page.route('**/status/*', route => {
    heldStatus.set(new URL(route.request().url()).pathname.split('/').pop(), route);
  });
  await page.goto('/slides-extraction');
  await expect.poll(() => heldStatus.has('older-run')).toBe(true);
  await expect(page.locator('#status-text')).toHaveText(olderJob.step_description);
  return {
    ...account,
    async selectNewerJob() {
      // A run started in another tab appears in the regular active-job refresh.
      // Keep both jobs active so cache reconciliation does not issue another old poll.
      activeJobs = [olderJob, newerJob];
      await expect(page.locator('#status-text')).toHaveText(newerJob.step_description, { timeout: 16000 });
      await expect.poll(() => heldStatus.has('newer-run')).toBe(true);
    },
    async release(jobId, payload) {
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/status/${jobId}`);
      await heldStatus.get(jobId).fulfill({ json: payload });
      await (await responsePromise).finished();
      // Let the response consumer and its DOM update finish before checking absence.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    },
    async fail(jobId) {
      const failed = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === `/status/${jobId}`);
      await heldStatus.get(jobId).abort('failed');
      await failed;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    },
  };
}

for (const oldStatus of ['processing', 'complete']) {
  test(`late ${oldStatus} response cannot replace the newer run`, async ({ page }) => {
    const f = await fixture(page);
    await f.selectNewerJob();
    await f.release('older-run', {
      status: oldStatus,
      mode: 'slides-only',
      step: 1,
      total_steps: 2,
      step_description: 'Outdated older-run progress',
      result: '# Older run result',
      study_features: 'none',
    });
    expect(await page.locator('#results-section').getAttribute('class')).not.toMatch(/\bvisible\b/);
    expect(await page.locator('#status-text').textContent()).toBe('Preparing the newer run');
    await expect(page.locator('#process-button')).toBeDisabled();
    expect(f.browserErrors).toEqual([]);
  });
}

test('an older network failure cannot change the newer run', async ({ page }) => {
  const f = await fixture(page);
  await f.selectNewerJob();
  await f.fail('older-run');
  expect(await page.locator('#status-text').textContent()).toBe('Preparing the newer run');
  await expect(page.locator('#process-button')).toBeDisabled();
  expect(f.browserErrors).toEqual([]);
});

test('a response after sign-out cannot restart status retries', async ({ page }) => {
  const f = await fixture(page);
  await page.evaluate(() => window.testAccount.switchTo(null));
  await expect(page.locator('#sign-in-required')).toHaveClass(/\bvisible\b/);
  const signedOutStatus = await page.locator('#status-text').textContent();
  await f.release('older-run', { status: 'processing', step_description: 'Outdated account progress' });
  expect(await page.locator('#status-text').textContent()).toBe(signedOutStatus);
  expect(await page.locator('#results-section').getAttribute('class')).not.toMatch(/\bvisible\b/);
  expect(f.browserErrors).toEqual([]);
});

test('the current run can still complete normally', async ({ page }, testInfo) => {
  const f = await fixture(page);
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await page.screenshot({ path: testInfo.outputPath(`polling-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
  }
  await f.release('older-run', {
    status: 'complete',
    result: '# Current run result',
    study_features: 'none',
  });
  await expect(page.locator('#results-section')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#results-content')).toContainText('Current run result');
  expect(f.browserErrors).toEqual([]);
});
