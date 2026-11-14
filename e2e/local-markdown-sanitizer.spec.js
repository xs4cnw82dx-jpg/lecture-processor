const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

const markdown = '# Example notes\n\nKeep **important details** and a [reference](https://example.test/reference).\n\n- First item\n- Second item';
const pack = {
  study_pack_id: 'sanitizer-example', title: 'Example notes', mode: 'manual',
  notes_markdown: markdown, flashcards: [], test_questions: [],
  flashcards_count: 0, test_questions_count: 0,
};

async function installOfflineFixture(page) {
  const fixture = await installAccountFixture(page);
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort('failed'));
  await page.route('https://browser.sentry-cdn.com/**', route => route.abort('failed'));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    let payload = {};
    if (path === '/api/auth/user') payload = {
      uid: 'a', allowed: true, email_verified: true, onboarding_completed: true,
      preferences: { onboarding_completed: true, output_language: 'english' },
    };
    else if (path === '/api/verify-email') payload = { allowed: true };
    else if (path === '/api/user-preferences') payload = { preferences: { interface_language: 'en' } };
    else if (path === '/api/study-packs') payload = { study_packs: [pack], has_more: false };
    else if (path === '/api/study-packs/sanitizer-example') payload = pack;
    else if (path === '/api/study-folders') payload = { folders: [] };
    else if (path === '/api/study-plan/membership') payload = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (path === '/api/shared/sanitizer-example') payload = { entity_type: 'pack', study_pack: pack };
    else if (path.includes('study-progress')) payload = { card_states: {}, daily_progress: {} };
    return route.fulfill({ json: payload });
  });
  return fixture;
}

async function expectFormattedNotes(locator) {
  await expect(locator.locator('h1')).toHaveText('Example notes');
  await expect(locator.locator('strong')).toHaveText('important details');
  await expect(locator.locator('ul li')).toHaveText(['First item', 'Second item']);
  await expect(locator.getByRole('link', { name: 'reference' })).toHaveAttribute('href', 'https://example.test/reference');
}

for (const path of ['/lecture-notes', '/study', '/shared/sanitizer-example']) {
  test(`${path} renders formatted safe content while jsDelivr is unavailable`, async ({ page }) => {
    const fixture = await installOfflineFixture(page);
    await page.goto(path);
    await page.evaluate(source => {
      const markdownHost = document.createElement('section');
      markdownHost.id = 'markdown-fixture';
      markdownHost.innerHTML = window.LectureProcessorMarkdown.parseMarkdownToSafeHtml(source);
      document.querySelector('main').append(markdownHost);
      const htmlHost = document.createElement('section');
      htmlHost.id = 'html-fixture';
      window.LectureProcessorHtml.setSafeInnerHtml(htmlHost,
        '<strong>Retained text</strong><img src="invalid-image" onerror="window.unexpectedMarkupRan=true">'
        + '<a href="javascript:window.unexpectedMarkupRan=true">Unsafe link</a>'
        + '<script>window.unexpectedMarkupRan=true</script>',
        { ALLOWED_TAGS: ['strong', 'a'], ALLOWED_ATTR: ['href'] });
      document.querySelector('main').append(htmlHost);
    }, markdown);
    await expectFormattedNotes(page.locator('#markdown-fixture'));
    const safeHtml = page.locator('#html-fixture');
    await expect(safeHtml.locator('strong')).toHaveText('Retained text');
    await expect(safeHtml.locator('a')).toHaveText('Unsafe link');
    await expect(safeHtml.locator('a')).not.toHaveAttribute('href');
    await expect(safeHtml.locator('script, img, [onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => window.unexpectedMarkupRan)).toBeUndefined();
    expect(await page.evaluate(() => window.DOMPurify.version)).toBe('3.3.2');
    expect(fixture.browserErrors).toEqual([]);
  });
}

for (const [path, selector] of [
  ['/study?pack_id=sanitizer-example', '#notes-view'],
  ['/shared/sanitizer-example', '#shared-notes-view'],
]) {
  test(`${path} keeps its actual notes formatted without jsDelivr`, async ({ page }, testInfo) => {
    const fixture = await installOfflineFixture(page);
    await page.goto(path);
    await expectFormattedNotes(page.locator(selector));
    await expect.poll(() => page.evaluate(() => window.LecturePreferences.get().ready)).toBe(true);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await expectFormattedNotes(page.locator(selector));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.locator(selector).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`notes-${theme}-${width}.png`), animations: 'disabled' });
      }
    }
    expect(fixture.browserErrors).toEqual([]);
  });
}
