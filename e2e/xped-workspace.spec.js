const { test, expect } = require('@playwright/test');

async function signedIn(page) {
  await page.route('https://**/*', route => route.abort());
  await page.route('**/static/js/firebase-bootstrap.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `const listeners = [];
      const makeUser = uid => uid && ({ uid, getIdToken: async () => uid });
      const auth = {
        currentUser: makeUser('author'),
        onAuthStateChanged(fn) { listeners.push(fn); queueMicrotask(() => fn(auth.currentUser)); return () => {}; }
      };
      window.switchAccount = uid => { auth.currentUser = makeUser(uid); listeners.forEach(fn => fn(auth.currentUser)); };
      window.firebase = {auth: () => auth};
      window.LectureProcessorBootstrap = {getAuth: () => auth, onAuthStateReady: (a, fn) => a.onAuthStateChanged(fn)};`,
  }));
}

const expedition = {
  id: 'studio-course', title: 'Example course', role: 'owner',
  enabledLanguages: ['nl', 'de'], moduleCount: 3, stepCount: 5, shareEnabled: false,
};

test('library exposes editing and response links, and an account change clears the open dialog', async ({ page }) => {
  await signedIn(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/api/elearning/expeditions', route => route.fulfill({ json: { expeditions: [expedition] } }));
  await page.goto('/physio/elearning');
  await expect(page.getByRole('heading', { name: 'Example course' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Builder' })).toHaveAttribute('href', '/physio/elearning/studio-course/edit');
  await expect(page.getByRole('link', { name: 'Responses', exact: true })).toHaveAttribute('href', '/physio/elearning/studio-course/responses');
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'More actions' }).press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Example course');
  await page.evaluate(() => window.switchAccount(null));
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('main')).not.toContainText('Example course');
  await expect(page.locator('#el-signin')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New expedition' })).toBeHidden();
});

test('a late report cannot display learner responses after sign-out', async ({ page }) => {
  await signedIn(page);
  let finish;
  const started = new Promise(resolve => {
    page.route('**/api/elearning/expeditions/studio-course/responses', async route => {
      resolve();
      await new Promise(release => { finish = release; });
      await route.fulfill({ json: { expedition, pilotFeedback: [{comment: 'Private response'}] } });
    });
  });
  await page.goto('/physio/elearning/studio-course/responses');
  await started;
  await page.evaluate(() => window.switchAccount(null));
  const done = page.waitForResponse(response => response.url().endsWith('/api/elearning/expeditions/studio-course/responses'));
  finish();
  await done;
  await expect(page.locator('#el-signin')).toBeVisible();
  await expect(page.locator('#el-response-report')).toBeHidden();
  await expect(page.locator('main')).not.toContainText('Private response');
});

test('a failed list can be retried and a create failure keeps the form editable', async ({ page }) => {
  await signedIn(page);
  let attempts = 0;
  await page.route('**/api/elearning/expeditions', route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 503, json: { error: 'Try saving again.' } });
    if (++attempts === 1) return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
    return route.fulfill({ json: { expeditions: [] } });
  });
  await page.goto('/physio/elearning');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Create your first expedition' })).toBeVisible();
  await page.getByRole('button', { name: 'New expedition' }).click();
  await page.getByLabel('Expedition Title').fill('Example draft');
  await page.getByRole('button', { name: 'Create & Open Builder' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Try saving again.');
  await expect(page.getByLabel('Expedition Title')).toHaveValue('Example draft');
  await expect(page.getByRole('button', { name: 'Create & Open Builder' })).toBeEnabled();
});
