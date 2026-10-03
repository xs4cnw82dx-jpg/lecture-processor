const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionNeedsSync, markConnectionDirty, postponeFailedWake, wakeDuePage } = require('../functions/calendar-sync-recovery');

test('source wake reads connection and deletion tombstone in its write transaction', async () => {
  const rows = { 'study_google_calendars/a': { status: 'connected' } };
  const reads = [];
  const writes = [];
  const db = {
    collection: collection => ({ doc: uid => ({ path: collection + '/' + uid }) }),
    runTransaction: operation => operation({
      get: async ref => { reads.push(ref.path); return { exists: !!rows[ref.path], data: () => rows[ref.path] }; },
      set: (ref, value) => { writes.push({ path: ref.path, value }); },
    }),
  };
  await markConnectionDirty(db, 'a', value => ({ increment: value }));
  assert.deepEqual(reads, ['account_deletions/a', 'study_google_calendars/a']);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].value.generation, { increment: 1 });
  rows['account_deletions/a'] = { status: 'purging' };
  await markConnectionDirty(db, 'a', value => value);
  assert.equal(writes.length, 1);
  delete rows['account_deletions/a'];
  delete rows['study_google_calendars/a'];
  await markConnectionDirty(db, 'a', value => value);
  assert.equal(writes.length, 1);
});

function database(rows) {
  return {
    collection: () => ({ doc: uid => ({ uid }) }),
    runTransaction: async operation => operation({
      get: async ref => ({ exists: !!rows[ref.uid], data: () => rows[ref.uid] }),
      set: (ref, value) => { rows[ref.uid] = { ...rows[ref.uid], ...value }; },
    }),
  };
}

test('failed wake persists backoff without completing or dropping work', async () => {
  const rows = { a: { generation: 4, completed_generation: 2, next_attempt_at: 0 } };
  await postponeFailedWake(database(rows), 'a', 1000);
  assert.equal(rows.a.next_attempt_at, 1060);
  assert.equal(rows.a.generation, 4);
  assert.equal(rows.a.completed_generation, 2);
  assert.equal(rows.a.wake_failures, 1);
});

test('late HTTP failure respects an active worker lease and existing backoff', async () => {
  const rows = { a: { lease_until: 1100, next_attempt_at: 0 }, b: { next_attempt_at: 2000 } };
  const db = database(rows);
  await postponeFailedWake(db, 'a', 1000);
  await postponeFailedWake(db, 'b', 1000);
  assert.equal(rows.a.next_attempt_at, 0);
  assert.equal(rows.b.next_attempt_at, 2000);
});

test('recovery processes healthy users despite failing users and caps parallelism', async () => {
  const rows = Object.fromEntries(Array.from({ length: 10 }, (_, index) => ['user' + index, { next_attempt_at: 0 }]));
  const docs = Object.keys(rows).map(id => ({ id, data: () => rows[id] }));
  let running = 0;
  let maximum = 0;
  const completed = [];
  const errors = [];
  const result = await wakeDuePage(docs, {
    db: database(rows), now: () => 1000000, deadline: 1100000,
    wake: async uid => {
      running += 1; maximum = Math.max(maximum, running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running -= 1;
      if (uid === 'user0') throw new Error('timeout');
      completed.push(uid);
    },
    onError: uid => errors.push(uid),
  });
  assert.equal(result, true);
  assert.equal(maximum, 4);
  assert.equal(completed.length, 9);
  assert.deepEqual(errors, ['user0']);
  assert.equal(rows.user0.next_attempt_at, 1060);
});

test('connection trigger recovers lost enqueue without creating a sync loop', () => {
  const before = { status: 'pending', credentials: 'cipher', connection_id: 'id', include_deadlines: true, reminder_offset_minutes: 30 };
  assert.equal(connectionNeedsSync(undefined, before), true);
  assert.equal(connectionNeedsSync(before, { ...before, status: 'syncing' }), false);
  assert.equal(connectionNeedsSync(before, { ...before, status: 'connected', last_synced_at: 1000 }), false);
  assert.equal(connectionNeedsSync(before, { ...before, credentials: 'replacement' }), true);
  assert.equal(connectionNeedsSync(before, { ...before, status: 'disconnecting' }), true);
  assert.equal(connectionNeedsSync(before, { ...before, include_deadlines: false }), true);
  assert.equal(connectionNeedsSync(before, undefined), false);
});
