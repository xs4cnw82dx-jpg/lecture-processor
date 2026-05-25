const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadBootstrapWithAuth(auth) {
  const source = fs.readFileSync('static/js/firebase-bootstrap.js', 'utf8');
  function firebaseAuth() {
    return auth;
  }
  firebaseAuth.Auth = { Persistence: { LOCAL: 'local' } };
  const context = {
    Promise,
    setTimeout,
    clearTimeout,
    window: null,
    firebase: {
      app() {
        return { name: '[DEFAULT]', options: {} };
      },
      auth: firebaseAuth,
      initializeApp() {
        return { name: '[DEFAULT]', options: {} };
      },
    },
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return context.LectureProcessorBootstrap;
}

test('onAuthStateReady shares one Firebase observer and replays the resolved user', async () => {
  const user = { uid: 'u-1', email: 'u@example.com' };
  let observerCalls = 0;
  let listener = null;
  const auth = {
    currentUser: null,
    setPersistence() {
      return Promise.resolve();
    },
    onAuthStateChanged(callback) {
      observerCalls += 1;
      listener = callback;
      return () => {};
    },
  };
  const bootstrap = loadBootstrapWithAuth(auth);
  bootstrap.getAuth();

  const seen = [];
  bootstrap.onAuthStateReady(auth, (nextUser) => { seen.push(nextUser && nextUser.uid); });
  bootstrap.onAuthStateReady(auth, (nextUser) => { seen.push(`second:${nextUser && nextUser.uid}`); });

  auth.currentUser = user;
  listener(user);

  assert.equal(observerCalls, 1);
  assert.deepEqual(seen, ['u-1', 'second:u-1']);

  bootstrap.onAuthStateReady(auth, (nextUser) => { seen.push(`late:${nextUser && nextUser.uid}`); });
  await Promise.resolve();

  assert.deepEqual(seen, ['u-1', 'second:u-1', 'late:u-1']);
});

test('onAuthStateReady waits for Firebase before reporting signed out', () => {
  let listener = null;
  const auth = {
    currentUser: null,
    onAuthStateChanged(callback) {
      listener = callback;
      return () => {};
    },
  };
  const bootstrap = loadBootstrapWithAuth(auth);
  const seen = [];

  bootstrap.onAuthStateReady(auth, (nextUser) => { seen.push(nextUser); });
  assert.deepEqual(seen, []);

  listener(null);
  assert.deepEqual(seen, [null]);
});
