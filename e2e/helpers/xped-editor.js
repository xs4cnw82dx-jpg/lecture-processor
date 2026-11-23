const model = require('../../static/js/elearning-model.js');

async function editorFixture(page, options = {}) {
  const exp = {
    ...model.createExpeditionPreset('showcase', 'Course draft', 'en'),
    role: options.role || 'owner', revision: 1,
  };
  const writes = [];
  const translations = [];
  await page.route('https://**', route => route.abort());
  await page.route('**/static/js/firebase-bootstrap.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      const listeners = [];
      const makeUser = uid => uid && ({uid, getIdToken: async () => uid});
      const auth = {
        currentUser: makeUser(sessionStorage.getItem('editorAccount') || 'author'),
        onAuthStateChanged(fn) { listeners.push(fn); queueMicrotask(() => fn(auth.currentUser)); }
      };
      window.switchEditorAccount = uid => {
        sessionStorage.setItem('editorAccount', uid); auth.currentUser = makeUser(uid);
        listeners.forEach(fn => fn(auth.currentUser));
      };
      window.LectureProcessorBootstrap = {
        getAuth: () => auth,
        onAuthStateReady: (service, cb) => service.onAuthStateChanged(cb)
      };`,
  }));
  await page.route('**/api/elearning/grant-session', route => route.fulfill({
    json: { accessToken: 'local-grant', targetLanguage: 'de', expeditionId: 'visual' },
  }));
  await page.route('**/api/elearning/expeditions/visual**', async route => {
    const req = route.request();
    if (req.headers().authorization === 'Bearer second') {
      await route.fulfill({ status: 403, json: { error: 'Access unavailable' } });
    } else if (req.url().endsWith('/lease')) {
      await route.fulfill({ json: { granted: true, lease_token: 'local-lease' } });
    } else if (req.url().endsWith('/translations')) {
      translations.push(req.postDataJSON());
      if (options.waitForTranslation) await options.waitForTranslation(translations.length);
      await route.fulfill({ json: { expedition: { ...exp, revision: ++exp.revision } } });
    } else if (req.method() === 'PUT') {
      const body = req.postDataJSON();
      writes.push({ token: req.headers().authorization, body });
      if (options.saveStructure) return options.saveStructure(route, body, exp);
      await route.fulfill({ json: { expedition: { ...exp, revision: ++exp.revision } } });
    } else {
      await route.fulfill({ json: { expedition: exp } });
    }
  });
  return { writes, translations, exp };
}

module.exports = { editorFixture };
