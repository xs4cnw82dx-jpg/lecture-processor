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
