const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function stateFor(packId, owner) {
  return {
    pack_id: packId, transcript: 'Studying together helped me gain confidence.',
    transcript_base_key: 'synthetic-transcript', segments: [],
    codes: [{ code_id: 'manual', name: `Manual theme ${owner} ${packId}`, color: 'teal', description: '' }],
    quotations: [], palette: [{ key: 'teal', hex: '#CCFBF1', label: 'Teal' }],
    ai_estimate: { credit_cost: 1 }, latest_run: null, runs: [],
  };
}

async function fixture(page, options = {}) {
  const base = await installAccountFixture(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.codingJsonGate = { match: '', entered: 0, release: null };
    window.fetch = function (...args) {
      return originalFetch.apply(this, args).then(response => {
        const gate = window.codingJsonGate;
        if (gate.match && String(args[0]).endsWith(gate.match)) {
          gate.match = '';
          const originalJson = response.json.bind(response);
          response.json = async () => {
            const payload = await originalJson();
            gate.entered += 1;
            await new Promise(resolve => { gate.release = resolve; });
            return payload;
          };
        }
        return response;
      });
    };
  });
  const source = process.env.INTERVIEW_BACKGROUND_SOURCE || require('node:path').resolve('static/js/study.js');
  await page.route(/\/static\/js\/study(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', path: source }));
  const packs = ['interview-a', 'interview-b'].map((id, index) => ({
    study_pack_id: id, title: index ? 'Second interview' : 'First interview', mode: 'interview',
    notes_markdown: '# Interview\n\nStudying together helped me gain confidence.', flashcards: [], test_questions: [], flashcards_count: 0,
  }));
  const states = {}, posts = [], polls = [], reads = [], accepts = [];
  let heldRead = null, failRead = false, heldPoll = null, failPoll = false, failPack = false, pollRunOverride = null;
  function getState(owner = 'a', packId = 'interview-a') {
    const key = `${owner}/${packId}`;
    if (!states[key]) {
      states[key] = stateFor(packId, owner);
      if (options.initialStatus) states[key].latest_run = runFor(owner, packId, options.initialStatus);
    }
    return states[key];
  }
  function runFor(owner, packId, status = 'queued') {
    return { run_id: `run-${owner}-${packId}`, pack_id: packId, status,
      proposed_codes: [{ code_id: 'suggested', name: `Growing confidence ${owner}`, color: 'teal' }],
      proposed_quotations: [{ text: 'Studying together helped me gain confidence.', start_offset: 0, end_offset: 44 }],
      error: status === 'failed' ? 'AI coding failed. Please try again.' : '',
      error_code: status === 'failed' ? 'interview_coding_failed' : '', credit_refunded: status === 'failed' };
  }
  function envelope(state) {
    return { ok: true, run: state.latest_run, reused: false,
      status_url: `/api/interview-coding/packs/${state.pack_id}/ai-runs/${state.latest_run.run_id}` };
  }
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const owner = request.headers().authorization === 'Bearer token-b' ? 'b' : 'a';
    let body = {};
    if (pathname.startsWith('/api/interview-coding/packs/')) {
      const packId = pathname.split('/')[4], state = getState(owner, packId);
      if (pathname.endsWith('/ai-runs') && request.method() === 'POST') {
        posts.push({ owner, packId });
        const rejectedBeforeStarting = options.postError >= 400 && options.postError < 500;
        if (!rejectedBeforeStarting) state.latest_run = state.latest_run || runFor(owner, packId);
        if (options.postGate) await options.postGate.promise;
        if (options.postNetworkError) return route.abort('failed');
        if (options.postError) return route.fulfill({ status: options.postError, json: { error: options.postErrorMessage || 'Synthetic start response outage' } });
        return route.fulfill({ status: 202, json: envelope(state) });
      }
      if (pathname.endsWith('/accept')) {
        accepts.push({ owner, packId });
        state.latest_run.status = 'accepted';
        state.codes.push(...state.latest_run.proposed_codes);
        return route.fulfill({ json: { state } });
      }
      if (pathname.includes('/ai-runs/')) {
        polls.push({ owner, packId });
        const snapshot = structuredClone(envelope(state));
        if (pollRunOverride) { snapshot.run = pollRunOverride; pollRunOverride = null; }
        if (heldPoll) { const gate = heldPoll; heldPoll = null; await gate.promise; }
        if (failPoll) { failPoll = false; return route.fulfill({ status: 503, json: { error: 'Synthetic status outage' } }); }
        return route.fulfill({ json: snapshot });
      }
      reads.push({ owner, packId });
      const snapshot = structuredClone(state);
      if (heldRead) { const gate = heldRead; heldRead = null; await gate.promise; }
      if (failRead) { failRead = false; return route.fulfill({ status: 503, json: { error: 'Synthetic coding reload outage' } }); }
      body = snapshot;
    } else if (pathname === '/api/study-packs') body = { study_packs: packs, has_more: false };
    else if (pathname.startsWith('/api/study-packs/')) {
      if (failPack && pathname.endsWith('/interview-b')) {
        failPack = false;
        return route.fulfill({ status: 503, json: { error: 'Synthetic pack outage' } });
      }
      body = packs.find(pack => pack.study_pack_id === pathname.split('/')[3]) || {};
    }
    else if (pathname === '/api/study-folders') body = { folders: [] };
    else if (pathname === '/api/auth/user') body = { uid: owner, email_verified: true, onboarding_completed: true, allowed: true };
    else if (pathname === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (pathname.includes('progress')) body = { card_states: {}, daily_progress: {} };
    return route.fulfill({ json: body });
  });
  await page.goto('/study?pack_id=interview-a');
  await expect(page.locator('#pack-summary-title')).toHaveText('First interview');
  await page.locator('#open-learn-btn').click();
  await expect(page.locator('#coding-code-list')).toContainText('Manual theme a');
  return { ...base, states, posts, polls, reads, accepts, getState, runFor,
    holdRead(gate, fail = false) { heldRead = gate; failRead = fail; },
    holdPoll(gate, fail = false) { heldPoll = gate; failPoll = fail; },
    failPoll() { failPoll = true; },
    failNextPack() { failPack = true; },
    replaceNextPollRun(run) { pollRunOverride = run; },
  };
}

async function startRun(page) {
  await page.locator('#coding-ai-run-btn').click();
  await expect(page.locator('#confirm-modal-overlay')).toBeVisible();
  await page.locator('#confirm-modal-confirm').click();
}

test('queued generation stays pending and polls until a review draft exists', async ({ page }) => {
  const mock = await fixture(page);
  await startRun(page);
  await expect.poll(() => mock.polls.length, { timeout: 4000 }).toBeGreaterThan(0);
  await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
  await expect(page.locator('#coding-ai-panel')).toContainText('AI coding is running');
  await expect(page.locator('#toast')).not.toContainText('AI coding draft ready.');
  mock.getState().latest_run.status = 'processing';
  await expect.poll(() => mock.polls.length).toBeGreaterThan(1);
  mock.getState().latest_run.status = 'draft';
  await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
  await expect(page.locator('[data-ai-draft-action="accept"]')).toBeEnabled();
  expect(mock.posts).toHaveLength(1);
  expect(mock.browserErrors).toEqual([]);
});

test('repeated activation while the start response is held submits only once', async ({ page }) => {
  const gate = deferred();
  const mock = await fixture(page, { postGate: gate });
  try {
    await page.locator('#coding-ai-run-btn').evaluate(button => { button.click(); button.click(); });
    await page.locator('#confirm-modal-confirm').evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => mock.posts.length).toBe(1);
    await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
    await page.locator('#coding-ai-run-btn').evaluate(button => button.click());
    expect(mock.posts).toHaveLength(1);
    gate.resolve();
    await expect.poll(() => mock.polls.length).toBeGreaterThan(0);
    mock.getState().latest_run.status = 'draft';
    await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
    expect(mock.posts).toHaveLength(1);
  } finally { gate.resolve(); }
});

for (const initialStatus of ['queued', 'processing', 'refund_pending']) {
  test(`loading and reloading resumes ${initialStatus} without another start`, async ({ page }) => {
    const mock = await fixture(page, { initialStatus });
    await expect.poll(() => mock.polls.length).toBeGreaterThan(0);
    await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
    expect(mock.posts).toEqual([]);
    const count = mock.polls.length;
    await page.reload();
    await expect(page.locator('#pack-summary-title')).toHaveText('First interview');
    await expect.poll(() => mock.polls.length).toBeGreaterThan(count);
    await page.locator('#open-learn-btn').click();
    await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
    if (initialStatus === 'refund_pending') {
      await expect(page.locator('#coding-ai-panel')).toContainText('Finishing credit refund');
      await expect(page.locator('#coding-ai-panel')).not.toContainText('has been refunded');
    }
    mock.getState().latest_run.status = 'draft';
    await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
    expect(mock.posts).toEqual([]);
    expect(mock.browserErrors).toEqual([]);
  });
}

for (const refunded of [false, true]) {
  test(`terminal failure reports confirmed refund=${refunded} accurately and stops polling`, async ({ page }) => {
    const mock = await fixture(page, { initialStatus: 'refund_pending' });
    await expect(page.locator('#coding-status')).toContainText('still being processed');
    mock.getState().latest_run = { ...mock.runFor('a', 'interview-a', 'failed'), credit_refunded: refunded };
    await expect(page.locator('#coding-status')).toContainText('AI coding failed.');
    if (refunded) await expect(page.locator('#coding-status')).toContainText('Your credit has been refunded.');
    else await expect(page.locator('#coding-status')).not.toContainText('has been refunded');
    await expect(page.locator('#coding-ai-panel')).toBeHidden();
    await expect(page.locator('#coding-ai-run-btn')).toBeEnabled();
    const count = mock.polls.length;
    await page.clock.install();
    await page.clock.runFor(5000);
    expect(mock.polls).toHaveLength(count);
    expect(mock.posts).toEqual([]);
  });
}

test('a temporary status outage retries the same run without starting again', async ({ page }) => {
  const mock = await fixture(page, { initialStatus: 'processing' });
  mock.failPoll();
  await expect(page.locator('[data-ai-run-retry]')).toBeVisible();
  await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
  mock.getState().latest_run.status = 'draft';
  await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
  expect(mock.polls.length).toBeGreaterThan(1);
  expect(mock.posts).toEqual([]);
});

test('a lost start response reconciles the saved run before retrying', async ({ page }) => {
  const mock = await fixture(page, { postError: 503 });
  const reads = mock.reads.length;
  await startRun(page);
  await expect.poll(() => mock.reads.length).toBeGreaterThan(reads);
  await expect.poll(() => mock.polls.length).toBeGreaterThan(0);
  mock.getState().latest_run.status = 'draft';
  await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
  expect(mock.posts).toHaveLength(1);
});

for (const status of [402, 429]) {
  for (const previous of ['none', 'accepted', 'failed']) {
    test(`a definite ${status} start rejection with ${previous} prior run stays retryable without reconciliation`, async ({ page }) => {
      await page.clock.install();
      const reason = status === 402 ? 'Not enough credits for AI coding.' : 'Too many AI coding requests. Please try again shortly.';
      const mock = await fixture(page, {
        initialStatus: previous === 'none' ? undefined : previous,
        postError: status, postErrorMessage: reason,
      });
      const reads = mock.reads.length;
      const previousRun = structuredClone(mock.getState().latest_run);

      await startRun(page);
      await expect.poll(() => mock.posts.length).toBe(1);
      await page.clock.runFor(1600);

      await expect.soft(page.locator('#toast')).toHaveText(reason, { timeout: 1000 });
      await expect.soft(page.locator('#toast')).toBeVisible({ timeout: 1000 });
      await expect.soft(page.locator('#coding-status')).toHaveText(reason, { timeout: 1000 });
      await expect.soft(page.locator('#coding-ai-run-btn')).toBeEnabled({ timeout: 1000 });
      expect.soft(mock.reads).toHaveLength(reads);
      expect.soft(mock.polls).toHaveLength(0);
      expect.soft((await page.locator('#toast, #coding-status').allTextContents()).join(' ')).not.toContain('has been refunded');
      expect(mock.getState().latest_run).toEqual(previousRun);
      expect(mock.posts).toHaveLength(1);
      expect(mock.browserErrors).toEqual([]);
    });
  }
}

test('a network failure after a durable start reconciles the queued run without another POST', async ({ page }) => {
  const mock = await fixture(page, { postNetworkError: true });
  const reads = mock.reads.length;

  await startRun(page);
  await expect.poll(() => mock.reads.length).toBeGreaterThan(reads);
  await expect.poll(() => mock.polls.length).toBeGreaterThan(0);
  await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
  mock.getState().latest_run.status = 'draft';
  await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
  expect(mock.posts).toHaveLength(1);
  expect(mock.browserErrors).toEqual([]);
});

async function navigateAway(page, destination) {
  if (destination === 'signout') {
    await page.evaluate(() => window.testAccount.switchTo(null));
    await expect(page.locator('#coding-transcript')).toBeHidden();
    return;
  }
  await page.locator('#coding-close-btn').click();
  if (destination === 'pack') {
    await page.locator('#pack-list [data-pack-id="interview-b"] [data-pack-open]').click();
    await expect(page.locator('#pack-summary-title')).toHaveText('Second interview');
  } else {
    await page.evaluate(() => window.testAccount.switchTo('b'));
    await expect(page.locator('#coding-preview-codes')).toContainText('Manual theme b');
  }
  await page.locator('#open-learn-btn').click();
  await expect(page.locator('#coding-code-list')).toContainText(destination === 'pack' ? 'interview-b' : 'Manual theme b');
}

for (const destination of ['pack', 'account', 'signout']) {
  test(`a held POST cannot apply a late draft after ${destination} navigation`, async ({ page }) => {
    const gate = deferred();
    const mock = await fixture(page, { postGate: gate });
    try {
      await startRun(page);
      await expect.poll(() => mock.posts.length).toBe(1);
      await navigateAway(page, destination);
      mock.getState().latest_run.status = 'draft';
      const response = page.waitForResponse(item => item.url().endsWith('/interview-a/ai-runs'));
      gate.resolve();
      await (await response).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator('#coding-ai-panel')).toBeHidden();
      await expect(page.locator('#toast')).not.toContainText('AI coding draft ready.');
      if (destination !== 'signout') await expect(page.locator('#coding-ai-run-btn')).toBeEnabled();
      expect(mock.polls.filter(poll => poll.owner === 'a' && poll.packId === 'interview-a')).toEqual([]);
      expect(mock.browserErrors).toEqual([]);
    } finally { gate.resolve(); }
  });
}

for (const destination of ['pack', 'account']) {
  test(`a held poll cannot replace the next ${destination} or stop its run`, async ({ page }) => {
    const gate = deferred();
    const mock = await fixture(page);
    await startRun(page);
    mock.getState().latest_run.status = 'draft';
    mock.holdPoll(gate);
    try {
      await expect.poll(() => mock.polls.length).toBe(1);
      await navigateAway(page, destination);
      await startRun(page);
      await expect.poll(() => mock.posts.length).toBe(2);
      const response = page.waitForResponse(item => item.url().endsWith('/ai-runs/run-a-interview-a'));
      gate.resolve();
      await (await response).finished();
      await expect(page.locator('#coding-ai-panel')).toContainText('AI coding is running');
      await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
      await expect.poll(() => mock.polls.filter(poll => destination === 'pack' ? poll.packId === 'interview-b' : poll.owner === 'b').length).toBeGreaterThan(0);
      await expect(page.locator('#toast')).not.toContainText('AI coding draft ready.');
      expect(mock.browserErrors).toEqual([]);
    } finally { gate.resolve(); }
  });
}

for (const phase of ['POST', 'poll']) {
  test(`an account switch while ${phase} JSON is held cannot expose the old draft`, async ({ page }) => {
    const mock = await fixture(page, phase === 'poll' ? { initialStatus: 'processing' } : {});
    const match = phase === 'POST' ? '/interview-a/ai-runs' : '/ai-runs/run-a-interview-a';
    await page.evaluate(value => { window.codingJsonGate.match = value; }, match);
    if (phase === 'POST') await startRun(page);
    else mock.getState().latest_run.status = 'draft';
    await expect.poll(() => page.evaluate(() => window.codingJsonGate.entered)).toBe(1);
    try {
      await navigateAway(page, 'account');
      await page.evaluate(() => window.codingJsonGate.release());
      await expect(page.locator('#coding-code-list')).toContainText('Manual theme b');
      await expect(page.locator('#coding-code-list')).not.toContainText('Growing confidence a');
      await expect(page.locator('#coding-ai-panel')).not.toContainText('Growing confidence a');
      await expect(page.locator('#toast')).not.toContainText('AI coding draft ready.');
      expect(mock.posts.filter(post => post.owner === 'b')).toEqual([]);
      expect(mock.browserErrors).toEqual([]);
    } finally { await page.evaluate(() => { if (window.codingJsonGate.release) window.codingJsonGate.release(); }); }
  });
}

for (const failRead of [false, true]) {
  test(`stale coding load ${failRead ? 'failure' : 'success'} releases loading after a failed pack switch`, async ({ page }) => {
    const mock = await fixture(page), gate = deferred();
    await page.locator('#coding-close-btn').click();
    const before = mock.reads.length;
    mock.holdRead(gate, failRead);
    await page.locator('#open-learn-btn').click();
    await expect.poll(() => mock.reads.length).toBeGreaterThan(before);
    await page.locator('#coding-close-btn').click();
    mock.failNextPack();
    await page.locator('#pack-list [data-pack-id="interview-b"] [data-pack-open]').click();
    await expect(page.locator('#toast')).toContainText('Synthetic pack outage');
    await expect(page.locator('#pack-summary-title')).toHaveText('First interview');
    const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/interview-coding/packs/interview-a');
    gate.resolve();
    await (await response).finished();
    // This retained workspace has valid data; no fresh coding load is needed.
    await page.locator('#coding-ai-run-btn').evaluate(button => button.click());
    await expect(page.locator('#confirm-modal-overlay')).toBeVisible();
    await expect(page.locator('#confirm-modal-title')).toHaveText('Run AI Coding');
    expect(mock.posts).toEqual([]);
  });
}

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`a rejected start remains readable and retryable at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const reason = 'Too many AI coding requests. Please try again shortly.';
      const mock = await fixture(page, { initialStatus: 'failed', postError: 429, postErrorMessage: reason });
      await page.evaluate(value => window.LPTheme.apply({ theme: value }), theme);

      await startRun(page);

      await expect(page.locator('#coding-status')).toHaveText(reason);
      await expect(page.locator('#coding-status')).toBeInViewport();
      await expect(page.locator('#coding-ai-run-btn')).toBeEnabled();
      await expect(page.locator('#coding-close-btn')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`start-rejected-${theme}-${width}.png`), animations: 'disabled' });
      expect(mock.browserErrors).toEqual([]);
    });

    test(`pending coding is readable at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const mock = await fixture(page, { initialStatus: 'processing' });
      await page.evaluate(value => window.LPTheme.apply({ theme: value }), theme);
      await expect(page.locator('#coding-ai-panel')).toContainText('AI coding is running');
      await expect(page.locator('#coding-close-btn')).toBeInViewport();
      await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`pending-coding-${theme}-${width}.png`), animations: 'disabled' });
      expect(mock.browserErrors).toEqual([]);
    });
  }
}

test('a status poll preserves the focused manual code edit before autosave', async ({ page }) => {
  const mock = await fixture(page, { initialStatus: 'processing' }), gate = deferred();
  mock.holdPoll(gate);
  try {
    await expect.poll(() => mock.polls.length).toBe(1);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.locator('#coding-code-list [data-code-id="manual"]').click();
    await page.locator('#coding-edit-name').fill('New insight awaiting autosave');
    const response = page.waitForResponse(item => item.url().endsWith('/ai-runs/run-a-interview-a'));
    gate.resolve();
    await (await response).finished();
    await expect(page.locator('#coding-edit-name')).toHaveValue('New insight awaiting autosave');
    await expect(page.locator('#coding-edit-name')).toBeFocused();
    expect(mock.posts).toEqual([]);
  } finally { gate.resolve(); }
});

test('newer canonical draft wins over a held older processing poll', async ({ page }) => {
  const mock = await fixture(page, { initialStatus: 'processing' }), gate = deferred();
  mock.holdPoll(gate);
  try {
    await expect.poll(() => mock.polls.length).toBe(1);
    mock.getState().latest_run.status = 'draft';
    await page.locator('#coding-close-btn').click();
    await page.locator('#open-learn-btn').click();
    await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
    const response = page.waitForResponse(item => item.url().endsWith('/ai-runs/run-a-interview-a'));
    gate.resolve();
    await (await response).finished();
    await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
    await expect(page.locator('#coding-ai-run-btn')).toBeEnabled();
    expect(mock.posts).toEqual([]);
  } finally { gate.resolve(); }
});

test('a response for another run cannot replace the current generation', async ({ page }) => {
  const mock = await fixture(page, { initialStatus: 'processing' });
  mock.replaceNextPollRun({ ...mock.runFor('a', 'interview-a', 'draft'), run_id: 'different-run' });
  await expect(page.locator('[data-ai-run-retry]')).toBeVisible();
  await expect(page.locator('#coding-ai-panel')).not.toContainText('AI draft ready to review');
  await expect(page.locator('#coding-ai-run-btn')).toBeDisabled();
  mock.getState().latest_run.status = 'draft';
  await page.locator('[data-ai-run-retry]').click();
  await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
  expect(mock.posts).toEqual([]);
});
