const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

async function darkFixture(page) {
  await installAccountFixture(page);
  await page.route(/\/static\/js\/physio-launcher(?:\.min)?\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', path: require('node:path').resolve('static/js/physio-launcher.js') }));
  await page.addInitScript(() => {
    const value = JSON.stringify({ theme: 'dark', language: 'en' });
    localStorage.setItem('lp-preferences', value);
    localStorage.setItem('lp-preferences:a', value);
  });
  // This suite exercises appearance independently of account hydration. The
  // settings suite covers server persistence and account ownership separately.
  await page.route('**/static/js/preferences.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
}

for (const route of ['/', '/plan', '/study', '/lecture-notes', '/batch_mode', '/dashboard', '/buy_credits', '/voice-notes', '/physio', '/books', '/video-overlay-builder', '/faq']) {
  test(`dark appearance renders without light panels or overflow: ${route}`, async ({ page }, testInfo) => {
    await darkFixture(page);
    await page.goto(route);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      const result = await page.evaluate(() => {
        const bright = Array.from(document.querySelectorAll('body *')).filter(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const rgba = (style.backgroundColor.match(/[\d.]+/g) || []).map(Number);
          // Export canvases and embedded content intentionally retain their colors.
          if (element.closest('canvas, .book-canvas, .book-mini-cover, .overlay-canvas, .overlay-preview-text')) return false;
          return rect.width * rect.height > 8000 && rect.top < innerHeight && rect.bottom > 0
            && style.visibility !== 'hidden' && rgba[0] > 210 && rgba[1] > 210 && rgba[2] > 210 && (rgba[3] === undefined || rgba[3] > 0.8);
        }).map(element => element.className || element.tagName);
        return { bright, overflow: document.documentElement.scrollWidth > innerWidth + 1, colorScheme: getComputedStyle(document.documentElement).colorScheme };
      });
      expect(result).toEqual({ bright: [], overflow: false, colorScheme: 'dark' });
      await page.screenshot({ path: testInfo.outputPath(`dark-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    // No reload, lost form values, or markup replacement when appearance changes.
    const input = page.locator('input[type="text"]:visible').first();
    if (await input.count()) await input.fill('Retain this input');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lp:preferences-changed', { detail: { theme: 'light' } })));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    if (await input.count()) await expect(input).toHaveValue('Retain this input');
  });
}

test('dark shared controls provide legible semantic feedback and native dark inputs', async ({ page }) => {
  await darkFixture(page);
  await page.goto('/plan');
  const pairs = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    function luminance(hex) {
      const channels = hex.trim().slice(1).match(/.{2}/g).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    }
    return ['ink', 'muted', 'accent-ink', 'success-ink', 'warning-ink', 'danger-ink', 'violet-ink'].map(name => {
      const foreground = luminance(css.getPropertyValue(`--theme-${name}`));
      const surface = name.endsWith('-ink') ? name.replace('-ink', '-soft') : 'surface';
      const background = luminance(css.getPropertyValue(`--theme-${surface}`));
      return { name, contrast: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
    });
  });
  for (const pair of pairs) expect(pair.contrast, pair.name).toBeGreaterThanOrEqual(4.5);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.LPTheme.apply({ theme: 'light' }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('Physio launch transfers only appearance and language to the local workspace', async ({ page }) => {
  await darkFixture(page);
  await page.route('**/healthz', route => route.abort('connectionrefused'));
  await page.goto('/physio');
  const target = new URL(await page.locator('#physio-open-companion').getAttribute('href'));
  expect(target.searchParams.get('lp_theme')).toBe('dark');
  expect(target.searchParams.get('lp_language')).toBe('en');
  expect([...target.searchParams.keys()].sort()).toEqual(['lp_language', 'lp_theme']);
});

test('local clinical workspace applies transferred appearance and preserves owner authorization', async ({ page }, testInfo) => {
  const url = new URL(process.env.PHYSIO_COMPANION_URL);
  url.searchParams.set('lp_theme', 'dark');
  url.searchParams.set('lp_language', 'nl');
  url.hash = `owner_token=${encodeURIComponent(process.env.PHYSIO_COMPANION_OWNER_TOKEN)}`;
  await page.goto(url.href);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await expect(page.locator('#clinical-connection')).toHaveClass(/is-online/);
  expect(new URL(page.url()).search).toBe('');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`clinical-dark-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#clinical-connection')).toHaveClass(/is-online/);
});

test('printing a dark page restores light component colors', async ({ page }) => {
  await darkFixture(page);
  await page.goto('/plan');
  await expect(page.locator('.goal-health-card')).toHaveCSS('background-color', 'rgb(25, 35, 51)');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.goal-health-card')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(23, 35, 60)');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-ink').trim())).toBe('');
});
