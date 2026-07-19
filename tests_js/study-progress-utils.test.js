const test = require('node:test');
const assert = require('node:assert/strict');

const progressUtils = require('../static/js/study-progress-utils.js');

test('parseOptionalGoalValue accepts blank values and valid goals', () => {
  assert.equal(progressUtils.parseOptionalGoalValue(''), null);
  assert.equal(progressUtils.parseOptionalGoalValue('   '), null);
  assert.equal(progressUtils.parseOptionalGoalValue(null), null);
  assert.equal(progressUtils.parseOptionalGoalValue('24'), 24);
  assert.equal(progressUtils.parseOptionalGoalValue(0), null);
  assert.equal(progressUtils.parseOptionalGoalValue(700), null);
});

test('sameGoalValue compares optional goals consistently', () => {
  assert.equal(progressUtils.sameGoalValue('', null), true);
  assert.equal(progressUtils.sameGoalValue('18', 18), true);
  assert.equal(progressUtils.sameGoalValue('18', '24'), false);
});

test('formatGoalTarget returns cards per day labels', () => {
  assert.equal(progressUtils.formatGoalTarget(12), '12 cards/day');
  assert.equal(progressUtils.formatGoalTarget('', { emptyLabel: 'Not set' }), 'Not set');
});

test('updatePackCollectionGoal updates only the requested pack', () => {
  const packs = [
    { study_pack_id: 'pack-1', daily_card_goal: 12, title: 'One' },
    { study_pack_id: 'pack-2', daily_card_goal: null, title: 'Two' },
  ];

  const updated = progressUtils.updatePackCollectionGoal(packs, 'pack-2', 33);

  assert.deepEqual(updated, [
    { study_pack_id: 'pack-1', daily_card_goal: 12, title: 'One' },
    { study_pack_id: 'pack-2', daily_card_goal: 33, title: 'Two' },
  ]);
  assert.deepEqual(packs, [
    { study_pack_id: 'pack-1', daily_card_goal: 12, title: 'One' },
    { study_pack_id: 'pack-2', daily_card_goal: null, title: 'Two' },
  ]);
});

test('buildPackStats treats flipped cards as studied but still unmastered', () => {
  const stats = progressUtils.buildPackStats(
    { flashcards_count: 3 },
    {
      fc_0: { flip_count: 1, next_review_date: '' },
      fc_1: { seen: 1, level: 'mastered', next_review_date: '2099-01-01' },
    },
    '2026-03-22'
  );

  assert.deepEqual(stats, {
    total: 3,
    due: 1,
    unmastered: 2,
  });
});

test('mergeCardStateMaps hydrates non-empty local state without discarding newer remote scheduling', () => {
  const merged = progressUtils.mergeCardStateMaps(
    {
      fc_0: { seen: 2, correct: 1, wrong: 1, last_review_date: '2026-07-17', next_review_date: '2026-07-19', interval_days: 2, flip_count: 3 },
    },
    {
      fc_0: { seen: 4, correct: 3, wrong: 1, last_review_date: '2026-07-18', next_review_date: '2026-07-23', interval_days: 5, write_count: 2, last_action: 'good' },
      fc_1: { seen: 1, correct: 1, last_review_date: '2026-07-18', interval_days: 2 },
    }
  );

  assert.equal(merged.fc_0.seen, 4);
  assert.equal(merged.fc_0.flip_count, 3);
  assert.equal(merged.fc_0.write_count, 2);
  assert.equal(merged.fc_0.next_review_date, '2026-07-23');
  assert.equal(merged.fc_1.seen, 1);
});

test('revisioned sync controller preserves changes made while a request is in flight', async () => {
  const pendingRequests = [];
  const acknowledged = [];
  let value = 1;
  const controller = progressUtils.createRevisionedSyncController({
    createSnapshot(forceAll, markers) {
      return { payload: { value, forceAll }, markers };
    },
    transport(payload) {
      return new Promise((resolve) => pendingRequests.push({ payload, resolve }));
    },
    onAcknowledge(markers) {
      acknowledged.push(markers);
    },
  });

  controller.mark('pack-1');
  const firstFlush = controller.flush(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pendingRequests[0].payload, { value: 1, forceAll: false });

  value = 2;
  controller.mark('pack-1');
  pendingRequests[0].resolve();
  await firstFlush;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pendingRequests.length, 2);
  assert.deepEqual(pendingRequests[1].payload, { value: 2, forceAll: true });
  assert.deepEqual(acknowledged, []);

  pendingRequests[1].resolve();
  await controller.whenIdle();
  assert.deepEqual(acknowledged, [['pack-1']]);
});

test('device counters sum independent browsers and use max for retries from one browser', () => {
  const deviceA = progressUtils.incrementCardDeviceCounters({}, 'device_a', { seen: 1, correct: 1 });
  const deviceB = progressUtils.incrementCardDeviceCounters({}, 'device_b', { seen: 1, wrong: 1 });
  const merged = progressUtils.mergeCardStateEntry(deviceA, deviceB);

  assert.equal(merged.seen, 2);
  assert.equal(merged.correct, 1);
  assert.equal(merged.wrong, 1);
  assert.equal(merged.device_counters.device_a.seen, 1);
  assert.equal(merged.device_counters.device_b.seen, 1);

  const retriedDeviceA = progressUtils.mergeCardStateEntry(
    progressUtils.incrementCardDeviceCounters({}, 'device_a', { seen: 2, correct: 2 }),
    progressUtils.incrementCardDeviceCounters({}, 'device_a', { seen: 1, correct: 1 })
  );
  assert.equal(retriedDeviceA.seen, 2);
  assert.equal(retriedDeviceA.correct, 2);
});

test('daily progress sums device buckets and deduplicates same-device retries', () => {
  const local = progressUtils.incrementDailyProgressForDevice(
    { daily_progress_date: '2026-07-19', daily_progress_count: 0 },
    '2026-07-19',
    'device_a'
  );
  const remote = progressUtils.incrementDailyProgressForDevice(
    { daily_progress_date: '2026-07-19', daily_progress_count: 0 },
    '2026-07-19',
    'device_b'
  );
  const merged = progressUtils.mergeStreakData(local, remote);
  assert.equal(merged.daily_progress_count, 2);

  const retry = progressUtils.mergeStreakData(local, local);
  assert.equal(retry.daily_progress_count, 1);
});

test('progress device id is stable in browser storage', () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
  };
  const first = progressUtils.getOrCreateProgressDeviceId(storage, () => 'fixed-uuid');
  const second = progressUtils.getOrCreateProgressDeviceId(storage, () => 'different-uuid');
  assert.equal(first, 'web_fixed-uuid');
  assert.equal(second, first);
});

test('card merge uses updated_at to resolve same-day scheduling conflicts', () => {
  const merged = progressUtils.mergeCardStateEntry(
    { seen: 1, correct: 1, last_review_date: '2026-07-19', interval_days: 2, next_review_date: '2026-07-21', last_action: 'good', updated_at: 100 },
    { seen: 1, wrong: 1, last_review_date: '2026-07-19', interval_days: 1, next_review_date: '2026-07-19', last_action: 'retry', updated_at: 200 }
  );
  assert.equal(merged.last_action, 'retry');
  assert.equal(merged.interval_days, 1);
  assert.equal(merged.next_review_date, '2026-07-19');
  assert.equal(merged.updated_at, 200);
});
