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

const academyConfig = {
  apiKey: 'academy-web-api-key', authDomain: 'demo-academy.firebaseapp.com',
  projectId: 'demo-academy', appId: '1:234:web:567',
};

function academyBootstrap(json, existingConfig) {
  const initialized = [];
  let app = existingConfig ? { options: existingConfig } : null;
  const auth = { currentUser: null };
  const context = {
    document: {
      querySelector: () => ({}),
      getElementById: () => json === undefined ? null : { textContent: json },
    },
    firebase: {
      app() { if (!app) throw Error('No app'); return app; },
      initializeApp(config) { initialized.push(config.projectId); app = { options: config }; return app; },
      auth: () => auth,
    },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('static/js/firebase-bootstrap.js', 'utf8'), context);
  return { bootstrap: context.LectureProcessorBootstrap, initialized, auth };
}

test('Academy exposes and initializes the configured project and reuses its matching app', () => {
  const { bootstrap, initialized, auth } = academyBootstrap(JSON.stringify(academyConfig));
  assert.deepEqual({ ...bootstrap.firebaseConfig }, academyConfig);
  assert.equal(bootstrap.getAuth(), auth);
  assert.equal(bootstrap.ensureFirebaseApp().options, bootstrap.firebaseConfig);
  assert.deepEqual(initialized, ['demo-academy']);
});

test('Academy cannot initialize or reuse Firebase when configuration is absent or invalid', () => {
  const lectureConfig = loadBootstrapWithAuth({}).firebaseConfig;
  for (const json of [undefined, 'bad json', 'null', '{}', JSON.stringify(lectureConfig),
    JSON.stringify({ ...academyConfig, apiKey: '  ' }),
    JSON.stringify({ ...academyConfig, authDomain: lectureConfig.authDomain })]) {
    for (const existing of [null, lectureConfig]) {
      const { bootstrap, initialized } = academyBootstrap(json, existing);
      assert.equal(bootstrap.firebaseConfig, null);
      assert.throws(() => bootstrap.getAuth(), /Academy sign-in is not configured/);
      assert.deepEqual(initialized, []);
    }
  }
});

test('Academy rejects a previously initialized Firebase app belonging to another project', () => {
  const lectureConfig = loadBootstrapWithAuth({}).firebaseConfig;
  const { bootstrap, initialized } = academyBootstrap(JSON.stringify(academyConfig), lectureConfig);
  assert.throws(() => bootstrap.getAuth(), /does not match/);
  assert.deepEqual(initialized, []);
});
