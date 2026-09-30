const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../static/js/auth-utils.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(fetchImpl) {
  const requests = [];
  const listeners = [];
  const userA = { uid: 'a', getIdToken: async () => 'token-a' };
  const userB = { uid: 'b', getIdToken: async () => 'token-b' };
  const auth = { currentUser: userA, onAuthStateChanged: (callback) => { listeners.push(callback); } };
  const context = { window: {}, Promise, FormData, fetch: async (url, options) => {
    requests.push({ url, options });
    return fetchImpl ? fetchImpl(url, options) : new Response('{}');
  } };
  vm.runInNewContext(source, context);
  const client = context.window.LectureProcessorAuth.createAuthClient(auth, { initialToken: 'stale-token' });
  return { client, requests, userA, userB, auth, notify(user) {
    listeners.forEach((listener) => listener(user));
  }, switchTo(user) {
    auth.currentUser = user;
    listeners.forEach((listener) => listener(user));
  } };
}

test('A -> signed out -> B never reuses A credentials or manually supplied tokens', async () => {
  const h = harness();
  await h.client.authFetch('/history');
  assert.equal(h.client.getToken(), 'token-a');
  h.switchTo(null);
  assert.equal(h.client.getToken(), null);
  await assert.rejects(h.client.authFetch('/history'), /Not signed in/);
  h.switchTo(h.userB);
  h.client.setToken('token-a');
  assert.equal(h.client.getToken(), null);
  await h.client.authFetch('/history');
  assert.deepEqual(h.requests.map((r) => r.options.headers.Authorization), ['Bearer token-a', 'Bearer token-b']);
});

test('a delayed token from A is rejected before any request is dispatched under B', async () => {
  const token = deferred();
  const h = harness();
  h.userA.getIdToken = () => token.promise;
  const request = h.client.authFetch('/charge', { method: 'POST' });
  await Promise.resolve();
  h.switchTo(h.userB);
  token.resolve('token-a');
  await assert.rejects(request, { code: 'auth/session-changed' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.client.getToken(), null);
});

test('sign out then back into A invalidates a pending request even with the same user object', async () => {
  const token = deferred();
  const h = harness();
  h.userA.getIdToken = () => token.promise;
  const request = h.client.authFetch('/charge', { method: 'POST' });
  await Promise.resolve();
  h.switchTo(null);
  h.switchTo(h.userA);
  token.resolve('token-a');
  await assert.rejects(request, { code: 'auth/session-changed' });
  assert.equal(h.requests.length, 0);
});

test('an old response is rejected and a 401 is never retried as the new user', async () => {
  const response = deferred();
  const h = harness(() => response.promise);
  const request = h.client.authFetch('/charge', { method: 'POST' });
  while (!h.requests.length) await Promise.resolve();
  h.switchTo(h.userB);
  response.resolve(new Response('{}', { status: 401 }));
  await assert.rejects(request, { code: 'auth/session-changed' });
  assert.equal(h.requests.length, 1);
});

test('queued sign-out notifications invalidate pending work even if currentUser is already A again', async () => {
  const body = deferred();
  const h = harness(() => ({ status: 200, json: () => body.promise }));
  const response = await h.client.authFetch('/private-history');
  const reading = response.json();
  await Promise.resolve();
  h.notify(null);
  h.notify(h.userA);
  body.resolve({ private: 'old session' });
  await assert.rejects(reading, { code: 'auth/session-changed' });
});

test('a page observer may start the new account request before the helper observer runs', async () => {
  const h = harness();
  h.auth.currentUser = h.userB;
  const request = h.client.authFetch('/new-account');
  h.notify(h.userB);
  assert.equal((await request).status, 200);
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer token-b');
});

test('401 refresh stays with its original account and maintains JSON request options', async () => {
  let calls = 0;
  const h = harness(() => new Response('{}', { status: ++calls === 1 ? 401 : 200 }));
  const refreshes = [];
  h.userA.getIdToken = async (force) => { refreshes.push(force); return force ? 'fresh-a' : 'token-a'; };
  const response = await h.client.authFetch('/save', { method: 'POST', body: '{}' }, { ensureJsonContentType: true });
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(response.status, 200);
  assert.equal(h.requests[1].options.headers.Authorization, 'Bearer fresh-a');
  assert.equal(h.requests[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(await response.json(), {});
});

test('an account change during token refresh prevents the retry', async () => {
  const token = deferred();
  const h = harness(() => new Response('{}', { status: 401 }));
  let refreshing = false;
  h.userA.getIdToken = (force) => { if (force) { refreshing = true; return token.promise; } return Promise.resolve('token-a'); };
  const request = h.client.authFetch('/save', { method: 'POST' });
  while (!refreshing) await Promise.resolve();
  h.switchTo(h.userB);
  token.resolve('fresh-a');
  await assert.rejects(request, { code: 'auth/session-changed' });
  assert.equal(h.requests.length, 1);
});

test('a delayed JSON body cannot reveal the previous account after response headers arrive', async () => {
  const body = deferred();
  const h = harness(() => ({ status: 200, json: () => body.promise }));
  const response = await h.client.authFetch('/private-history');
  const reading = response.json();
  await Promise.resolve();
  h.switchTo(h.userB);
  body.resolve({ private: 'account a' });
  await assert.rejects(reading, { code: 'auth/session-changed' });
});

test('cloned responses keep their owner guard and genuine responses retain native methods', async () => {
  const h = harness(() => new Response('private-a', { headers: { 'Content-Type': 'text/plain' } }));
  const response = await h.client.authFetch('/download');
  assert.equal(response.headers.get('content-type'), 'text/plain');
  const clone = response.clone();
  assert.equal(await response.text(), 'private-a');
  h.switchTo(h.userB);
  await assert.rejects(clone.blob(), { code: 'auth/session-changed' });
});
