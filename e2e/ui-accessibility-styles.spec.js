const { test, expect } = require('@playwright/test');

const NOTES = 'A steady heartbeat supports healthy circulation.';

async function installLibrary(page, theme = 'light') {
  const packs = Array.from({ length: 20 }, (_, index) => ({
    study_pack_id: `synthetic-${index}`, title: `Anatomy topic ${index + 1}`, mode: 'manual', folder_id: '',
    notes_markdown: `# Circulation\n\n${NOTES}`, flashcards_count: 1, test_questions_count: 0,
    flashcards: [{ front: 'What supports circulation?', back: 'A steady heartbeat.' }], test_questions: [],
  }));
  await page.addInitScript(({ theme }) => {
    const user = { uid: 'style-fixture', email: 'style@example.test', getIdToken: () => Promise.resolve('fixture-token') };
    const auth = {
      currentUser: user, setPersistence: () => Promise.resolve(), authStateReady: () => Promise.resolve(),
      onAuthStateChanged: callback => { queueMicrotask(() => callback(user)); return () => {}; },
    };
    function factory() { return auth; }
    factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: factory };
    for (const key of ['lp-preferences', 'lp-preferences:style-fixture']) {
      localStorage.setItem(key, JSON.stringify({ theme, language: 'en' }));
    }
  }, { theme });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let payload = {};
    if (path === '/api/auth/user') payload = { uid: 'style-fixture', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/user-preferences') payload = { preferences: { interface_language: 'en', theme } };
    else if (path === '/api/study-folders') payload = { folders: [] };
    else if (path === '/api/study-plan/membership') payload = { pack_ids: [] };
    else if (path === '/api/runtime-jobs/active') payload = { jobs: [] };
    else if (path === '/api/study-packs') payload = { study_packs: packs, has_more: false };
    else if (path.startsWith('/api/study-packs/')) {
      const pack = packs.find(item => item.study_pack_id === path.split('/').pop());
      if (pack) {
        if (request.method() === 'PATCH') Object.assign(pack, request.postDataJSON());
        payload = pack;
      }
    } else if (path.includes('study-progress')) payload = { card_states: {}, daily_progress: {} };
    return route.fulfill({ json: payload });
  });
}

function contrastRatio(foreground, background) {
  function luminance(color) {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      value /= 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  }
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + .05) / (Math.min(...values) + .05);
}

// Render the actual styles with small component examples so every page-specific
// focus rule is exercised without depending on unrelated page API contracts.
async function renderStyles(page, styles, markup, theme = 'light') {
  await page.route('**/__accessibility-styles', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1">
      ${['shared-ui', 'app-shell', ...styles, 'theme'].map(name => `<link rel="stylesheet" href="/static/css/${name}.css">`).join('')}
      </head><body style="padding:32px;background:var(--theme-surface,#fff)">${markup}</body></html>`,
  }));
  await page.goto('/__accessibility-styles');
}

test('twenty Library checkboxes remain inside their scroll container', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installLibrary(page);
  await page.goto('/study');
  await expect(page.locator('#pack-list [data-pack-select]')).toHaveCount(20);
  const geometry = await page.evaluate(() => ({
    rootHeight: document.documentElement.scrollHeight, bodyHeight: document.body.scrollHeight,
    pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
  }));
  expect(geometry.rootHeight, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.bodyHeight + 2);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  await page.locator('#pack-list [data-pack-select]').last().check({ force: true });
  await expect(page.locator('#pack-list [data-pack-select]').last()).toBeChecked();
});

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`Library highlights and controls are legible at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await installLibrary(page, theme);
      await page.goto('/study?pack_id=synthetic-0');
      await expect(page.locator('#notes-view p')).toHaveText(NOTES);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const swatch = page.locator('[data-hl-color="yellow"]');
      await swatch.click();
      await page.locator('#notes-view p').evaluate(paragraph => {
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      const highlight = page.locator('#notes-view mark[data-hl]');
      await expect(highlight).toHaveText(NOTES);
      const colors = await highlight.evaluate(element => {
        const style = getComputedStyle(element);
        return { foreground: style.color, background: style.backgroundColor };
      });
      expect.soft(contrastRatio(colors.foreground, colors.background), JSON.stringify(colors)).toBeGreaterThanOrEqual(4.5);
      for (const color of ['yellow', 'green', 'blue', 'pink']) {
        const box = await page.locator(`[data-hl-color="${color}"]`).boundingBox();
        expect.soft(box.width, `${color} hit width`).toBeGreaterThanOrEqual(32);
        expect.soft(box.height, `${color} hit height`).toBeGreaterThanOrEqual(32);
      }
      await page.keyboard.press('Tab');
      await swatch.focus();
      await page.screenshot({ path: testInfo.outputPath(`library-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    });
  }

  test(`closed mobile sidebar casts no shadow in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await installLibrary(page, theme);
    await page.goto('/study');
    const sidebar = page.locator('.app-shell-sidebar');
    await expect(sidebar).toHaveCSS('box-shadow', 'none');
    await page.getByRole('button', { name: 'Open main navigation', exact: true }).click();
    await expect(page.locator('.app-shell')).toHaveClass(/sidebar-open/);
    await expect(sidebar).not.toHaveCSS('box-shadow', 'none');
    await page.keyboard.press('Escape');
    await expect(sidebar).toHaveCSS('box-shadow', 'none');
  });
}

const focusExamples = [
  { sheet: 'shared-ui', markup: '<button data-focus>Button</button><input data-focus class="app-toggle" type="checkbox"><div class="app-select-upgraded"><button data-focus class="app-select-button">Select</button><button data-focus class="app-select-item">Option</button></div><details class="app-disclosure"><summary data-focus>Details</summary></details>' },
  { sheet: 'app-shell', markup: '<div class="shell-modal-field"><input data-focus aria-label="Name"></div>' },
  { sheet: 'study', markup: '<button data-focus class="folder-collapse-btn">Folder</button><button data-focus class="pack-row-open">Pack</button><button data-focus class="peek-row">Card</button><button data-focus class="lesson-card">Lesson</button>' },
  { sheet: 'study-plan', markup: '<div class="study-plan-page"><button data-focus class="btn">Continue</button><button data-focus class="pretty-option">Option</button><button data-focus class="calendar-provider">Calendar</button><div class="plan-field"><input data-focus aria-label="Date"></div></div>' },
  { sheet: 'reader', markup: '<div class="reader-page"><button data-focus>Read</button></div>' },
  { sheet: 'dashboard', markup: '<button data-focus class="hero-btn">Open</button><button data-focus class="dashboard-text-action">Details</button>' },
  { sheet: 'index', markup: '<button data-focus class="file-download">Download</button><button data-focus class="upload-zone">Upload</button><input data-focus class="form-input" aria-label="Title">' },
  { sheet: 'physio-launcher', markup: '<div class="physio-launcher"><button data-focus>Open workspace</button></div>' },
  { sheet: 'physio-local', markup: '<div class="clinical-app"><button data-focus>Save</button><input data-focus type="checkbox" aria-label="Selected"></div>' },
  { sheet: 'batch-dashboard', markup: '<button data-focus class="bs-button">Retry</button><button data-focus class="bs-tab">Details</button>' },
  { sheet: 'book-studio', markup: '<div class="book-app"><button data-focus>Save</button><button data-focus class="book-path-point" aria-label="Point" style="position:relative;margin:30px"></button></div>' },
  { sheet: 'plan', markup: '<input data-focus class="input" aria-label="Date">' },
  { sheet: 'calendar', markup: '<input data-focus class="input" aria-label="Date">' },
  { sheet: 'tools-hub', markup: '<div class="tools-hub-page"><button data-focus>Open tool</button></div>' },
  { sheet: 'study-pictures', markup: '<button data-focus class="study-picture-open">Picture</button>' },
  { sheet: 'video-overlay-builder', markup: '<div class="overlay-zoom-controls"><input data-focus aria-label="Zoom"></div>' },
];

for (const theme of ['light', 'dark']) {
  test(`page focus indicators are opaque two-pixel outlines in ${theme}`, async ({ page }) => {
    for (const example of focusExamples) {
      await renderStyles(page, [example.sheet], example.markup, theme);
      await page.keyboard.press('Tab');
      for (const control of await page.locator('[data-focus]').all()) {
        await control.focus();
        const label = `${example.sheet}: ${await control.getAttribute('class') || await control.getAttribute('aria-label') || 'control'}`;
        // Existing transitions may interpolate the outline briefly. Assert the
        // finished computed state without a timing-dependent sleep.
        await expect.poll(() => control.evaluate(element => {
          const style = getComputedStyle(element);
          return { width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset, color: style.outlineColor };
        }), { message: label, timeout: 1500 }).toEqual({ width: '2px', style: 'solid', offset: '2px', color: theme === 'dark' ? 'rgb(155, 188, 255)' : 'rgb(37, 88, 217)' });
        const focus = await control.evaluate(element => {
          const style = getComputedStyle(element);
          return { visible: element.matches(':focus-visible'), width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset, color: style.outlineColor, surface: getComputedStyle(document.body).backgroundColor };
        });
        expect.soft(focus.visible, label).toBe(true);
        expect.soft(contrastRatio(focus.color, focus.surface), label).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test(`skip link stays offscreen until keyboard focus in ${theme}`, async ({ page }) => {
    await renderStyles(page, [], '<a class="skip-link" href="#main-content">Skip to content</a><button>Navigation</button><main id="main-content" tabindex="-1">Main content</main>', theme);
    const link = page.getByRole('link', { name: 'Skip to content' });
    let box = await link.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(0);
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    box = await link.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    const colors = await link.evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });
}

test('shared controls inherit font size, weight and line height', async ({ page }) => {
  await renderStyles(page, [], '<div id="parent" style="font:600 20px/30px serif"><button id="button">Inherit text metrics</button></div>');
  const metrics = await page.evaluate(() => {
    const properties = ['fontSize', 'fontWeight', 'lineHeight', 'fontFamily'];
    const read = id => Object.fromEntries(properties.map(property => [property, getComputedStyle(document.getElementById(id))[property]]));
    return { parent: read('parent'), button: read('button') };
  });
  expect(metrics.button).toEqual(metrics.parent);
});

test('dark support links and editor selection borders use the contrasting accent', async ({ page }) => {
  await renderStyles(page, ['support-pages'], '<a id="support-link" href="#help">Help</a>', 'dark');
  await expect(page.locator('#support-link')).toHaveCSS('color', 'rgb(155, 188, 255)');
  await renderStyles(page, ['book-studio', 'book-color-picker'], '<button class="book-color-trigger" aria-expanded="true">Color</button><button class="book-path-point" style="position:relative;margin:30px" aria-label="Point"></button><div class="book-color-popover"><input aria-label="Hex color" data-color-control="hex" aria-invalid="true"></div>', 'dark');
  await expect(page.locator('.book-color-trigger')).toHaveCSS('border-top-color', 'rgb(155, 188, 255)');
  await expect(page.locator('.book-path-point')).toHaveCSS('border-top-color', 'rgb(155, 188, 255)');
  await expect(page.getByRole('textbox', { name: 'Hex color' })).toHaveCSS('border-top-color', 'rgb(255, 165, 176)');
});

for (const theme of ['light', 'dark']) {
  test(`Features calculator sliders show a clear keyboard focus ring in ${theme}`, async ({ page }) => {
    await installLibrary(page, theme);
    await page.goto('/features');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('#calculator > summary').click();
    await page.keyboard.press('Tab');
    for (const name of ['Lectures per week', 'Weeks per semester', 'Minutes per lecture (manual notes)', 'Minutes per lecture (upload, review & correction)']) {
      const slider = page.getByRole('slider', { name, exact: true });
      await slider.focus();
      await expect(slider).toBeFocused();
      await expect(slider).toHaveCSS('outline-width', '2px');
      await expect(slider).toHaveCSS('outline-style', 'solid');
      await expect(slider).toHaveCSS('outline-offset', '2px');
      await expect(slider).toHaveCSS('outline-color', theme === 'dark' ? 'rgb(155, 188, 255)' : 'rgb(37, 88, 217)');
      const before = Number(await slider.inputValue());
      const step = Number(await slider.getAttribute('step') || 1);
      await page.keyboard.press('ArrowRight');
      await expect(slider).toHaveValue(String(before + step));
    }
  });
}

for (const sheet of ['calendar', 'plan', 'study']) {
  test(`${sheet} date picker today ring stays visible in dark mode`, async ({ page }) => {
    await renderStyles(page, [sheet], '<button class="flatpickr-day today">14</button>', 'dark');
    const shadow = await page.locator('.flatpickr-day').evaluate(element => getComputedStyle(element).boxShadow);
    expect(shadow).toContain('rgb(155, 188, 255)');
  });
}
