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
