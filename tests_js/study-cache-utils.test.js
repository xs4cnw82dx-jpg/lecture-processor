const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../static/js/study-cache-utils.js'), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const key = (uid, kind, id) => `lp_ui_v2:user:${uid}:study_cache:${encodeURIComponent(kind)}:${encodeURIComponent(id)}`;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const values = new Map();
  const faults = { set: false, remove: new Set(), read: false, enumerate: false };
  const clock = { now: Date.UTC(2026, 10, 1) };
  const storage = {
    get length() { if (faults.enumerate) throw new Error('Unavailable'); return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(name) { if (faults.read) throw new Error('Unavailable'); return values.has(name) ? values.get(name) : null; },
    setItem(name, value) { if (faults.set) throw new Error('Quota exceeded'); values.set(name, String(value)); },
    removeItem(name) { if (faults.remove.has(name)) throw new Error('Unavailable'); values.delete(name); },
  };
  const context = vm.createContext({ localStorage: storage, Date: class extends Date { static now() { return clock.now; } } });
  vm.runInContext(source, context);
  const cache = context.LectureProcessorStudyCache;
  cache.activate('alice');
  return { cache, values, faults, clock, context };
}

function sharedTabs() {
  const values = new Map(), tabs = [], events = [];
  function open() {
    const listeners = [], faults = { set: false, beforeSet: null, beforeKey: null };
    const storage = {
      get length() { return values.size; },
      key(index) {
        if (faults.beforeKey) faults.beforeKey(index);
        return [...values.keys()][index] || null;
      },
      getItem: name => values.has(name) ? values.get(name) : null,
      setItem(name, value) {
        if (faults.set) throw new Error('Quota exceeded');
        if (faults.beforeSet) { const callback = faults.beforeSet; faults.beforeSet = null; callback(name, value); }
        const oldValue = storage.getItem(name);
        values.set(name, String(value));
        for (const tab of tabs) if (tab.storage !== storage) events.push(() => tab.deliver({ key: name, oldValue, newValue: String(value), storageArea: tab.storage }));
      },
      removeItem(name) {
        const oldValue = storage.getItem(name);
        values.delete(name);
        for (const tab of tabs) if (tab.storage !== storage) events.push(() => tab.deliver({ key: name, oldValue, newValue: null, storageArea: tab.storage }));
      },
    };
    const context = vm.createContext({ localStorage: storage, addEventListener: (name, callback) => {
      if (name === 'storage') listeners.push(callback);
    } });
    vm.runInContext(source, context);
    const tab = { cache: context.LectureProcessorStudyCache, storage, faults,
      deliver: event => listeners.forEach(callback => callback(event)) };
    tabs.push(tab);
    tab.cache.activate('alice');
    return tab;
  }
  return { open, values, flush() { let count = 0; while (events.length) {
    assert.ok(count++ < 1000, 'storage listeners must settle'); events.shift()();
  } } };
}

test('another tab cannot recreate a removed pack before storage notifications arrive', () => {
  const shared = sharedTabs(), first = shared.open(), second = shared.open();
  const old = second.cache.capture('alice');
  second.cache.set(old, 'learning', 'gone', { step: 2 }, { packId: 'deleted' });
  second.cache.set(old, 'planned', 'kept', { revision: 2 }, { packId: 'kept', pending: true });
  assert.equal(first.cache.removePack('alice', 'deleted'), true);
  assert.equal(second.cache.set(old, 'learning', 'gone', { step: 3 }, { packId: 'deleted' }), false);
  assert.equal(second.cache.set(old, 'planned', 'kept', { revision: 3 }, { packId: 'kept', pending: true }), true);
  assert.equal(second.cache.set(second.cache.capture('alice'), 'learning', 'fresh', {}, { packId: 'deleted' }), true);
  shared.flush();
  assert.equal(first.cache.get('alice', 'learning', 'gone'), null);
  assert.deepEqual(plain(first.cache.get('alice', 'learning', 'fresh')), {});
  assert.deepEqual(plain(first.cache.get('alice', 'planned', 'kept')), { revision: 3 });
});

test('exact and user removal fence only their remote scope without event delivery', () => {
  const shared = sharedTabs(), first = shared.open(), second = shared.open();
  const old = second.cache.capture('alice');
  assert.equal(first.cache.remove('alice', 'planned', 'run'), true);
  assert.equal(second.cache.set(old, 'planned', 'run', {}, { packId: 'pack', pending: true }), false);
  assert.equal(second.cache.set(old, 'highlights', 'pack', {}, { packId: 'pack', pending: true }), true);
  assert.equal(first.cache.clearUser('alice'), true);
  assert.equal(second.cache.set(old, 'learning', 'another', {}), false);
  const newTab = shared.open();
  assert.equal(newTab.cache.set(newTab.cache.capture('alice'), 'learning', 'new-session', {}), true);
});

test('a removal during an in-flight write rejects and cleans that stale revision', () => {
  const shared = sharedTabs(), first = shared.open(), second = shared.open();
  const old = second.cache.capture('alice');
  second.faults.beforeSet = () => first.cache.removePack('alice', 'pack');
  assert.equal(second.cache.set(old, 'planned', 'run', { revision: 2 }, { packId: 'pack', pending: true }), false);
  shared.flush();
  assert.equal(shared.values.has(key('alice', 'planned', 'run')), false);
});

test('delayed stale record events clean old writes but preserve a newer current revision', () => {
  const shared = sharedTabs(), first = shared.open(), second = shared.open();
  second.cache.set(second.cache.capture('alice'), 'planned', 'run', { revision: 1 }, { packId: 'pack', pending: true });
  const stale = shared.values.get(key('alice', 'planned', 'run'));
  first.cache.removePack('alice', 'pack');
  second.storage.setItem(key('alice', 'planned', 'run'), stale);
  shared.flush();
  assert.equal(shared.values.has(key('alice', 'planned', 'run')), false);
  second.storage.setItem(key('alice', 'planned', 'run'), stale);
  second.cache.set(second.cache.capture('alice'), 'planned', 'run', { revision: 3 }, { packId: 'pack', pending: true });
  shared.flush();
  assert.deepEqual(plain(first.cache.get('alice', 'planned', 'run')), { revision: 3 });
});

test('external account clearing preserves pending revisions while fencing every old tab', () => {
  const shared = sharedTabs(), first = shared.open(), second = shared.open();
  const old = second.cache.capture('alice');
  second.cache.set(old, 'planned', 'run', { revision: 2 }, { packId: 'pack', pending: true });
  second.cache.set(old, 'highlights', 'pack', { ranges: [] }, { packId: 'pack', pending: true });
  second.cache.set(old, 'learning', 'acknowledged', { step: 1 }, { packId: 'pack' });
  assert.equal(first.cache.hasPending('alice'), true);
  assert.equal(first.cache.clearUser('alice', { preservePending: true }), true);
  assert.equal(second.cache.set(old, 'planned', 'run', { revision: 3 }, { packId: 'pack', pending: true }), false);
  shared.flush();
  const resumed = shared.open();
  assert.deepEqual(plain(resumed.cache.get('alice', 'planned', 'run')), { revision: 2 });
  assert.deepEqual(plain(resumed.cache.get('alice', 'highlights', 'pack')), { ranges: [] });
  assert.equal(resumed.cache.get('alice', 'learning', 'acknowledged'), null);
  assert.equal(resumed.cache.set(resumed.cache.capture('alice'), 'planned', 'run', { revision: 3 }, { packId: 'pack', pending: true }), true);
  assert.equal(first.cache.clearUser('alice'), true);
  shared.flush();
  assert.equal(resumed.cache.get('alice', 'planned', 'run'), null);
  assert.equal(resumed.cache.hasPending('alice'), false);
});

test('pending detection fails closed and fence persistence failure is reported', () => {
  const { cache, faults, values } = fixture();
  assert.equal(cache.hasPending('alice'), false);
  values.set(key('alice', 'planned', 'unknown'), '{invalid');
  assert.equal(cache.hasPending('alice'), true);
  faults.read = true;
  assert.equal(cache.hasPending('alice'), true);
  faults.read = false;
  faults.set = true;
  const old = cache.capture('alice');
  assert.equal(cache.removePack('alice', 'pack'), false);
  assert.equal(cache.set(old, 'planned', 'run', {}, { packId: 'pack', pending: true }), false);
});

test('a pending update completed immediately before an external clear remains resumable', () => {
  const shared = sharedTabs(), first = shared.open(), second = shared.open();
  const old = second.cache.capture('alice');
  second.cache.set(old, 'planned', 'run', { revision: 1 }, { packId: 'pack', pending: true });
  first.faults.beforeSet = () => {
    assert.equal(second.cache.set(old, 'planned', 'run', { revision: 2 }, { packId: 'pack', pending: true }), true);
  };
  assert.equal(first.cache.clearUser('alice', { preservePending: true }), true);
  shared.flush();
  assert.deepEqual(plain(first.cache.get('alice', 'planned', 'run')), { revision: 2 });
  assert.equal(second.cache.set(old, 'planned', 'run', { revision: 3 }, { packId: 'pack', pending: true }), false);
});

test('repeated external clears retain pending work but cannot revive a full-clear generation', () => {
  const shared = sharedTabs(), first = shared.open(), second = shared.open();
  const old = second.cache.capture('alice');
  second.cache.set(old, 'planned', 'deleted', { revision: 1 }, { packId: 'old', pending: true });
  const deleted = shared.values.get(key('alice', 'planned', 'deleted'));
  assert.equal(first.cache.clearUser('alice'), true);
  const fresh = second.cache.capture('alice');
  second.cache.set(fresh, 'planned', 'retained', { revision: 2 }, { packId: 'current', pending: true });
  first.cache.clearUser('alice', { preservePending: true });
  second.cache.clearUser('alice', { preservePending: true });
  second.storage.setItem(key('alice', 'planned', 'deleted'), deleted);
  shared.flush();
  assert.equal(first.cache.get('alice', 'planned', 'deleted'), null);
  assert.deepEqual(plain(first.cache.get('alice', 'planned', 'retained')), { revision: 2 });
  assert.equal(first.cache.removePack('alice', 'current'), true);
  first.cache.clearUser('alice', { preservePending: true });
  shared.flush();
  assert.equal(second.cache.get('alice', 'planned', 'retained'), null);
});

test('a pending replacement that loses its user fence restores the retained predecessor', () => {
  const shared = sharedTabs(), first = shared.open(), second = shared.open();
  const old = second.cache.capture('alice');
  second.cache.set(old, 'planned', 'run', { revision: 1 }, { packId: 'pack', pending: true });
  second.faults.beforeSet = () => first.cache.clearUser('alice', { preservePending: true });
  assert.equal(second.cache.set(old, 'planned', 'run', { revision: 2 }, { packId: 'pack', pending: true }), false);
  shared.flush();
  assert.deepEqual(plain(first.cache.get('alice', 'planned', 'run')), { revision: 1 });
});

test('an external clear cannot erase pending data when its fence write fails', () => {
  const { cache, values, faults } = fixture();
  const token = cache.capture('alice');
  cache.set(token, 'planned', 'run', { revision: 1 }, { packId: 'pack', pending: true });
  cache.set(token, 'learning', 'acknowledged', {}, { packId: 'pack' });
  const pending = values.get(key('alice', 'planned', 'run'));
  faults.set = true;
  assert.equal(cache.clearUser('alice', { preservePending: true }), false);
  assert.equal(values.get(key('alice', 'planned', 'run')), pending);
  assert.equal(cache.set(token, 'planned', 'run', { revision: 2 }, { packId: 'pack', pending: true }), false);
});

test('pending detection is conservative for unreadable or unknown namespaced entries', () => {
  const { cache, faults, values } = fixture();
  faults.read = true;
  assert.equal(cache.hasPending('alice'), true);
  faults.read = false;
  values.set('lp_ui_v2:user:alice:study_cache:unknown:unencoded:entry', 'unknown data');
  assert.equal(cache.hasPending('alice'), true);
  assert.equal(cache.clearUser('alice', { preservePending: true }), false);
  assert.equal(values.has('lp_ui_v2:user:alice:study_cache:unknown:unencoded:entry'), true);
  assert.equal(cache.clearUser('alice'), true);
  assert.equal(cache.hasPending('alice'), false);
});

test('eviction aborts when another tab turns its acknowledged candidate into pending work', () => {
  const shared = sharedTabs(), first = shared.open(), second = shared.open();
  const token = first.cache.capture('alice');
  const remote = second.cache.capture('alice');
  first.cache.set(token, 'planned', 'candidate', { data: 'x'.repeat(1500000), revision: 1 }, { packId: 'other' });
  first.cache.set(token, 'planned', 'target', { revision: 1 }, { packId: 'target', pending: true });
  const previousTarget = shared.values.get(key('alice', 'planned', 'target'));
  first.faults.beforeKey = index => {
    if (index !== 1) return;
    first.faults.beforeKey = null;
    assert.equal(second.cache.set(remote, 'planned', 'candidate', { data: 'x'.repeat(1500000), revision: 2 },
      { packId: 'other', pending: true }), true);
  };
  assert.equal(first.cache.set(token, 'planned', 'target', { data: 'y'.repeat(700000), revision: 2 },
    { packId: 'target', pending: true }), false);
  assert.equal(shared.values.get(key('alice', 'planned', 'target')), previousTarget);
  assert.equal(second.cache.get('alice', 'planned', 'candidate').revision, 2);
  shared.flush();
  assert.equal(first.cache.get('alice', 'planned', 'candidate').revision, 2);
});

test('records retain their owner and encoded identity without importing legacy data', () => {
  const { cache, values } = fixture();
  values.set('highlights_pack', JSON.stringify({ private: 'legacy' }));
  const token = cache.capture('alice');
  assert.equal(cache.set(token, 'highlights:notes', 'pack/a:b', { ranges: [] }, { packId: 'pack/a:b', pending: true }), true);
  const record = JSON.parse(values.get(key('alice', 'highlights:notes', 'pack/a:b')));
  assert.deepEqual(Object.keys(record).sort(), ['fences', 'id', 'kind', 'pack_id', 'payload', 'pending', 'schema', 'uid', 'updated_at', 'write_id']);
  assert.equal(typeof record.write_id, 'string');
  assert.deepEqual(record, { schema: 1, uid: 'alice', kind: 'highlights:notes', id: 'pack/a:b', pack_id: 'pack/a:b',
    updated_at: Date.UTC(2026, 10, 1), pending: true, payload: { ranges: [] }, write_id: record.write_id,
    fences: { user: '', pack: '', key: '' } });
  assert.deepEqual(plain(cache.get('alice', 'highlights:notes', 'pack/a:b')), { ranges: [] });
  assert.equal(cache.get('alice', 'highlights', 'pack'), null);
  assert.equal(cache.get('bob', 'highlights:notes', 'pack/a:b'), null);
  cache.activate('bob');
  assert.equal(cache.get('alice', 'highlights:notes', 'pack/a:b'), null);
  assert.equal(cache.get('bob', 'highlights:notes', 'pack/a:b'), null);
  assert.equal(values.has('highlights_pack'), true);
});

test('activation is idempotent for one UID and fences an earlier account session', () => {
  const { cache } = fixture();
  const old = cache.capture('alice');
  cache.activate('alice');
  assert.equal(cache.set(old, 'learning', 'first', 1), true);
  cache.activate('bob');
  assert.equal(cache.set(old, 'learning', 'first', 2), false);
  assert.equal(cache.capture('alice'), null);
  cache.activate('alice');
  assert.equal(cache.set(old, 'learning', 'first', 3), false);
  assert.equal(cache.set(cache.capture('alice'), 'learning', 'first', 4), true);
  cache.activate('');
  assert.equal(cache.capture(''), null);
  assert.equal(cache.get('alice', 'learning', 'first'), null);
});

test('foreign or fabricated tokens cannot write', () => {
  const { cache } = fixture();
  const foreign = fixture().cache.capture('alice');
  for (const token of [foreign, {}, null, 'alice']) assert.equal(cache.set(token, 'learning', 'a', 1), false);
});

test('exact removal fences an in-flight writer without blocking other keys', () => {
  const { cache } = fixture();
  const token = cache.capture('alice');
  assert.equal(cache.set(token, 'planned', 'run', { pending: true }, { packId: 'pack', pending: true }), true);
  assert.equal(cache.remove('alice', 'planned', 'run'), true);
  assert.equal(cache.set(token, 'planned', 'run', { late: true }, { packId: 'pack', pending: true }), false);
  assert.equal(cache.set(token, 'highlights', 'pack', { ranges: [] }, { packId: 'pack' }), true);
  assert.equal(cache.set(cache.capture('alice'), 'planned', 'run', { fresh: true }, { packId: 'pack' }), true);
});

test('pack removal clears every kind and fences records not yet written', () => {
  const { cache } = fixture();
  const token = cache.capture('alice');
  for (const kind of ['learning', 'highlights', 'planned', 'conflict']) {
    assert.equal(cache.set(token, kind, 'id-' + kind, { kind }, { packId: 'deleted', pending: true }), true);
  }
  assert.equal(cache.set(token, 'learning', 'kept', 'retained', { packId: 'kept' }), true);
  assert.equal(cache.removePack('alice', 'deleted'), true);
  for (const kind of ['learning', 'highlights', 'planned', 'conflict']) assert.equal(cache.get('alice', kind, 'id-' + kind), null);
  assert.equal(cache.set(token, 'planned', 'not-yet-written', {}, { packId: 'deleted' }), false);
  assert.equal(cache.set(token, 'learning', 'kept', 'still retained', { packId: 'kept' }), true);
  assert.equal(cache.set(cache.capture('alice'), 'learning', 'new', {}, { packId: 'deleted' }), true);
});

test('partial account clear returns false, continues deleting, and fences before storage access', () => {
  const { cache, values, faults } = fixture();
  const token = cache.capture('alice');
  cache.set(token, 'learning', 'first', 1);
  cache.set(token, 'learning', 'second', 2);
  cache.activate('bob');
  cache.set(cache.capture('bob'), 'learning', 'first', 3);
  cache.activate('alice');
  const beforeClear = cache.capture('alice');
  faults.remove.add(key('alice', 'learning', 'first'));
  assert.equal(cache.clearUser('alice'), false);
  assert.equal(values.has(key('alice', 'learning', 'first')), true);
  assert.equal(values.has(key('alice', 'learning', 'second')), false);
  assert.equal(values.has(key('bob', 'learning', 'first')), true);
  assert.equal(cache.set(beforeClear, 'learning', 'late', 4), false);
  assert.equal(cache.set(cache.capture('alice'), 'learning', 'fresh', 5), true);
});

test('partial pack clear reports failure while its old writer remains fenced', () => {
  const { cache, faults, values } = fixture();
  const token = cache.capture('alice');
  cache.set(token, 'planned', 'run', {}, { packId: 'pack', pending: true });
  cache.set(token, 'highlights', 'pack', { ranges: [] }, { packId: 'pack', pending: true });
  faults.remove.add(key('alice', 'planned', 'run'));
  assert.equal(cache.removePack('alice', 'pack'), false);
  assert.equal(values.has(key('alice', 'highlights', 'pack')), false);
  assert.equal(cache.set(token, 'learning', 'late', {}, { packId: 'pack' }), false);
});

test('failed exact removal still fences stale completion callbacks', () => {
  const { cache, faults } = fixture();
  const token = cache.capture('alice');
  cache.set(token, 'planned', 'run', {}, { pending: true });
  faults.remove.add(key('alice', 'planned', 'run'));
  assert.equal(cache.remove('alice', 'planned', 'run'), false);
  assert.equal(cache.set(token, 'planned', 'run', { late: true }, { pending: true }), false);
});

test('acknowledged records expire after thirty days while pending tombstones survive', () => {
  const { cache, clock, values } = fixture();
  const token = cache.capture('alice');
  cache.set(token, 'learning', 'old', { step: 1 });
  cache.set(token, 'highlights', 'clear', { ranges: [] }, { packId: 'pack', pending: true });
  clock.now += 30 * DAY;
  assert.deepEqual(plain(cache.get('alice', 'learning', 'old')), { step: 1 });
  clock.now += 1;
  assert.equal(cache.get('alice', 'learning', 'old'), null);
  assert.deepEqual(plain(cache.get('alice', 'highlights', 'clear')), { ranges: [] });
  assert.equal(cache.set(token, 'learning', 'fresh', {}), true);
  assert.equal(values.has(key('alice', 'learning', 'old')), false);
  assert.equal(values.has(key('alice', 'highlights', 'clear')), true);
});

test('the record cap evicts the oldest acknowledged record and protects pending state', () => {
  const { cache, values, clock } = fixture();
  const token = cache.capture('alice');
  cache.set(token, 'planned', 'pending', { revision: 2 }, { pending: true });
  for (let i = 0; i < 49; i += 1) {
    clock.now += 1;
    assert.equal(cache.set(token, 'learning', String(i), i), true);
  }
  assert.equal(cache.set(token, 'learning', 'new', 99), true);
  assert.equal(values.size, 50);
  assert.equal(cache.get('alice', 'learning', '0'), null);
  assert.deepEqual(plain(cache.get('alice', 'planned', 'pending')), { revision: 2 });
});

test('fifty pending records reject a new record without losing any pending work', () => {
  const { cache, values } = fixture();
  const token = cache.capture('alice');
  for (let i = 0; i < 50; i += 1) assert.equal(cache.set(token, 'planned', String(i), { revision: i }, { pending: true }), true);
  const before = [...values];
  assert.equal(cache.set(token, 'learning', 'extra', {}), false);
  assert.deepEqual([...values], before);
  assert.equal(cache.set(token, 'planned', '0', { revision: 1 }, { pending: true }), true);
});

test('the byte cap counts serialized Unicode bytes and evicts only acknowledged data', () => {
  const { cache, values } = fixture();
  const token = cache.capture('alice');
  const large = '😀'.repeat(300000);
  assert.equal(cache.set(token, 'learning', 'first', large), true);
  assert.equal(cache.set(token, 'learning', 'second', large), true);
  assert.equal(cache.get('alice', 'learning', 'first'), null);
  assert.equal(cache.get('alice', 'learning', 'second'), large);
  assert.ok([...values.values()].reduce((sum, raw) => sum + Buffer.byteLength(raw), 0) <= 2 * 1024 * 1024);
});

test('pending byte capacity rejects another write and preserves an existing replacement target', () => {
  const { cache, values } = fixture();
  const token = cache.capture('alice');
  assert.equal(cache.set(token, 'planned', 'large', 'x'.repeat(1500000), { pending: true }), true);
  assert.equal(cache.set(token, 'planned', 'target', 'old', { pending: true }), true);
  const before = [...values];
  assert.equal(cache.set(token, 'planned', 'target', 'x'.repeat(700000), { pending: true }), false);
  assert.deepEqual([...values], before);
  assert.equal(cache.set(token, 'planned', 'target', 'x'.repeat(2100000), { pending: true }), false);
  assert.deepEqual([...values], before);
});

test('a quota error or serialization error keeps the previous revision durable', () => {
  const { cache, values, faults } = fixture();
  const token = cache.capture('alice');
  cache.set(token, 'planned', 'run', { revision: 1 }, { pending: true });
  const before = [...values];
  faults.set = true;
  assert.equal(cache.set(token, 'planned', 'run', { revision: 2 }, { pending: true }), false);
  faults.set = false;
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(cache.set(token, 'planned', 'run', cyclic, { pending: true }), false);
  assert.equal(cache.set(token, 'planned', 'run', undefined, { pending: true }), false);
  assert.deepEqual([...values], before);
});

test('failed eviction does not overwrite the pending replacement target', () => {
  const { cache, values, faults } = fixture();
  const token = cache.capture('alice');
  cache.set(token, 'learning', 'acknowledged', 'x'.repeat(1500000));
  cache.set(token, 'planned', 'target', { revision: 1 }, { pending: true });
  faults.remove.add(key('alice', 'learning', 'acknowledged'));
  const before = values.get(key('alice', 'planned', 'target'));
  assert.equal(cache.set(token, 'planned', 'target', 'x'.repeat(700000), { pending: true }), false);
  assert.equal(values.get(key('alice', 'planned', 'target')), before);
});

test('invalid records are not returned or evicted as acknowledged work', () => {
  const { cache, values } = fixture();
  values.set(key('alice', 'planned', 'broken'), '{not-json');
  assert.equal(cache.get('alice', 'planned', 'broken'), null);
  assert.equal(cache.removePack('alice', 'pack'), false);
  assert.equal(values.has(key('alice', 'planned', 'broken')), true);
  assert.equal(cache.clearUser('alice'), true);
  assert.equal([...values.keys()].some(value => value.startsWith('lp_ui_v2:user:alice:study_cache:')), false);
});

test('blocked storage access never throws and failed clear still invalidates old tokens', () => {
  const { cache, context } = fixture();
  const token = cache.capture('alice');
  Object.defineProperty(context, 'localStorage', { configurable: true, get() { throw new Error('Denied'); } });
  assert.equal(cache.get('alice', 'planned', 'run'), null);
  assert.equal(cache.set(token, 'planned', 'run', {}), false);
  assert.equal(cache.remove('alice', 'planned', 'run'), false);
  assert.equal(cache.removePack('alice', 'pack'), false);
  assert.equal(cache.clearUser('alice'), false);
  Object.defineProperty(context, 'localStorage', { value: { setItem() { throw new Error('Must remain fenced'); } } });
  assert.equal(cache.set(token, 'planned', 'other', {}), false);
});

test('unavailable storage enumeration fails mutation without erasing the old record', () => {
  const { cache, values, faults } = fixture();
  const token = cache.capture('alice');
  cache.set(token, 'planned', 'run', { revision: 1 }, { pending: true });
  const before = [...values];
  faults.enumerate = true;
  assert.equal(cache.set(token, 'planned', 'run', { revision: 2 }, { pending: true }), false);
  assert.equal(cache.clearUser('alice'), false);
  assert.deepEqual([...values], before);
});
