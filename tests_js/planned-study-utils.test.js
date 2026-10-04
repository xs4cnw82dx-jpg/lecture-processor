const test = require('node:test');
const assert = require('node:assert/strict');
const utils = require('../static/js/planned-study-utils.js');

test('45-minute Pomodoro slot contains 40 focus minutes and one five-minute break', () => {
  assert.equal(utils.focusSeconds(2700, 'pomodoro', 2700), 2400);
  assert.equal(utils.focusSeconds(2700, 'countdown', 2700), 2700);
  assert.equal(utils.timerState({ timer_mode: 'pomodoro', slot_seconds: 1500, duration_seconds: 2700 }).onBreak, true);
  assert.equal(utils.timerState({ timer_mode: 'pomodoro', slot_seconds: 1800, duration_seconds: 2700 }).onBreak, false);
  assert.equal(utils.focusSeconds(3000, 'pomodoro', 2700), 2700);
});

test('unique answers advance targets and incorrect answers get one bounded retry', () => {
  const run = { queue: [{ id: 'fc_4', type: 'fc' }, { id: 'q_3', type: 'q' }], answers: { fc_4: { correct: false } }, retry_done: [], slot_seconds: 15, duration_seconds: 2700 };
  assert.deepEqual(utils.pendingItems(run).map(item => item.id), ['q_3', 'fc_4']);
  assert.equal(utils.canFinish(run), false);
  run.answers.q_3 = { correct: true };
  assert.equal(utils.canFinish(run), false);
  run.retry_done.push('fc_4');
  assert.equal(utils.canFinish(run), true);
});

test('elapsed timer alone cannot complete empty run; notes require real focus time', () => {
  const run = { queue: [{ id: 'notes', type: 'notes', seconds: 2700 }], answers: {}, notes_seconds: 0, slot_seconds: 2700, duration_seconds: 2700 };
  assert.equal(utils.canFinish(run), false);
  run.notes_seconds = 60;
  assert.equal(utils.canFinish(run), false);
  run.active_seconds = 2700;
  assert.equal(utils.canFinish(run), true);
});

test('local checkpoint resumes only its matching current content and completion generation', () => {
  const remote = { activity_id: 'run_1', content_fingerprint: 'new', generation: 2, checkpoint_revision: 3, queue: ['server'], active_seconds: 10 };
  assert.equal(utils.mergeCheckpoint(remote, { ...remote, generation: 1, checkpoint_revision: 8, active_seconds: 50 }), remote);
  assert.equal(utils.mergeCheckpoint(remote, { ...remote, content_fingerprint: 'old', checkpoint_revision: 8 }), remote);
  const merged = utils.mergeCheckpoint(remote, { ...remote, checkpoint_revision: 8, active_seconds: 50, queue: ['local'], run_status: 'active' });
  assert.equal(merged.active_seconds, 50);
  assert.equal(merged.run_status, 'paused');
  assert.deepEqual(merged.queue, ['server']);
});

test('a stale mode cannot override a new server mode even with a higher local revision', () => {
  const remote = {activity_id:'r',content_fingerprint:'v',generation:0,mode_generation:1,study_mode:'test',checkpoint_revision:5};
  assert.equal(utils.mergeCheckpoint(remote,{...remote,mode_generation:0,study_mode:'write',checkpoint_revision:50,pending_reviews:[{key:'fc_0:first'}]}),remote);
});
