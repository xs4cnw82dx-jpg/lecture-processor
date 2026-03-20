const test = require('node:test');
const assert = require('node:assert/strict');

const progressUtils = require('../static/js/index-progress-utils.js');
const runtimeJobUtils = require('../static/js/runtime-job-utils.js');

test('getProgressStepsForMode trims lecture steps to the requested count', () => {
  const steps = progressUtils.getProgressStepsForMode('lecture-notes', 2, {
    'lecture-notes': {
      steps: [{ num: 1, label: 'Slides' }, { num: 2, label: 'Transcript' }, { num: 3, label: 'Notes' }],
    },
    'slides-only': {
      steps: [{ num: 1, label: 'Slides' }, { num: 2, label: 'Study tools' }],
    },
    interview: {
      steps: [{ num: 1, label: 'Transcript' }],
    },
  });

  assert.deepEqual(steps, [{ num: 1, label: 'Slides' }, { num: 2, label: 'Transcript' }]);
});

test('getProgressStepsForMode uses the dedicated interview extras flow when total steps exceeds one', () => {
  const steps = progressUtils.getProgressStepsForMode('interview', 2, {
    interview: {
      steps: [{ num: 1, label: 'Transcript' }],
    },
  });

  assert.deepEqual(steps, [{ num: 1, label: 'Transcribe' }, { num: 2, label: 'Create Extras' }]);
});

test('buildRuntimeJobSnapshot normalizes the merged payload when runtime job helpers are available', () => {
  const snapshot = progressUtils.buildRuntimeJobSnapshot(
    { job_id: 'job-1', status: 'processing', step: '2' },
    { study_pack_title: 'Biology Week 1' },
    runtimeJobUtils
  );

  assert.equal(snapshot.job_id, 'job-1');
  assert.equal(snapshot.status, 'processing');
  assert.equal(snapshot.step, 2);
  assert.equal(snapshot.study_pack_title, 'Biology Week 1');
});
