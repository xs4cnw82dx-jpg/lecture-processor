const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

async function toolsFixture(page) {
  const fixture = await installAccountFixture(page);
  const saved = { a: [], b: [] };
  let failSave = false;
  await page.route('**/api/auth/user', (route) => {
    const uid = route.request().headers().authorization === 'Bearer token-b' ? 'b' : 'a';
    return route.fulfill({ json: { uid, email: uid + '@example.test', preferences: { favorite_tools: saved[uid] } } });
  });
  await page.route('**/api/user-preferences', (route) => {
    const uid = route.request().headers().authorization === 'Bearer token-b' ? 'b' : 'a';
    if (failSave) return route.fulfill({ status: 500, json: { error: 'Could not save favorites. Please try again.' } });
    saved[uid] = route.request().postDataJSON().favorite_tools;
    return route.fulfill({ json: { preferences: { favorite_tools: saved[uid] } } });
  });
  return { ...fixture, fail: () => { failSave = true; } };
}

test('favorites save, reorder, reload, and stay isolated between accounts', async ({ page }) => {
  const fixture = await toolsFixture(page);
  await page.goto('/tools');
  await expect(page.locator('#shell-tool-favorites')).toBeHidden();
  await page.getByRole('button', { name: 'Add Document Reader to favorites', exact: true }).click();
  await expect(page.locator('#hub-favorites-status')).toHaveText('Added to favorites.');
  await page.getByRole('button', { name: 'Add Image Reader to favorites', exact: true }).click();
  await expect(page.locator('#hub-favorites-status')).toHaveText('Added to favorites.');
  await page.getByRole('button', { name: 'Move Image Reader up', exact: true }).click();
  await expect(page.locator('#hub-favorites-list > li > a')).toHaveText(['Image Reader', 'Document Reader']);
  await expect(page.getByRole('button', { name: 'Move Image Reader down', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.locator('#shell-tool-favorites-links > a')).toHaveText(['Image Reader', 'Document Reader']);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#shell-tool-favorites')).toBeHidden();
  await expect(page.locator('#hub-favorites-list > li')).toHaveCount(0);
  await page.evaluate(() => window.testAccount.switchTo('a'));
  await expect(page.locator('#hub-favorites-list > li')).toHaveCount(2);
  fixture.fail();
  await page.locator('[data-tool-id="image-reader"] [data-favorite]').click();
  await expect(page.locator('#hub-favorites-status')).toContainText('Could not save favorites');
  await expect(page.locator('[data-tool-id="image-reader"] [data-favorite]')).toHaveAttribute('aria-pressed', 'true');
  expect(fixture.browserErrors).toEqual([]);
});

for (const width of [390, 1280]) {
  test(`tools search and category discovery work at ${width}px`, async ({ page }) => {
    await toolsFixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/tools');
    await expect(page.locator('[data-tool-id]:visible')).toHaveCount(14);
    await page.getByRole('button', { name: 'Read sources', exact: true }).click();
    await expect(page.locator('[data-tool-id]:visible')).toHaveCount(3);
    await page.getByRole('searchbox', { name: 'Search tools' }).fill('images');
    await expect(page.locator('[data-tool-id]:visible')).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Search tools' }).fill('nonexistent');
    await expect(page.locator('#hub-no-results')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await expect(page.locator('[data-tool-id]:visible')).toHaveCount(14);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/tools-hub-${width}.png`, fullPage: true });
  });
}
