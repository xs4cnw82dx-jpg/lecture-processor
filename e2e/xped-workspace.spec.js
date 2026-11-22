const { test, expect } = require('@playwright/test');

async function signedIn(page) {
  await page.route('https://**/*', route => route.abort());
  await page.route('**/api/auth/user', route => route.fulfill({ json: {
    uid: 'author',
    credits: { lecture_standard: 0, lecture_extended: 0, slides: 0, interview_short: 0, interview_medium: 0, interview_long: 0 },
    unlimited_credits: { lecture: false, slides: false, interview: false },
  } }));
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

for (const width of [1280, 375]) {
  test('the current studio link opens on entry and honors manual toggles at ' + width + 'px', async ({ page }) => {
    await signedIn(page);
    await page.setViewportSize({ width, height: 812 });
    await page.route('**/api/elearning/expeditions', route => route.fulfill({ json: { expeditions: [expedition] } }));
    const openMenu = async () => {
      if (width === 375) await page.getByRole('button', { name: 'Open main navigation' }).click();
    };
    const group = page.getByRole('button', { name: 'Physio Assistant' });
    const current = page.getByRole('link', { name: 'xPEDitie Pijn Studio', current: 'page' });

    await page.goto('/physio/elearning');
    await openMenu();
    await expect(current).toBeVisible();
    await group.click();
    await expect(current).toBeHidden();

    await page.reload();
    await openMenu();
    await expect(current).toBeVisible();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await group.click();
    await page.evaluate(() => window.LectureProcessorShell.refreshCredits());
    await expect(current).toBeHidden();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await group.click();
    await page.evaluate(() => window.LectureProcessorShell.refreshCredits());
    await expect(current).toBeVisible();
  });
}

test('creation requires an author-supplied title and opens the chosen expedition', async ({ page }) => {
  await signedIn(page);
  const created = [];
  await page.route('**/api/elearning/expeditions', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { expeditions: [expedition] } });
    created.push(route.request().postDataJSON());
    return route.fulfill({ json: { expedition: { id: 'new-course' } } });
  });
  await page.goto('/physio/elearning');
  await page.getByRole('button', { name: 'New expedition' }).click();
  const title = page.getByLabel('Expedition Title');
  await expect(title).toBeFocused();
  await expect(title).toHaveValue('');
  for (const blank of ['', '   ']) {
    await title.fill(blank);
    await page.getByRole('button', { name: 'Create & Open Builder' }).click();
    await expect(title).toBeFocused();
    expect(await title.evaluate(input => input.checkValidity())).toBe(false);
  }
  expect(created).toHaveLength(0);
  await title.fill('  Pijn begrijpen  ');
  const language = page.locator('#el-new-lang');
  await expect(language.locator('option')).toHaveText(['Nederlands (NL)', 'English (EN)', 'Deutsch (DE)']);
  await page.getByRole('button', { name: /Primary Authoring Language/ }).click();
  await page.getByRole('option', { name: 'Deutsch (DE)' }).click();
  await page.getByRole('button', { name: /Starting Structure/ }).click();
  await page.getByRole('option', { name: 'Three-station outline' }).click();
  await title.press('Enter');
  await expect(page).toHaveURL(/\/physio\/elearning\/new-course\/edit$/);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ title: 'Pijn begrijpen', defaultLanguage: 'de' });
  expect(created[0].modules).toHaveLength(3);
});

test('a clinical workspace subpage reveals the clinical link in the same group', async ({ page }) => {
  await signedIn(page);
  await page.goto('/physio/knowledge');
  await expect(page.getByRole('link', { name: 'Clinical workspace', current: 'page' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Physio Assistant' })).toHaveAttribute('aria-expanded', 'true');
});
