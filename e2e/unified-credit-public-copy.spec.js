const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

test('the pricing FAQ opens the visible unified action guide', async ({ page }) => {
  await installAccountFixture(page);
  await page.goto('/FAQ');
  await page.getByText('How much does processing cost?', { exact: true }).click();
  await page.getByRole('link', { name: 'credit guide', exact: true }).click();
  const anchor = await page.evaluate(() => location.hash);
  await expect(page.locator(anchor)).toBeVisible();
  await expect(page.locator('#credit-cost-guide')).toContainText('What each action costs');
});

for (const [width, language, theme] of [
  [1440, 'en', 'light'], [1440, 'nl', 'dark'],
  [375, 'en', 'dark'], [375, 'nl', 'light'],
]) {
  test(`public credit guidance renders ${language} ${theme} at ${width}px`, async ({ page }, testInfo) => {
    const setup = await installAccountFixture(page);
    await page.setViewportSize({ width, height: 950 });
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('lp-preferences', JSON.stringify({ language, theme }));
    }, { language, theme });
    for (const [url, expected] of [
      ['/helpcenter', language === 'nl' ? 'Eén creditsaldo geldt voor al je verwerkingstools.' : 'One credit balance covers your processing tools.'],
      ['/FAQ', language === 'nl' ? 'Elke nachtelijke batchactie kost precies de helft' : 'Each overnight batch action costs exactly half'],
      ['/features', language === 'nl' ? 'Optionele samenvattingen en ingedeelde transcripties' : 'Optional summaries and sectioned transcripts'],
      ['/terms', language === 'nl' ? 'Verwerkingstools gebruiken één gedeeld creditsaldo.' : 'Processing tools use one shared credit balance.'],
    ]) {
      await page.goto(url);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      if (url === '/FAQ') await page.getByText(language === 'nl' ? 'Hoe werken de nachtelijke tarieven?' : 'How does overnight pricing work?', { exact: true }).click();
      await expect(page.locator('body')).toContainText(expected);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${url.slice(1).toLowerCase()}-${language}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    expect(setup.browserErrors).toEqual([]);
  });
}
