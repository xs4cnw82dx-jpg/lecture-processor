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
