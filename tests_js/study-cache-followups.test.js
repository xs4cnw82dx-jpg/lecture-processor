const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(process.env.STUDY_CACHE_FOLLOWUPS_SOURCE || require.resolve('../static/js/study-cache-utils.js'), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;
const dataKey = (uid, kind, id) => `lp_ui_v2:user:${uid}:study_cache:${encodeURIComponent(kind)}:${encodeURIComponent(id)}`;
const fenceKey = (uid, suffix) => `lp_study_cache_fence_v1:${encodeURIComponent(uid)}:${suffix}`;
const plain = value => JSON.parse(JSON.stringify(value));

function sharedStorage() {
  const values = new Map();
  const clock = { now: Date.UTC(2026, 10, 14) };
  const tabs = [], events = [];
  function open(uid = 'alice') {
    const faults = { read: false, write: false, remove: false, beforeSet: null, beforeRemove: null };
    const listeners = [];
    function notify(key, oldValue, newValue) {
      for (const tab of tabs) if (tab.storage !== storage) events.push(() => tab.deliver({ key, oldValue, newValue, storageArea: tab.storage }));
    }
    const storage = {
      get length() { return values.size; },
      key(index) { return [...values.keys()][index] ?? null; },
      getItem(key) { if (faults.read) throw new Error('Storage unavailable'); return values.get(key) ?? null; },
      setItem(key, value) {
        if (faults.write) throw new Error('Storage full');
        if (faults.beforeSet) { const callback = faults.beforeSet; faults.beforeSet = null; callback(key, value); }
        const oldValue = values.get(key) ?? null;
        values.set(key, String(value));
        notify(key, oldValue, String(value));
      },
      removeItem(key) {
        if (faults.remove) throw new Error('Storage unavailable');
        if (faults.beforeRemove) { const callback = faults.beforeRemove; faults.beforeRemove = null; callback(key); }
        const oldValue = values.get(key) ?? null;
        values.delete(key);
        if (oldValue !== null) notify(key, oldValue, null);
      },
    };
    const context = vm.createContext({ localStorage: storage, Date: class extends Date { static now() { return clock.now; } },
      addEventListener(name, callback) { if (name === 'storage') listeners.push(callback); } });
    vm.runInContext(source, context);
    const cache = context.LectureProcessorStudyCache;
    cache.activate(uid);
    const tab = { cache, storage, faults, deliver: event => listeners.forEach(callback => callback(event)) };
    tabs.push(tab);
    return tab;
  }
  return { values, clock, open, flush() {
    let count = 0;
    while (events.length) { assert.ok(count++ < 1000, 'storage events must settle'); events.shift()(); }
  } };
}

function addSchemaOneCleanup(tab, uid) {
  // A prior tab understands only the released schema1 fence protocol. Its
  // storage listener removes records whose generations no longer match.
  const deliver = tab.deliver;
  function fence(key) {
    const raw = tab.storage.getItem(key);
    if (raw === null) return { version: '', retained: [] };
    const marker = JSON.parse(raw);
    if (!marker || marker.schema !== 1 || typeof marker.version !== 'string' || !marker.version || !Array.isArray(marker.retained)) throw new Error('Unknown fence');
    return marker;
  }
  tab.deliver = event => {
    for (let index = tab.storage.length - 1; index >= 0; index -= 1) {
      const key = tab.storage.key(index);
      if (!key || !key.startsWith(`lp_ui_v2:user:${uid}:study_cache:`)) continue;
      try {
        const record = JSON.parse(tab.storage.getItem(key));
        const saved = record.fences || { user: '', pack: '', key: '' };
        const user = fence(fenceKey(uid, 'user'));
        const pack = record.pack_id ? fence(fenceKey(uid, `pack:${encodeURIComponent(record.pack_id)}`)) : { version: '' };
        const exact = fence(fenceKey(uid, `key:${encodeURIComponent(record.kind)}:${encodeURIComponent(record.id)}`));
        if (saved.pack !== pack.version || saved.key !== exact.version || (saved.user !== user.version && !(record.pending && user.retained.includes(saved.user)))) tab.storage.removeItem(key);
      } catch (_) { /* The previous client retains bytes when it cannot read a fence. */ }
    }
    deliver(event);
  };
}

function captureSchemaOneWriter(tab, shared, uid, kind, id, packId) {
  const keys = { user: fenceKey(uid, 'user'), pack: fenceKey(uid, `pack:${encodeURIComponent(packId)}`),
    key: fenceKey(uid, `key:${encodeURIComponent(kind)}:${encodeURIComponent(id)}`) };
  function version(key) {
    const raw = tab.storage.getItem(key);
    if (raw === null) return '';
    const marker = JSON.parse(raw);
    if (marker.schema !== 1 || !marker.version || !Array.isArray(marker.retained)) throw new Error('Unknown fence');
    return marker.version;
  }
  const captured = Object.fromEntries(Object.entries(keys).map(([scope, key]) => [scope, version(key)]));
  return payload => {
    try {
      if (!Object.entries(keys).every(([scope, key]) => version(key) === captured[scope])) return false;
      const key = dataKey(uid, kind, id);
      const raw = JSON.stringify({ schema: 1, uid, kind, id, pack_id: packId, updated_at: shared.clock.now,
        pending: true, payload, fences: captured, write_id: 'schema-one-write' });
      tab.storage.setItem(key, raw);
      if (Object.entries(keys).every(([scope, key]) => version(key) === captured[scope])) return true;
      if (tab.storage.getItem(key) === raw) tab.storage.removeItem(key);
      return false;
    } catch (_) { return false; }
  };
}

test('new exact-key markers record their creation time', () => {
  const shared = sharedStorage(), tab = shared.open();
  assert.equal(tab.cache.remove('alice', 'planned', 'run'), true);
  const marker = JSON.parse(shared.values.get(fenceKey('alice', 'key:planned:run')));
  assert.equal(marker.created_at, shared.clock.now);
  assert.equal(typeof marker.version, 'string');
});

test('capture retains old and recent deletion markers for every scope and UID', () => {
  const shared = sharedStorage(), tab = shared.open();
  for (const [suffix, age] of [['user', YEAR + DAY], ['pack:pack', YEAR + DAY], ['key:planned:old', YEAR + DAY], ['key:planned:recent', YEAR - DAY]]) {
    shared.values.set(fenceKey('alice', suffix), JSON.stringify({ schema: 1, version: suffix, retained: [], created_at: shared.clock.now - age }));
  }
  const other = fenceKey('bob', 'key:planned:other');
  shared.values.set(other, JSON.stringify({ schema: 1, version: 'other', retained: [], created_at: 1 }));
  assert.ok(tab.cache.capture('alice'));
  assert.equal(shared.values.has(fenceKey('alice', 'key:planned:old')), true);
  for (const suffix of ['user', 'pack:pack', 'key:planned:recent']) assert.equal(shared.values.has(fenceKey('alice', suffix)), true);
  assert.equal(shared.values.has(other), true);
});

test('an old exact fence continues rejecting pre-clear writers across user changes and clock rollback', () => {
  const shared = sharedStorage(), first = shared.open(), second = shared.open();
  const old = second.cache.capture('alice');
  const oldWrite = captureSchemaOneWriter(second, shared, 'alice', 'planned', 'run', 'pack');
  assert.equal(first.cache.remove('alice', 'planned', 'run'), true);
  const key = fenceKey('alice', 'key:planned:run');
  shared.values.set(key, JSON.stringify({ ...JSON.parse(shared.values.get(key)), created_at: shared.clock.now }));
  assert.equal(second.cache.set(old, 'planned', 'run', { revision: 1 }, { packId: 'pack', pending: true }), false);
  shared.clock.now += YEAR + DAY;
  assert.ok(first.cache.capture('alice'));
  assert.equal(shared.values.has(key), true);
  assert.equal(first.cache.clearUser('alice', { preservePending: true }), true);
  assert.ok(first.cache.capture('alice'));
  assert.equal(shared.values.has(key), true);
  assert.equal(second.cache.set(old, 'planned', 'run', { revision: 2 }, { packId: 'pack', pending: true }), false);
  assert.equal(second.cache.set(second.cache.capture('alice'), 'planned', 'run', { revision: 3 }, { packId: 'pack', pending: true }), true);
  assert.deepEqual(plain(first.cache.get('alice', 'planned', 'run')), { revision: 3 });
  shared.clock.now -= YEAR + DAY;
  assert.equal(oldWrite({ revision: 4 }), false);
  assert.equal(second.cache.set(old, 'planned', 'run', { revision: 4 }, { packId: 'pack', pending: true }), false);
  assert.equal(second.cache.set(second.cache.capture('alice'), 'learning', 'after-clock-rollback', {}, { packId: 'other' }), true);
});

test('undated legacy markers remain unchanged because their age is unknown', () => {
  const shared = sharedStorage(), tab = shared.open();
  const key = fenceKey('alice', 'key:planned:legacy');
  const raw = JSON.stringify({ schema: 1, version: 'legacy-generation', retained: [] });
  shared.values.set(key, raw);
  assert.ok(tab.cache.capture('alice'));
  assert.equal(shared.values.get(key), raw);
  shared.clock.now += YEAR + DAY;
  assert.ok(tab.cache.capture('alice'));
  assert.equal(shared.values.get(key), raw);
});

test('an old exact marker with pending progress is retained and remains resumable', () => {
  const shared = sharedStorage(), tab = shared.open();
  const key = fenceKey('alice', 'key:planned:run');
  shared.values.set(fenceKey('alice', 'user'), JSON.stringify({ schema: 1, version: 'current-user', retained: [], created_at: shared.clock.now }));
  shared.values.set(key, JSON.stringify({ schema: 1, version: 'retained', retained: [], created_at: shared.clock.now }));
  const token = tab.cache.capture('alice');
  const saved = { revision: 4, pending_reviews: [{ key: 'first' }] };
  assert.equal(tab.cache.set(token, 'planned', 'run', saved, { packId: 'pack', pending: true }), true);
  shared.clock.now += YEAR + DAY;
  assert.ok(tab.cache.capture('alice'));
  assert.equal(shared.values.has(key), true);
  assert.deepEqual(plain(tab.cache.get('alice', 'planned', 'run')), saved);
  assert.equal(tab.cache.hasPending('alice'), true);
});

for (const scope of ['user', 'pack:pack', 'key:planned:run']) {
  test(`capture repairs a malformed ${scope} fence while quarantining pending progress and rejecting old writers`, () => {
    const shared = sharedStorage(), first = shared.open(), second = shared.open();
    const markerKey = fenceKey('alice', scope);
    shared.values.set(markerKey, JSON.stringify({ schema: 1, version: 'before-damage', retained: [], created_at: shared.clock.now }));
    const old = second.cache.capture('alice');
    const payload = { revision: 7, plan_item_id: 'session', pending_reviews: [{ key: 'card-1', answer: 'Unsynced answer' }] };
    assert.equal(second.cache.set(old, 'planned', 'run', payload, { packId: 'pack', pending: true }), true);
    const other = shared.open('bob');
    assert.equal(other.cache.set(other.cache.capture('bob'), 'planned', 'other', { revision: 2 }, { pending: true }), true);
    const otherRaw = shared.values.get(dataKey('bob', 'planned', 'other'));
    shared.values.set(markerKey, '{malformed fence');
    const fresh = first.cache.capture('alice');
    assert.ok(fresh);
    assert.equal(first.cache.hasPending('alice'), true);
    assert.equal(first.cache.get('alice', 'planned', 'run'), null);
    assert.deepEqual(JSON.parse(shared.values.get(dataKey('alice', 'planned', 'run'))).payload, payload);
    assert.equal(second.cache.set(old, 'planned', 'run', { revision: 8 }, { packId: 'pack', pending: true }), false);
    assert.equal(first.cache.set(fresh, 'planned', 'run', { ...payload, revision: 9 }, { packId: 'pack', pending: true }), false);
    assert.equal(first.cache.set(fresh, 'planned', 'new', { revision: 1 }, { packId: 'other', pending: true }), true);
    shared.flush();
    assert.deepEqual(JSON.parse(shared.values.get(dataKey('alice', 'planned', 'run'))).payload, payload);
    assert.equal(shared.values.get(dataKey('bob', 'planned', 'other')), otherRaw);
    assert.equal(first.cache.remove('alice', 'planned', 'run'), true);
    assert.equal(first.cache.set(first.cache.capture('alice'), 'planned', 'run', { revision: 10 }, { packId: 'pack', pending: true }), true);
    shared.flush();
    assert.deepEqual(plain(first.cache.get('alice', 'planned', 'run')), { revision: 10 });
  });
}

test('failed malformed-marker repair preserves pending bytes and remains fail closed', () => {
  const shared = sharedStorage(), tab = shared.open();
  tab.cache.set(tab.cache.capture('alice'), 'planned', 'run', { revision: 5 }, { pending: true });
  const raw = shared.values.get(dataKey('alice', 'planned', 'run'));
  const key = fenceKey('alice', 'user');
  shared.values.set(key, '{invalid');
  tab.faults.write = true;
  assert.equal(tab.cache.capture('alice'), null);
  assert.equal(tab.cache.hasPending('alice'), true);
  assert.equal(shared.values.get(key), '{invalid');
  assert.equal(shared.values.get(dataKey('alice', 'planned', 'run')), raw);
});

test('unreadable storage is not treated as a malformed marker to overwrite', () => {
  const shared = sharedStorage(), tab = shared.open();
  const key = fenceKey('alice', 'user');
  const raw = JSON.stringify({ schema: 1, version: 'keep', retained: [], created_at: shared.clock.now });
  shared.values.set(key, raw);
  tab.faults.read = true;
  assert.equal(tab.cache.capture('alice'), null);
  assert.equal(tab.cache.hasPending('alice'), true);
  assert.equal(shared.values.get(key), raw);
});

for (const scope of ['user', 'pack:pack', 'key:planned:run']) {
  test(`external clearing preserves ${scope} quarantine without promoting it to readable progress`, () => {
    const shared = sharedStorage(), first = shared.open(), second = shared.open();
    const token = second.cache.capture('alice');
    const payload = { revision: 2, answer: 'Keep uncertain pending bytes' };
    assert.equal(second.cache.set(token, 'planned', 'run', payload, { packId: 'pack', pending: true }), true);
    const raw = shared.values.get(dataKey('alice', 'planned', 'run'));
    shared.values.set(fenceKey('alice', scope), '{invalid');
    assert.ok(first.cache.capture('alice'));
    assert.equal(first.cache.clearUser('alice', { preservePending: true }), true);
    assert.equal(second.cache.clearUser('alice', { preservePending: true }), true);
    shared.flush();
    assert.equal(shared.values.get(dataKey('alice', 'planned', 'run')), raw);
    assert.equal(first.cache.get('alice', 'planned', 'run'), null);
    assert.equal(first.cache.hasPending('alice'), true);
    assert.equal(second.cache.set(second.cache.capture('alice'), 'planned', 'run', {}, { packId: 'pack', pending: true }), false);
    assert.equal(first.cache.clearUser('alice'), true);
    shared.flush();
    assert.equal(shared.values.has(dataKey('alice', 'planned', 'run')), false);
    assert.equal(first.cache.hasPending('alice'), false);
  });
}

for (const clearedScope of ['user', 'pack', 'key']) {
  test(`a definite ${clearedScope} deletion wins over a different repaired scope`, () => {
    const shared = sharedStorage(), first = shared.open(), second = shared.open();
    const old = second.cache.capture('alice');
    second.cache.set(old, 'planned', 'run', { revision: 1 }, { packId: 'pack', pending: true });
    const raw = shared.values.get(dataKey('alice', 'planned', 'run'));
    const removed = clearedScope === 'user' ? first.cache.clearUser('alice')
      : clearedScope === 'pack' ? first.cache.removePack('alice', 'pack') : first.cache.remove('alice', 'planned', 'run');
    assert.equal(removed, true);
    shared.values.set(dataKey('alice', 'planned', 'run'), raw);
    const damaged = { user: 'pack:pack', pack: 'key:planned:run', key: 'user' }[clearedScope];
    shared.values.set(fenceKey('alice', damaged), '{invalid');
    assert.ok(first.cache.capture('alice'));
    assert.equal(first.cache.get('alice', 'planned', 'run'), null);
    assert.equal(first.cache.hasPending('alice'), false);
    shared.flush();
    assert.equal(shared.values.has(dataKey('alice', 'planned', 'run')), false);
    assert.equal(second.cache.set(old, 'planned', 'run', { revision: 2 }, { packId: 'pack', pending: true }), false);
  });
}

test('corrupting the authoritative full-clear fence never makes an earlier generation readable', () => {
  const shared = sharedStorage(), first = shared.open(), second = shared.open();
  second.cache.set(second.cache.capture('alice'), 'planned', 'run', { revision: 1 }, { packId: 'pack', pending: true });
  const raw = shared.values.get(dataKey('alice', 'planned', 'run'));
  assert.equal(first.cache.clearUser('alice'), true);
  shared.values.set(dataKey('alice', 'planned', 'run'), raw);
  shared.values.set(fenceKey('alice', 'user'), '{lost authoritative fence');
  const fresh = first.cache.capture('alice');
  assert.ok(fresh);
  shared.flush();
  assert.equal(first.cache.get('alice', 'planned', 'run'), null);
  assert.equal(first.cache.hasPending('alice'), true);
  assert.equal(shared.values.get(dataKey('alice', 'planned', 'run')), raw);
  assert.equal(first.cache.set(fresh, 'planned', 'run', {}, { packId: 'pack', pending: true }), false);
  assert.equal(first.cache.remove('alice', 'planned', 'run'), true);
  shared.flush();
  assert.equal(first.cache.hasPending('alice'), false);
  assert.equal(first.cache.set(first.cache.capture('alice'), 'planned', 'run', { revision: 2 }, { packId: 'pack', pending: true }), true);
});

test('a pending write already in progress when repair runs remains quarantined instead of being removed', () => {
  const shared = sharedStorage(), first = shared.open(), second = shared.open();
  const old = second.cache.capture('alice');
  let repaired;
  second.faults.beforeSet = () => {
    shared.values.set(fenceKey('alice', 'user'), '{invalid');
    repaired = first.cache.capture('alice');
  };
  assert.equal(second.cache.set(old, 'planned', 'late', { revision: 8 }, { packId: 'pack', pending: true }), false);
  assert.ok(repaired);
  shared.flush();
  assert.deepEqual(JSON.parse(shared.values.get(dataKey('alice', 'planned', 'late'))).payload, { revision: 8 });
  assert.equal(first.cache.get('alice', 'planned', 'late'), null);
  assert.equal(first.cache.hasPending('alice'), true);
});

test('a changed pending snapshot aborts capture but the repair fence protects every uncovered pending write', () => {
  const shared = sharedStorage(), first = shared.open(), second = shared.open();
  second.cache.set(second.cache.capture('alice'), 'planned', 'run', { revision: 1 }, { packId: 'pack', pending: true });
  const original = JSON.parse(shared.values.get(dataKey('alice', 'planned', 'run')));
  shared.values.set(fenceKey('alice', 'user'), '{invalid');
  first.faults.beforeSet = () => {
    // An already-validated writer lands while capture publishes its repair.
    second.storage.setItem(dataKey('alice', 'planned', 'late'), JSON.stringify({ ...original,
      id: 'late', write_id: 'late-write', payload: { revision: 2 } }));
  };
  assert.equal(first.cache.capture('alice'), null);
  shared.flush();
  assert.equal(first.cache.hasPending('alice'), true);
  assert.deepEqual(JSON.parse(shared.values.get(dataKey('alice', 'planned', 'late'))).payload, { revision: 2 });
  assert.equal(first.cache.get('alice', 'planned', 'late'), null);
  assert.ok(first.cache.capture('alice'));
});

test('repair fails closed above the pending count bound and never truncates preserved bytes', () => {
  const shared = sharedStorage(), tab = shared.open();
  const token = tab.cache.capture('alice');
  for (let index = 0; index < 50; index += 1) assert.equal(tab.cache.set(token, 'planned', String(index), { revision: index }, { pending: true }), true);
  const extra = JSON.parse(shared.values.get(dataKey('alice', 'planned', '0')));
  shared.values.set(dataKey('alice', 'planned', 'extra'), JSON.stringify({ ...extra, id: 'extra', write_id: 'extra-write' }));
  shared.values.set(fenceKey('alice', 'user'), '{invalid');
  const before = [...shared.values];
  assert.equal(tab.cache.capture('alice'), null);
  assert.deepEqual([...shared.values], before);
  assert.equal(tab.cache.hasPending('alice'), true);
  assert.equal(tab.cache.clearUser('alice'), true);
  assert.equal(tab.cache.hasPending('alice'), false);
});

for (const scope of ['user', 'pack:pack', 'key:planned:run']) {
  test(`a schema1-only tab cannot delete pending ${scope} quarantine when its delayed listener runs`, () => {
    const shared = sharedStorage(), first = shared.open(), previous = shared.open();
    addSchemaOneCleanup(previous, 'alice');
    first.cache.set(first.cache.capture('alice'), 'planned', 'run', { answer: 'Preserve pending bytes' }, { packId: 'pack', pending: true });
    const raw = shared.values.get(dataKey('alice', 'planned', 'run'));
    shared.values.set(fenceKey('alice', scope), '{invalid');
    assert.ok(first.cache.capture('alice'));
    shared.flush();
    assert.equal(shared.values.get(dataKey('alice', 'planned', 'run')), raw);
    assert.equal(first.cache.hasPending('alice'), true);
    assert.equal(first.cache.get('alice', 'planned', 'run'), null);
    first.cache.clearUser('alice', { preservePending: true });
    shared.flush();
    assert.equal(shared.values.get(dataKey('alice', 'planned', 'run')), raw);
    first.cache.clearUser('alice');
    shared.flush();
    assert.equal(shared.values.has(dataKey('alice', 'planned', 'run')), false);
  });
}
