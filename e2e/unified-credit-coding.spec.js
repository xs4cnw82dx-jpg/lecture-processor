const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test.use({ serviceWorkers: 'block' });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(page, options = {}) {
  const base = await installAccountFixture(page);
  const language = options.language || 'en';
  await page.addInitScript(value => {
    const preferences = JSON.stringify({ language: value, theme: 'light' });
    localStorage.setItem('lp-preferences', preferences);
    localStorage.setItem('lp-preferences:a', preferences);
  }, language);
  if (process.env.UNIFIED_CODING_SOURCE) {
    await page.route(/\/static\/js\/study(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', path: process.env.UNIFIED_CODING_SOURCE }));
  }
  const pack = { study_pack_id: 'coding-pack', title: 'Authored interview title', mode: 'interview',
    notes_markdown: '# Interview\n\nStudying together helped me gain confidence.', flashcards: [], test_questions: [], flashcards_count: 0 };
  const state = {
    pack_id: pack.study_pack_id, transcript: 'Studying together helped me gain confidence.', transcript_base_key: 'synthetic-transcript', segments: [],
    codes: [{ code_id: 'manual', name: 'Authored manual theme', color: 'teal', description: '' }],
    quotations: [], palette: [{ key: 'teal', hex: '#CCFBF1', label: 'Teal' }],
    ai_estimate: options.estimate || { credit_cost: 2, credit_scheme: 2, charged_credits: 2 },
    latest_run: options.initialRun || null, runs: [],
  };
  const requests = { posts: [], polls: [], codingReads: 0, profileReads: 0, balance: 20, profiles: [] };
  function envelope() {
    return { ok: true, run: state.latest_run, reused: !!options.reused,
      status_url: `/api/interview-coding/packs/coding-pack/ai-runs/${state.latest_run.run_id}` };
  }
  function run(status = 'queued') {
    return { run_id: 'synthetic-coding-run', pack_id: 'coding-pack', status,
      proposed_codes: [{ code_id: 'proposed', name: 'Authored proposed theme', color: 'teal' }], proposed_quotations: [],
      credit_refunded: status === 'failed', error: status === 'failed' ? 'AI coding could not be completed. Please try again.' : '' };
  }
  if (options.initialStatus) state.latest_run = run(options.initialStatus);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const uid = request.headers().authorization === 'Bearer token-b' ? 'b' : 'a';
    let body = {};
    if (pathname === '/api/auth/user') {
      requests.profileReads += 1;
      requests.profiles.push(uid);
      body = { uid, credits_version: 2, credits: uid === 'a' ? requests.balance : 37,
        credit_costs: { interview_coding: { category: 'slides', instant: 2, overnight: null } },
        unlimited_credits: { lecture: false, slides: state.ai_estimate.charged_credits === 0, interview: false },
        preferences: { interface_language: language, favorite_tools: [], onboarding_completed: true } };
    } else if (pathname === '/api/config') body = { bundles: {}, stripe_publishable_key: '' };
    else if (pathname === '/api/user-preferences') body = { preferences: { interface_language: language, theme: options.theme || 'light' } };
    else if (pathname === '/api/study-packs') body = { study_packs: [pack], has_more: false };
    else if (pathname === '/api/study-packs/coding-pack') body = pack;
    else if (pathname === '/api/study-folders') body = { folders: [] };
    else if (pathname === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (pathname.includes('progress')) body = { card_states: {}, daily_progress: {} };
    else if (pathname === '/api/interview-coding/packs/coding-pack/ai-runs' && request.method() === 'POST') {
      requests.posts.push({ uid, body: request.postDataJSON() });
      if (options.postGate) await options.postGate.promise;
      if (options.postError) return route.fulfill({ status: options.postError, json: options.errorPayload || { error: 'Synthetic rejection', needed: 8, available: 1 } });
      state.latest_run = state.latest_run || run();
      if (!options.reused) requests.balance = 20 - (state.ai_estimate.charged_credits ?? state.ai_estimate.credit_cost);
      return route.fulfill({ status: options.reused ? 200 : 202, json: envelope() });
    } else if (pathname === '/api/interview-coding/packs/coding-pack/codes/manual' && request.method() === 'PATCH') {
      Object.assign(state.codes[0], request.postDataJSON());
      body = { code: state.codes[0] };
    } else if (pathname.includes('/api/interview-coding/packs/coding-pack/ai-runs/')) {
      requests.polls.push(uid);
      body = envelope();
    } else if (pathname === '/api/interview-coding/packs/coding-pack') {
      requests.codingReads += 1;
      body = state;
    }
    return route.fulfill({ json: body });
  });
  await page.goto('/study?pack_id=coding-pack');
  await expect(page.locator('#pack-summary-title')).toHaveText(pack.title);
  await page.locator('#open-learn-btn').click();
  await expect(page.locator('#coding-code-list')).toContainText('Authored manual theme');
  return { ...base, state, requests, run };
}

async function expectBalance(page, amount, uid = 'a') {
  await expect.poll(() => page.evaluate(() => window.LectureProcessorShell.getCreditState())).toMatchObject({
    uid, status: 'ready', source: 'server', snapshot: { balance: amount },
  });
  expect(await page.evaluate(account => JSON.parse(localStorage.getItem(`lp_ui_v2:user:${account}:credit_snapshot`)).snapshot.balance, uid)).toBe(amount);
}

async function confirmRun(page) {
  await page.locator('#coding-ai-run-btn').click();
  await expect(page.locator('#confirm-modal-overlay')).toBeVisible();
  await page.locator('#confirm-modal-confirm').click();
}

for (const charged of [2, 0]) {
  test(`unified confirmation uses the authoritative ${charged}-credit charge while the public rollout is off`, async ({ page }) => {
    const mock = await fixture(page, { estimate: { credit_cost: 2, credit_scheme: 2, charged_credits: charged } });
    await page.locator('#coding-ai-run-btn').click();
    await expect(page.locator('#confirm-modal-overlay')).toBeVisible();
    await expect(page.locator('#confirm-modal-message')).toHaveText(`This will use ${charged} credits and create a draft you can review before applying.`);
    expect(mock.requests.posts).toHaveLength(0);
    expect(mock.browserErrors).toEqual([]);
  });
}

for (const charged of [2, 0]) {
  test(`Dutch unified confirmation localizes the ${charged}-credit amount`, async ({ page }) => {
    const mock = await fixture(page, { language: 'nl', estimate: { credit_cost: 2, credit_scheme: 2, charged_credits: charged } });
    await page.locator('#coding-ai-run-btn').click();
    await expect(page.locator('#confirm-modal-message')).toContainText(`${charged} credits`);
    await expect(page.locator('#confirm-modal-message')).toContainText('concept');
    await expect(page.locator('#confirm-modal-message')).not.toContainText('This will use');
    await expect(page.locator('#confirm-modal-message')).not.toContainText('tekstextractiecredit');
    expect(mock.requests.posts).toEqual([]);
    expect(mock.browserErrors).toEqual([]);
  });
}

for (const estimate of [{ credit_cost: 1, credit_scheme: 1, charged_credits: 1 }, { credit_cost: 2 }]) {
  test(`legacy estimate ${estimate.credit_cost} preserves the existing confirmation`, async ({ page }) => {
    const mock = await fixture(page, { estimate });
    await page.locator('#coding-ai-run-btn').click();
    await expect(page.locator('#confirm-modal-message')).toHaveText(`This will use ${estimate.credit_cost} text extraction credit${estimate.credit_cost === 1 ? '' : 's'} and create a draft you can review before applying.`);
    expect(mock.requests.posts).toEqual([]);
    expect(mock.browserErrors).toEqual([]);
  });
}

test('a zero gross quote still blocks coding without a transcript', async ({ page }) => {
  const mock = await fixture(page, { estimate: { credit_cost: 0, credit_scheme: 2, charged_credits: 0 } });
  await page.locator('#coding-ai-run-btn').click();
  await expect(page.locator('#toast')).toHaveText('No transcript available for AI coding.');
  await expect(page.locator('#confirm-modal-overlay')).toBeHidden();
  expect(mock.requests.posts).toEqual([]);
});

for (const language of ['en', 'nl']) for (const previous of ['none', 'draft']) {
  test(`a ${language} authoritative 402 preserves ${previous} draft state and manual input`, async ({ page }) => {
    const mock = await fixture(page, { language, initialStatus: previous === 'draft' ? 'draft' : undefined, postError: 402 });
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.locator('#coding-code-list [data-code-id="manual"]').click();
    await page.locator('#coding-edit-name').fill('Keep this authored edit');
    const savedRun = structuredClone(mock.state.latest_run);
    await confirmRun(page);
    const expected = language === 'nl'
      ? 'Niet genoeg credits. Nodig: 8 credits; beschikbaar: 1.'
      : 'Not enough credits. This needs 8 credits; 1 are available.';
    await expect(page.locator('#toast')).toHaveText(expected);
    await expect(page.locator('#coding-status')).toHaveText(expected);
    await expect(page.locator('#coding-edit-name')).toHaveValue('Keep this authored edit');
    await expect(page.locator('#coding-ai-run-btn')).toBeEnabled();
    if (previous === 'draft') await expect(page.locator('#coding-ai-panel')).toContainText('Authored proposed theme');
    expect(mock.state.latest_run).toEqual(savedRun);
    expect(mock.requests.posts).toHaveLength(1);
    await page.clock.runFor(1600);
    expect(mock.requests.polls).toHaveLength(0);
    expect(mock.browserErrors).toEqual([]);
  });
}

for (const charged of [2, 0]) {
  test(`accepted admission refreshes the balance after charging ${charged} and produces one background draft`, async ({ page }) => {
    const gate = deferred();
    const mock = await fixture(page, { estimate: { credit_cost: 2, credit_scheme: 2, charged_credits: charged }, postGate: gate });
    await expectBalance(page, 20);
    const before = mock.requests.profileReads;
    await confirmRun(page);
    await expect.poll(() => mock.requests.posts.length).toBe(1);
    await page.locator('#coding-ai-run-btn').evaluate(button => button.click());
    expect(mock.requests.posts).toHaveLength(1);
    gate.resolve();
    await expect.poll(() => mock.requests.profileReads).toBeGreaterThan(before);
    await expectBalance(page, 20 - charged);
    await expect.poll(() => mock.requests.polls.length).toBeGreaterThan(0);
    mock.state.latest_run.status = 'draft';
    await expect(page.locator('#coding-ai-panel')).toContainText('Authored proposed theme');
    await expect(page.locator('[data-ai-draft-action="accept"]')).toBeEnabled();
    expect(mock.requests.posts).toHaveLength(1);
    expect(mock.browserErrors).toEqual([]);
  });
}

test('confirmed terminal refund refreshes the shared balance without starting another run', async ({ page }) => {
  const mock = await fixture(page);
  await confirmRun(page);
  await expectBalance(page, 18);
  await expect.poll(() => mock.requests.polls.length).toBeGreaterThan(0);
  mock.state.latest_run.status = 'refund_pending';
  await expect(page.locator('#coding-ai-panel')).toContainText('Finishing credit refund');
  await expectBalance(page, 18);
  mock.requests.balance = 20;
  mock.state.latest_run = mock.run('failed');
  await expect(page.locator('#coding-status')).toContainText('has been refunded');
  await expectBalance(page, 20);
  await expect(page.locator('#coding-ai-run-btn')).toBeEnabled();
  expect(mock.requests.posts).toHaveLength(1);
  expect(mock.browserErrors).toEqual([]);
});

test('reused draft keeps its review content and balance', async ({ page }) => {
  const mock = await fixture(page, { initialStatus: 'draft', reused: true });
  const before = mock.requests.profileReads;
  await expect(page.locator('#coding-ai-panel')).toContainText('Authored proposed theme');
  await confirmRun(page);
  await expect.poll(() => mock.requests.profileReads).toBeGreaterThan(before);
  await expect(page.locator('#coding-ai-panel')).toContainText('Authored proposed theme');
  await expectBalance(page, 20);
  expect(mock.requests.posts).toHaveLength(1);
  expect(mock.requests.polls).toHaveLength(0);
  expect(mock.browserErrors).toEqual([]);
});

test('a late old-account admission cannot refresh or display the old balance', async ({ page }) => {
  const gate = deferred();
  const mock = await fixture(page, { postGate: gate });
  await confirmRun(page);
  await expect.poll(() => mock.requests.posts.length).toBe(1);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expectBalance(page, 37, 'b');
  const reads = mock.requests.profileReads;
  const response = page.waitForResponse(value => value.url().endsWith('/coding-pack/ai-runs'));
  gate.resolve();
  await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expectBalance(page, 37, 'b');
  expect(mock.requests.profileReads).toBe(reads);
  expect(mock.requests.polls).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('lp_ui_v2:user:a:credit_snapshot'))).toBeNull();
  expect(mock.browserErrors).toEqual([]);
});

for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
  test(`unified coding quote is readable in ${theme} at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const mock = await fixture(page, { theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('#coding-ai-run-btn').click();
    await expect(page.locator('#confirm-modal-message')).toHaveText('This will use 2 credits and create a draft you can review before applying.');
    for (const language of ['en', 'nl']) {
      await page.evaluate(value => window.LectureI18n.setLanguage(value), language);
      await expect(page.locator('#confirm-modal-confirm')).toBeInViewport();
      await expect(page.locator('#confirm-modal-cancel')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`coding-credits-${language}-${theme}-${width}.png`), animations: 'disabled' });
    }
    expect(mock.browserErrors).toEqual([]);
  });
}
