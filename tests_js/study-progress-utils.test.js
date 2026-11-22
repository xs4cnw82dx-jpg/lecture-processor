const test = require('node:test');
const assert = require('node:assert/strict');

const progressUtils = require('../static/js/study-progress-utils.js');

for (const [date, offset, expected] of [
  ['2026-03-01', -1, '2026-02-28'],
  ['2024-03-01', -1, '2024-02-29'],
  ['2026-01-01', -1, '2025-12-31'],
  ['2026-03-30', '-1', '2026-03-29'],
  ['2026-11-13', 0, '2026-11-13'],
  ['2026-01-30', 5, '2026-02-04'],
  ['2026-12-31', 1, '2027-01-01'],
]) {
  test(`local date arithmetic moves ${date} by ${offset} days`, () => {
    assert.equal(progressUtils.addDaysToLocalDate(date, offset), expected);
  });
}

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

for (const [current, action, expected] of [
  [0, 'retry', 1],
  [30, 'retry', 1],
  [0, 'hard', 1],
  [4, 'hard', 5],
  [20, 'hard', 25],
  [0, 'good', 2],
  [2, 'good', 4],
  [10, 'good', 18],
  [0, 'easy', 4],
  [1, 'easy', 4],
  [10, 'easy', 24],
  [100, 'easy', 120],
  [0, 'unknown', 2],
  [3, 'GOOD', 5],
]) {
  test(`a ${action} review after ${current} days schedules the next one in ${expected}`, () => {
    assert.equal(progressUtils.nextReviewIntervalDays(current, action), expected);
  });
}

test('review actions are normalised, with unknown ones counting as good', () => {
  assert.equal(progressUtils.normalizeReviewAction('Retry'), 'retry');
  assert.equal(progressUtils.normalizeReviewAction('easy'), 'easy');
  assert.equal(progressUtils.normalizeReviewAction(''), 'good');
  assert.equal(progressUtils.normalizeReviewAction('skip'), 'good');
  assert.equal(progressUtils.mapLegacyDifficultyToAction('HARD'), 'hard');
  assert.equal(progressUtils.mapLegacyDifficultyToAction('easy'), 'easy');
  assert.equal(progressUtils.mapLegacyDifficultyToAction('medium'), 'good');
});

test('stored card entries gain missing fields and a max interval', () => {
  const entry = progressUtils.normalizeCardStateEntry({ seen: 3, interval_days: 9 });
  assert.equal(entry.seen, 3);
  assert.equal(entry.level, 'new');
  assert.equal(entry.max_interval_days, 9);
  assert.deepEqual(entry.device_counters, {});
  assert.equal(progressUtils.normalizeCardStateEntry({ interval_days: 4, max_interval_days: 30 }).max_interval_days, 30);
  assert.equal(progressUtils.normalizeCardStateEntry(null).max_interval_days, 0);
  const first = progressUtils.createEmptyCardStateEntry();
  first.device_counters.a = { seen: 1 };
  assert.deepEqual(progressUtils.createEmptyCardStateEntry().device_counters, {});
});

test('a good review counts as correct and schedules the card ahead', () => {
  const before = { seen: 1, correct: 1, interval_days: 2, difficulty: 'hard', device_counters: { phone: { seen: 1, correct: 1 } } };
  const after = progressUtils.applyReviewToEntry(before, 'good', {
    today: '2026-11-22',
    deviceId: 'laptop',
    now: 1234,
    deriveLevel: (entry) => `level-${entry.interval_days}`,
  });
  assert.equal(after.seen, 2);
  assert.equal(after.correct, 2);
  assert.equal(after.wrong, 0);
  assert.equal(after.device_counters.laptop.seen, 1);
  assert.equal(after.device_counters.phone.seen, 1);
  assert.equal(after.interval_days, 4);
  assert.equal(after.max_interval_days, 4);
  assert.equal(after.last_review_date, '2026-11-22');
  assert.equal(after.next_review_date, '2026-11-26');
  assert.equal(after.difficulty, 'medium');
  assert.equal(after.last_action, 'good');
  assert.equal(after.level, 'level-4');
  assert.equal(after.updated_at, 1234);
  assert.equal(before.seen, 1, 'the stored entry is not changed in place');
});

test('a retry counts as wrong, is due again today and keeps the longest interval', () => {
  const after = progressUtils.applyReviewToEntry({ interval_days: 30, max_interval_days: 30 }, 'retry', {
    today: '2026-11-22',
    deviceId: 'laptop',
  });
  assert.equal(after.seen, 1);
  assert.equal(after.wrong, 1);
  assert.equal(after.correct, 0);
  assert.equal(after.interval_days, 1);
  assert.equal(after.max_interval_days, 30);
  assert.equal(after.next_review_date, '2026-11-22');
  assert.equal(after.last_action, 'retry');
});

test('hard and easy reviews set the card difficulty', () => {
  const options = { today: '2026-12-30', deviceId: 'laptop' };
  const hard = progressUtils.applyReviewToEntry({}, 'hard', options);
  assert.equal(hard.difficulty, 'hard');
  assert.equal(hard.next_review_date, '2026-12-31');
  const easy = progressUtils.applyReviewToEntry({}, 'easy', options);
  assert.equal(easy.difficulty, 'easy');
  assert.equal(easy.next_review_date, '2027-01-03');
});

test('studying on consecutive days grows the streak and a missed day resets it', () => {
  const yesterday = { last_study_date: '2026-11-21', current_streak: 4, daily_progress_date: '2026-11-21', daily_progress_count: 12 };
  const today = progressUtils.recordStudyDay(yesterday, '2026-11-22');
  assert.equal(today.current_streak, 5);
  assert.equal(today.last_study_date, '2026-11-22');
  assert.equal(today.daily_progress_date, '2026-11-22');
  assert.equal(today.daily_progress_count, 0);
  assert.equal(yesterday.current_streak, 4, 'the stored streak is not changed in place');

  const sameDay = progressUtils.recordStudyDay({ ...today, daily_progress_count: 7 }, '2026-11-22');
  assert.equal(sameDay.current_streak, 5);
  assert.equal(sameDay.daily_progress_count, 7);

  const missed = progressUtils.recordStudyDay({ last_study_date: '2026-11-19', current_streak: 9 }, '2026-11-22');
  assert.equal(missed.current_streak, 1);
  assert.equal(progressUtils.recordStudyDay({}, '2026-11-22').current_streak, 1);
  assert.equal(progressUtils.recordStudyDay({ last_study_date: '2026-02-28', current_streak: 2 }, '2026-03-01').current_streak, 3);
});

for (const [input, expected] of [
  ['', ''],
  ['   ', ''],
  ['2026-11-22', '2026-11-22'],
  [' 22-11-2026 ', '2026-11-22'],
  ['01-02-2027', '2027-02-01'],
  ['29-02-2024', '2024-02-29'],
  ['29-02-2026', null],
  ['2026-02-30', null],
  ['2026-13-01', null],
  ['22/11/2026', null],
  ['tomorrow', null],
]) {
  test(`exam date input ${JSON.stringify(input)} reads as ${JSON.stringify(expected)}`, () => {
    assert.equal(progressUtils.parseDateInput(input), expected);
  });
}

test('exam dates are shown day first', () => {
  assert.equal(progressUtils.formatDisplayDate('2026-11-22'), '22-11-2026');
  assert.equal(progressUtils.formatDisplayDate('22-11-2026'), '');
  assert.equal(progressUtils.formatDisplayDate(null), '');
});
