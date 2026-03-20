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
