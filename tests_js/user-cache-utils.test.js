const test = require('node:test');
const assert = require('node:assert/strict');

const userCache = require('../static/js/user-cache-utils.js');

function createStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

test('user-cache-utils stores and reads plain and user-scoped JSON payloads', () => {
  global.localStorage = createStorage();

  assert.equal(userCache.buildUserScopedKey('user-1', 'prefs'), 'user:user-1:prefs');

  assert.equal(userCache.setJson('plain', { ok: true }), true);
  assert.deepEqual(userCache.getJson('plain', null), { ok: true });

  assert.equal(userCache.setUserJson({ uid: 'user-1' }, 'prefs', { theme: 'light' }), true);
  assert.deepEqual(userCache.getUserJson('user-1', 'prefs', null), { theme: 'light' });
});

test('user-cache-utils clears only the requested user scope keys', () => {
  global.localStorage = createStorage();

  userCache.setUserJson('user-1', 'dashboard_summary', { streak: 4 });
  userCache.setUserJson('user-1', 'credits_breakdown', { total: 9 });
  userCache.setUserJson('user-2', 'dashboard_summary', { streak: 8 });

  assert.equal(
    userCache.clearUserScope('user-1', ['dashboard_summary', 'credits_breakdown']),
    true
  );

  assert.equal(userCache.getUserJson('user-1', 'dashboard_summary', null), null);
  assert.equal(userCache.getUserJson('user-1', 'credits_breakdown', null), null);
  assert.deepEqual(userCache.getUserJson('user-2', 'dashboard_summary', null), { streak: 8 });
});

test('clearUserScope reports a delegated clear failure', () => {
  assert.equal(userCache.clearUserScope('user-1', [], { clearUserScope: () => false }), false);
});

test('clearUserScope attempts every key and reports a partial failure', () => {
  const removed = [];
  const cache = { remove: key => { removed.push(key); return key !== 'user:user-1:first'; } };
  assert.equal(userCache.clearUserScope('user-1', ['first', 'second'], cache), false);
  assert.deepEqual(removed, ['user:user-1:first', 'user:user-1:second']);
});

test('clearUserScope contains delegated access errors', () => {
  assert.equal(userCache.clearUserScope('user-1', [], {
    clearUserScope: () => { throw new Error('Storage unavailable'); },
  }), false);
});

test('clearUserScope passes study-cache ownership to the UI cache', () => {
  let received;
  const uiCache = { clearUserScope: (uid, options) => { received = { uid, options }; return true; } };
  assert.equal(userCache.clearUserScope('user-1', [], uiCache, { preserveStudyCache: true }), true);
  assert.deepEqual(received, { uid: 'user-1', options: { preserveStudyCache: true } });
});

test('fallback scope clearing preserves study records only when requested', () => {
  const removed = [];
  const uiCache = { remove: key => { removed.push(key); return true; } };
  const keys = ['dashboard', 'study_cache:planned:run', 'study_cache:learning:pack', 'study_cache_other'];
  assert.equal(userCache.clearUserScope('user-1', keys, uiCache, { preserveStudyCache: true }), true);
  assert.deepEqual(removed, ['user:user-1:dashboard', 'user:user-1:study_cache_other']);
});
