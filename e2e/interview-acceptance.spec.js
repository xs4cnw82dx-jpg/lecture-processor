const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function codingState(packId, status = 'draft', owner = 'a') {
  const transcript = 'Studying together helped me gain confidence.';
  return {
    pack_id: packId, transcript, transcript_base_key: 'synthetic-transcript', segments: [],
    codes: [{ code_id: 'manual', name: 'Manual theme ' + owner, color: 'teal', description: '' }],
    quotations: [], palette: [{ key: 'teal', hex: '#CCFBF1', label: 'Teal' }], ai_estimate: { credit_cost: 1 },
    latest_run: { run_id: 'run-' + packId, status,
      proposed_codes: [{ code_id: 'suggested', name: 'Growing confidence ' + owner, color: 'teal' }],
      proposed_quotations: [{ text: transcript, start_offset: 0, end_offset: transcript.length }] },
  };
}

async function fixture(page, options = {}) {
  const base = await installAccountFixture(page);
  if (process.env.INTERVIEW_BASELINE_JS) {
    await page.route(/\/static\/js\/study(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({
      contentType: 'application/javascript', path: process.env.INTERVIEW_BASELINE_JS,
    }));
  }
  const packs = ['interview-a', 'interview-b'].map((id, index) => ({
    study_pack_id: id, title: index ? 'Second interview' : 'First interview', mode: 'interview',
    notes_markdown: '# Interview\n\nStudying together helped me gain confidence.',
    flashcards: [], test_questions: [], flashcards_count: 0,
  }));
  const states = {};
  const accepts = [];
  const writes = [];
  const reads = [];
  let failNextAccept = false;
  let failNextRead = false;
  let heldRead = null;
  function stateFor(owner, packId) {
    const key = owner + '/' + packId;
    return states[key] || (states[key] = codingState(packId, options.status || 'draft', owner));
  }
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const owner = request.headers().authorization === 'Bearer token-b' ? 'b' : 'a';
    let body = {};
    if (pathname.startsWith('/api/interview-coding/packs/')) {
      const packId = pathname.split('/')[4];
      const state = stateFor(owner, packId);
      if (request.method() === 'GET') {
        reads.push({ owner, packId });
        if (heldRead) {
          const gate = heldRead;
          heldRead = null;
          await gate.promise;
        }
        if (failNextRead) {
          failNextRead = false;
          return route.fulfill({ status: 503, json: { error: 'Synthetic coding reload outage' } });
        }
      }
      if (request.method() !== 'GET') writes.push({ owner, packId, pathname, method: request.method() });
      if (pathname.endsWith('/accept')) {
        accepts.push({ owner, packId });
        state.latest_run.status = 'accepting';
        if (options.acceptGate) await options.acceptGate.promise;
        if (failNextAccept) {
          failNextAccept = false;
          failNextRead = !!options.failRefresh;
          return route.fulfill({ status: 503, json: { error: 'Could not finish applying the draft. Please try again.' } });
        }
        state.latest_run.status = 'accepted';
        state.codes = [state.codes[0], { ...state.latest_run.proposed_codes[0] }];
        state.quotations = [{ quotation_id: 'accepted-quote', ...state.latest_run.proposed_quotations[0], code_ids: ['suggested'] }];
        body = { state };
      } else body = state;
    } else if (pathname === '/api/study-packs') body = { study_packs: packs, has_more: false };
    else if (pathname.startsWith('/api/study-packs/')) body = packs.find(pack => pack.study_pack_id === pathname.split('/')[3]) || {};
    else if (pathname === '/api/study-folders') body = { folders: [] };
    else if (pathname === '/api/auth/user') body = { uid: owner, email_verified: true, onboarding_completed: true, allowed: true };
    else if (pathname === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (pathname.includes('progress')) body = { card_states: {}, daily_progress: {} };
    return route.fulfill({ json: body });
  });
  await page.goto('/study?pack_id=interview-a');
  await expect(page.locator('#pack-summary-title')).toHaveText('First interview');
  await page.locator('#open-learn-btn').click();
  await expect(page.locator('#coding-transcript')).toBeVisible();
  await expect(page.locator('#coding-code-list')).toContainText('Manual theme a');
  return { ...base, states, accepts, writes, reads, failNextAccept() { failNextAccept = true; }, holdNextRead(gate) { heldRead = gate; } };
}

test('an interrupted acceptance can be resumed after loading the interview', async ({ page }) => {
  const mock = await fixture(page, { status: 'accepting' });

  await expect(page.locator('#coding-ai-panel')).toContainText('Finish applying');
  await expect(page.locator('#coding-ai-panel')).toContainText(/already started|started applying/i);
  await expect(page.locator('[data-ai-draft-action="reject"]')).toHaveCount(0);
  await expect(page.locator('#coding-ai-reject-btn')).toBeHidden();
  await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
  await page.locator('.coding-more-actions summary').click();
  await expect(page.locator('#coding-reset-btn')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.locator('[data-ai-draft-action="accept"]').click();

  await expect(page.locator('#coding-code-list')).toContainText('Growing confidence a');
  await expect(page.locator('#coding-ai-panel')).toBeHidden();
  await expect(page.locator('#coding-ai-run-btn')).toBeEnabled();
  expect(mock.accepts).toHaveLength(1);
  expect(mock.browserErrors).toEqual([]);
});

test('a normal draft keeps its review preview and accepts successfully', async ({ page }) => {
  const mock = await fixture(page);
  await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
  await expect(page.locator('#coding-ai-panel')).toContainText('Suggested quotations');
  await expect(page.locator('[data-ai-draft-action="reject"]')).toBeVisible();
  await page.locator('[data-ai-draft-action="accept"]').click();
  await expect(page.locator('#coding-code-list')).toContainText('Growing confidence a');
  await expect(page.locator('#coding-ai-panel')).toBeHidden();
  expect(mock.accepts).toHaveLength(1);
  expect(mock.browserErrors).toEqual([]);
});

test('repeated accept activation submits only one request while applying', async ({ page }) => {
  const gate = deferred();
  const mock = await fixture(page, { acceptGate: gate });
  try {
    await page.locator('[data-ai-draft-action="accept"]').evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => mock.accepts.length).toBeGreaterThan(0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(mock.accepts).toHaveLength(1);
    await expect(page.locator('[data-ai-draft-action="accept"]')).toBeDisabled();
    await expect(page.locator('#coding-ai-accept-btn')).toBeDisabled();
    await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
    await expect(page.locator('#coding-reset-btn')).toBeDisabled();
  } finally {
    gate.resolve();
  }
  await expect(page.locator('#coding-code-list')).toContainText('Growing confidence a');
});

for (const failRefresh of [false, true]) {
  test(`failed acceptance remains resumable after reload${failRefresh ? ' even when status refresh fails' : ''}`, async ({ page }) => {
    const mock = await fixture(page, { failRefresh });
    mock.failNextAccept();
    await page.locator('[data-ai-draft-action="accept"]').click();
    await expect(page.locator('#toast')).toContainText('Could not finish applying the draft');
    await expect(page.locator('[data-ai-draft-action="accept"]')).toHaveText('Finish applying');
    await expect(page.locator('[data-ai-draft-action="accept"]')).toBeEnabled();
    await expect(page.locator('#coding-ai-reject-btn')).toBeHidden();
    await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
    await page.reload();
    await expect(page.locator('#coding-preview-status')).toContainText('Finish applying');
    await page.locator('#open-learn-btn').click();
    await page.locator('[data-ai-draft-action="accept"]').click();
    await expect(page.locator('#coding-code-list')).toContainText('Growing confidence a');
    await expect(page.locator('#coding-ai-panel')).toBeHidden();
    expect(mock.accepts).toHaveLength(2);
    expect(mock.writes.every(write => write.pathname.endsWith('/accept'))).toBe(true);
    expect(mock.browserErrors).toEqual([]);
  });
}

for (const destination of ['pack', 'account']) {
  test(`late acceptance cannot replace coding in the next ${destination}`, async ({ page }) => {
    const gate = deferred();
    const mock = await fixture(page, { acceptGate: gate });
    try {
      await page.locator('[data-ai-draft-action="accept"]').click();
      await expect.poll(() => mock.accepts.length).toBe(1);
      await page.locator('#coding-close-btn').click();
      if (destination === 'pack') {
        await page.locator('#pack-list [data-pack-id="interview-b"] [data-pack-open]').click();
        await expect(page.locator('#pack-summary-title')).toHaveText('Second interview');
      } else {
        await page.evaluate(() => window.testAccount.switchTo('b'));
        await expect(page.locator('#coding-preview-codes')).toContainText('Manual theme b');
      }
      await page.locator('#open-learn-btn').click();
      await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
      const response = page.waitForResponse(item => item.url().includes('/interview-a/ai-runs/') && item.url().endsWith('/accept'));
      gate.resolve();
      await (await response).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
      await expect(page.locator('#coding-code-list')).not.toContainText('Growing confidence a');
      await expect(page.locator('#coding-ai-run-btn')).toBeEnabled();
      expect(mock.accepts).toHaveLength(1);
      expect(mock.browserErrors).toEqual([]);
    } finally { gate.resolve(); }
  });
}

test('a late failure-refresh response cannot replace another interview', async ({ page }) => {
  const mock = await fixture(page);
  const gate = deferred();
  const readsBefore = mock.reads.length;
  mock.holdNextRead(gate);
  mock.failNextAccept();
  try {
    await page.locator('[data-ai-draft-action="accept"]').click();
    await expect.poll(() => mock.reads.length).toBeGreaterThan(readsBefore);
    await page.locator('#coding-close-btn').click();
    await page.locator('#pack-list [data-pack-id="interview-b"] [data-pack-open]').click();
    await expect(page.locator('#pack-summary-title')).toHaveText('Second interview');
    await page.locator('#open-learn-btn').click();
    await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
    const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/interview-coding/packs/interview-a');
    gate.resolve();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
    await expect(page.locator('#coding-ai-run-btn')).toBeEnabled();
    expect(mock.browserErrors).toEqual([]);
  } finally { gate.resolve(); }
});

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`accepting interview remains readable at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await fixture(page, { status: 'accepting' });
      await page.evaluate(value => window.LPTheme.apply({ theme: value }), theme);
      await expect(page.locator('#coding-ai-panel')).toContainText('Finish applying');
      await expect(page.locator('[data-ai-draft-action="accept"]')).toBeInViewport();
      await expect(page.locator('#coding-close-btn')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('[data-ai-draft-action="accept"]').focus();
      await expect(page.locator('[data-ai-draft-action="accept"]')).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`accepting-${theme}-${width}.png`), animations: 'disabled' });
    });
  }
}
