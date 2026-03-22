const test = require('node:test');
const assert = require('node:assert/strict');

const studySessionUtils = require('../static/js/study-session-utils.js');

test('orderCardsByAlgo prioritizes due retry cards before deferred cards', () => {
  const queue = studySessionUtils.orderCardsByAlgo(
    [{ front: 'One' }, { front: 'Two' }, { front: 'Three' }],
    {
      sessionAlgo: ['retry', 'new', 'familiar', 'remaster', 'hard'],
      cardState: {
        fc_0: { seen: 1, level: 'familiar', next_review_date: '2099-01-01', correct: 1, wrong: 0 },
        fc_1: { seen: 3, level: 'familiar', next_review_date: '2020-01-01', correct: 1, wrong: 3, last_action: 'retry' },
      },
      isDueDate: (value) => value <= '2024-01-01',
      randomFn: () => 0,
    }
  );

  assert.deepEqual(queue.map((entry) => entry.idx), [1, 2, 0]);
});

test('orderCardsByAlgo repeats the lane across the whole session queue', () => {
  const queue = studySessionUtils.orderCardsByAlgo(
    [{ front: 'One' }, { front: 'Two' }, { front: 'Three' }, { front: 'Four' }, { front: 'Five' }, { front: 'Six' }],
    {
      sessionAlgo: ['new', 'familiar'],
      cardState: {
        fc_3: { seen: 1, level: 'familiar', next_review_date: '2024-01-01' },
        fc_4: { seen: 1, level: 'familiar', next_review_date: '2024-01-01' },
        fc_5: { seen: 1, level: 'familiar', next_review_date: '2024-01-01' },
      },
      isDueDate: (value) => value <= '2024-01-01',
      randomFn: () => 0.99,
    }
  );

  assert.deepEqual(queue.map((entry) => entry.idx), [0, 3, 1, 4, 2, 5]);
});

test('orderCardsByAlgo shuffles the full queue for all-random sessions', () => {
  const queue = studySessionUtils.orderCardsByAlgo(
    [{ front: 'One' }, { front: 'Two' }, { front: 'Three' }, { front: 'Four' }],
    {
      sessionAlgo: ['random', 'random', 'random', 'random', 'random'],
      cardState: {},
      randomFn: () => 0,
    }
  );

  assert.deepEqual(queue.map((entry) => entry.idx), [1, 2, 3, 0]);
});

test('getFlashcardQueue falls back to the selected pack cards when no ordered queue exists', () => {
  const queue = studySessionUtils.getFlashcardQueue([], {
    flashcards: [{ front: 'Front 1' }, { front: 'Front 2' }],
  });

  assert.deepEqual(queue, [
    { card: { front: 'Front 1' }, idx: 0 },
    { card: { front: 'Front 2' }, idx: 1 },
  ]);
});

test('gradeAnswer respects study-session normalization settings', () => {
  const settings = {
    caseSensitive: false,
    ignoreBrackets: true,
    ignoreArticles: true,
    ignoreDeterminers: true,
  };

  assert.equal(
    studySessionUtils.gradeAnswer('The Krebs cycle (citric acid cycle)', 'krebs cycle', settings),
    true
  );
});

test('getEnabledModes returns only the enabled learn modes', () => {
  assert.deepEqual(
    studySessionUtils.getEnabledModes({ flashcards: true, test: false, write: true, match: false }),
    ['flashcards', 'write']
  );
});

test('getCardStatusInfo uses real interaction history for viewed, familiar, and remaster cards', () => {
  assert.deepEqual(
    studySessionUtils.getCardStatusInfo({ flip_count: 1 }, { isDueDate: () => true }),
    {
      bucket: 'familiar',
      due: true,
      engaged: true,
      hard: false,
      key: 'viewed',
      label: 'Viewed',
      remaster: false,
      retry: false,
      viewedOnly: true,
    }
  );

  assert.equal(
    studySessionUtils.getCardStatusInfo({ write_count: 1 }, { isDueDate: () => true }).key,
    'familiar'
  );

  assert.equal(
    studySessionUtils.getCardStatusInfo(
      { seen: 3, interval_days: 2, max_interval_days: 21, difficulty: 'hard', next_review_date: '2099-01-01' },
      { isDueDate: (value) => value <= '2024-01-01' }
    ).key,
    'remaster'
  );
});

test('getAnswerDisplay formats the matching option label and fallback text', () => {
  assert.equal(
    studySessionUtils.getAnswerDisplay({
      options: ['Aorta', 'Atrium', 'Artery', 'Ventricle'],
      answer: 'Artery',
    }),
    'C: Artery'
  );

  assert.equal(studySessionUtils.getAnswerDisplay({ options: [], answer: 'Missing' }), 'A: (empty)');
});
