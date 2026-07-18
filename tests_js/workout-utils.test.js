const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../static/js/workout-utils.js');

test('rest ranges use workbook midpoints', () => {
  assert.equal(utils.restSeconds('1-2 min'), 90);
  assert.equal(utils.restSeconds('2-3 min'), 150);
  assert.equal(utils.restSeconds('3-4 min'), 210);
});

test('equipment-aware client volume matches server contract', () => {
  const set = { type: 'normal', kg: 10, reps: 10, completed: true };
  assert.equal(utils.setVolume({ tracking_type: 'weight_reps', pair_multiplier: 2 }, set, 62.5), 200);
  assert.equal(utils.setVolume({ tracking_type: 'weighted_bodyweight', bodyweight_contributes: true }, set, 62.5), 725);
});

test('warmups round down to available workbook loads', () => {
  assert.deepEqual(utils.warmupSets(20, [0, 2, 3, 5, 7, 8, 10, 12, 13, 15, 17, 18, 20], [
    { percent: 40, reps: 10 },
    { percent: 60, reps: 5 },
    { percent: 80, reps: 3 },
  ]), [
    { type: 'warmup', percent: 40, reps: 10, kg: 8 },
    { type: 'warmup', percent: 60, reps: 5, kg: 12 },
    { type: 'warmup', percent: 80, reps: 3, kg: 15 },
  ]);
});

test('client progression mirrors increase and lower-load branches', () => {
  const exercise = {
    target_sets: 3,
    rep_min: 8,
    rep_max: 10,
    last_rpe: 9,
    sets: [
      { type: 'normal', kg: 10, reps: 10, rpe: 8, completed: true },
      { type: 'normal', kg: 10, reps: 10, rpe: 8.5, completed: true },
      { type: 'normal', kg: 10, reps: 10, rpe: 9, completed: true },
    ],
  };
  assert.equal(utils.progression(exercise, 'Build').next_action, 'Verhoog load volgende keer');
  exercise.sets[0].reps = 6;
  assert.equal(utils.progression(exercise, 'Build').flag, 'Load omlaag');
});
