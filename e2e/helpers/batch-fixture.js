const path = require('node:path');
async function installAccountFixture(page) {
  const requests = [];
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.addInitScript(() => {
    const listeners = [];
    const users = {};
    function userFor(uid) {
      if (!uid) return null;
      if (!users[uid]) users[uid] = {
        uid, email: uid + '@example.test', emailVerified: true, displayName: 'Student ' + uid,
        getIdToken: () => Promise.resolve('token-' + uid),
      };
      return users[uid];
    }
    const auth = {
      currentUser: userFor('a'),
      setPersistence: () => Promise.resolve(),
      authStateReady: () => Promise.resolve(),
      onAuthStateChanged(callback) {
        listeners.push(callback);
        queueMicrotask(() => callback(auth.currentUser));
        return () => { const index = listeners.indexOf(callback); if (index >= 0) listeners.splice(index, 1); };
      },
      switchTo(uid) { auth.currentUser = userFor(uid); listeners.slice().forEach((callback) => callback(auth.currentUser)); },
      signOut() { auth.switchTo(null); return Promise.resolve(); },
    };
    function authFactory() { return auth; }
    authFactory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: () => ({}), initializeApp: () => ({}), auth: authFactory };
    window.testAccount = auth;
  });
  await page.route('https://www.gstatic.com/firebasejs/**', (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
  // Exercise the working sources even before the shared build regenerates assets.
  await page.route(/\/static\/js\/(buy-credits|batch-dashboard|batch-mode|voice-notes)(\.min)?\.js(?:\?.*)?$/, (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop().replace('.min.js', '.js');
    return route.fulfill({ contentType: 'application/javascript', path: path.resolve('static/js', name) });
  });
  await page.route('**/api/**', (route) => {
    const request = route.request();
    requests.push({ path: new URL(request.url()).pathname, method: request.method(), authorization: request.headers().authorization });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      user: { uid: 'a', display_name: 'Student', credits: { lecture: 10, slides: 10 } },
      preferences: {}, purchases: [], batches: [], voice_notes: [],
    }) });
  });
  return { requests, browserErrors };
}

module.exports = { installAccountFixture };
