const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

const notices = [
  ['admin-session-required', 'Your admin session expired. Open Admin again to reconnect.'],
  ['local-data-not-cleared', 'Some study data could not be cleared from this browser. Clear site data before sharing this device.'],
];

for (const [notice, message] of notices) {
  test(`${notice} explains navigation once without removing the remaining URL`, async ({ page }) => {
    const fixture = await installAccountFixture(page);
    await page.addInitScript(() => {
      localStorage.setItem('lp-preferences', JSON.stringify({ language: 'en', theme: 'light' }));
    });
    await page.goto(`/dashboard?keep=one%20two&notice=${notice}&tab=due&keep=second#recent-activity`);

    const alert = page.locator('#shell-toast');
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toHaveAttribute('aria-live', 'assertive');
    await expect(alert).toHaveClass(/visible/);
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(message);

    function remainingLocation() {
      const current = new URL(page.url());
      return { path: current.pathname, query: [...current.searchParams], hash: current.hash };
    }
    const expectedLocation = {
      path: '/dashboard', query: [['keep', 'one two'], ['tab', 'due'], ['keep', 'second']], hash: '#recent-activity',
    };
    expect(remainingLocation()).toEqual(expectedLocation);

    await page.reload();
    await page.waitForFunction(() => typeof window.LectureProcessorShell?.showToast === 'function');
    await expect(alert).not.toHaveClass(/visible/);
    await expect(alert).toHaveText('');
    expect(remainingLocation()).toEqual(expectedLocation);
    expect(fixture.browserErrors).toEqual([]);
  });
}
