const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

for (const [route, button] of [['/lecture-notes', '#output-language-button'], ['/batch_mode', '#output-language-button'], ['/general-transcriber', '#transcriber-output-language-button']]) {
  test(`output language picker on ${route} is named by its visible label`, async ({ page }) => {
    await installAccountFixture(page);
    await page.goto(route);
    const name = await page.locator(button).evaluate(element => (element.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => document.getElementById(id)).filter(Boolean).map(node => node.textContent.trim()).join(' '));
    expect(name).toMatch(/Output language.*English/i);
  });
}

test('placeholder-only fields have real labels', async ({ page }) => {
  await installAccountFixture(page);
  await page.goto('/study');
  await expect(page.locator('label[for="coding-edit-name"]')).toHaveText('Code name');
  await expect(page.locator('label[for="coding-edit-description"]')).toHaveText('Description');
  await page.goto('/lecture-notes');
  await expect(page.locator('#output-language-custom')).toHaveAttribute('aria-label', 'Custom output language');
});

test.describe('touch screens', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('button-like controls are at least 44px', async ({ page }) => {
    await installAccountFixture(page);
    await page.goto('/dashboard');
    for (const selector of ['#app-shell-menu-btn', '#shell-credits-link', '.hero-btn']) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box.height, selector).toBeGreaterThanOrEqual(44);
    }
    const menu = await page.locator('#app-shell-menu-btn').boundingBox();
    expect(menu.width).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
});

test.describe('mouse screens', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('the touch minimum does not apply to precise pointers', async ({ page }) => {
    await installAccountFixture(page);
    await page.goto('/dashboard');
    const box = await page.locator('#shell-credits-link').boundingBox();
    expect(box.height).toBeLessThan(44);
  });
});

test('shared dropdowns follow values set in code, not only clicks', async ({ page }) => {
  await installAccountFixture(page);
  await page.goto('/batch_dashboard');
  const result = await page.evaluate(() => {
    const select = document.getElementById('batch-dashboard-mode-filter');
    const label = () => document.getElementById(select.id + '-value').textContent.trim();
    const target = select.options[select.options.length - 1];
    select.value = target.value;
    const afterValue = label();
    select.selectedIndex = 0;
    return { expected: target.textContent.trim(), afterValue, afterIndex: label(), first: select.options[0].textContent.trim() };
  });
  expect(result.afterValue).toBe(result.expected);
  expect(result.afterIndex).toBe(result.first);
});

test.describe('batch modes on phones', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('mode tabs stay one scrollable row and the shell title stays short', async ({ page }) => {
    await installAccountFixture(page);
    await page.goto('/batch_mode_text_combine');
    const tops = await page.locator('.mode-links .mode-link').evaluateAll(links => links.map(link => Math.round(link.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    await expect(page.locator('.mode-links .mode-link.active')).toBeInViewport();
    await expect(page.locator('.app-shell-title')).toHaveText('Batch');
    expect(await page.locator('.app-shell-title').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
});

test('the shared toast keeps errors readable, pauses on hover and replaces older messages', async ({ page }) => {
  await installAccountFixture(page);
  await page.goto('/dashboard');
  await page.clock.install();
  const state = () => page.evaluate(() => { const el = document.querySelector('.app-toast'); return el ? { visible: el.classList.contains('visible'), text: el.textContent, role: el.getAttribute('role') } : null; });
  await page.evaluate(() => window.LectureProcessorUx.toast('Saved', { type: 'success' }));
  await page.evaluate(() => window.LectureProcessorUx.toast('Could not save', { type: 'error', duration: 1000 }));
  expect(await state()).toEqual({ visible: true, text: 'Could not save', role: 'alert' });
  await page.clock.runFor(5000);
  expect((await state()).visible).toBe(true);
  await page.locator('.app-toast').hover();
  await page.clock.runFor(10000);
  expect((await state()).visible).toBe(true);
  await page.mouse.move(0, 0);
  await page.clock.runFor(2500);
  expect((await state()).visible).toBe(false);
});
