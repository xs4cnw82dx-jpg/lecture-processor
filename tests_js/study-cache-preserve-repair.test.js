const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(process.env.STUDY_CACHE_PRESERVE_REPAIR_SOURCE || require.resolve('../static/js/study-cache-utils.js'), 'utf8');
const key = (uid, kind, id) => `lp_ui_v2:user:${uid}:study_cache:${encodeURIComponent(kind)}:${encodeURIComponent(id)}`;
const userFence = uid => `lp_study_cache_fence_v1:${encodeURIComponent(uid)}:user`;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(activeUid = 'alice') {
  const values = new Map(), faults = { write: false };
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(name) { return values.get(name) ?? null; },
    setItem(name, value) { if (faults.write) throw new Error('Storage unavailable'); values.set(name, String(value)); },
    removeItem(name) { values.delete(name); },
  };
  function open(uid) {
    const context = vm.createContext({ localStorage: storage });
    vm.runInContext(source, context);
    const cache = context.LectureProcessorStudyCache;
    cache.activate(uid);
    return cache;
  }
  const cache = open(activeUid), remote = open('alice'), other = open('bob');
  const old = remote.capture('alice'), otherToken = other.capture('bob');
  const payload = { revision: 4, pending_reviews: [{ answer: 'Retain uncertain pending work' }] };
  assert.equal(remote.set(old, 'planned', 'run', payload, { packId: 'pack', pending: true }), true);
  assert.equal(other.set(otherToken, 'planned', 'other', { revision: 7 }, { packId: 'other-pack', pending: true }), true);
  return { values, faults, cache, remote, other, old, otherToken, payload };
}

for (const activeUid of ['alice', 'bob']) {
  test(`external clear repairs the old user fence before any capture while ${activeUid} is active`, () => {
    const state = fixture(activeUid);
    const raw = state.values.get(key('alice', 'planned', 'run'));
    const otherRaw = state.values.get(key('bob', 'planned', 'other'));
    state.values.set(userFence('alice'), '{damaged user marker');

    assert.equal(state.cache.hasPending('alice'), true);
    assert.equal(state.values.get(userFence('alice')), '{damaged user marker', 'Pending detection must not itself mutate storage');
    assert.equal(state.cache.clearUser('alice', { preservePending: true }), true);

    assert.equal(state.values.get(key('alice', 'planned', 'run')), raw);
    assert.equal(state.values.get(key('bob', 'planned', 'other')), otherRaw);
    assert.equal(state.cache.hasPending('alice'), true);
    assert.equal(state.remote.set(state.old, 'planned', 'run', { revision: 5 }, { packId: 'pack', pending: true }), false);
    assert.equal(state.other.set(state.otherToken, 'planned', 'other', { revision: 8 }, { packId: 'other-pack', pending: true }), true);
    state.cache.activate('alice');
    assert.equal(state.cache.get('alice', 'planned', 'run'), null);
    const fresh = state.cache.capture('alice');
    assert.ok(fresh);
    assert.equal(state.cache.set(fresh, 'planned', 'run', { revision: 6 }, { packId: 'pack', pending: true }), false);
    assert.equal(state.cache.set(fresh, 'learning', 'fresh', { step: 2 }, { packId: 'new-pack' }), true);
    assert.equal(state.cache.clearUser('alice'), true);
    assert.equal(state.values.has(key('alice', 'planned', 'run')), false);
    assert.deepEqual(plain(state.other.get('bob', 'planned', 'other')), { revision: 8 });
  });
}

test('external clear does not promote an old full-clear generation when its user marker is damaged', () => {
  const state = fixture();
  const raw = state.values.get(key('alice', 'planned', 'run'));
  assert.equal(state.cache.clearUser('alice'), true);
  state.values.set(key('alice', 'planned', 'run'), raw);
  state.values.set(userFence('alice'), '{lost full-clear marker');

  assert.equal(state.cache.clearUser('alice', { preservePending: true }), true);

  assert.equal(state.values.get(key('alice', 'planned', 'run')), raw);
  assert.equal(state.cache.get('alice', 'planned', 'run'), null);
  assert.equal(state.cache.hasPending('alice'), true);
  assert.equal(state.cache.set(state.cache.capture('alice'), 'planned', 'run', {}, { packId: 'pack', pending: true }), false);
});

test('an earlier successful capture already permits preservation after user-marker repair', () => {
  const state = fixture();
  const raw = state.values.get(key('alice', 'planned', 'run'));
  state.values.set(userFence('alice'), '{damaged user marker');
  assert.ok(state.cache.capture('alice'));

  assert.equal(state.cache.clearUser('alice', { preservePending: true }), true);

  assert.equal(state.values.get(key('alice', 'planned', 'run')), raw);
  assert.equal(state.cache.get('alice', 'planned', 'run'), null);
  assert.equal(state.cache.hasPending('alice'), true);
});

test('failed repair during external clear preserves all bytes and reports pending work', () => {
  const state = fixture();
  state.values.set(userFence('alice'), '{damaged user marker');
  const before = [...state.values];
  state.faults.write = true;

  assert.equal(state.cache.clearUser('alice', { preservePending: true }), false);

  assert.deepEqual([...state.values], before);
  assert.equal(state.cache.hasPending('alice'), true);
});

test('explicit full discard still replaces a damaged marker without requiring a prior capture', () => {
  const state = fixture();
  state.values.set(userFence('alice'), '{damaged user marker');

  assert.equal(state.cache.clearUser('alice'), true);

  assert.equal(state.values.has(key('alice', 'planned', 'run')), false);
  assert.equal(state.cache.hasPending('alice'), false);
  assert.deepEqual(plain(state.other.get('bob', 'planned', 'other')), { revision: 7 });
});
