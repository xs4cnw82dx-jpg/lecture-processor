const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

async function loginFixture(page, options = {}) {
  const calls = [];
  const errors = [];
  const pending = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ verified, restored }) => {
    const listeners = [];
    window.tokenRefreshes = [];
    window.firebaseSignIns = 0;
    const user = {
      uid: 'login-student', email: 'student@gmail.com', displayName: 'Login Student',
      emailVerified: verified, providerData: [{ providerId: 'password' }],
      getIdToken: async (force) => { window.tokenRefreshes.push(!!force); return 'fixture-token'; },
      reload: async () => { user.emailVerified = true; },
    };
    const auth = {
      currentUser: restored ? user : null,
      setPersistence: async () => {},
      onAuthStateChanged(callback) {
        listeners.push(callback);
        queueMicrotask(() => callback(auth.currentUser));
        return () => {};
      },
      async signInWithEmailAndPassword() {
        window.firebaseSignIns++;
        auth.currentUser = user;
        listeners.forEach((callback) => callback(user));
        return { user };
      },
      async signInWithPopup() { return auth.signInWithEmailAndPassword(); },
      async signOut() { auth.currentUser = null; listeners.forEach((callback) => callback(null)); },
    };
    const factory = () => auth;
    factory.Auth = { Persistence: { LOCAL: 'local' } };
    factory.GoogleAuthProvider = function () {};
    window.firebase = { app: () => ({}), auth: factory };
    window.loginTestAuth = auth;
  }, { verified: options.verified !== false, restored: !!options.restored });
  await page.route('https://www.gstatic.com/firebasejs/**', (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    calls.push(pathname);
    if ((options.hold || []).includes(pathname)) {
      await new Promise((resolve) => pending.push({ pathname, resolve }));
    }
    const payload = pathname === '/api/verify-email'
      ? { allowed: options.allowed !== false, message: 'This email is not allowed.' }
      : pathname === '/api/auth/user'
        ? { uid: 'login-student', credits: {}, is_admin: !!options.admin, preferences: { onboarding_completed: true } }
        : { ok: true, jobs: [], summary: {} };
    await route.fulfill({ status: pathname === '/api/session/login' ? (options.sessionStatus || 200) : 200,
      contentType: 'application/json', body: JSON.stringify(payload) });
  });
  return { calls, errors, release: (pathname) => {
    for (let index = pending.length - 1; index >= 0; index--) {
      if (!pathname || pending[index].pathname === pathname) pending.splice(index, 1)[0].resolve();
    }
  } };
}

async function submitEmail(page, next = '') {
  await page.goto('/lecture-notes?auth=signin' + (next ? '&next=' + encodeURIComponent(next) : ''));
  await page.locator('#signin-email').fill('student@gmail.com');
  await page.locator('#signin-password').fill('fixture-password');
  await page.locator('#signin-submit').click();
}

for (const method of ['email', 'google']) {
  test(`${method} login completes while profile and jobs are still loading`, async ({ page }) => {
    const fixture = await loginFixture(page, { hold: ['/api/auth/user', '/api/runtime-jobs/active'] });
    try {
      if (method === 'email') await submitEmail(page);
      else {
        await page.goto('/lecture-notes?auth=signin');
        await page.locator('#google-sign-in-btn').click();
      }
      await expect(page.locator('#toast-text')).toHaveText('Signed in successfully!');
      await expect(page.locator('#auth-overlay')).toBeHidden();
      await expect(page.locator('#signin-submit')).toBeEnabled();
      await expect.poll(() => fixture.calls.includes('/api/auth/user')).toBe(true);
      await expect.poll(() => fixture.calls.includes('/api/runtime-jobs/active')).toBe(true);
      expect(fixture.calls.filter((url) => url === '/api/verify-email')).toHaveLength(1);
      // The shared navigation and processing page each load their profile.
      expect(fixture.calls.filter((url) => url === '/api/auth/user')).toHaveLength(2);
      expect(await page.evaluate(() => window.tokenRefreshes.includes(true))).toBe(false);
      expect(fixture.errors).toEqual([]);
    } finally { fixture.release(); }
  });
}

test('admin return waits for profile and secure cookie but never study statistics', async ({ page }) => {
  const fixture = await loginFixture(page, { admin: true, hold: ['/api/auth/user', '/api/study-progress/summary', '/api/session/login'] });
  await page.route('**/admin/workout', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Admin destination</h1>' }));
  try {
    await submitEmail(page, '/admin/workout');
    await expect.poll(() => fixture.calls.includes('/api/auth/user')).toBe(true);
    expect(fixture.calls).not.toContain('/api/session/login');
    expect(page.url()).toContain('/lecture-notes');
    fixture.release('/api/auth/user');
    await expect.poll(() => fixture.calls.includes('/api/session/login')).toBe(true);
    expect(page.url()).toContain('/lecture-notes');
    // Release only the cookie; the stats request remains pending.
    fixture.release('/api/session/login');
    await expect(page).toHaveURL(/\/admin\/workout$/);
    expect(fixture.calls.filter((url) => url === '/api/session/login')).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally { fixture.release(); }
});

test('failed admin cookie never redirects', async ({ page }) => {
  const fixture = await loginFixture(page, { admin: true, sessionStatus: 401 });
  await submitEmail(page, '/admin/workout');
  await expect.poll(() => fixture.calls.includes('/api/session/login')).toBe(true);
  await expect(page.locator('#signin-submit')).toBeEnabled();
  expect(page.url()).toContain('/lecture-notes');
  expect(await page.evaluate(() => sessionStorage.getItem('lectureProcessorAuthReturnUrl'))).toBe('/admin/workout');
});

test('unverified email stays blocked; confirming verification refreshes claims', async ({ page }) => {
  const fixture = await loginFixture(page, { verified: false });
  await submitEmail(page);
  await expect(page.locator('#signin-error')).toContainText('Verify student@gmail.com');
  expect(fixture.calls).not.toContain('/api/runtime-jobs/active');
  await page.getByRole('button', { name: 'I verified my email' }).click();
  await expect(page.locator('#toast-text')).toHaveText('Email verified. You are signed in.');
  expect(await page.evaluate(() => window.tokenRefreshes.filter(Boolean).length)).toBe(1);
  expect(fixture.errors).toEqual([]);
});

test('disallowed email cannot start password authentication', async ({ page }) => {
  const fixture = await loginFixture(page, { allowed: false });
  await submitEmail(page);
  await expect(page.locator('#signin-error')).toContainText('This email is not allowed.');
  expect(await page.evaluate(() => window.firebaseSignIns)).toBe(0);
  expect(fixture.calls).not.toContain('/api/auth/user');
});

test('restored sessions still check email eligibility', async ({ page }) => {
  const fixture = await loginFixture(page, { restored: true, allowed: false });
  await page.goto('/lecture-notes');
  await expect(page.locator('#signin-error')).toContainText('This email is not allowed.');
  expect(fixture.calls).toContain('/api/verify-email');
  expect(fixture.calls).not.toContain('/api/runtime-jobs/active');
  expect(await page.evaluate(() => window.loginTestAuth.currentUser)).toBeNull();
});

test('ordinary return destinations open without waiting for profile data', async ({ page }) => {
  const fixture = await loginFixture(page, { hold: ['/api/auth/user'] });
  await page.route('**/study?pack_id=login-test', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Study destination</h1>' }));
  try {
    await submitEmail(page, '/study?pack_id=login-test');
    await expect(page).toHaveURL(/\/study\?pack_id=login-test$/);
    expect(fixture.calls).not.toContain('/api/session/login');
    expect(fixture.errors).toEqual([]);
  } finally { fixture.release(); }
});

test('signing out during token retrieval cannot reactivate the old account', async ({ page }) => {
  const fixture = await loginFixture(page);
  await page.goto('/lecture-notes?auth=signin');
  await page.evaluate(() => {
    const original = window.loginTestAuth.signInWithEmailAndPassword;
    window.releaseLoginTokens = [];
    window.loginTestAuth.signInWithEmailAndPassword = async () => {
      const credential = await original();
      credential.user.getIdToken = () => new Promise((resolve) => window.releaseLoginTokens.push(resolve));
      return credential;
    };
  });
  await page.locator('#signin-email').fill('student@gmail.com');
  await page.locator('#signin-password').fill('fixture-password');
  await page.locator('#signin-submit').click();
  await expect.poll(() => page.evaluate(() => window.releaseLoginTokens.length)).toBeGreaterThan(0);
  await page.evaluate(async () => {
    await window.loginTestAuth.signOut();
    window.releaseLoginTokens.forEach((resolve) => resolve('old-token'));
  });
  await expect(page.locator('#signin-submit')).toBeEnabled();
  await expect(page.locator('#sign-in-required')).toBeVisible();
  expect(fixture.calls).not.toContain('/api/runtime-jobs/active');
  await expect(page.locator('#toast-text')).not.toHaveText('Signed in successfully!');
  expect(fixture.errors).toEqual([]);
});
